# 更新日志

本项目版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`。

## [Unreleased]

### Fixed

- `wechatide` 通道新增 `wechatide_auth_required` 错误分类：官方 CLI 输出
  `Failed to connect to WechatIDE` / `requires toolCall:auth` 时不再落入通用错误
  让 Agent 原地重试，而是返回定向 blocker 并提示点「同意」授权。
  此前该现象常被 automator 通道误判成 `port_disabled`，引导使用者白改安全设置。
- `wechatide` 通道新增 `task_not_found` 错误分类：官方返回 `ok:false` + `Task not found`
  时不再空转到 deadline，而是一次抛出定向 blocker，提示重新调用原工具而非继续轮询同一个 `taskId`。
- `README.md` 同步补充上述两种报错的排查条目。

## [0.4.0] - 2026-09-18

首个公开发布。30 个工具，双通道设计。

### Added

- **automator 直连（20 个工具）**，通过 `ws://127.0.0.1:9420` 调试小程序：
  - `evaluate` 在逻辑层执行任意 JS 函数
  - `call_wx_api` 调用同步 `wx.*` API
  - 页面栈与导航：`page_stack` / `navigate_to`（目标为 tabBar 页自动降级 `switchTab`）/ `navigate_back` / `get_current_page`
  - 页面数据与元素：`get_data` / `element_tap` / `element_input` / `element_scroll`
  - 自检与自愈：`preflight` 静态自检、`rebuild`（close → open → auto 重编译并自动重连）、`build_npm`
  - 运行时用例体系：`list_checks` / `run_check`，`checks/` 下自动发现，内置通用用例 `smoke-basic`
  - `ensure_ready` 自动拉起自动化端口，`auto_test` 零参数一键联调
- **官方 wechatide CLI 封装（10 个工具）**，补齐 automator 覆盖不到的能力：
  模拟器截图、console / network 日志、预览二维码、预览推送微信、上传体验版、项目列表、状态查询、异步任务轮询，
  以及 **`wechatide_call` 通用透传**——官方 CLI 的长尾工具（云开发、编译诊断、项目管理等）基本都可达。
- **零配置可移植**：项目根目录 / `cli` 路径 / `wechatide` 路径 / 端口全部自动探测，
  含从微信开发者工具的「最近打开项目」记录兜底定位项目；均可用环境变量覆盖。
- **中文 Windows 编码修复**：CLI 输出改为逐行 UTF-8 试探 + GBK 回落，
  解决 GBK 与 UTF-8 混排导致的中文乱码，以及依赖中文文案的错误识别静默失效。

[Unreleased]: https://github.com/MrC-Sinclair/miniprogram-devtools-mcp/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/MrC-Sinclair/miniprogram-devtools-mcp/releases/tag/v0.4.0

> `Unreleased` 与 `0.4.0` 的比较链接需在本仓库打上 `v0.4.0` tag 后才生效：
>
> ```bash
> git tag -a v0.4.0 -m "v0.4.0"
> git push origin v0.4.0
> ```
