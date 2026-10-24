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
    inject(_deps, callback) {
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
      }
      callback(inner)
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  }
  return { ctx, tools, promptSections, dispose: async () => { for (const fn of disposers.reverse()) await fn() } }
}

test('插件注册：四个工具 + 合法 schema + 系统提示词', async () => {
  assert.equal(pluginName, 'chunk-download')
  assert.deepEqual(inject, ['tools'])

  const { ctx, tools, promptSections, dispose } = createFakeContext()
  apply(ctx, {})
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
    assert.deepEqual(tools.get('chunk_download').parameters.required, ['url'])
    assert.deepEqual(tools.get('chunk_download_control').parameters.properties.action.enum, [
      'pause', 'resume', 'retry', 'cancel', 'remove', 'export',
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
  apply(ctx, { dir: path.join(root, 'out'), stateDir: path.join(root, 'state'), connections: 4 })
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

test('端到端：control 暂停 → 状态 paused → resume 续传完成', async () => {
  const payload = makePayload(16 * 1024 * 1024)
  const server = await startFileServer({ payload, chunkDelayMs: 6 })
  const root = await makeTempDir()
  const { ctx, tools, dispose } = createFakeContext()
  apply(ctx, { dir: path.join(root, 'out'), stateDir: path.join(root, 'state'), connections: 4 })
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
