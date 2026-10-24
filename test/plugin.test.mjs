/**
 * 插件层测试：用一个假的 ctx 把 index.js 装起来，验证
 *  - 四个工具注册成功、参数 schema 只用 harness 允许的关键字；
 *  - 系统提示词注入；
 *  - 真的能调用 chunk_download / status / control / wait 把文件下下来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { apply, name as pluginName, inject } from '../index.js'
import { makePayload, makeTempDir, startFileServer } from './helpers.mjs'

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** 极简 ServerResponse 替身：只实现插件用到的 writeHead / end。 */
function makeMockResponse() {
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = String(body ?? ''); resolveDone() },
  }
  return { res, wait: () => done }
}

/** 极简 IncomingMessage 替身：POST body 走 async iterable。 */
function makeMockRequest(payload) {
  const body = Buffer.from(JSON.stringify(payload))
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield body },
  }
}

/** harness 的 JSON Schema 子集（dsh-tools/json-schema）允许的关键字 */
const SCHEMA_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])

function validateSchemaKeywords(schema, where = 'schema') {
  if (Array.isArray(schema)) {
    schema.forEach((item, index) => validateSchemaKeywords(item, `${where}[${index}]`))
    return
  }
  if (!schema || typeof schema !== 'object') return
  for (const [key, value] of Object.entries(schema)) {
    assert.ok(SCHEMA_KEYWORDS.has(key), `${where} 出现 harness 不支持的关键字：${key}`)
    if (key === 'oneOf') value.forEach((item, index) => validateSchemaKeywords(item, `${where}.oneOf[${index}]`))
    if (key === 'properties') {
      for (const [prop, sub] of Object.entries(value)) validateSchemaKeywords(sub, `${where}.properties.${prop}`)
    }
    if (key === 'items') validateSchemaKeywords(value, `${where}.items`)
  }
}

function createFakeContext() {
  const tools = new Map()
  const promptSections = []
  const disposers = []
  const routes = new Map()
  const ctx = {
    tools: {
      register(definition) {
        assert.ok(!tools.has(definition.name), `工具重名：${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(execute) {
      const disposer = execute()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    inject(deps, callback) {
      const inner = {
        effect(execute) {
          const disposer = execute()
          if (typeof disposer === 'function') disposers.push(disposer)
          return () => {}
        },
        systemPrompt: {
          section(section) {
            promptSections.push(section)
            return () => {}
          },
        },
        webServer: {
          register(route) {
            routes.set(route.path, route.handler)
            return () => routes.delete(route.path)
          },
        },
      }
      callback(inner)
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  }
  return { ctx, tools, promptSections, routes, dispose: async () => { for (const fn of disposers.reverse()) await fn() } }
}

test('插件注册：四个工具 + 合法 schema + 系统提示词', async () => {
  assert.equal(pluginName, 'chunk-download')
  assert.deepEqual(inject, ['tools'])

  const { ctx, tools, promptSections, dispose } = createFakeContext()
  apply(ctx, { notifyOnComplete: false })
  try {
    assert.deepEqual([...tools.keys()].sort(), [
      'chunk_download',
      'chunk_download_control',
      'chunk_download_status',
      'chunk_download_wait',
    ])
    for (const tool of tools.values()) {
      assert.ok(tool.description.length > 10, `${tool.name} 缺少描述`)
      assert.equal(tool.parameters.type, 'object')
      validateSchemaKeywords(tool.parameters, `${tool.name}.parameters`)
      validateSchemaKeywords(tool.output.schema, `${tool.name}.output.schema`)
      assert.equal(typeof tool.execute, 'function')
      assert.equal(typeof tool.output.render, 'function')
    }
    const downloadSchema = tools.get('chunk_download').parameters
    assert.equal(downloadSchema.required, undefined, 'url / urls 二选一，不能硬性 required')
    for (const key of ['url', 'urls', 'sha256', 'ifExists', 'dir', 'connections', 'waitMs']) {
      assert.ok(downloadSchema.properties[key], `缺少参数 ${key}`)
    }
    assert.deepEqual(downloadSchema.properties.ifExists.enum, ['overwrite', 'skip', 'rename'])
    assert.deepEqual(tools.get('chunk_download_control').parameters.properties.action.enum, [
      'pause', 'resume', 'retry', 'cancel', 'remove', 'export', 'pauseAll', 'resumeAll', 'clear',
    ])

    assert.equal(promptSections.length, 1, '应注入一段"优先用本插件下载"的系统提示')
    assert.match(promptSections[0].text, /chunk_download/)
    assert.equal(promptSections[0].name, 'chunk-download:prefer')
  } finally {
    await dispose()
  }
})

test('端到端：chunk_download 下载 → status 查进度 → wait 完成', async () => {
  const payload = makePayload(8 * 1024 * 1024)
  const server = await startFileServer({ payload, chunkDelayMs: 1 })
  const root = await makeTempDir()
  const { ctx, tools, dispose } = createFakeContext()
  apply(ctx, { dir: path.join(root, 'out'), stateDir: path.join(root, 'state'), connections: 4, notifyOnComplete: false })
  const download = tools.get('chunk_download')
  const status = tools.get('chunk_download_status')
  const wait = tools.get('chunk_download_wait')
  try {
    const started = await download.execute({ url: server.url, filename: 'e2e.bin' })
    assert.equal(started.ok, true)
    assert.equal(started.task.mode, 'chunked')
    assert.match(started.text, /分片/)

    const running = await status.execute({ id: started.task.id })
    assert.ok(['downloading', 'queued', 'completed'].includes(running.task.status))

    const finished = await wait.execute({ id: started.task.id, timeoutMs: 30000 })
    assert.equal(finished.ok, true)
    assert.equal(finished.task.status, 'completed')
    assert.match(finished.text, /已完成/)

    const file = await fsp.readFile(path.join(root, 'out', 'e2e.bin'))
    assert.equal(sha256(file), sha256(payload))

    const list = await status.execute({})
    assert.match(list.text, /分片下载任务/)
    assert.equal(list.summary.completed, 1)

    const rendered = download.output.render({}, started)
    assert.equal(rendered[0].type, 'text')
    assert.ok(rendered[0].text.length > 0)
  } finally {
    await dispose()
    await server.close()
  }
})

test('批量下载：urls 一次建多个任务', async () => {
  const payload = makePayload(512 * 1024)
  const server = await startFileServer({ payload })
  const origin = new URL(server.url).origin
  const root = await makeTempDir()
  const { ctx, tools, dispose } = createFakeContext()
  apply(ctx, {
    dir: path.join(root, 'out'), stateDir: path.join(root, 'state'), connections: 2, notifyOnComplete: false,
  })
  const download = tools.get('chunk_download')
  const wait = tools.get('chunk_download_wait')
  try {
    const started = await download.execute({
      urls: [`${origin}/batch-a.bin`, `${origin}/batch-b.bin`, `${origin}/batch-c.bin`],
    })
    assert.equal(started.ok, true)
    assert.equal(started.tasks.length, 3)
    for (const task of started.tasks) {
      const done = await wait.execute({ id: task.id, timeoutMs: 30000 })
      assert.equal(done.task.status, 'completed')
    }
    for (const name of ['batch-a.bin', 'batch-b.bin', 'batch-c.bin']) {
      const file = await fsp.readFile(path.join(root, 'out', name))
      assert.equal(sha256(file), sha256(payload))
    }
  } finally {
    await dispose()
    await server.close()
  }
})

test('HTTP 接口：GET /tasks 与 POST /control', async () => {
  const payload = makePayload(256 * 1024)
  const server = await startFileServer({ payload })
  const root = await makeTempDir()
  const { ctx, tools, routes, dispose } = createFakeContext()
  apply(ctx, {
    dir: path.join(root, 'out'), stateDir: path.join(root, 'state'), connections: 2, notifyOnComplete: false,
  })
  const download = tools.get('chunk_download')
  const tasksHandler = routes.get('/chunk-download/tasks')
  const controlHandler = routes.get('/chunk-download/control')
  assert.equal(typeof tasksHandler, 'function', '应注册 /chunk-download/tasks')
  assert.equal(typeof controlHandler, 'function', '应注册 /chunk-download/control')
  try {
    const started = await download.execute({ url: server.url, filename: 'api.bin' })
    const getRes = makeMockResponse()
    await tasksHandler({ method: 'GET', headers: {} }, getRes.res)
    await getRes.wait()
    const payloadGet = JSON.parse(getRes.res.body)
    assert.equal(payloadGet.ok, true)
    assert.ok(Array.isArray(payloadGet.tasks))
    assert.ok(payloadGet.tasks.some((t) => t.id === started.task.id))

    const postRes = makeMockResponse()
    await controlHandler(makeMockRequest({ id: started.task.id, action: 'pause' }), postRes.res)
    await postRes.wait()
    const payloadPost = JSON.parse(postRes.res.body)
    assert.equal(payloadPost.ok, true)
    assert.equal(payloadPost.task.status, 'paused')

    const badRes = makeMockResponse()
    await controlHandler({ method: 'GET', headers: {} }, badRes.res)
    await badRes.wait()
    assert.equal(badRes.res.status, 405)
  } finally {
    await dispose()
    await server.close()
  }
})

test('端到端：control 暂停 → 状态 paused → resume 续传完成', async () => {
  const payload = makePayload(16 * 1024 * 1024)
  const server = await startFileServer({ payload, chunkDelayMs: 6 })
  const root = await makeTempDir()
  const { ctx, tools, dispose } = createFakeContext()
  apply(ctx, { dir: path.join(root, 'out'), stateDir: path.join(root, 'state'), connections: 4, notifyOnComplete: false })
  const download = tools.get('chunk_download')
  const control = tools.get('chunk_download_control')
  const wait = tools.get('chunk_download_wait')
  try {
    const started = await download.execute({ url: server.url, filename: 'pause.bin' })
    await new Promise((resolve) => setTimeout(resolve, 300))

    const paused = await control.execute({ id: started.task.id, action: 'pause' })
    assert.equal(paused.task.status, 'paused')
    assert.ok(paused.task.completedChunks > 0, '暂停时应已有完整分片落盘')

    const resumed = await control.execute({ id: started.task.id, action: 'resume' })
    assert.ok(['queued', 'downloading'].includes(resumed.task.status))

    const finished = await wait.execute({ id: started.task.id, timeoutMs: 30000 })
    assert.equal(finished.task.status, 'completed')

    const file = await fsp.readFile(path.join(root, 'out', 'pause.bin'))
    assert.equal(sha256(file), sha256(payload))

    const removed = await control.execute({ id: started.task.id, action: 'remove', deleteFile: true })
    assert.equal(removed.ok, true)
    await assert.rejects(fsp.access(path.join(root, 'out', 'pause.bin')))
  } finally {
    await dispose()
    await server.close()
  }
})
