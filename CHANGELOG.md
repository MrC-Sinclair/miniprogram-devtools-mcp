# 更新日志

本项目版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`。

## [0.5.0] - 2026-10-21

（0.5.0 为首次发布到 npm 的版本；此前 0.1.0–0.4.0 仅存在于本地开发，未上 registry。）

### Changed

- 跟随微信开发者工具 2.02.2609231 RC / wechatide-skill v0.3.11 / miniprogram-automator 0.13.0
  （2026-10-15 发布）验证：`miniprogram-automator` 依赖 `^0.12.1` → `^0.13.0`。
  注意 0.x 的 caret 不会跨 minor，不手动改永远升不上来。API 层全兼容
  （connect / pageStack / navigateTo / navigateBack / currentPage / evaluate /
  callWxMethod / page.\$ / setData / 元素操作均未变）；`disconnect()` 由同步改异步，
  本 MCP 调用点本就全部 await，且顺带修复了旧版 dispose 不等待 ws 关闭的问题。
  0.13.0 新增 `mp.native()`（鸿蒙原生操控）与 `mp.CDP()`（CDP 透传），暂未封装。

### Added

- **连接自愈（统一机制）**：`dispatch()` 新增 `ensureAlive` 闸门，所有依赖连接的工具
  （automator 直连 14 个 + wechatide 需项目窗口的 7 个）调用前先探活，死了自动重连。
  背景：IDE 重启 / 9420 被占用 / 久置不用都会让 ws **静默断开**，而 `mp` 仍是非 null 的
  死引用——旧逻辑只查 `mp` 是否为 null，于是放行，下游抛一堆底层 ws 错误，表现为
  「截图/console 偶发失败、重试又好了」，Agent 无法据此自助恢复。现在这一层在入口处拦掉：
  活着直接放行，死了自动重连，仍连不上才返回 `connection_lost` 结构化 blocker。
  探活结果有 2s 缓存窗口（`WECHAT_DEVTOOLS_ALIVE_CACHE_MS`），连续调用几乎零额外开销；
  `WECHAT_DEVTOOLS_AUTO_HEAL=0` 可退回旧行为（用于测试旧路径）。
  经两类场景实测：主动 `disconnect` 后直接调 `evaluate` / `simulator_screenshot`；
  以及双实例抢 9420 造成 A 静默死亡后直接调用——均自愈成功。

### Changed

- `e2e-all-tools.js` 新增 `E2E_SAFE=1` 安全模式：跳过 `rebuild` / `build_npm`
  （仅有的两个会改项目状态的工具），其余 60+ 项照跑。让「跑一遍验证」变成随时可做、
  不需要人事先批准的动作；要覆盖它们时不设该变量即可。
- `e2e-all-tools.js` 组1 的 `evaluate` / `get_data` / `page_stack` 三条断言随自愈上线改契约：
  由「未连接时应抛 Not connected」改为「未连接时应自动重连并成功」。组1 更名为
  「静态工具 + 自愈契约」。当前安全模式全量结果：PASS 60 / FAIL 1 / WARN 4 / SKIP 5，
  唯一 FAIL 与 4 个 WARN 均源于本机缺少 `e2e.config.js`（回落到 example 的占位符），与本次改动无关。
- `wechatide_status` 新增官方 skill 版本自检：向 `check_wechatide_status` 上报本 MCP
  验证过的官方 skill 版本（`lib/wechatide.js` 的 `TESTED_SKILL_VERSION`，当前 `0.3.11`），
  官方 skill 随工具升级后返回 `versionRelation: agent_behind` 并附升级提示——
  把「开发者工具更新后本 MCP 要不要跟进」变成 MCP 的自诊断信息。新增 `skillVersion` 参数可覆盖。
- 新增 `wechatide_help` 工具（第 31 个）：官方 wechatide 工具的**动态发现**，离线可用
  （不连 IDE、不触发授权）。不传 `tool` 返回当前开发者工具内置的完整工具清单
  （分组/摘要/必填参数/废弃标记/官方 skill 版本）；传 `tool` 返回该工具完整参数定义
  （含 action 枚举）。数据源为官方 skill 目录的 `tools.yaml` 权威定义，
  回落 `wechatide --help` 解析——官方增改废工具实时反映，本 MCP 不再硬编码官方工具清单，
  从机制上保证「对比不漏」。注意 CLI `--help` 不展示 deprecated 工具
  （当前 `project_setting_get` / `project_setting_update` 均已被官方废弃，
  改为直接读写 `project.config.json`），故以 tools.yaml 为准。
- `upload` / `auto_preview` 工具描述补入官方 pendingTask 恢复规则：重发前必须先用旧
  `taskId` 调 `wechatide_poll_task`（pending 不重发 / success 用旧结果 / 仅
  failed·cancelled·expired 才重发）。

### Fixed

- `wechatide_call` 透传的对象/数组参数修复：`buildFlags` 此前用 `String(value)`，
  对象参数会变成 `"[object Object]"`、数组变成 `"a,b"`——命令不报错但语义全丢（静默传错）。
  现按官方 CLI 的 `<json>` 参数约定序列化为 JSON 文本；超大 JSON 可用官方
  `--<参数>-file <path>` 变体（`wechatide_help` 会展示该变体）。
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
