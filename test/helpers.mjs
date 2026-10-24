/**
 * 测试用的本地 HTTP 服务器：支持 Range / 忽略 Range / 限速 / 慢速分块，
 * 并统计 Range 请求数、最大并发连接数，用来验证引擎真的在并发拉分片。
 */
import http from 'node:http'
import zlib from 'node:zlib'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 生成可校验的伪随机内容（同一 size 结果稳定）。 */
export function makePayload(size) {
  const buffer = Buffer.allocUnsafe(size)
  let seed = 0x12345678
  for (let index = 0; index < size; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    buffer[index] = (seed >>> 16) & 0xff
  }
  return buffer
}

export async function makeTempDir(prefix = 'chunk-dl-') {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 启动测试服务器。
 * @param {object} options
 * @param {Buffer} options.payload 文件内容
 * @param {boolean} [options.supportRange] 是否真的按 Range 返回 206
 * @param {boolean} [options.ignoreRange] true = 无视 Range 永远回 200 整文件
 * @param {number} [options.chunkDelayMs] 每 64KB 数据的延时，用来制造"慢下载"
 * @param {string} [options.disposition] Content-Disposition 头
 */
export async function startFileServer(options = {}) {
  const {
    payload,
    supportRange = true,
    ignoreRange = false,
    chunkDelayMs = 0,
    disposition = null,
    gzipWhenAccepted = false,
  } = options
  const stats = {
    rangeRequests: 0,
    fullRequests: 0,
    headRequests: 0,
    maxConcurrent: 0,
    active: 0,
    bytesSent: 0,
    acceptedEncodings: [],
  }

  const stream = async (res, buffer) => {
    const slice = 64 * 1024
    for (let offset = 0; offset < buffer.length; offset += slice) {
      const piece = buffer.subarray(offset, Math.min(offset + slice, buffer.length))
      if (!res.write(piece)) {
        await new Promise((resolve) => res.once('drain', resolve))
      }
      stats.bytesSent += piece.length
      if (chunkDelayMs > 0) await sleep(chunkDelayMs)
      if (res.writableEnded || res.destroyed) return
    }
    res.end()
  }

  const server = http.createServer(async (req, res) => {
    stats.active += 1
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.active)
    res.on('close', () => {
      stats.active -= 1
    })

    const acceptEncoding = String(req.headers['accept-encoding'] ?? '')
    stats.acceptedEncodings.push(acceptEncoding)
    const commonHeaders = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' }
    if (disposition) commonHeaders['content-disposition'] = disposition

    if (req.method === 'HEAD') {
      stats.headRequests += 1
      res.writeHead(200, { ...commonHeaders, 'content-length': payload.length })
      res.end()
      return
    }

    // 模仿会压缩静态文件的服务端：客户端接受 gzip 就整文件压缩返回（会让 content-length 与实际字节不符）
    if (gzipWhenAccepted && acceptEncoding.includes('gzip') && !req.headers.range) {
      stats.fullRequests += 1
      const body = zlib.gzipSync(payload)
      res.writeHead(200, { ...commonHeaders, 'content-encoding': 'gzip', 'content-length': body.length })
      res.end(body)
      return
    }

    const rangeHeader = req.headers.range
    if (rangeHeader && supportRange && !ignoreRange) {
      stats.rangeRequests += 1
      const match = /^bytes=(\d+)-(\d*)$/.exec(String(rangeHeader).trim())
      if (!match) {
        res.writeHead(400).end('bad range')
        return
      }
      const start = Number(match[1])
      const end = match[2] === '' ? payload.length - 1 : Math.min(Number(match[2]), payload.length - 1)
      if (start >= payload.length || end < start) {
        res.writeHead(416, { 'content-range': `bytes */${payload.length}` }).end()
        return
      }
      const body = payload.subarray(start, end + 1)
      res.writeHead(206, {
        ...commonHeaders,
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'content-length': body.length,
      })
      await stream(res, body)
      return
    }

    stats.fullRequests += 1
    res.writeHead(200, { ...commonHeaders, 'content-length': payload.length })
    await stream(res, payload)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/file.bin`,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
