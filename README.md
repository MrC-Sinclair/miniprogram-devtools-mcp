# miniprogram-devtools-mcp

[![npm version](https://img.shields.io/npm/v/miniprogram-devtools-mcp.svg)](https://www.npmjs.com/package/miniprogram-devtools-mcp)
[![license](https://img.shields.io/npm/l/miniprogram-devtools-mcp.svg)](./LICENSE)

操控微信开发者工具的 [MCP](https://modelcontextprotocol.io/) server（v0.4.0，30 个工具）。双通道设计：

- **automator 直连**（20 个工具）：基于 [miniprogram-automator](https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/)，让 AI 直接调试小程序——读 `globalData`、执行 JS、点击元素、读页面 data、静态自检、坏状态自愈、跑运行时用例
- **官方 wechatide CLI 封装**（10 个工具）：补齐 automator 覆盖不到的能力——模拟器截图、console/network 日志、预览推送、上传体验版、云开发等，并内置 **`wechatide_call` 通用透传**，官方 CLI 工具基本都可达

对官方 2.x 开发者工具（含自带的 wechatide-skill / 内置 MCP）**能力对齐**：官方的高频能力要么有专用入口，要么一条透传即达；官方 skill 里的编排知识（授权等待、异步轮询、错误分类）已全部代码化。

> **免责声明**：本项目是**第三方开源工具，非腾讯 / 微信官方出品**，与微信团队无任何隶属或合作关系。
> "微信""微信小程序""微信开发者工具"等相关名称与商标归腾讯所有，此处仅作描述性引用。
> 本项目只是调用开发者工具自带的 `cli` / `wechatide` 命令行接口，不修改、不分发、不逆向任何官方程序。
> 使用本项目产生的预览、上传、发布等操作，后果由使用者自行承担。

> ⚠️ **安全提示**：本 MCP 提供 `evaluate` / `call_wx_api` 等**任意 JS 执行**能力，等价于把小程序逻辑层的完整控制权交给 AI。
> 请仅在**本机受信任环境**中使用：不要把它暴露到公网、不要挂在多人共享的远程服务上、不要让不受信任的人间接调用。
> 发布类工具（`upload` / `auto_preview` / `create_preview_qrcode`）只应在你明确要求时触发。

---

## 目录

- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [安装](#安装)
- [免安装分发（离线拷贝）](#免安装分发离线拷贝)
- [环境适配（可移植性）](#环境适配可移植性)
- [启动](#启动)
- [运行与使用](#运行与使用)
- [MCP 工具列表](#mcp-工具列表)
- [与官方内置 MCP 的关系](#与官方内置-mcp-的关系)
- [注册到 MCP 客户端](#注册到-mcp-客户端)
- [发布到 npm](#发布到-npm)
- [故障排查](#故障排查)
- [限制与边界](#限制与边界)
- [开发](#开发)

---

## 工作原理

```
MCP 客户端（Cursor / Trae / Claude Desktop…）
   │ stdio
   ▼
miniprogram-devtools-mcp（Node 进程）
   │
   ├── [automator 直连，20 工具]
   │      └── ws://127.0.0.1:9420 ──▶ 微信开发者工具自动化端口（cli.bat auto 拉起）
   │            调试 / 自检 / 自愈 / 用例
   │
   └── [wechatide CLI 封装，10 工具]
          └── spawn wechatide.cmd ──▶ IDE HTTP 服务端口（如 48819，设置-安全设置里那个）
                截图 / 日志 / 预览 / 上传 / 云开发 / 透传任意官方工具
```

**关键点**：

- MCP server 进程由客户端自动拉起（stdio 传输），无需手动启动
- 自动化端口（默认 9420）由 `ensure_ready` 自动启动：内部 spawn `cli.bat auto`，不受 IDE sandbox 影响
- wechatide 通道走 IDE 的 **HTTP 服务端口**（与 9420 自动化端口是两个东西），与 automator 会话互不干扰
- **零参数自愈**：项目路径、cli 路径、wechatide 路径、端口全部自动探测，`auto_test` 可以不带任何参数调用
- 两条通道分工明确：automator 系工具不碰 HTTP 端口，wechatide 系不碰 9420——没有会话冲突

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | MCP SDK 与 miniprogram-automator 要求 |
| 微信开发者工具 | 稳定版 1.06+，**推荐 2.x** | 需带 `cli.bat`/`cli`；2.x 自带 `wechatide.cmd`（截图/日志/预览/上传/透传依赖它） |
| 操作系统 | Windows / macOS | Linux 不支持微信开发者工具 |
| npm | ≥ 9 | 随 Node 安装 |

**首次使用 wechatide 系工具**会触发一次客户端授权弹窗（默认客户端名 `miniprogram-mcp`），在开发者工具里点同意即可，之后免确认。

**Windows 上 `cli.bat` 默认路径**：

- 默认安装：`C:\Program Files (x86)\Tencent\微信web开发者工具\cli.bat`
- 用户安装：`%USERPROFILE%\AppData\Local\微信开发者工具\cli.bat`
- 自定义盘符 / 非默认位置：`findCli` 会浅扫描 C:/D:/E: 自动发现（含装在子目录的情形），或设 `WECHAT_DEVTOOLS_CLI` 环境变量指定
- `wechatide.cmd` 自动在与 `cli.bat` 同目录寻找，无需配置

**macOS 上 `cli` 默认路径**：

```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli
```

---

## 安装

### 方式一：npx 直接跑（推荐）

不用克隆仓库，也不需要手动 `npm install`，在 MCP 客户端里这样注册即可：

```json
"wechat-devtools": {
  "command": "npx",
  "args": ["-y", "miniprogram-devtools-mcp"],
  "env": {}
}
```

首次运行会自动下载，之后走本地缓存。

### 方式二：克隆源码本地运行

需要改代码或参与开发时用：

```bash
git clone https://github.com/MrC-Sinclair/miniprogram-devtools-mcp.git
cd miniprogram-devtools-mcp
npm install
npm run smoke      # 冒烟自检：确认 30 个工具可列出、preflight 无 error
```

### 方式三：放进小程序项目子目录（团队共用）

把本目录拷进小程序仓库的 `mcp/miniprogram-devtools-mcp/` 并提交，随代码一起走版本库，团队成员拉取代码后：

```bash
cd mcp/miniprogram-devtools-mcp
npm install
npm run smoke
```

> `node_modules/` 不随 git 提交，换机器后**必须**重新 `npm install`（已带 `package-lock.json`，装出来版本一致）。
> 想省掉安装步骤，就把整个目录连 `node_modules/` 一起打包拷贝（见下一节）。

---

## 免安装分发（离线拷贝）

目标机器不能联网 / 不想跑 `npm install` 时，直接把**整个目录（含已装好的 `node_modules/`）** 压缩带走，解压后注册 MCP 即可，零安装。

```powershell
# 在 miniprogram-devtools-mcp/ 目录下执行，打包成 ../miniprogram-devtools-mcp.zip
Compress-Archive -Path .\* -DestinationPath ..\miniprogram-devtools-mcp.zip
```

换机器后：解压 → 在 MCP 客户端把 `args` 指向解压出的 `index.js` 绝对路径 → 即可使用。

**除注册时需填一个 `index.js` 路径外，项目路径 / cli 路径 / wechatide 路径 / 端口 / 运行时用例全部由 AI 自动探测与执行，不需要任何人手写配置。**

> 提示：`node_modules/` 含平台相关文件，跨 Windows/macOS 混用请重新打包对应平台；同平台（x64 Windows）直接拷贝即用。

---

## 环境适配（可移植性）

> 目标：换一台机器 → `npm install` → 注册 MCP → 全自动跑完小程序测试，**不依赖某台电脑、某个小程序**。

### 不需要改任何代码就能适配的环境差异

| 环境差异 | 处理方式 |
|---|---|
| 微信开发者工具安装位置不同 | `findCli()` 依次探测候选路径 + 浅扫描常见安装目录；也可设 `WECHAT_DEVTOOLS_CLI` |
| wechatide 位置不同 | 与 `cli.bat` 同目录自动发现；也可设 `WECHAT_DEVTOOLS_WECHATIDE` |
| 操作系统不同 | Windows 用 `cmd.exe /c cli.bat`，macOS 直接执行 `cli`（见 `lib/config.js`） |
| 小程序项目路径不同 | `resolveProject()` 四级兜底：显式参数 → `WECHAT_DEVTOOLS_PROJECT` → 从 cwd / MCP 目录向上找 `project.config.json` → **读 DevTools 的「最近打开项目」列表**（多个候选中优先根目录有 `app.json` 的原生小程序，避免选中 Taro 这类编译型项目） |
| 自动化端口不是 9420 | 默认端口未监听时自动扫描 9420-9430，命中即用；也可显式传 `port` |
| 测试的小程序不同 | `preflight` 基于 `app.json` 动态推导；`checks/` 只放**通用**用例（如内置 `smoke-basic`），不依赖任何具体页面 |

**项目路径自动探测的最后一级**依赖 DevTools 自己写的本地记录，无需任何配置：

```text
%LOCALAPPDATA%\微信开发者工具\User Data\<hash>\WeappLocalData\
  ├── hash_key_map_2.json                 ← key→文件名 映射（value 为 last_all_projects）
  └── localstorage_<hash>.json            ← [{ "projectid": "<项目绝对路径>" }, ...]
```

所以即使 MCP 放在项目外、cwd 也不在项目内，只要你用 DevTools 打开过该项目，就能被自动定位。

### 环境变量（可选覆盖）

```bash
# Windows
set WECHAT_DEVTOOLS_CLI=C:\path\to\微信web开发者工具\cli.bat
set WECHAT_DEVTOOLS_WECHATIDE=C:\path\to\微信web开发者工具\wechatide.cmd
set WECHAT_DEVTOOLS_PROJECT=C:\path\to\my-miniprogram
set WECHATIDE_CLIENT=miniprogram-mcp
rem WECHATIDE_TOKEN=仅在安全设置启用 CLI 访问令牌时需要

# macOS
export WECHAT_DEVTOOLS_CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
export WECHAT_DEVTOOLS_WECHATIDE=/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide
export WECHAT_DEVTOOLS_PROJECT=~/code/my-miniprogram
export WECHATIDE_CLIENT=miniprogram-mcp
```

> 这些变量都是**兜底手段**，正常情况下不需要设置。`WECHAT_DEVTOOLS_MAX_OUTPUT` 可调单次工具返回上限（默认 100000 字符）。

### 全自动联调流程（AI 侧）

**首选：一次调用搞定**

```text
auto_test    → 定位项目 → 拉起/连接端口 → preflight → run_check → 返回 pass/blocker/hint
```

**分步调用**（需要单独看某一步结果时）：

```text
1. preflight          → 静态自检（JSON / 页面源码 / 组件四件套 / tabBar / 构建 npm）
2. ensure_ready       → 自动拉起自动化端口并连接
3. run_check          → 跑 checks/ 下所有运行时用例
4. （若报编译坏状态）rebuild → close + open + auto，自动重连，无需人工点编译

> **时序坑**：端口监听 ≠ 小程序运行时就绪。IDE 重启或 build_npm 之后立刻 evaluate 会超时，
> 因此 rebuild 重连后会自动轮询等待运行时 ready（探针要求 getApp() 已实例化），
> run_check 执行前也会先探测一次。
```

实测（Windows）：`auto_test` 零参数约 15-60s 跑完（首次冷启动较慢，热缓存约 20s），`preflight` 0 error 0 warning，`smoke-basic` 用例全部 PASS。

### 新增自己的用例

`checks/` 分两类，**不要混放**：

| 位置 | 用途 | 是否被执行 |
|---|---|---|
| `checks/*.js` | 通用用例（任何小程序都能过） | ✅ 自动发现 |
| `checks/examples/*.js` | 项目专属示例（依赖具体页面/组件） | ❌ 不执行，仅供参考 |
| `checks/_*.js` | 模板 / 草稿 | ❌ 不执行 |

内置 `smoke-basic.js` 是通用用例的标杆：系统信息 → `getApp()` 可达 → 首页可达 → 逐个 `tabBar` 页面 `switchTab` 后校验路由与 `data`，全部从 `app.json` 动态推导，换个小程序照样能过。

写项目专属断言时，复制 `checks/_template.js` 改名（去掉 `_` 前缀）即可，无需改动 server：

```js
module.exports = {
  name: 'my-check',
  description: '我的页面校验',
  async run(ctx) {
    const { mp, withTimeout, sleep } = ctx;
    const page = await withTimeout(mp.currentPage(), 15000, 'currentPage');
    await page.setData({ foo: 1 });
    await sleep(300);
    const el = await page.$('.foo');
    return { pass: !!el, detail: { found: !!el } };
  },
};
```

`ctx` 提供：`mp`（automator 实例）、`automator`、`withTimeout`、`sleep`、`projectRoot`。

> ⚠️ 往 `checks/` 放**依赖具体页面或自定义组件**的用例，会让别人拿到包后 `run_check` 必失败。
> 这类用例请放 `checks/examples/`，或在用例内对缺失页面做 skip 处理。

---

## 启动

### 步骤1：启动微信开发者工具自动化端口（通常无需手动）

> 推荐让 AI 直接调 `ensure_ready`：自动探测端口 → 自动 spawn cli.bat 启动 → 自动连接。
> 仅 DevTools 未安装 / 未登录（需扫码）/ 安全设置未开服务端口时才需人工处理。

手动方式（排障时用）：

**Windows**：

```powershell
& "<cli.bat 路径>" auto --project "<小程序项目路径>" --auto-port 9420
```

**macOS**：

```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto --project "/path/to/your/miniprogram" --auto-port 9420
```

**预期输出**：

```
√ IDE server has started, listening on http://127.0.0.1:19279
√ Using AppID: wx********
√ auto
```

**保持这个窗口开着不要关**。等约 30 秒让项目编译完成。

### 步骤2：验证 9420 端口在监听（可选）

另开一个 PowerShell 窗口：

```powershell
Get-NetTCPConnection -LocalPort 9420 -State Listen
```

看到 `LISTENING` 即可。

### 步骤3：MCP server 不需要手动启动

MCP server 由客户端自动拉起。只要 [mcp.json 已注册](#注册到-mcp-客户端) 且客户端已重启加载，AI 调用 `ensure_ready` / `connect` 时会自动连 9420。

---

## 运行与使用

### 完整调试流程

1. **启动自动化端口**（见[启动](#启动)）
2. **在 AI 对话里提需求**，例如：
   - "连上微信开发者工具" → AI 调 `ensure_ready`
   - "读一下 globalData.userInfo" → AI 调 `evaluate`
   - "切到 pages/index/index 页面" → AI 调 `navigate_to`
   - "调 wx.getSystemInfoSync" → AI 调 `call_wx_api`
   - "当前页面 data 是什么" → AI 调 `get_data`
   - "点列表第一项" → AI 调 `element_tap`
   - "截个图看看现在界面" → AI 调 `simulator_screenshot`
   - "看看 console 有没有报错" → AI 调 `get_simulator_console`
3. **发布类操作**（AI 仅在明确要求时执行）：
   - "生成预览二维码" → AI 调 `create_preview_qrcode`
   - "把预览推到我微信上" → AI 调 `auto_preview`
   - "上传体验版 1.2.0" → AI 调 `upload`
   - "看看云函数列表" → AI 调 `wechatide_call { tool: "cloud_fn_list", ... }`
4. **调试结束**：让 AI 调 `disconnect`，或直接关掉步骤1 的窗口

### 独立运行（不走 AI 客户端，仅用于调试 MCP 本身）

```bash
cd mcp/miniprogram-devtools-mcp
npm start
```

MCP server 通过 stdio 通信，直接跑会等待 stdin 输入。测试协议握手可用：

```bash
# 发送 initialize 请求
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | node index.js
```

### 端到端测试脚本（开发自测用）

如果修改了 `index.js`，建议临时写个一次性脚本，spawn 本 server 后走 JSON-RPC 验证（实现思路可参考仓库内的 `smoke.js`）。

---

## MCP 工具列表

共 30 个工具 = automator 直连 20 个 + 官方 wechatide CLI 封装 10 个。

### automator 直连（20 个）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `auto_test` | **零参数一键联调**：自动定位项目 → 自动拉起/连接端口 → `preflight` → `run_check`，返回带 `pass` / `blocker` / `hint` 的合并报告；preflight 有 error 时短路返回 | 全部可选：`projectPath`、`port`、`checkName` |
| `ensure_ready` | 确保调试就绪（扫端口→自动启动 cli.bat→连接），失败返回结构化 blocker（not_installed / project_path_required / port_disabled / start_timeout / connect_failed） | 全部可选：`projectPath`、`port` |
| `connect` | 连接已运行的自动化端口；端口未监听时改用 ensure_ready | `port`（默认 9420） |
| `disconnect` | 断开连接（不关闭开发者工具） | — |
| `status` | 查询连接状态和当前页面 | — |
| `evaluate` | **核心**：在小程序逻辑层执行 JS 函数 | `fn`（必填，函数表达式字符串，如 `() => 1+2`） |
| `page_stack` | 获取当前页面栈 | — |
| `navigate_to` | 跳转页面（等同 `wx.navigateTo`）；目标为 tabBar 页时**自动降级 switchTab** | `url`（必填） |
| `navigate_back` | 返回上一页（等同 `wx.navigateBack`）；`delta` 超过页面栈深度时自动收敛到栈底，不会空转等待 | `delta`（默认 1，传 0/负数表示不返回） |
| `get_current_page` | 获取当前页面：路径、query、data | — |
| `call_wx_api` | 调用同步 `wx.*` API | `method`（必填）、`args` |
| `get_data` | 读取当前页面 data | — |
| `element_tap` | 点击元素 | `selector`（必填） |
| `element_input` | 在输入框输入内容 | `selector`、`value`（均必填） |
| `element_scroll` | 滚动到坐标 (x, y)；不传 `selector` 为页面级滚动。**容器级滚动只对 `<scroll-view>` 生效** | `selector`（须为 scroll-view）、`x`、`y` |
| `preflight` | **联调前静态自检**（无需连接 IDE）：关键 JSON 可解析 / pages 与分包有源码 / usingComponents 四件套 / tabBar 图标 / miniprogram_npm 已构建 / 端口监听 | `projectPath`、`port` |
| `rebuild` | **自动重编译**：`cli close` → `cli open` → `cli auto` 重启端口并重连，用于「解析 project.config.json 失败」等 IDE 坏状态自愈 | `projectPath`、`port`、`timeoutMs`、`withAutoPort`、`reconnect` |
| `build_npm` | 执行 `cli build-npm`，等价于「工具 → 构建 npm」，修复 preflight 的「miniprogram_npm 为空」告警 | `projectPath`、`timeoutMs` |
| `list_checks` | 列出 `checks/` 下可用运行时用例 | — |
| `run_check` | 执行 `checks/` 下的运行时用例（需先 `ensure_ready`），不传 `name` 则全跑 | `name`、`projectPath` |

### 官方 wechatide CLI 封装（10 个）

补齐 automator 协议覆盖不到的能力，走开发者工具自带的 `wechatide.cmd` 命令（随官方工具升级），
不依赖官方 MCP 配置；编排规则（首次授权弹窗等待、异步任务轮询、错误分类）已在 `lib/wechatide.js`
内代码化。与 automator 直连工具互不抢连接（前者走 IDE HTTP 服务端口，后者走 ws 自动化端口）。

客户端简称默认 `miniprogram-mcp`（须与首次授权弹窗一致），可用参数 `client` 或环境变量 `WECHATIDE_CLIENT`
覆盖；CLI 访问令牌未启用时免传，启用后用参数 `token` 或环境变量 `WECHATIDE_TOKEN`。

**需要用户动手的操作绝不静默阻塞**：首次授权弹窗短等 12s、上传等人工确认短等 45s，
超时即返回 `{pending: true, taskId, userAction, hint}`——AI 应把 `userAction` 原样转告用户
（如「开发者工具弹出了授权框，请点击同意」），用户操作后用 `wechatide_poll_task` 传 `taskId` 续查。
CLI 报服务端口未开/登录失效时返回 `port_disabled` / `wechatide_not_logged_in` blocker，附人工处理指引。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `wechatide_status` | 读取工具状态：登录态/当前用户/是否启用令牌；首次调用触发授权弹窗 | 全部可选：`client`、`token` |
| `wechatide_poll_task` | 查询异步任务结果（`upload` 等返回 `{pending, taskId}` 时续查） | `taskId`（必填） |
| `simulator_screenshot` | 截取模拟器画面，返回 `{path, imageWidth, imageHeight}`，默认 1280 JPEG | `projectPath`、`path`、`wait`、`waitForSelector`、`optimize`、`quality` |
| `get_simulator_console` | 读取 console 日志缓冲区（grep 过滤），返回 `{matched, output}`。**Windows 下正则/含空格的模式须用单引号**，双引号会被命令行吞掉 | `projectPath`、`command`（默认 `grep -n .` 取全部） |
| `get_simulator_network` | 读取 network 请求缓冲区（grep 过滤），返回 `{matched, output}`；引号规则同上 | `projectPath`、`command` |
| `create_preview_qrcode` | 生成预览二维码（window 展示或 image 输出文件） | `projectPath`、`qrFormat`、`qrOutput`、`pagePath`、`query`、`scene` |
| `auto_preview` | 预览直接推送到开发者微信，无需扫码 | `projectPath`、`pagePath`、`query`、`scene` |
| `upload` | 上传代码包发布体验版（需人工确认，可能返回 pending） | `projectPath`、`version`（必填）、`desc` |
| `project_list` | 列出已导入项目（只读）：路径/名称/AppID/类型 | `scope` |
| `wechatide_call` | **通用透传**：调用任意未单独封装的官方工具（cloud_* 云开发、get_user_appids、simulator_refresh、compile_wxml/wxss、debug_clear_cache、login、share_minicode 等）；automation_* 需先 disconnect 释放会话，破坏性操作需 `{"confirm": true}` | `tool`（必填）、`args`（参数对象）、`projectPath`（不传则自动探测并注入 `--project`，与其它 wechatide 工具一致）、`timeoutMs` |

### `auto_test` 返回值示例

```json
{
  "projectPath": "<自动探测到的项目路径>",
  "pass": true,
  "steps": {
    "ensure_ready": { "connected": true, "port": 9420, "startedBySelf": true },
    "preflight":    { "pass": true, "errors": [], "warnings": [] },
    "run_check":    { "pass": true, "total": 1, "passed": 1 }
  },
  "durationMs": 63082
}
```

失败时报告里带 `blocker` 与 `hint`，按提示自助修复（例如 `blocker: preflight_failed` 且是 `miniprogram_npm` 缺失 → 调 `build_npm`；`blocker: port_disabled` → 去安全设置开服务端口）。

### `evaluate` 用法示例

```
fn: () => 1 + 2 + 3                              → 6
fn: () => JSON.stringify(getApp().globalData)    → 完整 globalData
fn: () => getCurrentPages().length               → 页面栈深度
fn: () => wx.getStorageSync('userInfo')          → 读 storage
```

⚠️ `fn` 必须是**函数表达式**（箭头函数或 `function` 形式），不能是裸表达式（`1+2` 会报 "Unexpected number"）。

### `call_wx_api` 用法示例

```
method: "getSystemInfoSync"                       → 系统信息
method: "getStorageSync", args: ["userInfo"]      → 读 storage
method: "getAccountInfoSync"                      → 账号信息
```

⚠️ 仅支持同步 API。异步 API（如 `wx.login`、`wx.request`）请用 `evaluate` 自行包装 Promise。

### `wechatide_call` 用法示例

```
tool: "cloud_fn_list", projectPath: "D:\\code\\my-miniprogram",
args: { "env": "cloud1-xxx" }                    → 云函数列表

tool: "compile_wxml", projectPath: "D:\\code\\my-miniprogram",
args: { "filePath": "pages/index/index.wxml" }   → WXML 编译诊断

tool: "get_user_appids"                          → 当前用户可管理的 AppID 列表
```

---

## 与官方内置 MCP 的关系

微信开发者工具 2.x 自带 wechatide-skill（CLI + Skill 知识包 + MCP 配置三件套，设置页「复制 MCP 配置」）。
本 MCP 与它的关系是**借用能力、不依赖其 MCP**：

| 官方 CLI 工具 | 本 MCP 的覆盖方式 |
|---|---|
| 高频能力（状态/截图/日志/预览/上传/项目列表/构建 npm 等） | **10 个专用封装**，带编排（授权等待、轮询、错误分类）与护栏 |
| automator 原子操作（evaluate/导航/元素/wx API/运行时信息） | **6 组等价直连**（走我们自己的 automator 会话，含 tabBar 降级等增强） |
| 其余长尾（云开发、automation 高阶、项目管理、编译诊断等） | **`wechatide_call` 透传**，一条通吃 |

> 官方 CLI 工具集会随开发者工具版本增减，上表按「能力类型」而非逐个工具名对齐——
> 长尾工具一律走 `wechatide_call` 透传，因此官方新增工具通常无需改动本 MCP 即可调用。

- 官方 skill 的编排规则（门禁检查、异步轮询、错误快表）在本 MCP 里是**代码**，不占 AI 上下文
- 两者可以共存（客户端同时挂官方 MCP 和本 MCP），但**不要同时驱动同一个项目的自动化**——
  自动化端口（9420）是单连接的；本 MCP 未封装 `automation_*`（会与自身会话冲突，透传时会被护栏拦截）
- 官方工具升级后 `wechatide` 命令随之更新，本 MCP 的封装层只要命令名/参数不变就自动受益

---

## 注册到 MCP 客户端

### 用 npx（推荐）

在任意支持 MCP 的客户端里，把下面这段加进配置文件的 `mcpServers`：

```json
"wechat-devtools": {
  "command": "npx",
  "args": ["-y", "miniprogram-devtools-mcp"],
  "env": {},
  "description": "通过 miniprogram-automator + 官方 wechatide CLI 操控微信开发者工具"
}
```

### 用本地源码

把 `args` 指向本地的 `index.js` 即可：

```json
"wechat-devtools": {
  "command": "node",
  "args": ["<本目录绝对路径>/index.js"],
  "env": {}
}
```

⚠️ 路径分隔符在 JSON 里用 `\\`（Windows）或 `/`（macOS）。`node` 需在 PATH 中，否则写 node 绝对路径。

**注册后必须重启客户端**让 MCP server 加载（改了 server 源码同样需要重连）。重启不影响已运行的 `cli.bat auto` 进程。

### 各客户端配置文件位置

| 客户端 | 配置文件 |
|---|---|
| Cursor | `~/.cursor/mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json`（Windows：`%APPDATA%\Claude\claude_desktop_config.json`） |
| Trae | Windows `%APPDATA%\Trae CN\User\mcp.json`，macOS `~/Library/Application Support/Trae CN/User/mcp.json` |
| WorkBuddy | `~/.workbuddy/mcp.json` |

其他客户端同理：找到它的 MCP 配置文件，把上面的 JSON 片段加进 `mcpServers` 即可。

---

## 发布到 npm

> 维护者发布流程。普通用户直接看 [安装](#安装) 用 `npx` 即可。

包已具备发布条件：`type: commonjs`、`bin` 入口已配、`files` 白名单已设、`index.js` 顶部已有 `#!/usr/bin/env node` shebang。`LICENSE` 由 npm 自动打包，无需写进白名单。

```bash
npm login                 # 首次需要，按提示输入用户名 / 密码 / OTP
npm pack --dry-run        # 确认只含 index.js、lib/、checks/、smoke.js、README.md
npm publish               # 首次发布 72 小时内可 npm unpublish，超过不可撤销
```

> 推 GitHub 前先确认这几类文件**没有**进版本库（本机隐私，已在 `.gitignore` 排除）：
> `e2e-report.*`、`e2e-edge-report.*`、`e2e.config.js`、`node_modules/`。
> 检查办法：`git status --porcelain` 里不应出现它们。

验证与迭代：

```bash
npm view miniprogram-devtools-mcp
npm version patch         # 0.4.0 → 0.4.1，bug 修复
npm version minor         # 0.4.0 → 0.5.0，新功能（向后兼容）
npm version major         # 0.4.0 → 1.0.0，破坏性变更
npm publish
```

> ⚠️ `files` 白名单里必须保留 `smoke.js`，否则装包后 `npm run smoke` 会因缺文件失败。

---

## 故障排查

### 报「工具的服务端口已关闭」/ "IDE service port disabled"

**原因**：IDE 的 HTTP 服务端口没开（wechatide/CLI 调用的前提），或工具大版本更新后该开关被重置、端口号变了。注意这是**服务端口**（设置页显示的那个，如 48819），不是 9420 自动化端口。

**解决**：打开开发者工具 → 设置 → 安全设置 → 打开「服务端口」（2.x 首次开启可能要求确认 CLI 能力）→ 重试。`ensure_ready` / `wechatide_call` 遇到此情况会返回 `port_disabled` blocker。

### wechatide 工具返回 `{pending: true, taskId, userAction}`

**原因**：该操作需要你在开发者工具里动手（首次授权、上传确认等），工具短等超时后主动返回，**不是出错**。

**解决**：按 `userAction` 的指引在开发者工具里操作（点同意/确认），然后把 `taskId` 交给 AI 用 `wechatide_poll_task` 续查，或直接重试原工具。

### 登录失效（`wechatide_not_logged_in` / loginExpired）

**解决**：打开开发者工具扫码登录后重试。可先调 `wechatide_status` 确认登录态。

### wechatide 返回 `wechatide_auth_required`（工具未就绪 / 需要重新授权）

**原因**：官方 CLI 输出了 `Failed to connect to WechatIDE` / 提示跑 `wechatide auth -c <client>` /
`requires toolCall:auth`。常见两种情况：开发者工具**冷启动尚未完成**，或某个工具需要一次
**独立的授权握手**（IDE 里会弹「同意」框）。
注意这**不是**服务端口没开、也不是登录失效——冷启动期间安全设置里的端口其实通常是开着的，
照着 `port_disabled` 的指引去改设置会白折腾一圈。

**解决**：确认开发者工具已启动并打开了项目窗口 → 工具内点「同意」→ 重试。冷启动场景稍等
10-20 秒再试通常即可，一般无需改动安全设置。

### wechatide 返回 `task_not_found`（异步任务已不存在）

**原因**：`wechatide_poll_task` 查询的 `taskId` 已从 IDE 侧消失——多半是确认弹窗超时被关闭，
也可能是任务完成后结果被回收。两种情况下这个 `taskId` 都已经没用了。

**解决**：**重新调用原工具**再走一次（不要继续轮询同一个 `taskId`）。上传类操作请留意
开发者工具里的确认弹窗，在它超时前点掉。

### wechatide 返回 `ide_window_not_active`（项目窗口没打开 / 没激活）

**原因**：官方 CLI 取不到窗口句柄（底层报错 `Cannot read properties of undefined (reading 'winId')`）。截图 / 日志类工具依赖项目窗口，窗口被最小化到托盘或被别的窗口盖住时都可能触发，属 IDE 侧行为。

**解决**：先调 `ensure_ready` 拉起项目窗口，或手动把开发者工具里该项目的窗口切到前台（托盘图标需先还原），然后重试。

### 只有某一个 wechatide 工具卡住超时（如 `compile_wxml` 卡满 120s）

**原因**：`projectPath` 传入的路径大小写与开发者工具记录的不一致（最常见：手写成 `D:\...`，
而 DevTools 记录的是 `d:\...`）。窗口按路径字符串精确匹配，匹配不上就一直等。

**判断方法**：看生成的报告里该次调用带的 `projectPath`——正常应该和其它工具用的完全一致。
出现「只有某一个工具拿到的路径大小写和其它工具不一致，且恰好只有它超时」就基本确定了。

**解决**：把 `projectPath` 清空交给自动探测，或改成与 DevTools 记录完全一致的写法。
详见 [端到端测试的夹具配置](#端到端测试的夹具配置)。

### wechatide 返回 `command_quote_issue`（grep 命令被命令行吃掉）

**原因**：Windows 的 `cmd.exe` 会把 `command` 里的双引号当成命令分隔符，例如 `grep -iE "error|fail"` 会被拆开，输出变成 `'fail""' 不是内部或外部命令`。

**解决**：改用单引号写正则 / 含空格的模式：

```text
❌ grep -iE "error|fail"
✅ grep -iE 'error|fail'
```

### `get_simulator_console` 的中文报错是乱码

> 已修复。中文 Windows 上 `cmd.exe` 的输出是 GBK，而 `wechatide` 自己打印的 JSON 是 UTF-8，两者混在同一条输出里。
> 旧实现按单一编码解码 → 中文全变方块，导致「服务端口已关闭」这类依赖中文文案的错误识别静默失效。
> 现在 `lib/config.js` 的 `decodeCliOutput()` 会**逐行**用 fatal UTF-8 试探、失败再回落 GBK，两种编码都能正确还原。

### `connect` 报 "Failed connecting to ws://127.0.0.1:9420"

**原因**：cli.bat auto 没启动，或端口不对。

**解决**：

1. 检查 9420 端口：`Get-NetTCPConnection -LocalPort 9420 -State Listen`（Windows）
2. 如果没监听，直接让 AI 调 `ensure_ready`（自动启动），或手动跑：
   ```powershell
   & "<cli.bat 路径>" auto --project "<小程序项目路径>" --auto-port 9420
   ```
3. 等 30 秒再调 `connect`

### `connect` 报 timeout（15s）

**原因**：项目还在编译，自动化端口虽开但小程序未就绪。

**解决**：等 30 秒再试。首次编译较慢，后续增量编译快。

### AI 客户端看不到 `wechat-devtools` 工具

**原因**：mcp.json 没加载，或 JSON 格式错误。

**解决**：

1. 验证 JSON：`Get-Content mcp.json -Raw | ConvertFrom-Json`（PowerShell）
2. 重启客户端（改了 server 源码同样需要重启加载）

### `evaluate` 报 "Unexpected number" / "Unexpected token"

**原因**：`fn` 参数不是函数表达式。

**解决**：改成箭头函数形式：
- ❌ `1 + 2 + 3`
- ✅ `() => 1 + 2 + 3`
- ❌ `JSON.stringify(getApp().globalData)`
- ✅ `() => JSON.stringify(getApp().globalData)`

### `element_tap` 报 "Element not found"

**原因**：选择器不对、元素还没渲染，或元素在未激活的 `wx:if` 分支里。

**解决**：

1. 先调 `get_current_page` 确认当前页面
2. 用开发者工具的 Wxml 面板确认选择器（class / id）；动态 class（含 `{{}}` 模板）可能匹配不到，换静态类名
3. 如果是异步渲染，加 `evaluate(() => new Promise(r => setTimeout(r, 1000)))` 等一下

### MCP server 启动报 "Cannot find module '@modelcontextprotocol/sdk'"

**原因**：依赖没装。

**解决**：

```bash
cd mcp/miniprogram-devtools-mcp
npm install
```

---

## 限制与边界

### 能做

- ✅ 读 / 写 `globalData`、页面 `data`
- ✅ 执行任意 JS（逻辑层 AppService）
- ✅ 调同步 `wx.*` API（`getSystemInfoSync`、`getStorageSync` 等）
- ✅ 页面跳转、返回（tabBar 页自动降级 switchTab）
- ✅ UI 元素点击、输入、滚动
- ✅ 读取页面栈
- ✅ 模拟器截图、console/network 日志抓取（wechatide 通道）
- ✅ 预览二维码 / 推送到微信 / 上传体验版（wechatide 通道）
- ✅ 云开发操作：云函数部署、云数据库、云存储（`wechatide_call` 透传）
- ✅ 官方 CLI 工具基本全量可达（10 个专用封装 + 6 组等价直连 + `wechatide_call` 透传兜底）

### 不能做 / 注意

- ❌ **BLE 蓝牙通信**：模拟器 `brand: devtools`，BLE API 不可用。核心蓝牙逻辑仍需真机调试
- ❌ **异步 wx API**：`call_wx_api` 仅支持同步。异步 API 用 `evaluate` 自行包 Promise
- ❌ **真机行为差异**：模拟器是 `iPhone 12/13 (Pro)`，真机 Android/iOS 行为可能不同
- ❌ **launch 模式**：SDK 的 `launch` 在 Windows + Node 18+ 上 spawn `.bat` 失败，本 MCP 仅用 `connect` 模式
- ⚠️ **两个 MCP 不能同时驱动同一项目的自动化**：自动化端口是单连接；官方 `automation_*` 工具经本 MCP 透传时会被护栏拦截（先 `disconnect` 再用）
- ⚠️ **发布类操作**（`upload`/`auto_preview`）只在用户明确要求时调用

### 性能

- API 调用超时：30 秒（`API_TIMEOUT_MS`）
- connect 超时：15 秒
- wechatide 单命令超时：180 秒；授权等待 12 秒、人工确认等待 45 秒后返回 pending
- 实测单次 `evaluate` 耗时：100-500ms

---

## 开发

### 项目结构

```
miniprogram-devtools-mcp/
├── index.js           # MCP server 主文件（v0.4.0：30 个工具 = automator 20 + wechatide 封装 10）
├── lib/
│   ├── config.js      # 跨平台 CLI 探测 + 项目根目录解析（含 DevTools 最近项目兜底）+ CLI 输出解码
│   ├── preflight.js   # 联调前静态自检
│   ├── rebuild.js     # close/open/auto 自动重编译 + 服务端口关闭检测
│   ├── wechatide.js   # 官方 wechatide CLI 封装：探测/门禁/授权等待/异步轮询/错误分类
│   └── checks.js      # checks/ 用例发现与执行
├── checks/
│   ├── smoke-basic.js     # 通用冒烟用例（任何小程序都能过，开箱即用）
│   ├── _template.js       # 用例模板（下划线开头，不执行）
│   └── examples/
│       └── component-render.js  # 通用示例：自定义组件渲染校验（不执行，仅参考，无项目专属印记）
├── smoke.js           # 冒烟自检脚本（npm run smoke，无需 IDE）
├── e2e-all-tools.js   # 全量端到端测试脚本（需 IDE，逐工具判定，产出 e2e-report.md/json）
├── e2e-edge-cases.js  # 补充端到端测试（需 IDE，覆盖参数路径/护栏分支/返回值形态，产出 e2e-edge-report.md/json）
├── e2e.config.example.js  # e2e 夹具模板（占位值，随仓库提交）
├── e2e.config.js      # e2e 本机夹具（你的项目专属值，已 gitignore，不入库）
├── package.json       # 依赖声明
├── package-lock.json  # 依赖锁定
└── README.md          # 本文档
```

### 修改工具

编辑 `index.js` 的 `TOOLS` 数组（工具定义）和 `dispatch` 函数（工具分发）。修改后：

1. 语法检查：`node --check index.js`（改 `lib/` 同理）
2. 冒烟测试：`npm run smoke`（无需 IDE，会真实 spawn server 走一遍 JSON-RPC）
3. 全量端到端测试：`node e2e-all-tools.js`（需开发者工具与本项目均可用，会真实拉起 IDE 窗口并执行一次 `rebuild` / `build_npm`）；
   产物为 `e2e-report.json`（机器可读）与 `e2e-report.md`（含每个工具的判定与耗时）。`--report-only` 只按已有 JSON 重渲染 Markdown。
   发布类工具默认只验证参数校验路径，不真实上传/预览
4. 补充边界测试：`node e2e-edge-cases.js`（需 IDE，覆盖各工具的参数路径、护栏分支、返回值形态与两个环境变量开关）
5. 端到端测试：`ensure_ready` 后调 `run_check`；wechatide 系改动建议再实测 1-2 个只读工具（如 `project_list`）

> `e2e-report.*` / `e2e-edge-report.*` 里会带上本机绝对路径、微信登录态、AppID 等隐私信息，
> 已在 `.gitignore` 中排除。**不要**把它们提交到公开仓库。

### 端到端测试的夹具配置

两个 e2e 脚本要真机跑通「跳子包页」「先渲染再输入」这类用例，就必须知道**被测小程序自己的**
页面路径、选择器、data 字段。这些值放在 `e2e.config.js`（已 gitignore），仓库里只提交占位模板：

```bash
cp e2e.config.example.js e2e.config.js   # Windows: copy e2e.config.example.js e2e.config.js
```

然后按模板注释填上你自己项目的值：

| 字段 | 用途 | 没填会怎样 |
|---|---|---|
| `projectPath` | 被测小程序根目录 | 留空则走 `lib/config.js` 自动探测（**推荐**，见下方警告） |
| `containerSelector` | 页面容器选择器（element_tap / 容器滚动） | 用例降级 WARN |
| `formPage` / `dialogField` / `selectedField` / `valueField` / `inputSelector` | 「先渲染再输入」用例 | 该用例整段 SKIP |
| `subPackagePage` | 子包导航用例 | 该用例 SKIP |
| `tabPage` | tabBar 自动降级用例 | 该用例 SKIP |
| `wxmlFile` | `compile_wxml` 透传用例 | 该用例报错 |

> ⚠️ **`projectPath` 别手写**，尤其是 Windows 盘符大小写。开发者工具按路径字符串精确匹配已打开的项目窗口，
> 它自己记录的是小写盘符（如 `d:\code\my-miniprogram`）；你在配置里写 `D:\code\my-miniprogram` 就会匹配不上，
> 表现为某个 wechatide 工具卡满 120s 后 FAIL，而同一次运行里其它工具全都正常。
> 留空让自动探测返回 DevTools 记录的原值，最省事也最不容易错。

没配置时脚本不会崩——依赖夹具的用例自动降级为 WARN / SKIP，其余用例照常执行。

### 修改后让客户端重新加载

修改 `index.js` 后，需要在客户端设置面板重启 `wechat-devtools` MCP server，或重启客户端。

---

## License

MIT
