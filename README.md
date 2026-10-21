# miniprogram-devtools-mcp

[![npm version](https://img.shields.io/npm/v/miniprogram-devtools-mcp.svg)](https://www.npmjs.com/package/miniprogram-devtools-mcp)
[![license](https://img.shields.io/npm/l/miniprogram-devtools-mcp.svg)](./LICENSE)

操控微信开发者工具的 MCP server，31 个工具：

- **automator 直连（20）**：ws 连调试端口（9420）——执行 JS、读写 data、导航、元素操作、静态自检 `preflight`、坏状态自愈 `rebuild`、运行时用例
- **官方 wechatide CLI 封装（11）**：模拟器截图、console/network 日志、预览、上传体验版、项目列表、云开发透传，以及 `wechatide_help` 官方工具动态发现

## 与官方 MCP 的差异

官方 2.x 开发者工具自带 `wechatide mcp`（49 工具，需独立 MCP Token）。两者可共存，但**不要同时驱动同一项目的自动化**（9420 单连接）。选这个的理由：

- **同步快车道**：ws 直连，`evaluate` 100-500ms；官方 `automation_*` 每次调用走异步 task + 授权摩擦
- **零配置**：路径 / 端口 / 项目全自动探测，一次授权弹窗后免确认；官方 MCP 要手动复制配置 + 填 MCP Token
- **编排是代码，不是提示词**：授权等待、轮询、错误分类已代码化，失败返回结构化 blocker，不占 AI 上下文
- **自愈与用例体系**：`preflight` 静态自检、`rebuild` 坏状态自愈、`checks/` 运行时用例框架——官方没有对应物
- **细节增强**：tabBar 页自动降级 switchTab、`delta` 越界自动收敛、GBK/UTF-8 混排解码

长尾能力不镜像、不硬编码：`wechatide_call` 透传 + `wechatide_help` 动态发现，官方增改废工具实时反映。官方 skill 升级后 `wechatide_status` 返回 `versionRelation: agent_behind` 提示跟进。

> 第三方开源工具，非腾讯官方出品；仅调用开发者工具自带的 `cli` / `wechatide` 接口，不分发不逆向。
> ⚠️ 提供任意 JS 执行能力，仅用于本机受信任环境；发布类工具只在明确要求时触发。

## 安装

npx（推荐）——加入 MCP 客户端的 `mcpServers`，重启客户端：

```json
"wechat-devtools": {
  "command": "npx",
  "args": ["-y", "miniprogram-devtools-mcp"],
  "env": {}
}
```

其他方式：克隆源码 `npm install && npm run smoke`；团队共用放进项目 `mcp/` 子目录；离线拷贝整个目录（含 `node_modules`）后把 `args` 指向 `index.js`。配置位置：Cursor `~/.cursor/mcp.json`、Claude Desktop `%APPDATA%\Claude\`、Trae `%APPDATA%\Trae CN\User\mcp.json`、WorkBuddy `~/.workbuddy/mcp.json`。

## 环境

Node ≥ 18；微信开发者工具稳定版 1.06+（推荐 2.x，需带 `cli.bat` / `wechatide.cmd`；官方 skill 兼容门槛 2.02.2607152+）。Windows / macOS。

零配置：项目路径、cli 路径、wechatide 路径、端口（9420-9430 扫描）全部自动探测；需要时可用 `WECHAT_DEVTOOLS_CLI` / `WECHAT_DEVTOOLS_PROJECT` / `WECHATIDE_CLIENT` 等环境变量覆盖。首次调用 wechatide 系工具会弹一次授权框（客户端名 `miniprogram-mcp`），点同意后免确认。

## 使用

AI 对话里说人话即可（"连上开发者工具" → `ensure_ready`；"读一下 globalData" → `evaluate`；"截个图" → `simulator_screenshot`；"看看 console" → `get_simulator_console`），或一键 `auto_test`：定位项目 → 连接 → `preflight` → 跑用例，返回 pass / blocker / hint。

### 连接自愈：不必记得先连接

所有依赖连接的工具（automator 直连 14 个 + wechatide 需项目窗口的 7 个）在 `dispatch()` 统一过一道 `ensureAlive` 闸门：**活着直接放行，死了自动重连，仍连不上才返回 `connection_lost` 结构化 blocker。**

IDE 重启 / 9420 被别的客户端占用 / 久置不用都会让 ws 静默断开，而 `mp` 引用还在——旧逻辑只查 `mp` 是否为 null，于是放行，下游抛一堆底层 ws 错误，表现为「截图/console 偶发失败、重试又好了」。现在这一层在入口处拦掉，调用方不需要记得先 `ensure_ready`，每个 handler 也不必各写一遍重试。

- 探活有 2s 缓存窗口（`WECHAT_DEVTOOLS_ALIVE_CACHE_MS` 可调），连续调用几乎零额外开销
- `WECHAT_DEVTOOLS_AUTO_HEAL=0` 退回旧行为（只查 `mp` 是否为 null），用于对比测试
- `ensure_ready` 仍然值得显式调用：它会等运行时就绪，避免冷启动后首条调用超时

### automator 直连（20）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `auto_test` | 一键联调：定位项目 → 连接 → preflight → run_check，合并报告；preflight 有 error 时短路 | `projectPath`、`port`、`checkName` |
| `ensure_ready` | 确保调试就绪（扫端口→启动 cli.bat→连接），失败返回结构化 blocker | `projectPath`、`port` |
| `connect` / `disconnect` / `status` | 连接 / 断开（不关 IDE）/ 查状态与当前页 | `port`（默认 9420） |
| `evaluate` | 逻辑层执行 JS 函数 | `fn`（必填，函数表达式如 `() => 1+2`） |
| `page_stack` / `get_current_page` | 页面栈 / 当前页（路径、query、data） | — |
| `navigate_to` / `navigate_back` | 跳转 / 返回；tabBar 页自动降级 switchTab，delta 越界自动收敛 | `url`；`delta` |
| `call_wx_api` | 调同步 `wx.*` API | `method`（必填）、`args` |
| `get_data` | 读当前页 data | — |
| `element_tap` / `element_input` / `element_scroll` | 点击 / 输入 / 滚动（容器级仅 `<scroll-view>`） | `selector`、`value`、`x`、`y` |
| `preflight` | 静态自检（免连 IDE）：JSON / 页面源码 / 组件四件套 / tabBar / miniprogram_npm / 端口 | `projectPath`、`port` |
| `rebuild` | close→open→auto 自动重编译并重连，自愈 IDE 坏状态 | `projectPath`、`port`、`timeoutMs` |
| `build_npm` | `cli build-npm`，修 preflight 的 npm 未构建告警 | `projectPath` |
| `list_checks` / `run_check` | 列出 / 执行 `checks/` 用例（run_check 需先 ensure_ready） | `name`、`projectPath` |

### 官方 wechatide CLI 封装（11）

走 `wechatide.cmd`（随官方工具升级），不依赖官方 MCP 配置；授权等待、异步轮询、错误分类已在 `lib/wechatide.js` 代码化。需要动手的操作（授权 / 上传确认）短等后返回 `{pending, taskId, userAction}`，转告用户后用 `wechatide_poll_task` 续查。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `wechatide_status` | 登录态 / 当前用户 / CLI 令牌 / 官方 skill 版本关系 `versionRelation`；首次触发授权弹窗 | `client`、`token`、`skillVersion` |
| `wechatide_poll_task` | 查异步任务结果 | `taskId`（必填） |
| `wechatide_help` | 官方工具动态发现（离线）：不传 tool 返回完整清单（分组/摘要/必填/废弃标记/skill 版本），传 tool 返回完整参数（含 action 枚举） | `tool`、`client`、`token` |
| `simulator_screenshot` | 截模拟器，返回 `{path, imageWidth, imageHeight}` | `path`、`wait`、`waitForSelector`、`quality` |
| `get_simulator_console` / `get_simulator_network` | 读 console / network 缓冲区（grep 过滤）。Windows 下正则须用单引号 | `command`（默认 `grep -n .`） |
| `create_preview_qrcode` / `auto_preview` | 预览二维码 / 直推开发者微信 | `pagePath`、`query`、`scene` |
| `upload` | 上传体验版（需人工确认）；重发前必须先查旧 taskId（pending 不重发） | `version`（必填）、`desc` |
| `project_list` | 已导入项目（只读） | `scope` |
| `wechatide_call` | 透传任意未封装官方工具（cloud_*、compile_wxml/wxss、simulator_open_page、login 等，清单用 wechatide_help 查）；automation_* 需先 disconnect；破坏性操作需 `{"confirm": true}` | `tool`（必填）、`args`（JSON 值自动序列化） |

`evaluate` 的 `fn` 必须是函数表达式；`call_wx_api` 仅支持同步 API（异步用 `evaluate` 包 Promise）。

## 故障排查

| 现象 | 处理 |
|---|---|
| 服务端口已关闭 | 设置 → 安全设置 → 打开「服务端口」（是设置页那个端口，不是 9420） |
| 返回 `{pending, taskId, userAction}` | 不是出错：按 userAction 在工具里操作，再 `wechatide_poll_task` 续查 |
| 登录失效 | 扫码登录后重试 |
| `wechatide_auth_required` | 冷启动未完成或需重新授权：等 10-20s 或点「同意」，别改安全设置 |
| `task_not_found` | taskId 已失效：重新调用原工具，别继续轮询 |
| `ide_window_not_active` | 项目窗口没打开 / 最小化到托盘：切到前台再试 |
| 单个工具卡满超时 | `projectPath` 大小写与 DevTools 记录不一致：留空走自动探测 |
| `command_quote_issue` | Windows 吞双引号：grep 正则用单引号 `'error\|fail'` |
| connect 失败 / 超时 | 端口没起：AI 调 `ensure_ready`，或手动 `cli.bat auto --project X --auto-port 9420`，等 30s |
| `evaluate` 报 Unexpected number | `fn` 须是函数表达式 `() => ...` |
| `element_tap` 报 Element not found | 选择器不对 / 未渲染：先 `get_current_page`，异步渲染等 1s |
| 客户端看不到工具 | mcp.json 格式错误或没重启客户端 |
| 偶发失败、重试又好了 | ws 静默断开，已由连接自愈自动处理。若设了 `WECHAT_DEVTOOLS_AUTO_HEAL=0`，去掉即可恢复自愈 |
| `connection_lost` | 自动重连也没成功：按 hint 重试，或 `rebuild` 自愈 IDE 坏状态 |

中文 Windows 的 GBK/UTF-8 混排解码与六类 blocker 分类已在 `lib/` 代码化。

## 限制

BLE 不可用（模拟器 `brand: devtools`）；`call_wx_api` 仅同步 API；真机行为可能与模拟器不同；`launch` 模式在 Windows + Node 18+ 上不可用（仅 `connect`）。

## 开发

`node --check index.js` → `npm run smoke`（免 IDE）→ `node e2e-all-tools.js`（需 IDE，产物 gitignore 勿提交）。自定义用例放 `checks/*.js`（通用）或 `checks/examples/`（项目专属），模板 `_template.js`。发布：`npm version minor && npm publish`（`files` 白名单须含 `smoke.js`）。

## License

MIT
