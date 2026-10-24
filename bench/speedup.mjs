/**
 * 加速效果演示：本地服务器模拟"单连接被限速 256KB/s"的 CDN，
 * 同一个文件分别用 1 连接（≈ curl 单线程）和 8 连接（插件默认）下载，对比耗时。
 *
 * 运行：node bench/speedup.mjs [文件大小MB]
 * 说明：真实加速比取决于服务端是否对单连接限速；单连接已跑满带宽时并行不会更快。
 */
import path from 'node:path'
import fsp from 'node:fs/promises'
import { DownloadEngine } from '../lib/engine.js'
import { makePayload, makeTempDir, startFileServer } from '../test/helpers.mjs'

const sizeMb = Number(process.argv[2]) || 2
const payload = makePayload(sizeMb * 1024 * 1024)
const perConnectionDelayMs = 250 // 每 64KB 等 250ms ≈ 单连接 256KB/s

async function run(connections) {
  const server = await startFileServer({ payload, chunkDelayMs: perConnectionDelayMs })
  const root = await makeTempDir('chunk-dl-bench-')
  const engine = new DownloadEngine({
    dir: path.join(root, 'out'),
    stateDir: path.join(root, 'state'),
    connections,
    maxConcurrentTasks: 1,
    log: () => {},
  })
  await engine.start()
  const startedAt = Date.now()
  const task = await engine.addTask({ url: server.url, filename: `bench-${connections}.bin` })
  const result = await engine.waitFor(task.id, { timeoutMs: 300000 })
  const seconds = (Date.now() - startedAt) / 1000
  await engine.shutdown()
  await server.close()
  await fsp.rm(root, { recursive: true, force: true })
  if (result.task.status !== 'completed') throw new Error(`下载失败：${result.task.error}`)
  return { connections, seconds, mbps: sizeMb / seconds, chunks: result.task.chunkCount }
}

const single = await run(1)
const multi = await run(8)
const perConnectionKbps = Math.round((64 * 1024 * 1000) / perConnectionDelayMs / 1024)
console.log(`文件大小：${sizeMb} MB（服务端把单连接限速到约 ${perConnectionKbps} KB/s）`)
console.log(`1 连接（≈ curl 单线程）：${single.seconds.toFixed(2)}s  ${single.mbps.toFixed(2)} MB/s  分片计划 ${single.chunks} 片`)
console.log(`8 连接（插件默认）    ：${multi.seconds.toFixed(2)}s  ${multi.mbps.toFixed(2)} MB/s  分片计划 ${multi.chunks} 片`)
console.log(`加速比：${(single.seconds / multi.seconds).toFixed(2)}×`)
