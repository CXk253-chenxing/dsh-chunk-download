# Changelog

版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)；本项目处于 `0.x`，接口仍可能调整。

## [0.3.1] - 2026-10-25

### 修复

- **某个槽位不存在不再拖垮整个客户端**：`slots.inject` 在缺少该槽位的布局（如手机端的
  `sidebar.footer.action`）会抛错，之前一个失败就中断 apply，导致三个入口全部注册不上。
  现在逐个 `mount()` 并各自 try/catch，互不影响。
- 新增 `/chunk-download/ui-log` 路由：客户端把 apply / 注册 / 错误写回
  `~/.dsh/chunk-download/ui.log`，没有控制台也能排查。

## [0.3.0] - 2026-10-25

### 界面

- **新增输入框上方的整条下载进度**（`conversation.input.dock`）：手机端原先看不到侧边栏，现在任务一开始
  就能在输入框上方看到文件名 / 进度条 / 百分比 / 速度，并可直接暂停或取消；点开是完整面板。
- **桌面端面板改到右下角浮动卡**（400px），不再贴着侧边栏；手机端仍是底部抽屉。
- 面板新增「导出到手机」按钮（已完成但未导出的任务）。
- 三个入口（标题栏胶囊 / 输入框下载条 / 侧边栏行）共用同一份数据与同一个面板，互不重复渲染。

## [0.2.3] - 2026-10-25

### 变更

- **许可证由 MIT 改为 AGPL-3.0-or-later**：本项目的分片规划、校验、回退、限速与测速思路参考自
  [YunX（云析）](https://github.com/CYQawa/YunX)（AGPL-3.0），按上游协议要求同样以 AGPL-3.0 开源；
  二次分发或以其提供网络服务时需一并开源。
- README（中/英）新增「许可与致谢」段，LICENSE 换成 AGPL-3.0 全文。

## [0.2.2] - 2026-10-25

### 修复

- **不再占用 `shell.overlay` 全屏悬浮槽位**：该槽位是帧级浮层，任何注册者都会在上面盖一层，
  导致桌宠（dsh-pet-luotianyi）等同样挂在 overlay 的插件**看得见但点不到/拖不动**。
  面板改为挂在「标题栏胶囊 / 侧边栏行」自己的子树里（`position: fixed`），行为不变、不再压别人。

## [0.2.1] - 2026-10-25

分发与文档版本，无代码改动。

### 变更

- README 改为「手机端下载助手」开场，新增**适合谁**、**同类项目**、**界面示意**
- 新增 [assets/ui-mock.svg](assets/ui-mock.svg)（界面示意，非截图）
- 新增 [docs/publishing.md](docs/publishing.md)：npm 发布、awesome-dsh-plugin 目录 PR、GitHub Release 流程
- 新增 [docs/catalog-entry.yml](docs/catalog-entry.yml)：可直接提交的目录条目
- 基准数据保持 2026-10-25 实测，不再复测（作者处于限速网络）

## [0.2.0] - 2026-10-25

### 新增

- **图形界面（浏览器半身）**
  - 会话标题栏进度胶囊（手机 / 桌面通用）：环形进度 + 百分比 + 实时速度
  - 桌面侧边栏底部任务摘要 + 迷你进度条
  - 浮动面板 / 手机底部抽屉：任务列表、暂停/继续/取消、全部暂停、清理已完成
  - 宿主新增只读接口 `GET /chunk-download/tasks` 与控制接口 `POST /chunk-download/control`
- **SHA-256 校验**：`sha256` 参数，下完逐字节核对；不匹配置为失败，`deleteOnMismatch` 可删坏文件
- **同名文件策略**：`ifExists: overwrite | skip | rename`
- **磁盘预检**：远端给出大小且可用空间不足时，开下前直接拒绝
- **批量下载**：`urls[]` 一次提交最多 20 条，逐条返回结果
- **完成通知**：手机端经 3090 设备桥发通知栏消息（`notifyOnComplete`）
- **批量控制**：`pauseAll` / `resumeAll` / `clear`（工具与面板都能用）
- 测试：23 个用例（引擎 15 + 插件层 5 + 客户端半身 2 + 辅助），三平台 CI

## [0.1.0] - 2026-10-24

首个公开版本：把 Range 分片下载做成 DeepSeek Harness 的 Agent 工具。

### 新增

- `chunk_download` 新建任务（可阻塞等待）：Range 分片并发、同链接去重、单任务限速、可指定保存目录/文件名/请求头
- `chunk_download_status` 查看进度、速度、ETA、分片完成数、队列汇总
- `chunk_download_control` 暂停 / 恢复 / 重试 / 取消 / 删除 / 导出到手机
- `chunk_download_wait` 阻塞等待任务进入终态
- 下载内核：
  - `Range: bytes=0-0` 探测总长，`Content-Range` 严格校验
  - 分片数 = `max(大小档位, 连接数×8)`，单片 ≥256KB，总数 ≤512
  - 盈余片 + 工作窃取，避免尾部塌缩
  - 分片级重试（指数退避）与停滞看门狗（30s 无数据即掐断）
  - 断点续传：分片位图 + 计划签名落盘，计划变化自动作废重下
  - 服务端忽略 Range 或响应被压缩时自动回退单流
  - 令牌桶限速（全局 + 单任务）、5 秒滑动窗口测速
  - 任务队列（并发上限、FIFO）
  - 完成后通过 DSH 设备桥导出到手机 `Download/DeepSeekHarness`
- 系统提示词注入：让 Agent 默认优先用本插件而不是 `curl`
- 跨平台：Linux / macOS / Windows（Node ≥20）；Windows 覆盖同名目标文件前先删除
- 桌面端无设备桥时自动跳过导出，不影响下载
- 测试：16 个用例（引擎 13 + 插件层 3），全部使用本地 HTTP 服务器
- 基准脚本 `bench/speedup.mjs`：模拟单连接限速 CDN 量测加速比
