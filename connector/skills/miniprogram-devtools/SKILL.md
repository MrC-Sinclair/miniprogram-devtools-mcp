---
name: miniprogram-devtools
description: 操控本机微信开发者工具调试小程序。当用户要求截图模拟器、读取页面 data、执行 JS、点击或输入元素、查看 console 与网络日志、生成预览码或上传体验版时使用。
---

# 微信小程序自动化（wechat-devtools MCP）

## 前置条件

这个连接器**操作的是用户本机已安装的微信开发者工具**，不是云端服务。开始前确认：

1. 本机装了微信开发者工具（稳定版 1.06+，推荐 2.x）
2. 工具已登录（未登录时 CLI 会返回 `not_logged_in`，需人工扫码）
3. 目标项目已导入开发者工具
4. 设置 → 安全设置 → 已开启「服务端口」
   - 这是 IDE 的 HTTP 服务端口，**不是** 9420 自动化端口，别搞混
   - 工具大版本更新后该开关可能被重置

任一条不满足，先让用户处理，不要反复重试。

## 连接：不需要手动连

所有依赖连接的工具在调用前会**自动探活并重连**。连接掉了（IDE 重启、久置、端口被占）会自动恢复，不需要先调 `ensure_ready`。

只有两种情况值得显式调用 `ensure_ready`：

- 冷启动后第一次操作 —— 它会等 AppScript 编译完成，避免首条调用超时
- 用户明确说「连上开发者工具」 —— 用它给一个确定的连接反馈

## 工具怎么选

| 用户想做的事 | 用这个 | 关键参数 |
|---|---|---|
| 一键体检：定位项目 → 连接 → 自检 → 跑用例 | `auto_test` | `projectPath`（可自动探测） |
| 只做静态自检（不连 IDE） | `preflight` | `projectPath` |
| 看模拟器画面 | `simulator_screenshot` | `wait`（**秒**，0–10）、`waitForSelector` |
| 读页面数据 | `get_data` | — |
| 查当前页路径与 query | `get_current_page` | — |
| 看页面栈 | `page_stack` | — |
| 执行 JS（读 globalData、调 wx API、算值） | `evaluate` | `fn`（**必须是函数表达式**） |
| 调同步 wx API | `call_wx_api` | `method`、`args` |
| 跳转 / 返回 | `navigate_to` / `navigate_back` | `url`；`delta` |
| 点击 / 输入 / 滚动 | `element_tap` / `element_input` / `element_scroll` | `selector`、`value`、`x`、`y` |
| 看 console | `get_simulator_console` | `command`（grep 字符串） |
| 看网络请求 | `get_simulator_network` | `command` |
| 查开发者工具登录态 | `wechatide_status` | — |
| 官方工具清单与参数 | `wechatide_help` | `tool`（不传则列全部） |
| 调未封装的官方工具 | `wechatide_call` | `tool`、`args` |
| 已导入项目列表 | `project_list` | `scope`（找不到项目时用 `all`） |

## 常用组合

**「看看现在这个页面」**

```
get_current_page  →  simulator_screenshot  →  get_simulator_console
```

**「这个功能坏了，帮我查」**

```
get_simulator_console { command: "grep -i error" }
get_simulator_network { command: "grep -i fail" }
```

**「改一下页面状态再验证」**

```
evaluate { fn: "() => { getApp().globalData.debug = true; return true }" }
→ get_data 确认
→ simulator_screenshot 留证
```

**「从零验证一个项目」**

```
auto_test   ← 定位 → 连接 → preflight → 跑用例，一次返回 pass / blocker
```

## 参数易错点

- `evaluate.fn` **必须是函数表达式**：`() => 1 + 2`、`function () { return 1 }`。
  传裸表达式 `1 + 2` 会报 `Unexpected number`。
- `simulator_screenshot.wait` 单位是**秒**，范围 0–10。传 1500 会被拒。
- `get_simulator_console.command` 是 grep 命令字符串。
  Windows 下正则必须用**单引号**：`grep -iE 'error|fail'`，双引号会被命令行吞掉。
- `element_scroll` 的容器级滚动仅支持 `<scroll-view>`。
- `call_wx_api` 只支持**同步** API；异步的用 `evaluate` 包 Promise。

## 常见 blocker 与处理

| 返回 | 含义 | 怎么办 |
|---|---|---|
| `port_disabled` | IDE 服务端口没开 | 让用户去 设置 → 安全设置 → 开启「服务端口」 |
| `not_logged_in` | 开发者工具未登录 | 让用户扫码登录后重试 |
| `not_installed` | 找不到 cli.bat | 让用户确认安装路径，或设 `WECHAT_DEVTOOLS_CLI` |
| `project_path_required` | 探测不到项目 | 传 `projectPath`（小程序项目绝对路径） |
| `connect_failed` | 端口通但握手失败 | 项目可能还在编译，等 30 秒重试 |
| `connection_lost` | 自动重连也失败 | 重试一次；仍失败用 `rebuild` 自愈 IDE 坏状态 |
| `ide_window_not_active` | 项目窗口没开或最小化 | 让用户切到前台 |
| `runtime_not_ready` | AppService 还在编译 | 等一会儿再试，或 `rebuild` 强制重编译 |

返回 `{pending, taskId, userAction}` **不是错误** —— 是需要用户在工具里点一下。
把 `userAction` 原样转告用户，再调 `wechatide_poll_task` 续查。

## 高风险操作

以下操作**必须先获得用户明确同意**，不要自行发起：

- `upload` —— 上传体验版，会写入线上
- `create_preview_qrcode` / `auto_preview` —— 生成预览码、推送到用户微信
- `wechatide_call` 里的破坏性操作 —— 需显式传 `{"confirm": true}`
- `rebuild` —— 会关闭并重开项目窗口，用户正在编辑时可能丢失未保存内容
- `build_npm` —— 会重建 `miniprogram_npm`

`wechatide_call` 调 `automation_*` 系列之前必须先 `disconnect`，否则会和本 MCP 的连接抢 9420。

## 边界

- 模拟器 `brand` 为 `devtools`，**BLE 不可用**
- 真机行为可能与模拟器不同，涉及蓝牙、传感器、性能的结论要提醒用户
- `launch` 模式在 Windows + Node 18+ 上不可用，只能 `connect`
