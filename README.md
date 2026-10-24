<div align="center">

<img src="icon.svg" width="110" alt="dsh-chunk-download" />

# 分片高速下载 · dsh-chunk-download

**给 AI Agent 用的多线程下载器：Range 分片并发 + 断点续传 + 限速，比 `curl` 单连接快数倍**

[![CI](https://img.shields.io/github/actions/workflow/status/<your-name>/dsh-chunk-download/ci.yml?style=flat-square&label=CI)](.github/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/<your-name>/dsh-chunk-download?style=flat-square&color=4C8BF5)](https://github.com/<your-name>/dsh-chunk-download/releases)
[![License](https://img.shields.io/github/license/<your-name>/dsh-chunk-download?style=flat-square&color=3DA639)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)

[功能](#功能) · [为什么快](#为什么快) · [安装](#安装) · [用法](#用法) · [配置](#配置) · [实测](#实测) · [原理](docs/how-it-works.md)

</div>

***

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：把 **HTTP Range 分片下载** 做成 Agent 可直接调用的工具 ——
多连接并发、断点续传、暂停/恢复、限速，比 `curl` 单连接快数倍；**Linux / macOS / Windows 通用**，Android 上还能一键送进 `Download/DeepSeekHarness`。

> 单连接已经跑满带宽时并行不会更快 —— 加速收益来自**服务端对单连接限速**的场景（网盘直链、部分 CDN、GitHub Releases 等），
> 这在实测里通常就是数倍差距。

## 功能

| | 能力 | 说明 |
| --- | --- | --- |
| 🚀 | **Range 分片并发** | 1~64 条连接按 `bytes=x-y` 并行拉取，片数与分片策略见[原理](docs/how-it-works.md) |
| ⏯ | **断点续传** | 已完成分片位图 + 分片计划签名落盘，进程重启后能接着下 |
| ⏸ | **暂停 / 恢复 / 取消** | 运行中随时干预，暂停保留 `.part`，取消可连文件一起删 |
| 🧮 | **任务队列** | 同时跑 N 个任务（默认 2），其余排队；FIFO 调度 |
| 🐢 | **全局限速 + 单任务限速** | 令牌桶实现，所有连接合计不超设定速率 |
| 🛡 | **严格校验** | `Content-Range` 与请求必须匹配、实收字节数必须等于区间、文件大小变化即报错 |
| 🔀 | **自动回退单流** | 服务端忽略 Range（返回 200）或响应被 gzip 压缩时，自动退回单流下载，绝不写花文件 |
| 🕵️ | **停滞看门狗** | 单请求 30s 没数据即掐断重试，慢连接不拖死整个任务 |
| 📊 | **实时进度** | 进度条 / 速度 / ETA / 分片完成数 / 队列汇总 |
| 📱 | **送进手机 Download** | 完成后通过 DSH 设备桥导出到 `Download/DeepSeekHarness` |
| 🔁 | **同链接去重** | 同一 URL + 同一目标文件已有任务时直接复用，不重复下载 |
| 🖥 | **跨平台** | Linux / macOS / Windows，Node ≥20；纯 Node 实现，无原生依赖 |
| 🧩 | **零依赖** | 只用 Node 内置模块，不需要 `npm install` 任何东西 |

## 为什么快

```
curl 单连接      ────────────── 48MB / 380KB/s / 130s ──────────────►
chunk-download   ──┬── 1/8 ──┬── 2/8 ──┬── 3/8 ──┬ ... 8 路并行，聚合带宽
                   └─────────┴─────────┴─────────┘  同一个文件，数倍的速度
```

- **分片数远多于连接数**：按「每连接 8 片」给盈余片，worker 领完一片再领下一片（工作窃取），
  避免某一片慢导致其他连接空转的“尾部塌缩”。
- **单片大小自适应**：按文件大小档位规划（`<5MB` 不分片、`<50MB` 8 片、`<500MB` 32 片、更大 64 片），
  单片不小于 256KB、总数封顶 512 片 —— 既不产生海量 Range 请求，也不会因为片太大而失去并行度。
- **失败只重试那一片**：指数退避，已完成的片不重下。

## 安装

### 作为 DSH 插件（推荐）

1. 打成 npm 风格 tgz（`package/` 前缀）：

   ```bash
   rm -rf /tmp/tarpkg && mkdir -p /tmp/tarpkg
   cp -a dsh-chunk-download /tmp/tarpkg/package
   tar czf dsh-chunk-download-0.1.0.tgz -C /tmp/tarpkg package
   ```

2. 在 DEEPSEEK_HARNESS 的**插件管理**里安装这个 tgz，启用 `chunk-download`，然后开新会话。
3. 工具列表里出现 `chunk_download` / `chunk_download_status` / `chunk_download_control` / `chunk_download_wait` 即成功。

> 插件会往系统提示词注入一段“下载文件优先用 `chunk_download`”，让 Agent 自动走这条路而不是 `curl`。

### 本地开发

```bash
git clone https://github.com/<your-name>/dsh-chunk-download.git
cd dsh-chunk-download
node --test                # 16 个用例，全部用本地 HTTP 服务器，无需外网
node bench/speedup.mjs 2   # 加速比演示
```

## 跨平台

| 平台 | 下载 | 导出到手机 |
| --- | --- | --- |
| Linux / macOS / Windows | ✅ 纯 Node，路径用 `path` 处理；Windows 覆盖同名文件前会先删目标 | —（无设备桥，自动跳过） |
| Android（DEEPSEEK_HARNESS） | ✅ | ✅ 走 3090 设备桥，落 `Download/DeepSeekHarness` |

桌面端没有设备桥时，`export: true` 会被跳过并在任务里记 `exportError`（"已跳过导出；文件已保存在本地"），**下载不受影响**。
CI 在 Ubuntu × Node 20/22/24、macOS × 22、Windows × 22 上跑同一套测试。

## 用法

### 1. 下载一个文件

```jsonc
// chunk_download
{
  "url": "https://example.com/big.iso",
  "dir": "/root/Downloads",   // 可选，默认 ~/Downloads
  "filename": "big.iso",      // 可选，默认取 Content-Disposition / URL 末段
  "connections": 16,          // 可选，1~64，默认 8
  "export": true,             // 可选，下完送进手机 Download/DeepSeekHarness
  "waitMs": 60000             // 可选，阻塞等它下完（否则立即返回任务 id）
}
```

### 2. 跟进进度

```jsonc
// chunk_download_status（给 id 看单个，不给看全部 + 汇总）
{ "id": "dl_mvm1kptj_281a40" }
```

返回里带进度条、速度、ETA、分片完成数：

```
任务 dl_xxx  ▶ 下载中
  文件   /root/Downloads/node.tar.gz
  进度   93.2% ███████████████████░  45.0 MB / 48.3 MB
  速度   6.4 MB/s · 剩余 10s
  分片   111/128 片完成 · 16 连接并发
```

### 3. 干预与收尾

```jsonc
{ "id": "dl_xxx", "action": "pause" }                        // 暂停（保留 .part）
{ "id": "dl_xxx", "action": "resume" }                       // 恢复续传
{ "id": "dl_xxx", "action": "cancel", "deleteFile": true }    // 取消并删 .part
{ "id": "dl_xxx", "action": "export" }                        // 完成后送进手机
{ "id": "dl_xxx", "action": "remove", "deleteFile": true }    // 删任务记录（可连文件）
```

### 4. 阻塞等待

```jsonc
// chunk_download_wait
{ "id": "dl_xxx", "timeoutMs": 120000 }
```

### 网盘直链（需要带识别头）

```jsonc
{
  "url": "https://cdn.example.com/file.zip",
  "headers": {
    "referer": "https://pan.quark.cn/",
    "cookie": "你的登录态"
  },
  "connections": 16
}
```

> 直链通常对 Referer / Cookie / UA 敏感，缺了会 403；本插件只负责“更快地下”，不负责解析分享链接。

## 配置

`cordis.patch.yml` 里的 `config`（也可在插件管理里改）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dir` | `~/Downloads` | 默认下载目录 |
| `connections` | `8` | 单任务默认并发连接数（1~64） |
| `maxConcurrentTasks` | `2` | 同时运行的任务数，其余排队 |
| `speedLimit` | `0` | 全局限速（字节/秒），0 = 不限 |
| `exportToPhone` | `false` | `true` 时所有任务完成后自动导出到手机（桌面端自动跳过） |
| `autoResume` | `true` | 进程重启后自动续传未完成任务 |
| `retries` | `4` | 单分片重试次数 |
| `requestTimeoutMs` | `20000` | 探测 / 建连超时 |
| `stallTimeoutMs` | `30000` | 单请求停滞多久判定死连接 |
| `stateDir` | `$DSH_HOME/chunk-download` | 任务状态目录（续传依赖它） |
| `promptSection` | `true` | 是否注入“下载优先用本插件”的系统提示 |

## 实测

| 场景 | 单连接（curl） | 本插件 | 差距 |
| --- | --- | --- | --- |
| 4MB，服务端单连接限速 256KB/s，8 连接 | 15.86s (264KB/s) | **2.03s (1.97MB/s)** | **7.8×** |
| 2MB，同上，8 连接（bench 脚本） | 8.32s | **1.26s** | **6.6×** |
| 50.65MB 真实 CDN（npmmirror，单连接未限速） | 7.5s (6.75MB/s) | 7.05s (6.85MB/s) | ≈1×（带宽已跑满） |

真实文件校验：下载 48.3MB 的 Node 发行包，SHA-256 与官方 `SHASUMS256.txt` **完全一致**；
`export: true` 时手机 `Download/DeepSeekHarness` 里能直接看到成品。

## 工作原理

完整细节见 [docs/how-it-works.md](docs/how-it-works.md)，要点：

1. `Range: bytes=0-0` 探测总长度（校验 `Content-Range`），拿不到就 HEAD 兜底；
2. 按文件大小与连接数规划分片数，单片 ≥256KB、总数 ≤512 片；
3. N 个 worker 从共享队列领取分片，定位写入同一个文件（`fs.write(buffer, pos)`）；
4. 每片严格校验 `Content-Range` 与实收字节数，不符即重试；
5. 已完成分片索引 + 计划签名落盘，续传时跳过已完成片；
6. 服务端返回 200 或响应被压缩 ⇒ 放弃分片，回退单流。

## 与 YunX 的关系

分片策略、校验规则、限速与测速思路参考了开源项目
[YunX（云析）](https://github.com/CYQawa/YunX) 的 Android 下载内核（Kotlin）：片数 = `max(档位, 连接数×8)`、
单片 ≥256KB、封顶 512 片、`Content-Range` 严格匹配、忽略 Range 时回退单流等。

本仓库是**独立重新实现的 Node 版本**：没有复用其代码，且把「part_N 临时分片 + 合并」换成「直接定位写最终文件」，
省掉一次全量磁盘合并。感谢原项目的思路启发。

## 目录结构

```
dsh-chunk-download/
├── index.js                 # 插件入口：注册 4 个工具 + 系统提示
├── lib/engine.js            # 下载内核（探测/分片/并发/续传/限速/队列/持久化）
├── lib/format.js            # 进度条与人类可读文案
├── cordis.patch.yml         # 插件层挂载配置
├── locale/{zh,en}.json      # 插件管理里显示的名称与简介
├── icon.svg
├── docs/how-it-works.md     # 原理、分片规划、协议校验细节
├── test/                    # node --test：引擎 + 插件层端到端
├── bench/speedup.mjs        # 加速比演示
└── .github/workflows/ci.yml # CI：node 20 / 22 / 24 跑测试
```

## 已知限制

- 只做**直链下载**，不解析网盘分享链接（那需要各平台登录态与逆向，风险与合规成本都不适合放进插件）；
- 不支持 HLS(m3u8) / DASH / 磁力 / BT；
- 服务端不支持 Range 时只能单流（无法续传）；
- 连接数过高可能撞上 CDN 对单 IP 的连接数限制（429 / 连接重置），此时调低 `connections`。

## License

[MIT](LICENSE) © 2026 &lt;your-name&gt;
