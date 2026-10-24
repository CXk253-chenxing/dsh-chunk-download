/**
 * 引擎集成测试：真的起一个本地 HTTP 服务器，跑分片下载、断点续传、限速、回退单流。
 * 运行：node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import {
  DownloadEngine,
  planChunkCount,
  parseContentRange,
  sanitizeFilename,
  filenameFromUrl,
  filenameFromDisposition,
  TASK_STATUS,
} from '../lib/engine.js'
import { makePayload, makeTempDir, startFileServer } from './helpers.mjs'

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

function newEngine(dir, stateDir, overrides = {}) {
  return new DownloadEngine({
    dir,
    stateDir,
    connections: 4,
    maxConcurrentTasks: 2,
    retries: 3,
    requestTimeoutMs: 5000,
    stallTimeoutMs: 8000,
    log: () => {},
    ...overrides,
  })
}

test('分片下载：多连接并发 + 内容一致 + 完成后 .part 消失', async () => {
  const payload = makePayload(12 * 1024 * 1024)
  const server = await startFileServer({ payload, chunkDelayMs: 1 })
  const root = await makeTempDir()
  const engine = newEngine(path.join(root, 'out'), path.join(root, 'state'))
  try {
    await engine.start()
    const task = await engine.addTask({ url: server.url, filename: 'payload.bin' })
    assert.equal(task.mode, 'chunked', '12MB 应走分片模式')
    assert.equal(task.total, payload.length)

    const result = await engine.waitFor(task.id, { timeoutMs: 30000 })
    assert.equal(result.timedOut, false)
    assert.equal(result.task.status, TASK_STATUS.COMPLETED)
    assert.equal(result.task.progress, 1)

    const written = await fsp.readFile(path.join(root, 'out', 'payload.bin'))
    assert.equal(sha256(written), sha256(payload), '下载内容必须与源文件一致')

    assert.ok(server.stats.maxConcurrent >= 2, `应有多连接并发，实测最大并发 ${server.stats.maxConcurrent}`)
    assert.ok(server.stats.rangeRequests >= 4, `应有多个 Range 请求，实测 ${server.stats.rangeRequests}`)
    await assert.rejects(fsp.access(path.join(root, 'out', 'payload.bin.part')), '完成后 .part 应已被改名')
  } finally {
    await engine.shutdown()
    await server.close()
  }
})

test('断点续传：暂停保留已完成分片，恢复后不重下并校验一致', async () => {
  const payload = makePayload(24 * 1024 * 1024)
  const server = await startFileServer({ payload, chunkDelayMs: 8 })
  const root = await makeTempDir()
  const engine = newEngine(path.join(root, 'out'), path.join(root, 'state'))
  try {
    await engine.start()
    const task = await engine.addTask({ url: server.url, filename: 'resume.bin' })
    await new Promise((resolve) => setTimeout(resolve, 450))
    const paused = await engine.pause(task.id)
    assert.equal(paused.status, TASK_STATUS.PAUSED)
    assert.ok(paused.completedChunks > 0, '暂停时应已落下若干完整分片')
    assert.ok(paused.downloaded < payload.length, '暂停时不应已下完')

    const partPath = path.join(root, 'out', 'resume.bin.part')
    const partStat = await fsp.stat(partPath)
    assert.equal(partStat.size, payload.length, '.part 预分配为完整大小')

    const resumed = await engine.resume(task.id)
    assert.ok([TASK_STATUS.QUEUED, TASK_STATUS.DOWNLOADING].includes(resumed.status))
    const result = await engine.waitFor(task.id, { timeoutMs: 30000 })
    assert.equal(result.task.status, TASK_STATUS.COMPLETED)

    const written = await fsp.readFile(path.join(root, 'out', 'resume.bin'))
    assert.equal(sha256(written), sha256(payload))
  } finally {
    await engine.shutdown()
    await server.close()
  }
})

test('服务端忽略 Range（永远 200）时回退单流', async () => {
  const payload = makePayload(3 * 1024 * 1024)
  const server = await startFileServer({ payload, ignoreRange: true })
  const root = await makeTempDir()
  const engine = newEngine(path.join(root, 'out'), path.join(root, 'state'))
  try {
    await engine.start()
    const task = await engine.addTask({ url: server.url, filename: 'single.bin' })
    assert.equal(task.mode, 'single', '不支持 Range 应走单流')
    const result = await engine.waitFor(task.id, { timeoutMs: 30000 })
    assert.equal(result.task.status, TASK_STATUS.COMPLETED)
    const written = await fsp.readFile(path.join(root, 'out', 'single.bin'))
    assert.equal(sha256(written), sha256(payload))
  } finally {
    await engine.shutdown()
    await server.close()
  }
})

test('进程重启后能从落盘状态继续（计划与分片位图保留）', async () => {
  const payload = makePayload(24 * 1024 * 1024)
  const server = await startFileServer({ payload, chunkDelayMs: 8 })
  const root = await makeTempDir()
  const stateDir = path.join(root, 'state')
  const outDir = path.join(root, 'out')

  const first = newEngine(outDir, stateDir)
  let firstTaskId
  try {
    await first.start()
    const task = await first.addTask({ url: server.url, filename: 'restart.bin' })
    firstTaskId = task.id
    await new Promise((resolve) => setTimeout(resolve, 400))
    await first.pause(task.id)
  } finally {
    await first.shutdown()
  }

  const second = newEngine(outDir, stateDir, { autoResume: false })
  try {
    await second.start()
    const restored = second.get(firstTaskId)
    assert.ok(restored, '重启后应加载到任务状态')
    assert.equal(restored.status, TASK_STATUS.PAUSED)
    assert.ok(restored.chunksDone.length > 0, '已完成分片索引应被保留')

    const resumed = await second.resume(firstTaskId)
    assert.ok(resumed)
    const result = await second.waitFor(firstTaskId, { timeoutMs: 30000 })
    assert.equal(result.task.status, TASK_STATUS.COMPLETED)
    const written = await fsp.readFile(path.join(outDir, 'restart.bin'))
    assert.equal(sha256(written), sha256(payload))
  } finally {
    await second.shutdown()
    await server.close()
  }
})

test('全局限速生效（2MB @ 1MB/s）', async () => {
  const payload = makePayload(2 * 1024 * 1024)
  const server = await startFileServer({ payload })
  const root = await makeTempDir()
  const engine = newEngine(path.join(root, 'out'), path.join(root, 'state'), { speedLimit: 1024 * 1024, connections: 4 })
  try {
    await engine.start()
    const startedAt = Date.now()
    const task = await engine.addTask({ url: server.url, filename: 'limited.bin' })
    const result = await engine.waitFor(task.id, { timeoutMs: 30000 })
    const elapsed = Date.now() - startedAt
    assert.equal(result.task.status, TASK_STATUS.COMPLETED)
    assert.ok(elapsed >= 1200, `限速 1MB/s 下 2MB 至少 1.2s，实测 ${elapsed}ms`)
    assert.ok(elapsed <= 8000, `限速不应离谱地慢，实测 ${elapsed}ms`)
  } finally {
    await engine.shutdown()
    await server.close()
  }
})

test('任务队列：并发上限生效', async () => {
  const payload = makePayload(2 * 1024 * 1024)
  const server = await startFileServer({ payload, chunkDelayMs: 2 })
  const root = await makeTempDir()
  const engine = newEngine(path.join(root, 'out'), path.join(root, 'state'), { maxConcurrentTasks: 1 })
  try {
    await engine.start()
    const tasks = []
    for (let index = 0; index < 3; index += 1) {
      tasks.push(await engine.addTask({ url: server.url, filename: `queue-${index}.bin` }))
    }
    let maxRunning = 0
    const timer = setInterval(() => {
      maxRunning = Math.max(maxRunning, engine.runs.size)
    }, 30)
    for (const task of tasks) await engine.waitFor(task.id, { timeoutMs: 30000 })
    clearInterval(timer)
    assert.equal(maxRunning, 1, `并发上限 1，实测同时运行 ${maxRunning}`)
    for (let index = 0; index < 3; index += 1) {
      const written = await fsp.readFile(path.join(root, 'out', `queue-${index}.bin`))
      assert.equal(sha256(written), sha256(payload))
    }
  } finally {
    await engine.shutdown()
    await server.close()
  }
})

test('文件名：Content-Disposition 优先，其次 URL 末段', async () => {
  const payload = makePayload(64 * 1024)
  const server = await startFileServer({
    payload,
    disposition: "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95-%E6%96%87%E4%BB%B6.bin",
  })
  const root = await makeTempDir()
  const engine = newEngine(path.join(root, 'out'), path.join(root, 'state'))
  try {
    await engine.start()
    const task = await engine.addTask({ url: server.url })
    assert.equal(task.filename, '测试-文件.bin')
    await engine.waitFor(task.id, { timeoutMs: 15000 })
    const written = await fsp.readFile(path.join(root, 'out', '测试-文件.bin'))
    assert.equal(sha256(written), sha256(payload))
  } finally {
    await engine.shutdown()
    await server.close()
  }
})

test('会压缩的服务端：强制 identity，不被 Content-Length 骗到', async () => {
  // 120KB 文本（< 单片下限 → 单流），服务端只要客户端接受 gzip 就整文件压缩返回
  const payload = Buffer.from('abcdef'.repeat(20000))
  const server = await startFileServer({ payload, gzipWhenAccepted: true })
  const root = await makeTempDir()
  const engine = newEngine(path.join(root, 'out'), path.join(root, 'state'))
  try {
    await engine.start()
    const task = await engine.addTask({ url: server.url, filename: 'text.txt' })
    const result = await engine.waitFor(task.id, { timeoutMs: 30000 })
    assert.equal(result.task.status, TASK_STATUS.COMPLETED, `应完成，实际错误：${result.task.error}`)
    const written = await fsp.readFile(path.join(root, 'out', 'text.txt'))
    assert.equal(sha256(written), sha256(payload))
    assert.ok(
      server.stats.acceptedEncodings.every((value) => !value.includes('gzip')),
      `请求必须带 accept-encoding: identity，实测 ${JSON.stringify(server.stats.acceptedEncodings)}`,
    )
  } finally {
    await engine.shutdown()
    await server.close()
  }
})

test('大文件 + 会压缩的服务端：分片请求同样不被压缩干扰', async () => {
  const payload = Buffer.from('0123456789'.repeat(300000)) // ≈2.8MB，可压缩
  const server = await startFileServer({ payload, gzipWhenAccepted: true, chunkDelayMs: 1 })
  const root = await makeTempDir()
  const engine = newEngine(path.join(root, 'out'), path.join(root, 'state'))
  try {
    await engine.start()
    const task = await engine.addTask({ url: server.url, filename: 'big-text.txt' })
    assert.equal(task.mode, 'chunked')
    const result = await engine.waitFor(task.id, { timeoutMs: 60000 })
    assert.equal(result.task.status, TASK_STATUS.COMPLETED, `应完成，实际错误：${result.task.error}`)
    const written = await fsp.readFile(path.join(root, 'out', 'big-text.txt'))
    assert.equal(sha256(written), sha256(payload))
  } finally {
    await engine.shutdown()
    await server.close()
  }
})

test('桌面端没有设备桥：导出被跳过，下载照常完成', async () => {
  const payload = makePayload(512 * 1024)
  const server = await startFileServer({ payload })
  const root = await makeTempDir()
  const engine = newEngine(path.join(root, 'out'), path.join(root, 'state'), {
    bridgeUrl: 'http://127.0.0.1:1',
    bridgeTokenFile: path.join(root, 'no-such-token'),
  })
  try {
    await engine.start()
    const task = await engine.addTask({ url: server.url, filename: 'desktop.bin', export: true })
    const result = await engine.waitFor(task.id, { timeoutMs: 30000 })
    assert.equal(result.task.status, TASK_STATUS.COMPLETED, `下载应成功，实际：${result.task.error}`)
    assert.match(String(result.task.exportError ?? ''), /设备桥/, '应给出"没有设备桥"的说明而不是报错')
    const written = await fsp.readFile(path.join(root, 'out', 'desktop.bin'))
    assert.equal(sha256(written), sha256(payload))
  } finally {
    await engine.shutdown()
    await server.close()
  }
})

test('拒绝非 http(s) 直链', async () => {
  const root = await makeTempDir()
  const engine = newEngine(path.join(root, 'out'), path.join(root, 'state'))
  try {
    await engine.start()
    await assert.rejects(engine.addTask({ url: 'file:///etc/passwd' }), /http/)
  } finally {
    await engine.shutdown()
  }
})

test('工具函数：分片规划 / Content-Range / 文件名清洗', () => {
  assert.equal(planChunkCount(1 * 1024 * 1024, 8), 4, '1MB / 256KB = 4 片')
  assert.equal(planChunkCount(12 * 1024 * 1024, 4), 32, '12MB + 4 连接 → max(8, 32) 片')
  assert.equal(planChunkCount(1 * 1024 * 1024 * 1024, 32), 256, '1GB + 32 连接 → max(64, 256) 片')
  assert.equal(planChunkCount(2 * 1024 * 1024 * 1024, 64), 512, '大文件封顶 512 片')

  assert.deepEqual(parseContentRange('bytes 0-0/12345'), { start: 0, end: 0, total: 12345 })
  assert.deepEqual(parseContentRange('bytes 100-199/*'), { start: 100, end: 199, total: null })
  assert.equal(parseContentRange('bytes 5-1/10'), null)
  assert.equal(parseContentRange('garbage'), null)

  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeFilename('a\u0000b?.zip'), 'a_b_.zip')
  assert.equal(filenameFromUrl('https://x.test/a/b/%E6%B5%8B%E8%AF%95.mp4?token=1'), '测试.mp4')
  assert.equal(filenameFromDisposition('attachment; filename="a b.zip"'), 'a b.zip')
})
