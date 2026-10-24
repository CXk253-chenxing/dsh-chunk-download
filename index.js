/**
 * chunk-download —— DEEPSEEK_HARNESS 分片下载插件（宿主侧）。
 *
 * 目标：给 agent 一条"高速下载通道"。agent 要下安装包 / 模型 / 视频 / 网盘直链时，
 * 调 chunk_download 走 Range 分片并发（8~32 连接），比 curl/wget 单连接快数倍，
 * 并支持断点续传、暂停/恢复、全局限速、完成后一键送进手机 Download。
 *
 * 下载内核见 lib/engine.js（参照 YunX 云析的 Range 分片引擎实现）。
 *
 * 注册的工具：
 *   chunk_download          新建任务（可阻塞等待完成）
 *   chunk_download_status   查进度 / 看队列
 *   chunk_download_control  暂停 / 恢复 / 取消 / 删除 / 导出到手机
 *   chunk_download_wait     阻塞等某个任务结束
 */

import os from 'node:os'
import path from 'node:path'
import { DownloadEngine } from './lib/engine.js'
import { formatTaskBlock, formatTaskList, formatSpeed } from './lib/format.js'

export const name = 'chunk-download'

/** 下载工具依赖工具注册表；可选依赖系统提示词（有就注入一段"优先用本插件"的说明）。 */
export const inject = ['tools']

const PROMPT_TEXT = [
  '## 下载文件：优先用 chunk_download 分片下载插件',
  '需要把 http(s) 直链（安装包 / 模型 / 视频 / 网盘直链 / 数据集）下到本地时，优先调用 `chunk_download`：',
  '它用 Range 分片 + 多连接并发 + 断点续传，比 `curl`/`wget` 单连接快数倍；不要用 bash 里的 curl 硬下大文件，',
  '`web_fetch` 只用于读网页/API 文本，不能下二进制。',
  '- 新建：`chunk_download {url, dir?, filename?, headers?, connections?, speedLimit?, export?, waitMs?}`',
  '- 跟进：`chunk_download_status {id?}` 看进度/速度/队列；`chunk_download_wait {id, timeoutMs}` 阻塞等完成',
  '- 干预：`chunk_download_control {id, action: pause|resume|cancel|retry|remove|export}`',
  '- 需要让用户在手机「Download/DeepSeekHarness」里看到文件：建任务时给 `export: true`，或完成后 control 里 `action: export`',
].join('\n')

const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    const text = value?.text
    if (typeof text === 'string' && text.length > 0) return [{ type: 'text', text }]
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  },
}

function resolveOptions(config = {}) {
  const pick = (key, fallback) => (config[key] === undefined ? fallback : config[key])
  const positive = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
  }
  return {
    dir: typeof config.dir === 'string' && config.dir.trim() ? config.dir.trim() : path.join(os.homedir(), 'Downloads'),
    stateDir: typeof config.stateDir === 'string' && config.stateDir.trim() ? config.stateDir.trim() : undefined,
    connections: positive(pick('connections', 8), 8),
    maxConcurrentTasks: positive(pick('maxConcurrentTasks', 2), 2),
    speedLimit: Math.max(0, Number(pick('speedLimit', 0)) || 0),
    retries: Number.isFinite(Number(pick('retries', 4))) ? Math.max(0, Math.trunc(Number(pick('retries', 4)))) : 4,
    requestTimeoutMs: positive(pick('requestTimeoutMs', 20000), 20000),
    stallTimeoutMs: positive(pick('stallTimeoutMs', 30000), 30000),
    exportToPhone: pick('exportToPhone', false) === true,
    autoResume: pick('autoResume', true) !== false,
    bridgeUrl: typeof config.bridgeUrl === 'string' ? config.bridgeUrl : 'http://127.0.0.1:3090',
    bridgeTokenFile: typeof config.bridgeTokenFile === 'string' ? config.bridgeTokenFile : '/root/.dsh/.bridge_token',
  }
}

export function apply(ctx, config = {}) {
  const options = resolveOptions(config)
  const logger = ctx.logger
  const log = (level, message) => {
    try {
      if (level === 'warn') logger?.warn?.(`chunk-download: ${message}`)
      else logger?.info?.(`chunk-download: ${message}`)
    } catch {}
  }

  const engine = new DownloadEngine({ ...options, log })
  const ready = engine.start().catch((error) => {
    log('warn', `引擎启动失败：${error?.message ?? error}`)
    throw error
  })
  ready.catch(() => {})

  // 插件卸载 / HMR 时收尾：中止运行中的任务并把进度落盘
  ctx.effect(() => () => {
    void engine.shutdown()
  })

  // 有 systemPrompt 服务就注入一段"下载优先用本插件"的说明（短，省上下文）
  if (config.promptSection !== false) {
    ctx.inject?.(['systemPrompt'], (inner) => {
      try {
        inner.effect(() =>
          inner.systemPrompt.section({ name: 'chunk-download:prefer', order: 60, text: PROMPT_TEXT }),
        )
      } catch (error) {
        log('warn', `注入系统提示词失败：${error?.message ?? error}`)
      }
    })
  }

  ctx.tools.register({
    name: 'chunk_download',
    description: [
      '用 Range 分片并发把 http(s) 直链高速下载到本地（多连接 + 断点续传 + 限速）。',
      '下载大文件（安装包 / 模型 / 视频 / 网盘直链，>5MB）时优先用本工具，比 curl 单连接快数倍。',
      '立即返回任务信息；需要等它下完就传 waitMs（如 60000），或之后用 chunk_download_wait。',
      '同一 URL + 同一目标文件已存在任务时直接复用该任务并返回 reused=true（传 force=true 强制新建）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https 直链（必填）' },
        dir: { type: 'string', description: '保存目录（绝对路径，可省略，默认 ~/Downloads）' },
        filename: { type: 'string', description: '文件名（可省略：优先 Content-Disposition，其次 URL 末段）' },
        headers: {
          type: 'object',
          additionalProperties: true,
          description: '额外请求头对象，如 {"referer":"https://...","cookie":"..."}（部分网盘直链必须带 Referer/Cookie，否则 403）',
        },
        connections: { type: 'integer', description: '并发连接数 1~64，默认 8；CDN 限 IP 连接数时调低' },
        speedLimit: { type: 'integer', description: '本任务限速（字节/秒），0/省略为不限速' },
        export: { type: 'boolean', description: 'true = 完成后自动送进手机 Download/DeepSeekHarness' },
        waitMs: { type: 'integer', description: '>0 时阻塞等待任务结束（毫秒，建议 ≤120000），默认 0 立即返回' },
        force: { type: 'boolean', description: 'true = 即使已有同目标任务也新建一个' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args = {}) {
      await ready
      const snapshot = await engine.addTask({
        url: args.url,
        dir: args.dir,
        filename: args.filename,
        headers: args.headers,
        connections: args.connections,
        speedLimit: args.speedLimit,
        export: args.export === true,
        force: args.force === true,
      })

      const waitMs = Number(args.waitMs) || 0
      if (waitMs > 0 && snapshot.status !== 'completed') {
        const result = await engine.waitFor(snapshot.id, { timeoutMs: Math.min(600000, waitMs) })
        const task = result.task
        return {
          ok: task.status === 'completed',
          timedOut: result.timedOut,
          task,
          text: `${result.timedOut ? '等待超时，任务仍在后台继续。\n' : ''}${formatTaskBlock(task)}`,
        }
      }
      return {
        ok: true,
        task: snapshot,
        text: `${snapshot.reused ? '已复用同一直链的现有任务。\n' : ''}${formatTaskBlock(snapshot)}\n\n进度可用 chunk_download_status 查看，完成后可用 chunk_download_control {action:"export"} 送进手机。`,
      }
    },
    presentCall(args) {
      return { card: 'generic', title: `分片下载 ${args?.url ?? ''}`, kind: 'fetch' }
    },
  })

  ctx.tools.register({
    name: 'chunk_download_status',
    description: '查看分片下载任务的进度 / 速度 / 剩余时间 / 队列；给 id 看单个详情，不给则看全部任务汇总。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id（如 dl_xxx），省略则列出全部任务' },
        limit: { type: 'integer', description: '列表最多显示多少条，默认 20' },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args = {}) {
      await ready
      if (args.id) {
        const task = engine.get(String(args.id))
        if (!task) throw new Error(`没有这个任务：${args.id}`)
        const snapshot = engine.snapshot(task)
        return { ok: true, task: snapshot, text: formatTaskBlock(snapshot) }
      }
      const limit = Number(args.limit) > 0 ? Math.min(200, Math.trunc(Number(args.limit))) : 20
      const { tasks, summary } = engine.list({ limit })
      return {
        ok: true,
        tasks,
        summary,
        text: formatTaskList(tasks, { summary }),
      }
    },
  })

  ctx.tools.register({
    name: 'chunk_download_control',
    description: [
      '控制分片下载任务：pause 暂停 / resume 恢复 / cancel 取消并删 .part / retry 重试失败任务 / remove 删除任务记录 / export 把已完成文件送进手机 Download/DeepSeekHarness。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        action: { type: 'string', enum: ['pause', 'resume', 'retry', 'cancel', 'remove', 'export'], description: '要执行的动作' },
        deleteFile: { type: 'boolean', description: 'cancel/remove 时是否连本地文件一起删，默认 true' },
      },
      required: ['id', 'action'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args = {}) {
      await ready
      const id = String(args.id ?? '')
      const action = String(args.action ?? '')
      const deleteFile = args.deleteFile !== false
      let payload
      switch (action) {
        case 'pause':
          payload = { ok: true, task: await engine.pause(id) }
          break
        case 'resume':
        case 'retry':
          payload = { ok: true, task: await engine.resume(id) }
          break
        case 'cancel':
          payload = { ok: true, task: await engine.cancel(id, { deleteFile }) }
          break
        case 'remove':
          payload = { ok: true, removed: await engine.remove(id, { deleteFile }) }
          break
        case 'export':
          payload = { ok: true, task: await engine.exportToDevice(id) }
          break
        default:
          throw new Error(`不认识的动作：${action}（可用 pause/resume/retry/cancel/remove/export）`)
      }
      const task = payload.task
      return {
        ...payload,
        text: task ? formatTaskBlock(task) : `已删除任务 ${id}`,
      }
    },
  })

  ctx.tools.register({
    name: 'chunk_download_wait',
    description: '阻塞等待某个下载任务进入终态（完成/失败/取消），或超时返回；用于"下完再继续"的流程。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id' },
        timeoutMs: { type: 'integer', description: '最长等待毫秒数，默认 60000，上限 600000' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args = {}) {
      await ready
      const timeout = Math.min(600000, Math.max(1000, Number(args.timeoutMs) || 60000))
      const result = await engine.waitFor(String(args.id ?? ''), { timeoutMs: timeout })
      const task = result.task
      const head = result.timedOut ? `等待超时（${timeout}ms），任务仍在后台。` : '任务已结束。'
      return {
        ok: task.status === 'completed',
        timedOut: result.timedOut,
        task,
        text: `${head}\n${formatTaskBlock(task)}`,
      }
    },
  })

  log('info', `插件已加载：默认 ${options.connections} 连接，下载目录 ${options.dir}，限速 ${options.speedLimit ? formatSpeed(options.speedLimit) : '不限'}`)
}
