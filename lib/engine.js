/**
 * 分片下载引擎（Node 实现）。
 *
 * 设计直接参照 YunX（云析，https://github.com/CYQawa/YunX）Android 端的下载内核
 * （app/src/main/kotlin/com/yunx/app/data/download/），把它最核心的几条约定搬了过来：
 *
 *  1. Range 探测：先发 `Range: bytes=0-0`，用 `Content-Range: bytes 0-0/total` 拿总长度；
 *     返回 200 说明服务端忽略 Range —— 绝不为单片下载整文件，直接回退单流。
 *  2. 分片规划（YunX `chunkCountFor`）：分片数 = max(按文件大小档位, 连接数×8)，
 *     单片不小于 256KB、总数封顶 512 片。盈余片远多于连接数 ⇒ worker 领取式工作窃取，
 *     某一片慢只影响它自己，不会出现"其他线程都下完、剩最后一个分片慢慢爬"的尾部塌缩。
 *  3. 严格校验：`Content-Range` 的 start/end 必须与请求一致，总长度变了就报错；
 *     单片实收字节数必须等于请求区间，否则重试该片。
 *  4. 断点续传：已完成分片索引 + 分片计划签名一起落盘；计划签名（总长/片大小/片数）变了
 *     就整任务作废重下，避免旧分片区间错位写花文件。
 *  5. 令牌桶限速：所有任务合计不超配置速率，与 YunX 的 SpeedLimiter 同思路。
 *  6. 5 秒滑动窗口测速，避免多连接瞬时抖动让剩余时间乱跳。
 *
 * 与安卓版的差异：这里不做 part_N 临时分片文件 + 合并，而是直接对最终文件做
 * 定位写（seek write），断点续传只依赖"已完成片索引"，省掉一次全量磁盘合并。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

const MB = 1024 * 1024
/** 单片下限：256KB（YunX 同值）。低于此值 Range 请求开销不划算。 */
const MIN_CHUNK_BYTES = 256 * 1024
/** 单任务分片数硬上限：512（YunX 同值）。 */
const MAX_CHUNK_COUNT = 512
/** 进度落盘节流：800ms 一次，避免小片密集写盘。 */
const PROGRESS_PERSIST_MS = 800

export const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
})

/** 任务被暂停/取消时，在中断点抛出的信号。 */
class AbortedTaskError extends Error {
  constructor(message = '任务已中止') {
    super(message)
    this.name = 'AbortedTaskError'
  }
}

/** 服务端忽略 Range（200 整文件）时抛出，上层回退单流。 */
class RangeUnsupportedError extends Error {
  constructor(message = '服务端不支持 Range 请求') {
    super(message)
    this.name = 'RangeUnsupportedError'
  }
}

/** 可被中止的 sleep。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedTaskError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AbortedTaskError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 单调时钟（秒），限速器用它算令牌补充量。 */
function nowSeconds() {
  return Number(process.hrtime.bigint()) / 1e9
}

function clampInt(value, min, max) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function describeError(error) {
  if (!error) return '未知错误'
  const cause = error.cause
  const base = error.message || String(error)
  if (cause && cause.message && !base.includes(cause.message)) return `${base}（${cause.message}）`
  return base
}

/** 解析 `Content-Range: bytes 0-0/12345`；total 为 `*` 时返回 null。 */
export function parseContentRange(value) {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i)
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? null : Number(match[3])
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  if (total !== null && (!Number.isFinite(total) || end >= total)) return null
  return { start, end, total }
}

/**
 * 分片数规划（YunX `chunkCountFor` 的等价实现）。
 * 小文件不分片；大文件按档位给基础片数，再按"每连接 8 片"给盈余片；
 * 最后按 256KB 单片下限与 512 片封顶收敛。
 */
export function planChunkCount(total, connections = 8) {
  if (!Number.isFinite(total) || total <= 0) return 1
  const bySize = total < 5 * MB ? 1 : total < 50 * MB ? 8 : total < 500 * MB ? 32 : 64
  const want = Math.max(bySize, Math.max(1, Math.trunc(connections)) * 8)
  const byMinChunk = Math.max(1, Math.floor(total / MIN_CHUNK_BYTES))
  return Math.max(1, Math.min(want, byMinChunk, MAX_CHUNK_COUNT))
}

/** 已完成的片索引 → 已完成字节数（最后一片可能不满）。 */
function countDoneBytes(done, chunkSize, total) {
  let bytes = 0
  for (const index of done) {
    const start = index * chunkSize
    if (start >= total) continue
    bytes += Math.min(chunkSize, total - start)
  }
  return bytes
}

/** 从 Content-Disposition 解析文件名（优先 RFC 5987 的 filename*）。 */
export function filenameFromDisposition(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const star = value.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i)
  if (star) {
    const raw = star[2].trim().replace(/^"|"$/g, '')
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  const plain = value.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i)
  if (plain) {
    const raw = (plain[2] ?? plain[1] ?? '').trim()
    if (!raw) return null
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

/** 从 URL 末段推断文件名。 */
export function filenameFromUrl(url) {
  try {
    const parsed = new URL(url)
    const segment = parsed.pathname.split('/').filter(Boolean).pop()
    if (!segment) return null
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** 清洗文件名：去目录分隔符 / 控制字符 / 保留名，限制长度。 */
export function sanitizeFilename(name, fallback = 'download.bin') {
  let base = String(name ?? '')
  base = base.split(/[\\/]/).pop() ?? ''
  base = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()
  base = base.replace(/^\.+$/, '')
  if (base === '' || base === '.' || base === '..') base = fallback
  if (base.length > 180) {
    const ext = path.extname(base).slice(0, 20)
    base = base.slice(0, Math.max(1, 180 - ext.length)) + ext
  }
  return base
}

/** 归一化请求头：键小写、值转字符串、丢掉空键与非法字符。 */
export function normalizeHeaders(headers) {
  const result = {}
  if (!headers || typeof headers !== 'object') return result
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key ?? '').trim()
    if (!name || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) continue
    if (value === undefined || value === null) continue
    const text = String(value)
    if (text.length === 0) continue
    result[name.toLowerCase()] = text
  }
  return result
}

/** 令牌桶限速器：0 表示不限速；令牌上限 1 秒的量（允许小突发）。 */
export class RateLimiter {
  constructor(bytesPerSecond = 0) {
    this.limit = 0
    this.tokens = 0
    this.last = nowSeconds()
    this.setLimit(bytesPerSecond)
  }

  setLimit(bytesPerSecond) {
    const n = Number(bytesPerSecond)
    this.limit = Number.isFinite(n) && n > 0 ? n : 0
    this.tokens = 0
    this.last = nowSeconds()
  }

  /** 消耗 bytes 字节额度；额度不足时按缺额睡对应时长（不持锁忙等）。 */
  async take(bytes) {
    if (this.limit <= 0 || !(bytes > 0)) return
    for (;;) {
      const now = nowSeconds()
      const elapsed = Math.max(0, now - this.last)
      this.last = now
      this.tokens = Math.min(this.limit, this.tokens + elapsed * this.limit)
      if (this.tokens >= bytes) {
        this.tokens -= bytes
        return
      }
      const missing = bytes - this.tokens
      await sleep(Math.max(1, Math.ceil((missing / this.limit) * 1000)))
    }
  }
}

/** 5 秒滑动窗口测速（YunX SpeedRecorder 同思路）。 */
class SpeedMeter {
  constructor(windowMs = 5000) {
    this.windowMs = windowMs
    this.samples = []
  }

  add(total) {
    const now = Date.now()
    this.samples.push({ t: now, bytes: total })
    while (this.samples.length > 2 && now - this.samples[0].t > this.windowMs) this.samples.shift()
  }

  speed() {
    const samples = this.samples
    if (samples.length < 2) return 0
    const last = samples[samples.length - 1]
    if (Date.now() - last.t > 3000) return 0
    const first = samples[0]
    const elapsed = (last.t - first.t) / 1000
    if (elapsed <= 0) return 0
    return Math.max(0, (last.bytes - first.bytes) / elapsed)
  }
}

/** 连接停滞看门狗：每次收到数据就续命，超时即中止本次请求（交给上层重试）。 */
function makeStallGuard(parentSignal, stallMs) {
  const controller = new AbortController()
  let timer = null
  const abortWith = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const touch = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => abortWith(new Error('连接停滞超时')), stallMs)
    timer.unref?.()
  }
  const onParentAbort = () => abortWith(parentSignal.reason)
  if (parentSignal.aborted) abortWith(parentSignal.reason)
  else parentSignal.addEventListener('abort', onParentAbort, { once: true })
  touch()
  return {
    signal: controller.signal,
    touch,
    dispose() {
      if (timer) clearTimeout(timer)
      timer = null
      parentSignal.removeEventListener('abort', onParentAbort)
    },
  }
}

/**
 * 探测直链：返回 { supportsRange, total, etag, lastModified, filename }。
 * 先 `Range: bytes=0-0` 探 206；被无视（200）就按单流处理；416 用 HEAD 兜底。
 */
async function probeResource(url, headers, { timeoutMs = 20000 } = {}) {
  const bounded = () => AbortSignal.timeout(timeoutMs)
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'accept-encoding': 'identity', ...headers, range: 'bytes=0-0' },
      redirect: 'follow',
      signal: bounded(),
    })
  } catch (error) {
    throw new Error(`探测直链失败：${describeError(error)}`)
  }

  const etag = response.headers.get('etag') || null
  const lastModified = response.headers.get('last-modified') || null
  const dispositionName = filenameFromDisposition(response.headers.get('content-disposition'))

  let supportsRange = false
  let total = null

  if (response.status === 206) {
    const range = parseContentRange(response.headers.get('content-range'))
    if (range && range.total !== null) {
      supportsRange = true
      total = range.total
    }
  } else if (response.status === 200) {
    const length = Number(response.headers.get('content-length'))
    total = Number.isFinite(length) && length >= 0 ? length : null
  } else if (response.status === 416) {
    // 空文件或服务器不认这个 Range：下面用 HEAD 兜底
    supportsRange = true
  } else if (response.status >= 400) {
    try {
      await response.body?.cancel()
    } catch {}
    throw new Error(`探测直链失败：HTTP ${response.status}`)
  }

  try {
    await response.body?.cancel()
  } catch {}

  if (total === null) {
    // 兜底：HEAD 拿 Content-Length（有些 CDN 对 GET 探测返回 chunked 不给长度）
    try {
      const head = await fetch(url, {
        method: 'HEAD',
        headers: { 'accept-encoding': 'identity', ...headers },
        redirect: 'follow',
        signal: bounded(),
      })
      const length = Number(head.headers.get('content-length'))
      if (head.ok && Number.isFinite(length) && length >= 0) total = length
      const headDisposition = filenameFromDisposition(head.headers.get('content-disposition'))
      if (!dispositionName && headDisposition) {
        return { supportsRange, total, etag, lastModified, filename: headDisposition }
      }
    } catch {}
  }

  return { supportsRange, total, etag, lastModified, filename: dispositionName }
}

/**
 * 下载引擎。
 *
 * 一个实例管理一批任务：入队、并发上限、暂停/恢复/取消、持久化、自动续传。
 * 所有对外方法都是 async 且幂等安全的（重复调用不会破坏状态）。
 */
export class DownloadEngine {
  constructor(options = {}) {
    this.dir = path.resolve(options.dir ?? path.join(os.homedir(), 'Downloads'))
    this.stateDir = path.resolve(
      options.stateDir ?? path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'chunk-download'),
    )
    this.connections = clampInt(options.connections ?? 8, 1, 64)
    this.maxConcurrentTasks = clampInt(options.maxConcurrentTasks ?? 2, 1, 16)
    this.speedLimit = Math.max(0, Number(options.speedLimit) || 0)
    this.retries = clampInt(options.retries ?? 4, 0, 10)
    this.requestTimeoutMs = clampInt(options.requestTimeoutMs ?? 20000, 3000, 180000)
    this.stallTimeoutMs = clampInt(options.stallTimeoutMs ?? 30000, 5000, 300000)
    this.exportToPhone = options.exportToPhone === true
    this.bridgeUrl = options.bridgeUrl ?? 'http://127.0.0.1:3090'
    this.bridgeTokenFile = options.bridgeTokenFile ?? '/root/.dsh/.bridge_token'
    this.autoResume = options.autoResume !== false
    this.log = typeof options.log === 'function' ? options.log : () => {}

    /** @type {Map<string, any>} */
    this.tasks = new Map()
    /** @type {Map<string, { controller: AbortController, promise: Promise<void> }>} */
    this.runs = new Map()
    /** @type {Map<string, SpeedMeter>} */
    this.meters = new Map()
    /** @type {Map<string, NodeJS.Timeout>} */
    this.persistTimers = new Map()
    this.limiter = new RateLimiter(this.speedLimit)
    this.startPromise = null
    this.started = false
  }

  /** 初始化：建目录、加载任务、把上次中断的任务重新排队。 */
  async start() {
    if (!this.startPromise) this.startPromise = this.#doStart()
    return this.startPromise
  }

  async #doStart() {
    await fsp.mkdir(path.join(this.stateDir, 'tasks'), { recursive: true })
    await fsp.mkdir(this.dir, { recursive: true })

    let files = []
    try {
      files = await fsp.readdir(path.join(this.stateDir, 'tasks'))
    } catch {
      files = []
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(this.stateDir, 'tasks', file), 'utf8'))
        if (!raw || typeof raw.id !== 'string') continue
        await this.#hydrate(raw)
      } catch (error) {
        this.log('warn', `读取任务状态 ${file} 失败，已跳过：${describeError(error)}`)
      }
    }

    for (const task of this.tasks.values()) {
      if (task.status === TASK_STATUS.DOWNLOADING || task.status === TASK_STATUS.QUEUED) {
        task.status = this.autoResume ? TASK_STATUS.QUEUED : TASK_STATUS.PAUSED
        void this.#persistNow(task)
      }
    }
    this.started = true
    this.log('info', `分片下载引擎就绪：${this.tasks.size} 个历史任务，下载目录 ${this.dir}`)
    this.#pump()
  }

  async #hydrate(raw) {
    const task = {
      id: raw.id,
      url: raw.url,
      headers: raw.headers ?? {},
      dir: raw.dir ?? this.dir,
      filename: raw.filename,
      targetPath: raw.targetPath,
      partPath: raw.partPath ?? `${raw.targetPath}.part`,
      status: raw.status ?? TASK_STATUS.QUEUED,
      mode: raw.mode ?? 'chunked',
      total: Number(raw.total) || 0,
      chunkCount: Number(raw.chunkCount) || 0,
      chunkSize: Number(raw.chunkSize) || 0,
      planSig: raw.planSig ?? '',
      chunksDone: Array.isArray(raw.chunksDone) ? raw.chunksDone.filter(Number.isInteger) : [],
      completedBytes: Number(raw.completedBytes) || 0,
      downloaded: Number(raw.downloaded) || 0,
      connections: clampInt(raw.connections ?? this.connections, 1, 64),
      speedLimit: Math.max(0, Number(raw.speedLimit) || 0),
      export: raw.export === true,
      exportedPath: raw.exportedPath ?? null,
      exportError: raw.exportError ?? null,
      etag: raw.etag ?? null,
      lastModified: raw.lastModified ?? null,
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
      finishedAt: raw.finishedAt ?? null,
      error: raw.error ?? null,
    }
    task._desired = null
    task._cancelDeleteFile = true

    // .part 不见了说明临时数据被清理过：已完成位图不可再信，从头下
    if (task.status !== TASK_STATUS.COMPLETED) {
      let exists = false
      try {
        await fsp.access(task.partPath)
        exists = true
      } catch {
        exists = false
      }
      if (!exists && (task.chunksDone.length > 0 || task.downloaded > 0)) {
        task.chunksDone = []
        task.completedBytes = 0
        task.downloaded = 0
      }
    }
    this.tasks.set(task.id, task)
  }

  // ---------------------------------------------------------------- 对外操作

  /**
   * 新增任务（会先探测直链拿大小/文件名，再入队）。
   * @returns 任务快照（含 reused 标记）
   */
  async addTask(input = {}) {
    await this.start()
    const url = String(input.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 直链')

    const headers = normalizeHeaders(input.headers)
    const connections = clampInt(input.connections ?? this.connections, 1, 64)
    const dir = path.resolve(String(input.dir ?? '').trim() || this.dir)
    const probe = await probeResource(url, headers, { timeoutMs: this.requestTimeoutMs })

    const filename = sanitizeFilename(
      String(input.filename ?? '').trim() || probe.filename || filenameFromUrl(url),
      `download-${Date.now()}.bin`,
    )
    const targetPath = path.join(dir, filename)
    const partPath = `${targetPath}.part`

    const existing = [...this.tasks.values()].find(
      (task) => task.url === url && task.targetPath === targetPath && task.status !== TASK_STATUS.CANCELED,
    )
    if (existing && input.force !== true) {
      const snapshot = this.snapshot(existing)
      snapshot.reused = true
      return snapshot
    }

    const speedLimit = Math.max(0, Number(input.speedLimit) || 0)
    const task = {
      id: `dl_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
      url,
      headers,
      dir,
      filename,
      targetPath,
      partPath,
      status: TASK_STATUS.QUEUED,
      mode: probe.supportsRange && (probe.total ?? 0) >= MIN_CHUNK_BYTES ? 'chunked' : 'single',
      total: probe.total ?? 0,
      chunkCount: 0,
      chunkSize: 0,
      planSig: '',
      chunksDone: [],
      completedBytes: 0,
      downloaded: 0,
      connections,
      speedLimit,
      export: input.export === true || this.exportToPhone,
      exportedPath: null,
      exportError: null,
      etag: probe.etag,
      lastModified: probe.lastModified,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: null,
      error: null,
      _desired: null,
      _cancelDeleteFile: true,
    }

    await fsp.mkdir(dir, { recursive: true })
    this.tasks.set(task.id, task)
    void this.#persistNow(task)
    this.log(
      'info',
      `新任务 ${task.id}：${task.mode === 'chunked' ? `${planChunkCount(task.total, connections)} 片 × ${connections} 连接` : '单流'}，`
      + `大小 ${task.total || '未知'}，目标 ${targetPath}`,
    )
    this.#pump()
    return this.snapshot(task)
  }

  /** 暂停：运行中则中止当前请求，状态落盘为 paused。 */
  async pause(id) {
    const task = this.#requireTask(id)
    if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.CANCELED) return this.snapshot(task)
    task._desired = 'pause'
    if (task.status === TASK_STATUS.QUEUED) {
      task.status = TASK_STATUS.PAUSED
      await this.#persistNow(task)
      return this.snapshot(task)
    }
    const run = this.runs.get(id)
    if (run) {
      try {
        run.controller.abort()
      } catch {}
      await Promise.race([run.promise.catch(() => {}), sleep(5000).catch(() => {})])
    }
    return this.snapshot(task)
  }

  /** 恢复：重新排队，由调度器按并发上限拉起。 */
  async resume(id) {
    const task = this.#requireTask(id)
    if (task.status === TASK_STATUS.COMPLETED || task.status === TASK_STATUS.DOWNLOADING) return this.snapshot(task)
    task._desired = null
    task.error = null
    task.status = TASK_STATUS.QUEUED
    await this.#persistNow(task)
    this.#pump()
    return this.snapshot(task)
  }

  /** 取消：中止并删除 .part（已完成的最终文件可选删除）。 */
  async cancel(id, { deleteFile = true } = {}) {
    const task = this.#requireTask(id)
    if (task.status === TASK_STATUS.CANCELED) return this.snapshot(task)
    task._desired = 'cancel'
    task._cancelDeleteFile = deleteFile
    const run = this.runs.get(id)
    if (run) {
      try {
        run.controller.abort()
      } catch {}
      await Promise.race([run.promise.catch(() => {}), sleep(5000).catch(() => {})])
    }
    task.status = TASK_STATUS.CANCELED
    task.finishedAt = task.finishedAt ?? Date.now()
    if (deleteFile) {
      await this.#deletePart(task)
      if (task.status === TASK_STATUS.COMPLETED) await fsp.rm(task.targetPath, { force: true }).catch(() => {})
    }
    await this.#persistNow(task)
    return this.snapshot(task)
  }

  /** 删除任务记录（默认连本地文件一起删）。 */
  async remove(id, { deleteFile = true } = {}) {
    const task = this.#requireTask(id)
    if (task.status === TASK_STATUS.DOWNLOADING || task.status === TASK_STATUS.QUEUED) {
      await this.cancel(id, { deleteFile: false })
    }
    this.tasks.delete(id)
    this.meters.delete(id)
    const stateFile = path.join(this.stateDir, 'tasks', `${id}.json`)
    await fsp.rm(stateFile, { force: true }).catch(() => {})
    await fsp.rm(`${stateFile}.tmp`, { force: true }).catch(() => {})
    if (deleteFile) {
      await this.#deletePart(task)
      if (task.status === TASK_STATUS.COMPLETED) await fsp.rm(task.targetPath, { force: true }).catch(() => {})
    }
    return { id, removed: true, deleteFile }
  }

  /** 手动把已完成任务导出到手机 Download/DeepSeekHarness。 */
  async exportToDevice(id) {
    const task = this.#requireTask(id)
    await this.#maybeExport(task, { force: true })
    return this.snapshot(task)
  }

  get(id) {
    return this.tasks.get(id) ?? null
  }

  /** 单任务快照。 */
  snapshot(task) {
    const meter = this.meters.get(task.id)
    const downloaded = task.downloaded
    const total = task.total
    const speed = task.status === TASK_STATUS.DOWNLOADING ? (meter?.speed() ?? 0) : 0
    const remaining = total > 0 ? Math.max(0, total - downloaded) : 0
    const eta = speed > 0 && remaining > 0 ? remaining / speed : null
    return {
      id: task.id,
      status: task.status,
      url: task.url,
      filename: task.filename,
      dir: task.dir,
      path: task.targetPath,
      total,
      downloaded,
      progress: total > 0 ? Math.min(1, downloaded / total) : null,
      speed,
      etaSeconds: eta,
      mode: task.mode,
      chunkCount: task.chunkCount,
      completedChunks: task.chunksDone.length,
      chunkSize: task.chunkSize,
      connections: task.connections,
      error: task.error,
      exportedPath: task.exportedPath,
      exportError: task.exportError ?? null,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      reused: false,
    }
  }

  /** 任务列表 + 汇总。 */
  list({ limit = 20 } = {}) {
    const tasks = [...this.tasks.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    const summary = {
      total: tasks.length,
      queued: 0,
      downloading: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      activeSpeed: 0,
    }
    for (const task of tasks) {
      summary[task.status] = (summary[task.status] ?? 0) + 1
      if (task.status === TASK_STATUS.DOWNLOADING) summary.activeSpeed += this.meters.get(task.id)?.speed() ?? 0
    }
    const slice = typeof limit === 'number' && limit > 0 ? tasks.slice(0, limit) : tasks
    return { tasks: slice.map((task) => this.snapshot(task)), summary }
  }

  /** 等待任务进入终态（完成/失败/取消）或超时。 */
  async waitFor(id, { timeoutMs = 60000 } = {}) {
    const task = this.#requireTask(id)
    const deadline = Date.now() + Math.max(1000, timeoutMs)
    const terminal = new Set([TASK_STATUS.COMPLETED, TASK_STATUS.FAILED, TASK_STATUS.CANCELED])
    while (!terminal.has(task.status)) {
      if (Date.now() >= deadline) return { timedOut: true, task: this.snapshot(task) }
      await new Promise((resolve) => {
        setTimeout(resolve, 250)
      })
    }
    return { timedOut: false, task: this.snapshot(task) }
  }

  /** 停机：中止全部运行中的任务并落盘。 */
  async shutdown() {
    const runs = [...this.runs.values()]
    for (const run of runs) {
      try {
        const task = [...this.tasks.values()].find((t) => t.id === run.id)
        if (task) task._desired = 'pause'
        run.controller.abort()
      } catch {}
    }
    await Promise.allSettled(runs.map((run) => run.promise))
    for (const [id, timer] of this.persistTimers) {
      clearTimeout(timer)
      this.persistTimers.delete(id)
      const task = this.tasks.get(id)
      if (task) await this.#persistNow(task)
    }
    this.started = false
  }

  // ---------------------------------------------------------------- 调度与执行

  #requireTask(id) {
    const task = this.tasks.get(String(id))
    if (!task) throw new Error(`没有这个任务：${id}`)
    return task
  }

  /** 按并发上限拉起排队任务（FIFO）。 */
  #pump() {
    if (!this.started) return
    while (this.runs.size < this.maxConcurrentTasks) {
      const next = [...this.tasks.values()]
        .filter((task) => task.status === TASK_STATUS.QUEUED)
        .sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!next) return
      this.#startTask(next)
    }
  }

  #startTask(task) {
    const controller = new AbortController()
    task.status = TASK_STATUS.DOWNLOADING
    task.error = null
    task._desired = null
    this.meters.set(task.id, new SpeedMeter())
    void this.#persistNow(task)

    const promise = this.#run(task, controller)
      .then(
        () => undefined,
        (error) => this.#settle(task, error),
      )
      .finally(() => {
        this.runs.delete(task.id)
        this.meters.delete(task.id)
        this.#pump()
      })
    this.runs.set(task.id, { controller, promise, id: task.id })
  }

  async #settle(task, error) {
    if (error instanceof AbortedTaskError || error?.name === 'AbortError') {
      if (task._desired === 'cancel') {
        task.status = TASK_STATUS.CANCELED
        if (task._cancelDeleteFile) await this.#deletePart(task)
      } else {
        task.status = TASK_STATUS.PAUSED
      }
    } else if (task.status !== TASK_STATUS.COMPLETED) {
      task.status = TASK_STATUS.FAILED
      task.error = describeError(error)
      this.log('warn', `任务 ${task.id} 失败：${task.error}`)
    }
    task.finishedAt = task.status === TASK_STATUS.COMPLETED ? task.finishedAt : Date.now()
    await this.#persistNow(task)
  }

  async #run(task, controller) {
    const signal = controller.signal
    const canChunk = task.mode !== 'single' && task.total > 0 && task.total >= MIN_CHUNK_BYTES
    try {
      if (!canChunk) return await this.#runSingle(task, signal)
      try {
        return await this.#runChunked(task, signal)
      } catch (error) {
        if (error instanceof RangeUnsupportedError) {
          this.log('warn', `任务 ${task.id} 服务端忽略 Range，回退单流下载：${error.message}`)
          task.mode = 'single'
          task.chunksDone = []
          task.completedBytes = 0
          task.downloaded = 0
          return await this.#runSingle(task, signal)
        }
        throw error
      }
    } finally {
      if (signal.aborted && task._desired !== 'cancel') task._desired = task._desired ?? 'pause'
    }
  }

  async #runChunked(task, signal) {
    const total = task.total
    const connections = clampInt(task.connections, 1, 64)
    const chunkCount = planChunkCount(total, connections)
    const chunkSize = Math.ceil(total / chunkCount)
    const planSig = `${total}:${chunkSize}:${chunkCount}`

    if (task.planSig && task.planSig !== planSig) {
      this.log('warn', `任务 ${task.id} 分片计划变化（${task.planSig} → ${planSig}），旧分片作废重下`)
      task.chunksDone = []
    }
    task.planSig = planSig
    task.chunkCount = chunkCount
    task.chunkSize = chunkSize
    task.mode = 'chunked'

    const done = new Set(task.chunksDone.filter((index) => index >= 0 && index < chunkCount))
    task.completedBytes = countDoneBytes(done, chunkSize, total)
    task.downloaded = task.completedBytes

    const handle = await this.#openPart(task, total)
    try {
      const pending = []
      for (let index = 0; index < chunkCount; index += 1) if (!done.has(index)) pending.push(index)
      const cursor = { index: 0 }
      const workerCount = Math.max(1, Math.min(connections, Math.max(1, pending.length)))
      const limiter = task.speedLimit > 0 ? new RateLimiter(task.speedLimit) : null
      const workers = []
      for (let worker = 0; worker < workerCount; worker += 1) {
        workers.push(this.#worker(task, signal, handle, pending, cursor, done, limiter))
      }
      await Promise.all(workers)
      if (signal.aborted) throw new AbortedTaskError()

      await handle.truncate(total)
      await handle.datasync().catch(() => {})
      await handle.close()
      await this.#renameIntoPlace(task)
      await this.#finish(task, total)
    } finally {
      await handle.close().catch(() => {})
    }
  }

  async #worker(task, signal, handle, pending, cursor, done, limiter) {
    for (;;) {
      if (signal.aborted) throw new AbortedTaskError()
      const index = pending[cursor.index]
      if (index === undefined) return
      cursor.index += 1
      const start = index * task.chunkSize
      const end = Math.min(start + task.chunkSize, task.total) - 1
      await this.#downloadChunk(task, signal, handle, index, start, end, limiter)
      done.add(index)
      task.chunksDone = [...done].sort((a, b) => a - b)
      task.completedBytes += end - start + 1
      void this.#persistSoon(task)
    }
  }

  async #downloadChunk(task, signal, handle, index, start, end, limiter) {
    let lastError = null
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (signal.aborted) throw new AbortedTaskError()
      let written = 0
      try {
        await this.#fetchRange(task, signal, handle, start, end, limiter, (bytes) => {
          written += bytes
          task.downloaded += bytes
          this.meters.get(task.id)?.add(task.downloaded)
          this.#persistSoon(task)
        })
        return
      } catch (error) {
        task.downloaded -= written
        if (signal.aborted) throw new AbortedTaskError()
        if (error instanceof RangeUnsupportedError) throw error
        lastError = error
        if (attempt >= this.retries) break
        const backoff = Math.min(8000, 300 * 2 ** attempt)
        this.log('warn', `任务 ${task.id} 分片 ${index} 第 ${attempt + 1} 次失败：${describeError(error)}；${backoff}ms 后重试`)
        await sleep(backoff, signal)
      }
    }
    throw lastError ?? new Error(`分片 ${index} 下载失败`)
  }

  /** 单分片一次 Range 请求：严格校验 Content-Range 与实收字节数。 */
  async #fetchRange(task, parentSignal, handle, start, end, limiter, onBytes) {
    const stall = makeStallGuard(parentSignal, this.stallTimeoutMs)
    let response
    try {
      response = await fetch(task.url, {
        headers: { 'accept-encoding': 'identity', ...task.headers, range: `bytes=${start}-${end}` },
        redirect: 'follow',
        signal: stall.signal,
      })
    } catch (error) {
      stall.dispose()
      if (parentSignal.aborted) throw new AbortedTaskError()
      throw new Error(`请求失败：${describeError(error)}`)
    }

    try {
      if (response.status === 200) {
        await response.body?.cancel().catch(() => {})
        throw new RangeUnsupportedError('服务端返回 200（忽略 Range），拒绝按分片写入')
      }
      if (response.headers.get('content-encoding')) {
        await response.body?.cancel().catch(() => {})
        throw new RangeUnsupportedError(`响应被压缩（${response.headers.get('content-encoding')}），无法按字节偏移写分片`)
      }
      if (response.status !== 206) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`HTTP ${response.status}`)
      }
      const range = parseContentRange(response.headers.get('content-range'))
      if (!range || range.start !== start || range.end !== end) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`Content-Range 与请求不一致：${response.headers.get('content-range') ?? '缺失'}`)
      }
      if (range.total !== null && task.total > 0 && range.total !== task.total) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`文件大小变化（${task.total} → ${range.total}），请重下`)
      }
      if (!response.body) throw new Error('响应没有 body')

      const reader = response.body.getReader()
      let position = start
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (parentSignal.aborted) {
          await reader.cancel().catch(() => {})
          throw new AbortedTaskError()
        }
        if (!value || value.byteLength === 0) continue
        stall.touch()
        if (limiter) await limiter.take(value.byteLength)
        if (this.speedLimit > 0) await this.limiter.take(value.byteLength)
        const { bytesWritten } = await handle.write(value, 0, value.byteLength, position)
        position += bytesWritten
        received += bytesWritten
        onBytes(bytesWritten)
      }
      const expected = end - start + 1
      if (received !== expected) throw new Error(`分片长度不符：期望 ${expected}，实收 ${received}`)
    } finally {
      stall.dispose()
    }
  }

  /** 单流下载（服务端不支持 Range，或文件小于单片下限）。 */
  async #runSingle(task, signal) {
    task.mode = 'single'
    task.chunksDone = []
    task.completedBytes = 0
    task.downloaded = 0

    const stall = makeStallGuard(signal, this.stallTimeoutMs)
    const limiter = task.speedLimit > 0 ? new RateLimiter(task.speedLimit) : null
    let handle = null
    try {
      const response = await fetch(task.url, {
        headers: { 'accept-encoding': 'identity', ...task.headers },
        redirect: 'follow',
        signal: stall.signal,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`HTTP ${response.status}`)
      }
      // 被压缩时 content-length 是压缩后的长度，不能拿它当文件总长；此时按实收字节计
      const compressed = response.headers.get('content-encoding') !== null
      const length = Number(response.headers.get('content-length'))
      if (!compressed && Number.isFinite(length) && length > 0) task.total = length
      if (!response.body) throw new Error('响应没有 body')

      await fsp.mkdir(path.dirname(task.partPath), { recursive: true })
      handle = await fsp.open(task.partPath, 'w+')
      const reader = response.body.getReader()
      let position = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (signal.aborted) {
          await reader.cancel().catch(() => {})
          throw new AbortedTaskError()
        }
        if (!value || value.byteLength === 0) continue
        stall.touch()
        if (limiter) await limiter.take(value.byteLength)
        if (this.speedLimit > 0) await this.limiter.take(value.byteLength)
        const { bytesWritten } = await handle.write(value, 0, value.byteLength, position)
        position += bytesWritten
        task.downloaded = position
        this.meters.get(task.id)?.add(position)
        this.#persistSoon(task)
      }
      if (!compressed && task.total > 0 && position !== task.total) {
        throw new Error(`下载不完整：期望 ${task.total}，实收 ${position}`)
      }
      if (task.total <= 0) task.total = position
      await handle.datasync().catch(() => {})
      await handle.close()
      handle = null
      await this.#renameIntoPlace(task)
      await this.#finish(task, position)
    } finally {
      stall.dispose()
      if (handle) await handle.close().catch(() => {})
    }
  }

  async #renameIntoPlace(task) {
    await fsp.mkdir(path.dirname(task.targetPath), { recursive: true })
    // POSIX 的 rename 会覆盖已存在文件，Windows 不会（EEXIST/EPERM）→ 先删目标
    if (process.platform === 'win32') {
      await fsp.rm(task.targetPath, { force: true }).catch(() => {})
    }
    await fsp.rename(task.partPath, task.targetPath)
  }

  async #finish(task, finalBytes) {
    if (finalBytes > 0) task.downloaded = finalBytes
    if (task.total > 0) task.downloaded = task.total
    task.error = null
    // 先送手机再标记完成：否则等待方拿到的快照里 exportedPath 可能还是空的
    await this.#maybeExport(task, { force: false })
    task.status = TASK_STATUS.COMPLETED
    task.finishedAt = Date.now()
    task.updatedAt = Date.now()
    await this.#persistNow(task)
    this.log('info', `任务 ${task.id} 完成：${task.targetPath}（${task.downloaded} 字节）`)
  }

  async #openPart(task, total) {
    await fsp.mkdir(path.dirname(task.partPath), { recursive: true })
    let handle
    try {
      handle = await fsp.open(task.partPath, 'r+')
    } catch {
      handle = await fsp.open(task.partPath, 'w+')
    }
    const stat = await handle.stat()
    if (total > 0 && stat.size !== total) await handle.truncate(total)
    return handle
  }

  async #deletePart(task) {
    await fsp.rm(task.partPath, { force: true }).catch(() => {})
  }

  /** 导出到手机：走 DEEPSEEK_HARNESS 3090 桥的 /app/export（落 Download/DeepSeekHarness）。 */
  async #maybeExport(task, { force = false } = {}) {
    if (!task.export && !force) return
    if (task.exportedPath && !force) return
    try {
      // 桌面端没有 DEEPSEEK_HARNESS 设备桥（3090）：跳过导出，下载本身不受影响
      let token = ''
      try {
        token = (await fsp.readFile(this.bridgeTokenFile, 'utf8')).trim()
      } catch {
        token = ''
      }
      if (!token) {
        task.exportedPath = null
        task.exportError = `当前环境没有 DSH 设备桥（${this.bridgeTokenFile} 不存在），已跳过导出；文件已保存在本地`
        this.log('info', `任务 ${task.id} 跳过导出：${task.exportError}`)
        return
      }
      const url = `${this.bridgeUrl}/app/export?path=${encodeURIComponent(task.targetPath)}&token=${encodeURIComponent(token)}`
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
      const text = await response.text()
      let result = text
      try {
        const parsed = JSON.parse(text)
        result = parsed?.result ?? text
      } catch {}
      if (!response.ok) throw new Error(`HTTP ${response.status}：${String(result).slice(0, 200)}`)
      task.exportedPath = String(result ?? '').trim() || 'OK'
      task.exportError = null
      await this.#persistNow(task)
      this.log('info', `任务 ${task.id} 已导出到手机：${task.exportedPath}`)
    } catch (error) {
      task.exportedPath = null
      task.exportError = describeError(error)
      this.log('warn', `任务 ${task.id} 导出到手机失败：${task.exportError}`)
    }
  }

  // ---------------------------------------------------------------- 持久化

  #serialize(task) {
    return {
      id: task.id,
      url: task.url,
      headers: task.headers,
      dir: task.dir,
      filename: task.filename,
      targetPath: task.targetPath,
      partPath: task.partPath,
      status: task.status,
      mode: task.mode,
      total: task.total,
      chunkCount: task.chunkCount,
      chunkSize: task.chunkSize,
      planSig: task.planSig,
      chunksDone: task.chunksDone,
      completedBytes: task.completedBytes,
      downloaded: task.downloaded,
      connections: task.connections,
      speedLimit: task.speedLimit,
      export: task.export,
      exportedPath: task.exportedPath,
      exportError: task.exportError ?? null,
      etag: task.etag,
      lastModified: task.lastModified,
      createdAt: task.createdAt,
      updatedAt: Date.now(),
      finishedAt: task.finishedAt,
      error: task.error,
    }
  }

  #stateFile(task) {
    return path.join(this.stateDir, 'tasks', `${task.id}.json`)
  }

  #persistSoon(task) {
    if (this.persistTimers.has(task.id)) return
    const timer = setTimeout(() => {
      this.persistTimers.delete(task.id)
      void this.#persistNow(task)
    }, PROGRESS_PERSIST_MS)
    timer.unref?.()
    this.persistTimers.set(task.id, timer)
  }

  async #persistNow(task) {
    const file = this.#stateFile(task)
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true })
      await fsp.writeFile(tmp, JSON.stringify(this.#serialize(task), null, 2))
      await fsp.rename(tmp, file)
    } catch (error) {
      this.log('warn', `写任务状态失败（${task.id}）：${describeError(error)}`)
    }
  }
}
