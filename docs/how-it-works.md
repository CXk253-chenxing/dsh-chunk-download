# 工作原理

> 这份文档解释插件「为什么这么切、这么校验」，适合想改并发策略或排查下载异常时阅读。

## 1. 一条任务的生命周期

```
addTask(url)
   │
   ├─ 探测：GET Range: bytes=0-0
   │     ├─ 206 + Content-Range: bytes 0-0/12345   → 支持 Range，总长 12345
   │     ├─ 200                                    → 忽略 Range，走单流
   │     └─ 416 / 无长度                            → HEAD 兜底拿 Content-Length
   │
   ├─ 规划：chunkCount / chunkSize / planSig
   │
   ├─ 入队（queued）→ 调度器按 maxConcurrentTasks 拉起
   │
   ├─ 下载中（downloading）
   │     ├─ chunked：N 个 worker 抢队列里的分片，定位写入最终文件
   │     └─ single ：一条连接顺序写
   │
   └─ 完成：truncate → rename(.part → 目标) → （可选）导出到手机
```

## 2. 分片规划

```js
planChunkCount(total, connections):
  bySize = total < 5MB   ? 1
         : total < 50MB  ? 8
         : total < 500MB ? 32
         : 64
  want   = max(bySize, connections * 8)      // 每连接 8 片盈余
  byMin  = floor(total / 256KB)              // 单片不小于 256KB
  return clamp(min(want, byMin), 1, 512)
```

| 文件大小 | 连接数 | 分片数 |
| --- | --- | --- |
| 1 MB | 8 | 4（受 256KB 下限约束） |
| 12 MB | 4 | 32 |
| 1 GB | 32 | 256 |
| 2 GB | 64 | 512（封顶） |

为什么要有盈余片：如果分片数等于连接数，某一片命中慢节点时其他连接只能干等，
表现为“前面很快、最后几十 KB 卡住”。盈余片 + 工作窃取让慢片只影响它自己。

## 3. 分片的请求与校验

每个分片一次请求：

```http
GET /file.bin HTTP/1.1
Range: bytes=1048576-1310719
Accept-Encoding: identity
```

必须同时满足两条才落盘：

1. 状态码 `206`，且 `Content-Range: bytes <start>-<end>/<total>` 的 start/end 与请求**完全一致**；
2. 流式读完后，实收字节数 == `end - start + 1`。

任何一条不满足：**不写坏数据**，该分片退避后重试；重试用尽则整个任务失败。

`Accept-Encoding: identity` 是必需的：如果服务端对 Range 响应做 gzip，
`Content-Length` 是压缩后长度，按字节偏移写入必然错位，所以直接要求不压缩。

## 4. 什么时候回退单流

| 情况 | 处理 |
| --- | --- |
| 探测返回 200（忽略 Range） | 直接单流 |
| 分片请求返回 200 | 抛 `RangeUnsupportedError`，任务清空分片位图，重开单流 |
| 206 但带 `Content-Encoding` | 同上（压缩过的字节不能按偏移写） |
| 总长度未知（chunked 传输） | 单流，进度只显示已下载字节 |

单流没有断点续传能力（服务端不支持 Range 时本来也无法续传），失败即从 0 重来。

## 5. 断点续传

状态文件（`$DSH_HOME/chunk-download/tasks/<id>.json`）保存：

```jsonc
{
  "total": 50652177,
  "chunkSize": 395720,
  "chunkCount": 128,
  "planSig": "50652177:395720:128",   // 总长:片大小:片数
  "chunksDone": [0, 1, 2, 7, ...],     // 已完成分片索引
  "downloaded": 18234567
}
```

- 续传时把 `chunksDone` 对应区间跳过，只请求剩余片；
- 若 `planSig` 变了（服务端文件大小变了、连接数改动导致片大小变化），**旧位图整体作废**，
  否则旧分片区间会与新规划错位，写出花文件；
- `.part` 文件不存在（被清理）时同样作废位图。

数据直接定位写到最终文件（`fs.write(buffer, offset, pos)`），完成时 `rename` 去掉 `.part` 后缀，
因此不需要 part_N 临时文件 + 合并那一步。

## 6. 限速与测速

- **令牌桶**：全局一个桶，容量 = 1 秒的量，按 `elapsed × limit` 补充；取不到额度就按缺额 sleep，
  所有连接共享同一个桶 ⇒ 总速率不会超过设定值。
- **测速**：5 秒滑动窗口，最多保留窗口内的样本，250ms 粒度更新；超过 3 秒没有新样本视为速度为 0
  （避免暂停后 ETA 还是旧值）。

## 7. 并发与调度

- 任务队列：`maxConcurrentTasks` 控制同时运行的任务数，按创建时间 FIFO；
- 分片并发：每个任务内部 `min(connections, 剩余分片数)` 个 worker；
- 单请求停滞：看门狗 30 秒没收到数据就 abort 该请求，交给分片级重试。

## 8. 下载后的三道关

`#finish` 里的顺序是固定的，任何一步失败都会让任务变成 `failed`：

1. **摘要校验**（可选）：按 1MB 块读整个文件算 SHA-256，与 `sha256` 参数逐字比对；
   不一致时抛错并把 `verification` 写进任务状态，`deleteOnMismatch` 为真则删掉坏文件。
2. **导出到手机**（可选）：走 3090 设备桥的 `/app/export`；桌面端没有 token 文件就跳过。
3. **完成通知**：桥存在时发一条通知栏消息，失败静默。

写盘本身用「先写 `.part` → 完成后 rename」的原子收尾；Windows 上 rename 不会覆盖同名文件，
所以那里会先删目标再 rename（见 `#renameIntoPlace`）。

## 9. 界面数据从哪来

浏览器半身不碰文件系统，只读宿主注册的两个同源接口：

| 接口 | 用途 |
| --- | --- |
| `GET /chunk-download/tasks` | `{ tasks, summary, serverTime }`，任务快照数组（最多 30 条） |
| `POST /chunk-download/control` | `{ id?, action, deleteFile? }`，与 `chunk_download_control` 工具同一套逻辑 |

轮询策略：有活动任务 1s，空闲 4s，`document.hidden` 时降频；弹窗关闭后停止。

## 10. 参数速查

| 参数 | 位置 | 建议 |
| --- | --- | --- |
| `connections` | 工具参数 / 配置 | 8~16 起步；遇 429 或连接重置往下调 |
| `speedLimit` | 工具参数 / 配置 | 只想限速某个任务时用工具参数 |
| `retries` | 配置 | CDN 抖动大可以调到 6~8 |
| `stallTimeoutMs` | 配置 | 慢速但稳定的源可调到 60s |
