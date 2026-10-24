/**
 * chunk-download —— DEEPSEEK_HARNESS 分片下载插件（宿主侧）。
 *
 * 目标：给 agent 一条"高速下载通道"。要下安装包 / 模型 / 视频 / 网盘直链时，
 * 调 chunk_download 走 Range 分片并发（1~64 连接），比 curl/wget 单连接快数倍，
 * 并支持断点续传、暂停/恢复、限速、摘要校验、完成后送进手机 Download。
 *
 * 下载内核见 lib/engine.js；浏览器半身见 client.js
 * （桌面侧边栏进度、会话标题栏进度胶囊、浮动任务面板）。
 *
 * 注册的工具：
 *   chunk_download          新建任务（单个或批量，可阻塞等待完成）
 *   chunk_download_status   查进度 / 看队列
 *   chunk_download_control  暂停 / 恢复 / 取消 / 删除 / 导出 / 全部暂停 / 全部恢复 / 清理
 *   chunk_download_wait     阻塞等某个任务结束
 *
 * 注册的 HTTP 路由（供 client.js 轮询）：
 *   GET  /chunk-download/tasks     任务列表 + 汇总
 *   POST /chunk-download/control   与 control 工具等价的操作
 */

import os from 'node:os'
import path from 'node:path'
import { DownloadEngine } from './lib/engine.js'
import { formatTaskBlock, formatTaskList, formatSpeed } from './lib/format.js'

export const name = 'chunk-download'

/** 下载工具依赖工具注册表；webServer / systemPrompt 是可选依赖（缺了就少一块能力）。 */
export const inject = ['tools']

const PROMPT_TEXT = [
  '## 下载文件：优先用 chunk_download 分片下载插件',
  '需要把 http(s) 直链（安装包 / 模型 / 视频 / 网盘直链 / 数据集）下到本地时，优先调用 `chunk_download`：',
  '它用 Range 分片 + 多连接并发 + 断点续传，比 `curl`/`wget` 单连接快数倍；不要用 bash 里的 curl 硬下大文件，',
  '`web_fetch` 只用于读网页/API 文本，不能下二进制。',
  '- 新建：`chunk_download {url | urls[], dir?, filename?, headers?, connections?, speedLimit?, sha256?, ifExists?, export?, waitMs?}`',
  '- 跟进：`chunk_download_status {id?}`；桌面侧边栏 / 会话标题栏也会实时显示进度',
  '- 干预：`chunk_download_control {id, action: pause|resume|cancel|retry|remove|export}`，或 `{action: pauseAll|resumeAll|clear}`',
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
    notifyOnComplete: pick('notifyOnComplete', true) !== false,
    bridgeUrl: typeof config.bridgeUrl === 'string' ? config.bridgeUrl : 'http://127.0.0.1:3090',
    bridgeTokenFile: typeof config.bridgeTokenFile === 'string' ? config.bridgeTokenFile : '/root/.dsh/.bridge_token',
  }
}

/** 统一控制入口：工具和 HTTP 路由共用，避免两套逻辑漂移。 */
async function runControl(engine, { id, action, deleteFile = true }) {
  switch (action) {
    case 'pause':
      return { ok: true, task: await engine.pause(id) }
    case 'resume':
    case 'retry':
      return { ok: true, task: await engine.resume(id) }
    case 'cancel':
      return { ok: true, task: await engine.cancel(id, { deleteFile }) }
    case 'remove':
      return { ok: true, removed: await engine.remove(id, { deleteFile }) }
    case 'export':
      return { ok: true, task: await engine.exportToDevice(id) }
    case 'pauseAll':
      return { ok: true, ...(await engine.pauseAll()) }
    case 'resumeAll':
      return { ok: true, ...(await engine.resumeAll()) }
    case 'clear':
      return { ok: true, ...(await engine.clearFinished()) }
    default:
      throw new Error(`不认识的动作：${action}（可用 pause/resume/retry/cancel/remove/export/pauseAll/resumeAll/clear）`)
  }
}

function sendJson(res, status, value) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  } catch {}
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
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

  // 浏览器半身轮询用的只读/控制接口（没有 webServer 就跳过，工具仍然可用）
  ctx.inject?.(['webServer'], (inner) => {
    try {
      inner.effect(() => inner.webServer.register({
        kind: 'exact',
        path: '/chunk-download/tasks',
        handler: async (_req, res) => {
          await ready.catch(() => {})
          const { tasks, summary } = engine.list({ limit: 30 })
          sendJson(res, 200, { ok: true, tasks, summary, serverTime: Date.now() })
        },
      }))
      inner.effect(() => inner.webServer.register({
        kind: 'exact',
        path: '/chunk-download/control',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '只接受 POST' })
            return
          }
          try {
            await ready
            const body = JSON.parse((await readBody(req)) || '{}')
            const payload = await runControl(engine, {
              id: body.id,
              action: String(body.action ?? ''),
              deleteFile: body.deleteFile !== false,
            })
            sendJson(res, 200, { ok: true, ...payload })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: error?.message ?? String(error) })
          }
        },
      }))
      log('info', '进度接口已注册：/chunk-download/tasks')
    } catch (error) {
      log('warn', `注册进度接口失败：${error?.message ?? error}`)
    }
  })

  ctx.tools.register({
    name: 'chunk_download',
    description: [
      '用 Range 分片并发把 http(s) 直链高速下载到本地（多连接 + 断点续传 + 限速 + 摘要校验）。',
      '下载大文件（安装包 / 模型 / 视频 / 网盘直链，>5MB）时优先用本工具，比 curl 单连接快数倍。',
      '支持一次下多个（urls）与 sha256 校验；立即返回任务信息，需要等它下完就传 waitMs。',
      '同一 URL + 同一目标文件已存在任务时直接复用（reused=true，force=true 强制新建）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https 直链（与 urls 二选一）' },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: '批量下载：多条直链一次建任务（最多 20 条），与 url 二选一',
        },
        dir: { type: 'string', description: '保存目录（绝对路径，可省略，默认 ~/Downloads）' },
        filename: { type: 'string', description: '文件名（可省略：优先 Content-Disposition，其次 URL 末段）' },
        headers: {
          type: 'object',
          additionalProperties: true,
          description: '额外请求头对象，如 {"referer":"https://...","cookie":"..."}（部分网盘直链必须带，否则 403）',
        },
        connections: { type: 'integer', description: '并发连接数 1~64，默认 8；CDN 限 IP 连接数时调低' },
        speedLimit: { type: 'integer', description: '本任务限速（字节/秒），0/省略为不限速' },
        sha256: { type: 'string', description: '下载完成后校验 SHA-256（不匹配则任务标记失败）' },
        ifExists: {
          type: 'string',
          enum: ['overwrite', 'skip', 'rename'],
          description: '同名文件策略：overwrite 覆盖（默认）/ skip 跳过 / rename 另存为 name (1).ext',
        },
        deleteOnMismatch: { type: 'boolean', description: 'sha256 校验失败时删除坏文件（默认保留）' },
        export: { type: 'boolean', description: 'true = 完成后自动送进手机 Download/DeepSeekHarness' },
        waitMs: { type: 'integer', description: '>0 时阻塞等待任务结束（毫秒，建议 ≤120000），默认 0 立即返回' },
        force: { type: 'boolean', description: 'true = 即使已有同目标任务也新建一个' },
      },
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args = {}) {
      await ready
      const urls = []
      if (Array.isArray(args.urls)) {
        for (const item of args.urls) {
          const value = String(item ?? '').trim()
          if (value) urls.push(value)
        }
      }
      if (urls.length === 0 && args.url) urls.push(String(args.url).trim())
      if (urls.length === 0) throw new Error('需要 url 或 urls（至少一条 http/https 直链）')
      if (urls.length > 20) throw new Error(`一次最多 20 条，收到 ${urls.length} 条`)

      const results = []
      for (const [index, target] of urls.entries()) {
        try {
          const snapshot = await engine.addTask({
            url: target,
            dir: args.dir,
            filename: urls.length === 1 ? args.filename : undefined,
            headers: args.headers,
            connections: args.connections,
            speedLimit: args.speedLimit,
            export: args.export === true,
            force: args.force === true,
            sha256: args.sha256,
            ifExists: args.ifExists,
            deleteOnMismatch: args.deleteOnMismatch === true,
          })
          results.push({ ok: true, task: snapshot })
        } catch (error) {
          results.push({ ok: false, url: target, error: error?.message ?? String(error) })
        }
        if (urls.length > 1 && index < urls.length - 1) await new Promise((r) => setTimeout(r, 80))
      }

      if (urls.length === 1) {
        const first = results[0]
        if (!first.ok) throw new Error(first.error)
        const snapshot = first.task
        if (snapshot?.skipped) {
          return {
            ok: true,
            skipped: true,
            task: snapshot,
            text: `文件已存在，按 ifExists=skip 跳过：${snapshot.path}`,
          }
        }
        const waitMs = Number(args.waitMs) || 0
        if (waitMs > 0 && snapshot.status !== 'completed') {
          const result = await engine.waitFor(snapshot.id, { timeoutMs: Math.min(600000, waitMs) })
          const task = result.task
          return {
            ok: task.status === 'completed' && task.verification?.ok !== false,
            timedOut: result.timedOut,
            task,
            text: `${result.timedOut ? '等待超时，任务仍在后台继续。\n' : ''}${formatTaskBlock(task)}`,
          }
        }
        return {
          ok: true,
          task: snapshot,
          text: `${snapshot.reused ? '已复用同一直链的现有任务。\n' : ''}${formatTaskBlock(snapshot)}\n\n进度可在桌面侧边栏 / 会话标题栏看到，也可用 chunk_download_status 查询。`,
        }
      }

      const lines = [`已提交 ${results.filter((r) => r.ok).length}/${results.length} 个下载任务：`]
      results.forEach((item, index) => {
        if (item.ok) lines.push(`  ${index + 1}. ✔ ${item.task.filename}  →  ${item.task.path}`)
        else lines.push(`  ${index + 1}. ✖ ${item.url}  —  ${item.error}`)
      })
      return { ok: results.every((r) => r.ok), tasks: results.map((r) => r.task ?? r), text: lines.join('\n') }
    },
    presentCall(args) {
      const label = Array.isArray(args?.urls) && args.urls.length > 0 ? `${args.urls.length} 个链接` : (args?.url ?? '')
      return { card: 'generic', title: `分片下载 ${label}`, kind: 'fetch' }
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
      return { ok: true, tasks, summary, text: formatTaskList(tasks, { summary }) }
    },
  })

  ctx.tools.register({
    name: 'chunk_download_control',
    description: [
      '控制分片下载任务：',
      'pause 暂停 / resume 恢复 / cancel 取消并删 .part / retry 重试失败任务 / remove 删除任务记录 / export 送进手机；',
      'pauseAll 全部暂停 / resumeAll 全部恢复 / clear 清理已完成记录（不删文件）。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id（pauseAll/resumeAll/clear 时可省略）' },
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'retry', 'cancel', 'remove', 'export', 'pauseAll', 'resumeAll', 'clear'],
          description: '要执行的动作',
        },
        deleteFile: { type: 'boolean', description: 'cancel/remove 时是否连本地文件一起删，默认 true' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: OUTPUT,
    async execute(args = {}) {
      await ready
      const action = String(args.action ?? '')
      const needsId = ['pause', 'resume', 'retry', 'cancel', 'remove', 'export'].includes(action)
      if (needsId && !args.id) throw new Error(`${action} 需要 id`)
      const payload = await runControl(engine, {
        id: args.id ? String(args.id) : undefined,
        action,
        deleteFile: args.deleteFile !== false,
      })
      const task = payload.task
      if (Array.isArray(payload.tasks)) {
        return { ...payload, text: formatTaskList(payload.tasks, { summary: payload.summary }) }
      }
      return { ...payload, text: task ? formatTaskBlock(task) : `已完成操作：${action}` }
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
        ok: task.status === 'completed' && task.verification?.ok !== false,
        timedOut: result.timedOut,
        task,
        text: `${head}\n${formatTaskBlock(task)}`,
      }
    },
  })

  log('info', `插件已加载：默认 ${options.connections} 连接，下载目录 ${options.dir}，限速 ${options.speedLimit ? formatSpeed(options.speedLimit) : '不限'}`)
}
