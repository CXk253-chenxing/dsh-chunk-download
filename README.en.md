<div align="center">

<img src="icon.svg" width="110" alt="dsh-chunk-download" />

# dsh-chunk-download

**A multi-connection HTTP Range downloader for AI agents — resume, rate limit, several times faster than single-connection `curl`.**

[![CI](https://img.shields.io/github/actions/workflow/status/CXk253-chenxing/dsh-chunk-download/ci.yml?style=flat-square&label=CI)](.github/workflows/ci.yml)
[![License](https://img.shields.io/github/license/CXk253-chenxing/dsh-chunk-download?style=flat-square&color=3DA639)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)

[中文](README.md) · Features · Install · Usage · [How it works](docs/how-it-works.md)

</div>

***

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns chunked Range downloading into agent
tools: N parallel connections, resumable chunks, pause/resume, rate limiting — several times faster than a single `curl`
connection. Runs on **Linux / macOS / Windows**; on Android it can also drop the file into `Download/DeepSeekHarness`.

> Parallelism does not help when a single connection already saturates the link. The win comes from servers that throttle
> per connection (cloud-drive direct links, some CDNs, GitHub Releases) — there it is routinely several times faster.

## Features

| | Feature | Notes |
| --- | --- | --- |
| 🚀 | Range chunking | 1–64 parallel `bytes=x-y` requests |
| ⏯ | Resume | completed-chunk bitmap + plan signature persisted on disk |
| ⏸ | Pause / resume / cancel | keeps `.part`, cancel can delete the file |
| 🧮 | Task queue | N concurrent tasks (default 2), the rest queue FIFO |
| 🐢 | Rate limit | token bucket, global and per task |
| 🛡 | Strict validation | `Content-Range` must match; byte counts must match; size changes rejected |
| 🔀 | Single-stream fallback | server ignores Range (200) or compresses the body ⇒ fall back, never write a corrupt file |
| 🕵️ | Stall watchdog | 30 s without data aborts and retries that chunk |
| 📊 | Live progress | progress bar, speed, ETA, chunk counts |
| 📱 | Export to phone | copies the finished file into `Download/DeepSeekHarness` through the DSH device bridge |
| 🔁 | Dedupe | the same URL + target reuses the existing task |
| 🖥 | Cross-platform | Linux / macOS / Windows, Node ≥ 20, no native deps |
| 🧩 | Zero dependencies | Node built-ins only |

## Install

Build an npm-style tarball (`package/` prefix), install it from the DEEPSEEK_HARNESS plugin manager, enable
`chunk-download`, then start a new session:

```bash
rm -rf /tmp/tarpkg && mkdir -p /tmp/tarpkg
cp -a dsh-chunk-download /tmp/tarpkg/package
tar czf dsh-chunk-download-0.1.0.tgz -C /tmp/tarpkg package
```

The plugin also injects a short system-prompt section telling the agent to prefer `chunk_download` over `curl` for files.

## Cross-platform

| Platform | Download | Export to phone |
| --- | --- | --- |
| Linux / macOS / Windows | ✅ pure Node (`path`-based, Windows removes an existing target before rename) | — (no device bridge, skipped) |
| Android (DEEPSEEK_HARNESS) | ✅ | ✅ via the 3090 bridge into `Download/DeepSeekHarness` |

Without a device bridge, `export: true` is skipped and recorded as `exportError`; **the download itself is unaffected**.
CI runs the same tests on Ubuntu (Node 20/22/24), macOS (22) and Windows (22).

## Usage

```jsonc
// chunk_download
{ "url": "https://example.com/big.iso", "connections": 16, "export": true, "waitMs": 60000 }

// chunk_download_status
{ "id": "dl_xxx" }                       // one task, or omit id for the whole queue

// chunk_download_control
{ "id": "dl_xxx", "action": "pause" }    // pause | resume | retry | cancel | remove | export

// chunk_download_wait
{ "id": "dl_xxx", "timeoutMs": 120000 }
```

Direct links often require identifying headers:

```jsonc
{ "url": "https://cdn.example.com/f.zip", "headers": { "referer": "https://pan.quark.cn/", "cookie": "..." } }
```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `dir` | `~/Downloads` | default download directory |
| `connections` | `8` | default parallel connections (1–64) |
| `maxConcurrentTasks` | `2` | concurrent tasks |
| `speedLimit` | `0` | global rate limit in bytes/s (0 = unlimited) |
| `exportToPhone` | `false` | export every finished file to the phone |
| `autoResume` | `true` | resume unfinished tasks after a restart |
| `retries` | `4` | per-chunk retries |
| `requestTimeoutMs` | `20000` | probe / connect timeout |
| `stallTimeoutMs` | `30000` | idle timeout for a single request |
| `stateDir` | `$DSH_HOME/chunk-download` | task state directory |
| `promptSection` | `true` | inject the "prefer this plugin" system-prompt section |

## Benchmarks

| Scenario | curl (1 connection) | this plugin | Gain |
| --- | --- | --- | --- |
| 4 MB, server caps each connection at 256 KB/s, 8 connections | 15.86 s | **2.03 s** | **7.8×** |
| 2 MB, same setup (`bench/speedup.mjs`) | 8.32 s | **1.26 s** | **6.6×** |
| 50.65 MB real CDN (npmmirror, single connection unthrottled) | 7.5 s | 7.05 s | ≈1× (link saturated) |

## Development

```bash
git clone https://github.com/CXk253-chenxing/dsh-chunk-download.git
cd dsh-chunk-download
node --test                 # 16 tests, local HTTP servers only
node bench/speedup.mjs 2    # speed-up demo
```

## Limitations

- Direct links only — no cloud-drive share-link parsing, no HLS/DASH/magnet;
- servers without Range support can only be downloaded single-stream (no resume);
- very high connection counts may hit per-IP limits (429 / resets) — lower `connections`.

## Credits & License

Chunk planning and validation rules were inspired by the Android downloader kernel of
[YunX](https://github.com/CYQawa/YunX) (Kotlin). This repository is an independent Node reimplementation.

[MIT](LICENSE) © 2026 &lt;your-name&gt;
