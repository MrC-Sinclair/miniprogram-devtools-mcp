#!/usr/bin/env node
/**
 * miniprogram-devtools-mcp: 通过 miniprogram-automator 操控微信开发者工具的 MCP server
 *
 * 工作机制：
 * 1. 调用 ensure_ready：自动探测端口 → 未监听则 spawn cli 启动 → 连接（全自助）
 * 2. 或直接调用 connect 连接已运行的自动化端口
 * 3. 暴露 30 个工具：
 *    - automator 直连（20）：ensure_ready/auto_test/connect/disconnect/status/evaluate/page_stack/
 *      navigate_to/navigate_back/get_current_page/call_wx_api/get_data/element_tap/element_input/
 *      element_scroll/preflight/rebuild/build_npm/list_checks/run_check
 *    - 官方 wechatide CLI 封装（10，补 automator 覆盖不到的能力，含 wechatide_call 通用透传）：
 *      wechatide_status/wechatide_poll_task/simulator_screenshot/get_simulator_console/
 *      get_simulator_network/create_preview_qrcode/auto_preview/upload/project_list
 *
 * 设计原则：AI Agent 优先自助（ensure_ready），仅 DevTools 未安装/未登录/服务端口未开
 * 这 3 种情况才需人工介入，错误返回会明确标注 blocker 字段。
 *
 * 可移植性：CLI 路径与项目根目录均自动探测（支持 WECHAT_DEVTOOLS_CLI / WECHAT_DEVTOOLS_PROJECT
 * 环境变量覆盖，Windows + macOS 双平台），换机器拷贝本目录即可直接使用。
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const automator = require('miniprogram-automator');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { findCli, resolveProject, cliCandidates, CLI_ENV, PROJECT_ENV } = require('./lib/config');
const { preflight } = require('./lib/preflight');
const {
  rebuild,
  startAutoPort,
  checkPort: checkPortUtil,
  buildNpm,
  sleep,
  isServicePortDisabled,
} = require('./lib/rebuild');
const { listChecks, runChecks } = require('./lib/checks');
const {
  findWechatide,
  callWechatide,
  buildFlags,
  WechatideError,
  CLIENT_ENV,
  TOKEN_ENV,
} = require('./lib/wechatide');

/** 官方 wechatide 全量工具名（用于 wechatide_call 透传的提示文案） */
const WECHATIDE_ALL_TOOLS =
  'check_wechatide_status, open_project_window, close_project_window, quit, login, ' +
  'polling_task_result, project_import, project_remove, share_minicode, import_minicode, ' +
  'get_user_appids, simulator_open_page, simulator_refresh, compile_wxml, compile_wxss, ' +
  'debug_clear_cache, automation_element_action, automation_game_action, automation_evaluate, ' +
  'automation_generate_script, automation_navigate, automation_page_action, automation_runtime_info, ' +
  'automation_testaccount, automation_viewport_action, automation_wx_api, ' +
  'cloud_env_list, cloud_fn_deploy, cloud_fn_inc_deploy, cloud_fn_info, cloud_fn_list, ' +
  'cloud_db_read_doc, cloud_db_read_struct, cloud_db_write_doc, cloud_db_write_struct, ' +
  'cloud_query_storage, cloud_manage_storage';

// 默认配置
const DEFAULT_PORT = 9420;
const PORT_SCAN_FROM = 9420; // 自动化端口扫描起点（DevTools 默认从 9420 起分配）
const PORT_SCAN_TO = 9430; // 扫描终点，覆盖手动 `--auto-port` 的常用取值
const API_TIMEOUT_MS = 30000; // automator API 调用超时，避免无限等待
const CLI_START_TIMEOUT_MS = 90000; // cli auto 启动到端口就绪的最长等待
const CLI_POLL_INTERVAL_MS = 3000; // 端口轮询间隔

const CLI_CANDIDATES = cliCandidates();

// 全局连接状态
let mp = null; // MiniProgram 实例
let currentPort = null;

// ============ 工具函数 ============

/** 带超时的 Promise 包装，避免 automator API 无限挂起；无论哪方先落定都清除定时器，避免泄漏 */
async function withTimeout(promise, ms = API_TIMEOUT_MS, label = 'api') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms calling ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 确保已连接，否则抛错 */
function ensureConnected() {
  if (!mp) {
    throw new Error(
      'Not connected. Call `ensure_ready` (auto-starts DevTools automation port) or `connect` first.'
    );
  }
}

/** 单条工具返回文本上限（约 100KB），避免大 payload（如完整 globalData）撑爆 LLM 上下文。
 *  可用环境变量 WECHAT_DEVTOOLS_MAX_OUTPUT（字符数）覆盖。 */
const MAX_TEXT_LEN = Number(process.env.WECHAT_DEVTOOLS_MAX_OUTPUT) || 100000;

/** 格式化成功返回 */
function ok(data) {
  let text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (text.length > MAX_TEXT_LEN) {
    text =
      text.slice(0, MAX_TEXT_LEN) +
      `\n... [已截断：原始长度 ${text.length} 字符，超过上限 ${MAX_TEXT_LEN}]`;
  }
  return {
    content: [{ type: 'text', text }],
  };
}

/** 格式化错误返回 */
function err(message) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

/**
 * 结构化错误返回：JSON body 携带 blocker 字段，便于 Agent 判断自助还是找人工
 * blocker 取值：
 *   - not_installed          DevTools 未安装（候选路径均无 cli.bat）→ 需人工
 *   - not_logged_in          DevTools 未登录（cli 启动失败/被拒）→ 需人工扫码
 *   - port_disabled          DevTools 安全设置未开服务端口 → 需人工开启
 *   - start_timeout          cli.bat 启动后端口迟迟未监听（可能未登录/编译慢）→ 附 cli 输出
 *   - project_path_required  Agent 未传 projectPath → Agent 补参数即可
 *   - connect_failed         端口已监听但 automator 连接失败（可能项目未编译完）→ 稍后重试
 */
function errBlock(blocker, detail, hint) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: detail, blocker, hint }, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * 扫描端口段内已监听的自动化端口。
 * DevTools 可能已被别的工具或上一次手动 `cli.bat auto` 开在非默认端口，
 * 此时若死守默认端口会误判为「未启动」并重复拉起一个端口。
 */
async function scanListeningPorts(from = PORT_SCAN_FROM, to = PORT_SCAN_TO) {
  for (let p = from; p <= to; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await checkPort(p)) return p;
  }
  return null;
}

/** 端口探测：复用 lib/rebuild 的 checkPort（别名 checkPortUtil），避免两份实现漂移 */
function checkPort(port) {
  return checkPortUtil(port);
}

// ============ wechatide（官方 CLI）封装层共用 ============

/**
 * 解析 wechatide 调用上下文；CLI 不存在时抛 WechatideError。
 * client/token 支持每工具参数覆盖 → 环境变量 → 默认值。
 */
function wechatideContext(args = {}) {
  const cliPath = findCli();
  const wechatidePath = findWechatide(cliPath);
  if (!wechatidePath) {
    throw new WechatideError(
      'wechatide_not_installed',
      `wechatide CLI not found（候选目录与 ${cliPath || 'cli.bat'} 同目录均已探测）`,
      `微信开发者工具 2.x 自带 wechatide 命令，未找到说明安装不完整或版本过旧；` +
        `也可设置环境变量 WECHAT_DEVTOOLS_WECHATIDE 指向 wechatide.cmd (macOS: wechatide)`
    );
  }
  return {
    wechatidePath,
    client: args.client || process.env[CLIENT_ENV] || undefined,
    token: args.token || process.env[TOKEN_ENV] || undefined,
  };
}

/** 统一把 wechatide 异常转成 MCP 错误返回 */
function wechatideErr(e) {
  if (e instanceof WechatideError) return errBlock(e.blocker, e.message, e.hint);
  return err(e.message);
}

/** wechatide 工具共用的 projectPath 解析（不传则自动探测） */
function wechatideProject(args) {
  const projectPath = resolveProject(args.projectPath);
  if (!projectPath) {
    throw new WechatideError(
      'project_path_required',
      'Could not resolve mini program project root',
      `传 projectPath 参数或设置环境变量 ${PROJECT_ENV}`
    );
  }
  return projectPath;
}

// ============ MCP 工具定义 ============

const TOOLS = [
  {
    name: 'ensure_ready',
    description:
      '确保微信开发者工具自动化调试就绪（推荐入口，全自动）。流程：已连接则直接返回 → ' +
      '端口已监听则直接连接 → 否则自动查找 cli.bat 并启动 `cli.bat auto --project <projectPath> ' +
      '--auto-port <port>` 等端口就绪后连接。失败时返回结构化 blocker，仅以下情况需人工介入：' +
      'DevTools 未安装 / 未登录（需扫码）/ 设置-安全设置-服务端口未开启。' +
      'projectPath 和 port 均可省略：项目路径自动探测（含 DevTools 最近打开列表），端口自动扫描 9420-9430。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description:
            '小程序项目绝对路径。可省略：自动探测顺序为 环境变量 → cwd 向上找 project.config.json → DevTools「最近打开的项目」',
        },
        port: {
          type: 'number',
          description: '自动化端口，默认 9420（未监听时自动扫描 9420-9430）',
          default: 9420,
        },
      },
    },
  },
  {
    name: 'auto_test',
    description:
      '一键自动化联调（无需任何参数）：自动定位项目 → 自动拉起/连接开发者工具自动化端口 → ' +
      '静态自检 preflight → 运行时用例 run_check，返回带 pass 字段的合并报告。' +
      'preflight 报 error 时短路返回，不在坏状态下跑运行时用例。' +
      '失败时报告里带 blocker 与 hint，按其提示自助修复（如 build_npm）后再重试。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: '小程序项目绝对路径；省略则自动探测',
        },
        port: {
          type: 'number',
          description: '自动化端口；省略则扫描 9420-9430',
        },
        checkName: {
          type: 'string',
          description: '只跑指定的运行时用例名（等价 run_check 的 name）；省略则跑 checks/ 下全部用例',
        },
      },
    },
  },
  {
    name: 'connect',
    description:
      '连接微信开发者工具自动化端口（ws://127.0.0.1:9420）。适用于端口已由 cli.bat auto ' +
      '启动的场景。若不确定端口状态，优先调用 ensure_ready（会自动启动端口并连接），' +
      '本工具失败时也应改调 ensure_ready 自助恢复。',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'number',
          description: '自动化端口，默认 9420',
          default: 9420,
        },
      },
    },
  },
  {
    name: 'disconnect',
    description: '断开与微信开发者工具的连接（不关闭开发者工具本身）',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: '查询当前连接状态和当前页面',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'evaluate',
    description:
      '在小程序逻辑层（AppService）执行 JS 函数。传函数字符串，如 "() => 1+2" 或 "() => JSON.stringify(getApp().globalData)"。可访问 wx、getApp、getCurrentPages 等。',
    inputSchema: {
      type: 'object',
      properties: {
        fn: {
          type: 'string',
          description: '要执行的函数表达式字符串，必须是箭头函数或 function 形式',
        },
      },
      required: ['fn'],
    },
  },
  {
    name: 'page_stack',
    description: '获取当前小程序页面栈',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navigate_to',
    description: '跳转到应用内某个页面（等同 wx.navigateTo）；目标为 tabBar 页时自动降级 switchTab',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '目标页面路径，如 pages/index/index',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'navigate_back',
    description:
      '关闭当前页面，返回上一页面或多级页面（等同 wx.navigateBack）。' +
      'delta 大于页面栈深度时会自动收敛（只返回到栈底），不会空转等待',
    inputSchema: {
      type: 'object',
      properties: {
        delta: {
          type: 'number',
          description: '返回的页面数，默认 1；传 0 或负数表示不返回',
          default: 1,
        },
      },
    },
  },
  {
    name: 'get_current_page',
    description: '获取当前页面实例：路径、query、data',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'call_wx_api',
    description:
      '调用同步 wx.* API（如 getSystemInfoSync、getStorageSync 等）。异步 API 请用 evaluate 自行处理。',
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          description: 'wx 上的方法名，如 "getSystemInfoSync"',
        },
        args: {
          type: 'array',
          description: '传给该方法的参数（同步 API 通常无参数）',
          items: {},
        },
      },
      required: ['method'],
    },
  },
  {
    name: 'get_data',
    description: '读取当前页面的 data 对象',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'element_tap',
    description: '点击当前页面的元素（通过选择器）',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'CSS-like 选择器，如 ".btn-submit" 或 "#login-btn"',
        },
      },
      required: ['selector'],
    },
  },
  {
    name: 'element_input',
    description: '在当前页面的输入框输入内容',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '输入框选择器' },
        value: { type: 'string', description: '要输入的内容' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'element_scroll',
    description:
      '在当前页面或指定滚动容器内滚动到坐标 (x, y)。' +
      '注意：容器级滚动只对 <scroll-view> 元素生效，其它标签请去掉 selector 走页面级滚动',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '滚动容器选择器（必须是 scroll-view），不传则操作页面级滚动',
        },
        x: { type: 'number', description: '横向滚动目标位置（px），默认 0', default: 0 },
        y: { type: 'number', description: '纵向滚动目标位置（px），默认 0', default: 0 },
      },
    },
  },
  {
    name: 'preflight',
    description:
      '联调/编译前静态自检，无需连接开发者工具。检查：关键 JSON 可解析（app.json 等）、' +
      'app.json 的 pages 与分包 pages 有对应源码、usingComponents 指向的组件四件套齐全、' +
      'tabBar 图标存在、miniprogram_npm 是否已构建、自动化端口是否监听。' +
      '返回 { pass, errors[], warnings[], stats }，errors 非空即必须修。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: '小程序项目根目录，不传则自动探测（环境变量 → 向上查找 project.config.json）',
        },
        port: {
          type: 'number',
          description: '顺带探测的自动化端口，默认 9420',
          default: 9420,
        },
      },
    },
  },
  {
    name: 'rebuild',
    description:
      '强制开发者工具重新编译：cli close --project → cli open --project → cli auto 重启自动化端口。' +
      '用于「解析 project.config.json 失败 / 未找到 xxx.js」等 IDE 坏状态的自动恢复，' +
      'reconnect=true 时会在端口就绪后自动重连 miniprogram-automator，全程无需人工点编译。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: '小程序项目根目录，不传则自动探测',
        },
        port: {
          type: 'number',
          description: '自动化端口，默认 9420',
          default: 9420,
        },
        timeoutMs: {
          type: 'number',
          description: '等待自动化端口就绪的最长毫秒数，默认 120000',
          default: 120000,
        },
        withAutoPort: {
          type: 'boolean',
          description: '是否重启自动化端口并重连，默认 true',
          default: true,
        },
        reconnect: {
          type: 'boolean',
          description: '端口就绪后是否自动 reconnect automator，默认 true',
          default: true,
        },
      },
    },
  },
  {
    name: 'build_npm',
    description:
      '执行 `cli build-npm --project <path>`，等价于开发者工具的「工具 → 构建 npm」。' +
      'preflight 报「miniprogram_npm 为空」时调用本工具一键修复，无需人工点菜单。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: '小程序项目根目录，不传则自动探测',
        },
        timeoutMs: {
          type: 'number',
          description: '最长等待毫秒数，默认 180000',
          default: 180000,
        },
      },
    },
  },
  {
    name: 'list_checks',
    description: '列出 checks/ 目录下可用的运行时用例（名称 + 说明），供 run_check 选择',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'run_check',
    description:
      '执行 checks/ 目录下的运行时用例（需已连接，先调 ensure_ready）。不传 name 则全部执行。' +
      '每个用例文件导出 { name, description, run(ctx) }，ctx 提供 { mp, automator, withTimeout, sleep, projectRoot }。' +
      '新增用例只需往 checks/ 丢一个 .js 文件，无需改动本 server。',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '用例名称或文件名（如 "component-render"）；不传则执行全部用例',
        },
        projectPath: {
          type: 'string',
          description: '小程序项目根目录，会作为 ctx.projectRoot 传给用例；不传则自动探测',
        },
      },
    },
  },
  // ============ wechatide（官方 CLI 封装）：automator 覆盖不到的能力 ============
  {
    name: 'wechatide_status',
    description:
      '读取微信开发者工具状态（走官方 wechatide CLI）：登录态 loginExpired、当前用户、' +
      '是否启用 CLI 令牌 tokenRequired。首次调用会触发一次客户端授权弹窗（默认客户端名 miniprogram-mcp）；' +
      '若用户未及时点击，约 12s 后返回 {pending, taskId, userAction}——把 userAction 原样转告用户，' +
      '确认后用 wechatide_poll_task 续查。不触发登录；登录失效时提示人工扫码。',
    inputSchema: {
      type: 'object',
      properties: {
        client: {
          type: 'string',
          description: '客户端简称（须与首次授权弹窗一致）；默认 miniprogram-mcp，可用环境变量 WECHATIDE_CLIENT 覆盖',
        },
        token: {
          type: 'string',
          description: 'CLI 访问令牌；工具未启用令牌校验时省略，可用环境变量 WECHATIDE_TOKEN 覆盖',
        },
      },
    },
  },
  {
    name: 'wechatide_poll_task',
    description:
      '查询 wechatide 异步任务结果。upload 等工具返回 { pending: true, taskId } 时（等待你在' +
      '开发者工具内确认），用本工具带 taskId 续查；任务完成返回最终 result。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '异步工具返回的 taskId' },
        client: { type: 'string', description: '客户端简称；默认同 wechatide_status' },
        token: { type: 'string', description: 'CLI 访问令牌；默认同 wechatide_status' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'simulator_screenshot',
    description:
      '截取模拟器画面（走官方 wechatide CLI），返回 { path, imageWidth, imageHeight }。' +
      '默认输出长边 1280 的优化 JPEG；optimize=false 时写原始 PNG。需项目窗口已打开（可先 ensure_ready）。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '小程序项目根目录；不传则自动探测' },
        path: { type: 'string', description: '截图输出路径；不传写入系统临时目录并返回路径' },
        wait: { type: 'number', description: '截图前固定等待秒数（0-10）' },
        waitForSelector: { type: 'string', description: '截图前等待出现的选择器' },
        optimize: { type: 'boolean', description: '是否优化尺寸（默认 true=JPEG）；false 时原始 PNG' },
        quality: { type: 'number', description: 'JPEG 质量 1-100，默认 80，仅 optimize=true 生效' },
      },
    },
  },
  {
    name: 'get_simulator_console',
    description:
      '读取小程序 console 日志缓冲区（走官方 wechatide CLI），对缓冲区执行 grep 过滤并返回命中行。' +
      'command 传 grep 命令字符串：\'grep -n .\' 取全部、\'grep -i error\' 过滤 error、\'grep -n warn\' 过滤 warn。' +
      'Windows 下正则/含空格的模式要用单引号（如 \'grep -iE \'\'error|fail\'\'），双引号会被命令行吞掉。' +
      '返回空字符串代表没有匹配行，不代表 console 为空。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '小程序项目根目录；不传则自动探测' },
        command: {
          type: 'string',
          description: "grep 命令字符串（不含文件名），如 'grep -n .'；不传默认 'grep -n .'（全部）",
        },
      },
    },
  },
  {
    name: 'get_simulator_network',
    description:
      '读取小程序 network 请求缓冲区（走官方 wechatide CLI），对缓冲区执行 grep 过滤并返回命中行。' +
      "command 传 grep 命令字符串：'grep -n .' 取全部请求、'grep -i fail' 过滤失败请求。",
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '小程序项目根目录；不传则自动探测' },
        command: {
          type: 'string',
          description:
            "grep 命令字符串（不含文件名），如 'grep -n .'；不传默认 'grep -n .'（全部）。" +
            'Windows 下含正则/空格的模式请用单引号',
        },
      },
    },
  },
  {
    name: 'create_preview_qrcode',
    description:
      '生成小程序预览二维码（走官方 wechatide CLI），扫码后在微信中打开预览版。' +
      '默认 qr-format=window 在开发者工具新窗口展示二维码；qr-format=image + qr-output 可输出图片文件。' +
      '上传/发布相关操作仅在用户明确要求时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '小程序项目根目录；不传则自动探测' },
        qrFormat: { type: 'string', enum: ['window', 'image'], description: '二维码展示方式，默认 window' },
        qrOutput: { type: 'string', description: '二维码图片输出路径（qrFormat=image 时使用）' },
        pagePath: { type: 'string', description: '预览打开的页面路径，如 pages/index/index' },
        query: { type: 'string', description: "预览页面参数，如 'a=b&c=d'" },
        scene: { type: 'string', description: '预览进入的场景值，如 1001' },
      },
    },
  },
  {
    name: 'auto_preview',
    description:
      '把预览版直接推送到开发者的微信（走官方 wechatide CLI），无需扫码取二维码。' +
      '需要当前登录用户有该 AppID 的预览权限。仅在用户明确要求预览时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '小程序项目根目录；不传则自动探测' },
        pagePath: { type: 'string', description: '预览打开的页面路径' },
        query: { type: 'string', description: "预览页面参数，如 'a=b&c=d'" },
        scene: { type: 'string', description: '预览进入的场景值' },
      },
    },
  },
  {
    name: 'upload',
    description:
      '上传代码包发布体验版（走官方 wechatide CLI）。仅在用户明确要求「上传代码」「发布体验版」时调用；' +
      '需用户在开发者工具内确认时，约 45s 内未确认即返回 {pending, taskId, userAction}——' +
      '把 userAction 转告用户，确认后用 wechatide_poll_task 续查。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '小程序项目根目录；不传则自动探测' },
        version: { type: 'string', description: '上传的版本号，如 1.0.0（必填）' },
        desc: { type: 'string', description: '版本描述信息' },
      },
      required: ['version'],
    },
  },
  {
    name: 'project_list',
    description:
      '列出微信开发者工具已导入的项目列表（走官方 wechatide CLI，只读）。' +
      '返回 { projects: [{ projectPath, projectName, appId, compileType }] }。' +
      '不等于打开项目窗口；找项目路径时优先用它。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['miniprogram', 'other', 'all'],
          description: '列表范围：miniprogram（默认）、other、all',
        },
      },
    },
  },
  {
    name: 'wechatide_call',
    description:
      '通用透传：调用任意官方 wechatide CLI 工具（覆盖未单独封装的长尾能力，' +
      '如云开发 cloud_*、get_user_appids、simulator_refresh、simulator_open_page、' +
      'compile_wxml/compile_wxss、debug_clear_cache、login、share_minicode 等）。' +
      'args 传参数对象（key 用 camelCase 或 kebab-case，自动转 --kebab-flag）；' +
      '传 projectPath 会自动注入 --project。' +
      '注意：automation_* 会与本 MCP 的自动化会话抢连接（已连接时会被拒绝，先 disconnect）；' +
      'quit/project_remove/debug_clear_cache 是破坏性操作，args 里需 {"confirm": true}。' +
      '可用工具名：' + WECHATIDE_ALL_TOOLS,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: '官方 wechatide 工具名（下划线命名），如 cloud_fn_list' },
        args: {
          type: 'object',
          description: '工具参数对象，如 {"env": "cloud1-xxx", "path": "functions/login"}；confirm 仅用于破坏性操作',
          additionalProperties: true,
        },
        projectPath: { type: 'string', description: '小程序项目根目录；传入则自动注入 --project' },
        client: { type: 'string', description: '客户端简称；默认同 wechatide_status' },
        token: { type: 'string', description: 'CLI 访问令牌；默认同 wechatide_status' },
        timeoutMs: { type: 'number', description: '单次命令超时毫秒，默认 180000' },
      },
      required: ['tool'],
    },
  },
];

// ============ 工具实现 ============

/** 实际建立 automator 连接（ensure_ready / connect 共用） */
async function doConnect(port) {
  const wsEndpoint = `ws://127.0.0.1:${port}`;
  mp = await withTimeout(automator.connect({ wsEndpoint }), 15000, 'connect');
  currentPort = port;
  return wsEndpoint;
}

/**
 * 带重试的连接。IDE 刚重启时端口虽已监听，但 automator 握手（版本协商）会失败，
 * 需等窗口初始化完成，故失败后间隔重试而非直接报错。
 */
async function connectWithRetry(port, attempts = 5, delayMs = 3000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await doConnect(port);
    } catch (e) {
      lastErr = e;
      mp = null;
      currentPort = null;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * 等待小程序运行时（AppService）就绪：轮询 evaluate 探针直到成功。
 * rebuild / 首次启动后必须调用，否则 evaluate 会超时（IDE 后台仍在编译）。
 * 探针要求 getApp() 已实例化——build_npm/重编译后 wx 对象先于 App 出现，
 * 只探 wx 会误判就绪，用例会在半初始化状态下跑挂。
 * 兜底：超时窗口后半段若 wx 可用但 getApp() 仍为空（存在无 App() 的项目形态），放行。
 */
async function waitRuntimeReady(timeoutMs = 90000, intervalMs = 2000) {
  ensureConnected();
  const deadline = Date.now() + timeoutMs;
  const graceAt = Date.now() + timeoutMs * 0.6;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const probe = await withTimeout(
        mp.evaluate(() => {
          if (typeof wx === 'undefined') return 'no-wx';
          const app = typeof getApp === 'function' ? getApp() : null;
          return app ? 'ready' : 'app-not-ready';
        }),
        8000,
        'runtimeProbe'
      );
      if (probe === 'ready') return true;
      if (probe === 'app-not-ready' && Date.now() >= graceAt) return true;
      lastErr = new Error(`runtime probe returned ${probe}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`runtime not ready within ${timeoutMs}ms: ${lastErr && lastErr.message}`);
}

/**
 * best-effort 等待运行时就绪：成功返回 true，超时返回 false（不改变调用方的成功/失败结论）。
 * ensure_ready 用得上——IDE 刚拉起时端口虽通、AppService 仍在编译，
 * 不等的话 Agent 拿走 ready:true 后第一条 automator 调用大概率超时。
 */
async function waitRuntimeReadyBestEffort(timeoutMs = 60000) {
  try {
    await waitRuntimeReady(timeoutMs);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * ensure_ready：一键确保调试环境就绪
 * 已连接 → 返回；端口已监听 → 连接；否则自动启动 cli.bat 后连接。
 * 失败返回结构化 blocker，Agent 据此决定自助重试还是找人工。
 */
async function handleEnsureReady(args) {
  let port = args.port || DEFAULT_PORT;
  // 未显式传项目路径时自动探测：环境变量 → cwd/MCP 目录向上找 project.config.json
  // → DevTools「最近打开的项目」列表兜底
  const projectPath = resolveProject(args.projectPath);

  // 1. 已连接，幂等返回
  if (mp) {
    return ok({ ready: true, connected: true, port: currentPort, startedBySelf: false });
  }

  // 2. 默认端口没监听时先扫一遍端口段：可能 DevTools 已经开在别的端口上
  let portScanned = false;
  if (!args.port && !(await checkPort(port))) {
    const found = await scanListeningPorts();
    if (found) {
      port = found;
      portScanned = true;
    }
  }

  // 3. 端口已在监听 → 直接连接
    if (await checkPort(port)) {
    try {
      await connectWithRetry(port, 2, 2000);
      // 端口通 ≠ 运行时就绪：等 AppService 起来，避免首个 automator 调用超时
      const runtimeReady = await waitRuntimeReadyBestEffort();
      return ok({
        ready: true,
        connected: true,
        port,
        portScanned,
        startedBySelf: false,
        projectPath,
        runtimeReady,
      });
    } catch (e) {
      // 端口开了但 automator 握手失败：项目可能还在编译，稍等重试即可
      return errBlock(
        'connect_failed',
        `Port ${port} is listening but automator connect failed: ${e.message}`,
        '项目可能仍在编译，等 30s 后重试 ensure_ready；若持续失败，检查 DevTools 是否打开的是目标项目'
      );
    }
  }

  // 3. 端口未监听 → 需要 cli.bat 启动
  const cliPath = findCli();
  if (!cliPath) {
    return errBlock(
      'not_installed',
      `cli not found in candidates: ${CLI_CANDIDATES.join('; ')}`,
      `微信开发者工具可能未安装或装在非默认路径。可设置环境变量 ${CLI_ENV} 指向 cli.bat(macOS: cli) 后重试`
    );
  }
  if (!projectPath) {
    return errBlock(
      'project_path_required',
      'Automation port is not running and projectPath could not be resolved automatically',
      `带 projectPath 参数（小程序项目绝对路径）重试，或设置环境变量 ${PROJECT_ENV}`
    );
  }

  // 4. 端口确实没起 → 启动 cli.bat auto 并等待端口就绪
  const { ok: started, cliOutput } = await startAutoPort(cliPath, projectPath, port);
  if (!started) {
    // CLI 明确报「服务端口已关闭」时单独归类，别让 Agent 误判成启动慢或未登录
    if (isServicePortDisabled(cliOutput)) {
      return errBlock(
        'port_disabled',
        `cli auto failed: DevTools service port is disabled. cli output: ${cliOutput}`,
        '打开微信开发者工具 → 设置 → 安全设置 → 打开「服务端口」（2.x 该页会显示服务端口号，' +
          '首次开启可能要求确认 CLI 能力），然后重试 ensure_ready。注意这是 IDE 的 HTTP 服务端口，' +
          '不是 9420 自动化端口；工具大版本更新后该开关可能被重置'
      );
    }
    return errBlock(
      'start_timeout',
      `cli.bat started but port ${port} not listening within ${CLI_START_TIMEOUT_MS / 1000}s. cli output: ${cliOutput}`,
      '常见原因：DevTools 未登录（cli 输出会提示 login）或 设置-安全设置-服务端口未开启，均需人工处理后重试'
    );
  }

  // 5. 连接（刚拉起的 IDE 需要等窗口初始化，握手失败时重试而非直接报错）
  try {
    await connectWithRetry(port, 3, 3000);
    // 冷启动尤其需要：cli.bat auto 拉起后编译还要几十秒
    const runtimeReady = await waitRuntimeReadyBestEffort();
    return ok({
      ready: true,
      connected: true,
      port,
      startedBySelf: true,
      cliPath,
      projectPath,
      runtimeReady,
    });
  } catch (e) {
    return errBlock(
      'connect_failed',
      `Port started but automator connect failed: ${e.message}`,
      '等 30s 让项目编译完成后重试 ensure_ready'
    );
  }
}

/** 从工具返回体里取出结构化数据（ok() 把内容 JSON 化塞进 content[0].text） */
function parseResult(result) {
  const text = result && result.content && result.content[0] ? result.content[0].text : '';
  try {
    return JSON.parse(text);
  } catch (_) {
    return { raw: text };
  }
}

/**
 * auto_test：一键「连上就测」。
 * ensure_ready（自动定位项目 + 自动端口）→ preflight（静态自检）→ run_check（运行时用例）。
 * preflight 有 error 时短路返回，不在坏状态下浪费运行时用例。
 */
async function handleAutoTest(args) {
  const startedAt = Date.now();
  const report = {
    projectPath: resolveProject(args.projectPath),
    pass: false,
    steps: {},
  };

  const ready = await handleEnsureReady(args);
  report.steps.ensure_ready = parseResult(ready);
  if (ready.isError) {
    report.blocker = report.steps.ensure_ready.blocker || 'ensure_ready_failed';
    report.hint = report.steps.ensure_ready.hint;
    report.durationMs = Date.now() - startedAt;
    return ok(report);
  }

  const pre = await handlePreflight(args);
  const preData = parseResult(pre);
  report.steps.preflight = preData;
  const preErrors = (preData && preData.errors) || [];
  if (pre.isError || preErrors.length > 0) {
    report.blocker = 'preflight_failed';
    report.hint =
      '静态自检未通过，先修 errors 再跑运行时用例（miniprogram_npm 缺失可调用 build_npm 一键修复）';
    report.durationMs = Date.now() - startedAt;
    return ok(report);
  }

  const run = await handleRunCheck({ name: args.checkName, projectPath: args.projectPath });
  const runData = parseResult(run);
  report.steps.run_check = runData;
  // 总 pass 必须反映用例结果：RPC 报错或用例自身 pass=false 都算失败
  report.pass = !run.isError && runData.pass !== false;
  if (run.isError) {
    report.blocker = (runData && runData.blocker) || 'run_check_failed';
    report.hint = runData && runData.hint;
  } else if (runData.pass === false) {
    report.blocker = 'run_check_failed';
    report.hint =
      '运行时用例未全部通过，看 steps.run_check.results 里各检查项的 problems 字段定位；' +
      '若在 build_npm/重编译后立即联调，可重跑一次 auto_test（AppService 可能仍在重启）';
  }
  report.durationMs = Date.now() - startedAt;
  return ok(report);
}

async function handleConnect(args) {
  const port = args.port || DEFAULT_PORT;
  if (mp) {
    return err(`Already connected (port ${currentPort}). Call disconnect first.`);
  }
  try {
    const wsEndpoint = await doConnect(port);
    return ok(`Connected to ${wsEndpoint}`);
  } catch (e) {
    mp = null;
    currentPort = null;
    // 结构化错误：端口未监听是最常见原因，明确告诉 Agent 走 ensure_ready 自助恢复
    const portListening = await checkPort(port);
    return errBlock(
      portListening ? 'connect_failed' : 'port_not_listening',
      `${e.message}`,
      portListening
        ? '端口在监听但握手失败，项目可能还在编译：等 30s 重试 connect，或用 ensure_ready 兜底'
        : `自动化端口 ${port} 未监听。调用 ensure_ready（传 projectPath）自动启动，无需人工`
    );
  }
}

async function handleDisconnect() {
  if (!mp) return ok('Not connected, nothing to do.');
  try {
    await withTimeout(mp.disconnect(), 5000, 'disconnect');
  } catch (_) {
    /* ignore */
  }
  mp = null;
  currentPort = null;
  return ok('Disconnected.');
}

async function handleStatus() {
  if (!mp) return ok({ connected: false });
  try {
    const stack = await withTimeout(mp.pageStack(), 10000, 'pageStack');
    const current = stack[stack.length - 1];
    return ok({
      connected: true,
      port: currentPort,
      pageStackDepth: stack.length,
      currentPagePath: current ? current.path : null,
    });
  } catch (e) {
    return ok({ connected: true, port: currentPort, error: e.message });
  }
}

async function handleEvaluate(args) {
  ensureConnected();
  // automator.evaluate 接受函数对象，会把函数 toString 后发到逻辑层 eval
  // MCP 传的是字符串，用 new Function 构造函数对象（比 eval 更隔离，不访问局部作用域）
  // ⚠️ 安全提示：MCP 协议层无鉴权，此工具仅在本地可信环境使用
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(`return ${args.fn}`)();
    if (typeof fn !== 'function') {
      return err(`fn must be a function expression, got ${typeof fn}`);
    }
  } catch (e) {
    return err(`Invalid function expression: ${e.message}`);
  }
  try {
    const result = await withTimeout(mp.evaluate(fn), API_TIMEOUT_MS, 'evaluate');
    return ok({ result });
  } catch (e) {
    return err(e.message);
  }
}

async function handlePageStack() {
  ensureConnected();
  try {
    const stack = await withTimeout(mp.pageStack(), API_TIMEOUT_MS, 'pageStack');
    // 只取可序列化字段，避免循环引用
    const safe = stack.map((p) => ({
      path: p.path,
      query: p.query,
      id: p.id,
    }));
    return ok({ depth: safe.length, pages: safe });
  } catch (e) {
    return err(e.message);
  }
}

async function handleNavigateTo(args) {
  ensureConnected();
  if (!args.url) return err('url is required');
  try {
    await withTimeout(mp.navigateTo(args.url), API_TIMEOUT_MS, 'navigateTo');
    return ok(`Navigated to ${args.url}`);
  } catch (e) {
    // 微信语义：navigateTo 不能打开 tabBar 页。自动降级 switchTab 保留 tab 语义
    if (/tabbar/i.test(e.message)) {
      try {
        await withTimeout(mp.switchTab(args.url), API_TIMEOUT_MS, 'switchTab');
        return ok(`Switched to tabBar page ${args.url}（navigateTo 不支持 tabBar 页，已自动降级 switchTab）`);
      } catch (e2) {
        return err(`switchTab fallback failed: ${e2.message}`);
      }
    }
    return err(e.message);
  }
}

async function handleNavigateBack(args) {
  ensureConnected();
  // 注意不能写 `args.delta || 1`：delta=0 是合法输入（微信语义为「不返回」），
  // 被 falsy 兜底成 1 会变成多退一页，与调用方要求不符。
  const raw = args.delta;
  let delta;
  if (raw === undefined || raw === null || raw === '') delta = 1;
  else {
    delta = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(delta)) return err(`delta must be a number, got: ${raw}`);
  }
  if (delta <= 0) return ok('Navigated back 0 page(s)（delta<=0，按微信语义不执行返回）');
  try {
    // automator 的 navigateBack() 无参数（d.ts 签名确认），只能循环调用 delta 次。
    // 关键坑：页面栈已到底时它**不抛错**，每次仍照常耗时约 3s。若直接跑满 delta 次，
    // delta 稍大就会挂死（实测栈深 1 时 delta=5 → 15s，delta=99 → 约 300s，超出任何客户端超时），
    // 而且回报的 "back up to N page(s)" 是假成功——实际一页都没退。
    // 因此先读栈深收敛预算，并只回报真正返回成功的次数。
    let depth = null;
    try {
      const stack = await withTimeout(mp.pageStack(), API_TIMEOUT_MS, 'pageStack');
      depth = Array.isArray(stack) ? stack.length : null;
    } catch (_) {
      /* 读不到栈深就退回原循环逻辑，仍受单次 API 超时保护 */
    }
    const budget = depth === null ? delta : Math.max(0, Math.min(delta, depth - 1));

    let done = 0;
    for (let i = 0; i < budget; i++) {
      try {
        await withTimeout(mp.navigateBack(), API_TIMEOUT_MS, `navigateBack[${i}]`);
        done++;
      } catch (_) {
        break; // 页面栈已到底或调用失败，停止返回
      }
    }

    if (depth !== null && budget < delta) {
      return ok(
        `Navigated back ${done} page(s)（页面栈仅 ${depth} 层，delta=${delta} 已收敛为 ${budget}）`
      );
    }
    return ok(`Navigated back ${done} page(s)`);
  } catch (e) {
    return err(e.message);
  }
}

async function handleGetCurrentPage() {
  ensureConnected();
  try {
    const result = await withTimeout(
      mp.evaluate(() => {
        const pages = getCurrentPages();
        if (!pages.length) return null;
        const p = pages[pages.length - 1];
        // data 可能含函数或循环引用，用 JSON.stringify 过滤避免 automator 序列化失败
        let safeData;
        try {
          safeData = JSON.parse(JSON.stringify(p.data));
        } catch (e) {
          safeData = { _error: `data not serializable: ${e.message}` };
        }
        return {
          route: p.route,
          data: safeData,
          options: p.options,
        };
      }),
      API_TIMEOUT_MS,
      'getCurrentPage'
    );
    return ok(result);
  } catch (e) {
    return err(e.message);
  }
}

async function handleCallWxApi(args) {
  ensureConnected();
  const { method, args: apiArgs = [] } = args;
  if (!method) return err('method is required');
  // 通过 evaluate 调用同步 wx API
  try {
    const result = await withTimeout(
      mp.evaluate(
        // eslint-disable-next-line no-new-func
        new Function(
          `return wx.${method}.apply(wx, ${JSON.stringify(apiArgs)})`
        )
      ),
      API_TIMEOUT_MS,
      'callWxApi'
    );
    return ok({ result });
  } catch (e) {
    return err(e.message);
  }
}

async function handleGetData() {
  ensureConnected();
  try {
    const result = await withTimeout(
      mp.evaluate(() => {
        const pages = getCurrentPages();
        if (!pages.length) return null;
        const p = pages[pages.length - 1];
        // data 可能含函数或循环引用，用 JSON.stringify 过滤避免 automator 序列化失败
        try {
          return JSON.parse(JSON.stringify(p.data));
        } catch (e) {
          return { _error: `data not serializable: ${e.message}` };
        }
      }),
      API_TIMEOUT_MS,
      'getData'
    );
    return ok(result);
  } catch (e) {
    return err(e.message);
  }
}

async function handleElementTap(args) {
  ensureConnected();
  const { selector } = args;
  if (!selector) return err('selector is required');
  try {
    const page = await withTimeout(mp.currentPage(), API_TIMEOUT_MS, 'currentPage');
    const element = await withTimeout(
      page.$(selector),
      API_TIMEOUT_MS,
      'page.$'
    );
    if (!element) return err(`Element not found: ${selector}`);
    await withTimeout(element.tap(), API_TIMEOUT_MS, 'element.tap');
    return ok(`Tapped ${selector}`);
  } catch (e) {
    return err(e.message);
  }
}

async function handleElementInput(args) {
  ensureConnected();
  const { selector, value } = args;
  if (!selector || value === undefined) {
    return err('selector and value are required');
  }
  try {
    const page = await withTimeout(mp.currentPage(), API_TIMEOUT_MS, 'currentPage');
    const element = await withTimeout(
      page.$(selector),
      API_TIMEOUT_MS,
      'page.$'
    );
    if (!element) return err(`Element not found: ${selector}`);
    await withTimeout(
      element.input(value),
      API_TIMEOUT_MS,
      'element.input'
    );
    return ok(`Input "${value}" into ${selector}`);
  } catch (e) {
    return err(e.message);
  }
}

async function handleElementScroll(args) {
  ensureConnected();
  const { selector, x = 0, y = 0 } = args;
  try {
    if (selector) {
      // 元素内滚动：Element.scrollTo(x, y)
      const page = await withTimeout(mp.currentPage(), API_TIMEOUT_MS, 'currentPage');
      const element = await withTimeout(page.$(selector), API_TIMEOUT_MS, 'page.$');
      if (!element) return err(`Element not found: ${selector}`);
      // automator 的 Element.create 按 tagName 分派，只有 <scroll-view> 才是带 scrollTo 的
      // ScrollViewElement；传其它标签会抛 "element.scrollTo is not a function"，
      // AI 从这条报错里看不出原因，无法自助纠正。这里显式判定并给出可操作提示。
      if (typeof element.scrollTo !== 'function') {
        return err(
          `${selector}（<${element.tagName || 'unknown'}>）不支持容器内滚动：` +
            '只有 <scroll-view> 元素才有 scrollTo。请改用 scroll-view 的选择器，' +
            '或去掉 selector 参数走页面级滚动'
        );
      }
      await withTimeout(element.scrollTo(x, y), API_TIMEOUT_MS, 'scrollTo');
      return ok(`Scrolled to (${x}, ${y}) in ${selector}`);
    } else {
      // 页面级滚动：MiniProgram.pageScrollTo(scrollTop)
      // Page 类无 scrollTo 方法（d.ts 确认），必须用 mp.pageScrollTo
      await withTimeout(mp.pageScrollTo(y), API_TIMEOUT_MS, 'pageScrollTo');
      return ok(`Page scrolled to y=${y}`);
    }
  } catch (e) {
    return err(e.message);
  }
}

async function handlePreflight(args) {
  const projectPath = resolveProject(args.projectPath);
  if (!projectPath) {
    return errBlock(
      'project_path_required',
      'Could not resolve mini program project root',
      `传 projectPath 参数或设置环境变量 ${PROJECT_ENV}`
    );
  }
  try {
    const report = await preflight(projectPath, {
      checkPort: checkPortUtil,
      port: args.port || DEFAULT_PORT,
    });
    return ok(Object.assign({ projectPath }, report));
  } catch (e) {
    return err(`preflight failed: ${e.message}`);
  }
}

async function handleRebuild(args) {
  const projectPath = resolveProject(args.projectPath);
  if (!projectPath) {
    return errBlock(
      'project_path_required',
      'Could not resolve mini program project root',
      `传 projectPath 参数或设置环境变量 ${PROJECT_ENV}`
    );
  }
  const cliPath = findCli();
  if (!cliPath) {
    return errBlock(
      'not_installed',
      `cli not found in candidates: ${CLI_CANDIDATES.join('; ')}`,
      `设置环境变量 ${CLI_ENV} 指向 cli.bat (macOS: cli) 后重试`
    );
  }

  const port = args.port || DEFAULT_PORT;
  // 重建前主动断开，避免旧连接悬空（关闭项目会让旧 socket 失效）
  if (mp) {
    try {
      await withTimeout(mp.disconnect(), 5000, 'disconnect');
    } catch (_) {
      /* ignore */
    }
    mp = null;
    currentPort = null;
  }

  const result = await rebuild({
    cliPath,
    projectPath,
    port,
    timeoutMs: args.timeoutMs || 120000,
    withAutoPort: args.withAutoPort !== false,
  });

  // 自动化端口起不来且 CLI 明确报服务端口关闭时，标注 blocker 让 Agent 直接去开设置
  if (!result.ok && isServicePortDisabled(result.cliOutput)) {
    result.blocker = 'port_disabled';
    result.hint = '服务端口未开启：微信开发者工具 → 设置 → 安全设置 → 打开「服务端口」后重试 rebuild';
  }

  if (args.reconnect !== false && result.ok) {
    try {
      await connectWithRetry(port);
      result.reconnected = true;
      // 端口通 ≠ 运行时就绪：IDE 后台编译未完成时 evaluate 会超时，这里等它 ready
      try {
        await waitRuntimeReady();
        result.runtimeReady = true;
      } catch (e) {
        result.runtimeReady = false;
        result.runtimeError = e.message;
      }
    } catch (e) {
      result.reconnected = false;
      result.reconnectError = e.message;
    }
  }

  return ok(Object.assign({ projectPath, cliPath }, result));
}

async function handleBuildNpm(args) {
  const projectPath = resolveProject(args.projectPath);
  if (!projectPath) {
    return errBlock(
      'project_path_required',
      'Could not resolve mini program project root',
      `传 projectPath 参数或设置环境变量 ${PROJECT_ENV}`
    );
  }
  const cliPath = findCli();
  if (!cliPath) {
    return errBlock(
      'not_installed',
      `cli not found in candidates: ${CLI_CANDIDATES.join('; ')}`,
      `设置环境变量 ${CLI_ENV} 指向 cli.bat (macOS: cli) 后重试`
    );
  }
  const r = await buildNpm(cliPath, projectPath, args.timeoutMs || 180000);
  // 构建后统计产物，便于判断成功与否
  let built = 0;
  const npmDir = path.join(projectPath, 'miniprogram_npm');
  try {
    if (fs.existsSync(npmDir)) {
      built = fs.readdirSync(npmDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    }
  } catch (_) {
    /* ignore */
  }
  const result = {
    projectPath,
    cliPath,
    exitCode: r.code,
    timedOut: r.timedOut,
    output: r.output,
    miniprogramNpmPackages: built,
  };
  // 服务端口关闭时 build-npm 必然失败，标注出来免得 Agent 去排查 npm 配置
  if (r.code !== 0 && isServicePortDisabled(r.output)) {
    result.blocker = 'port_disabled';
    result.hint = '服务端口未开启：微信开发者工具 → 设置 → 安全设置 → 打开「服务端口」后重试 build_npm';
  }
  return ok(result);
}

function handleListChecks() {
  return ok({ checkDir: 'checks', checks: listChecks() });
}

// ============ wechatide 工具实现 ============

async function handleWechatideStatus(args) {
  try {
    const ctx = wechatideContext(args);
    const { result } = await callWechatide({
      wechatidePath: ctx.wechatidePath,
      tool: 'check_wechatide_status',
      client: ctx.client,
      token: ctx.token,
      timeoutMs: 120000,
    });
    const data = { wechatidePath: ctx.wechatidePath, ...result };
    // 登录失效单独标注，提示人工扫码（官方 skill 门禁规则的代码化）
    if (result.loginExpired === true) {
      data.blocker = 'wechatide_not_logged_in';
      data.hint = '微信开发者工具登录已失效，需人工打开工具扫码登录后重试';
    }
    return ok(data);
  } catch (e) {
    return wechatideErr(e);
  }
}

async function handleWechatidePollTask(args) {
  try {
    const ctx = wechatideContext(args);
    if (!args.taskId) return err('taskId is required');
    const { result } = await callWechatide({
      wechatidePath: ctx.wechatidePath,
      tool: 'polling_task_result',
      args: ['--task-id', String(args.taskId)],
      client: ctx.client,
      token: ctx.token,
    });
    return ok(result);
  } catch (e) {
    return wechatideErr(e);
  }
}

async function handleSimulatorScreenshot(args) {
  try {
    const ctx = wechatideContext(args);
    const projectPath = wechatideProject(args);
    const flags = buildFlags({
      project: projectPath,
      path: args.path,
      wait: args.wait,
      'wait-for-selector': args.waitForSelector,
      optimize: args.optimize,
      quality: args.quality,
    });
    const { result } = await callWechatide({
      wechatidePath: ctx.wechatidePath,
      tool: 'simulator_screenshot',
      args: flags,
      client: ctx.client,
      token: ctx.token,
      timeoutMs: 60000,
    });
    return ok({ projectPath, ...result });
  } catch (e) {
    return wechatideErr(e);
  }
}

/** console/network 共用：grep 命令默认取全部；官方返回的是纯字符串（grep 输出） */
async function handleSimulatorLog(kind, args) {
  try {
    const ctx = wechatideContext(args);
    const projectPath = wechatideProject(args);
    const flags = buildFlags({
      project: projectPath,
      command: args.command || 'grep -n .',
    });
    const { result } = await callWechatide({
      wechatidePath: ctx.wechatidePath,
      tool: kind,
      args: flags,
      client: ctx.client,
      token: ctx.token,
      timeoutMs: 60000,
    });
    // 字符串结果直接放 output 字段；空字符串 = 无匹配行（不代表缓冲区为空）
    if (typeof result === 'string') {
      return ok({ projectPath, kind, matched: result.length > 0, output: result });
    }
    return ok({ projectPath, kind, ...result });
  } catch (e) {
    return wechatideErr(e);
  }
}

/** 预览类（qrcode / auto_preview）共用参数拼装 */
async function handlePreview(tool, args) {
  try {
    const ctx = wechatideContext(args);
    const projectPath = wechatideProject(args);
    const flags = buildFlags({
      project: projectPath,
      'qr-format': args.qrFormat,
      'qr-output': args.qrOutput,
      'page-path': args.pagePath,
      query: args.query,
      scene: args.scene,
    });
    const { result } = await callWechatide({
      wechatidePath: ctx.wechatidePath,
      tool,
      args: flags,
      client: ctx.client,
      token: ctx.token,
    });
    return ok({ projectPath, ...result });
  } catch (e) {
    return wechatideErr(e);
  }
}

async function handleUpload(args) {
  try {
    const ctx = wechatideContext(args);
    const projectPath = wechatideProject(args);
    if (!args.version) return err('version is required（上传的版本号，如 1.0.0）');
    const flags = buildFlags({
      project: projectPath,
      'upload-version': args.version,
      desc: args.desc,
    });
    const { result } = await callWechatide({
      wechatidePath: ctx.wechatidePath,
      tool: 'upload',
      args: flags,
      client: ctx.client,
      token: ctx.token,
    });
    return ok({ projectPath, version: args.version, ...result });
  } catch (e) {
    return wechatideErr(e);
  }
}

async function handleProjectList(args) {
  try {
    const ctx = wechatideContext(args);
    const flags = buildFlags({ scope: args.scope });
    const { result } = await callWechatide({
      wechatidePath: ctx.wechatidePath,
      tool: 'project_list',
      args: flags,
      client: ctx.client,
      token: ctx.token,
      timeoutMs: 60000,
    });
    return ok(result);
  } catch (e) {
    return wechatideErr(e);
  }
}

/**
 * wechatide_call：通用透传，覆盖未单独封装的官方工具（见 WECHATIDE_ALL_TOOLS）。
 * 两个护栏：
 * - automation_* 会与本 MCP 已持有的 automator 会话（ws 9420）抢连接 → 已连接时明确拒绝并给恢复指引
 * - quit 关闭整个开发者工具 → 需 args 里显式传 confirm=true
 */
async function handleWechatideCall(args) {
  try {
    const ctx = wechatideContext(args);
    const tool = args.tool;
    if (!tool || !/^[\w-]+$/.test(tool)) {
      return err('tool is required（官方 wechatide 工具名，下划线命名，如 get_user_appids）');
    }
    if (tool.startsWith('automation_') && mp) {
      return errBlock(
        'automation_conflict',
        `${tool} needs the DevTools automation session, which this MCP already holds on ws 9420`,
        '先调 disconnect 释放本 MCP 的自动化连接 → 再 wechatide_call ' + tool +
          ' → 用完调 ensure_ready 恢复连接；不要两边同时驱动同一个项目'
      );
    }
    const cliArgs = { ...(args.args || {}) };
    // 项目路径：与其它 wechatide 工具保持一致——没显式给就用 resolveProject() 自动探测，
    // 否则官方 CLI 会直接报 missing required arguments: --project，透传能力等于废掉一半。
    // 例外：args 里已带 project / appid 的（部分云工具用 appid 替代 project）按其为准，不覆盖。
    const explicitProject =
      cliArgs.project !== undefined || cliArgs.projectPath !== undefined || !!args.projectPath;
    const explicitAppId = cliArgs.appid !== undefined || cliArgs.appId !== undefined;
    let autoProjectPath = null;
    if (!explicitProject && !explicitAppId) {
      autoProjectPath = resolveProject();
    }
    const needsConfirm = tool === 'quit' || tool === 'project_remove' || tool === 'debug_clear_cache';
    const confirmed = cliArgs.confirm === true;
    delete cliArgs.confirm;
    if (needsConfirm && !confirmed) {
      return err(
        `${tool} 是破坏性操作（关闭工具/删项目/清缓存），args 里加 {"confirm": true} 再执行`
      );
    }
    const flags = buildFlags(cliArgs);
    if (args.projectPath) {
      flags.push('--project', resolveProject(args.projectPath) || args.projectPath);
    } else if (autoProjectPath) {
      flags.push('--project', autoProjectPath);
    }
    const { result } = await callWechatide({
      wechatidePath: ctx.wechatidePath,
      tool,
      args: flags,
      client: ctx.client,
      token: ctx.token,
      timeoutMs: args.timeoutMs || 180000,
      pollTimeoutMs: args.pollTimeoutMs || 120000,
    });
    // 官方部分工具（如 compile_wxml）返回纯字符串，统一挂 output 字段
    return ok(
      typeof result === 'string'
        ? { tool, output: result }
        : { tool, result }
    );
  } catch (e) {
    return wechatideErr(e);
  }
}

async function handleRunCheck(args) {
  ensureConnected();
  // 先等运行时就绪，避免 IDE 刚启动时 evaluate 超时导致用例假失败
  try {
    await waitRuntimeReady();
  } catch (e) {
    return errBlock(
      'runtime_not_ready',
      e.message,
      'IDE 可能仍在编译，稍后重试 run_check；或先调 rebuild 强制重编译'
    );
  }
  try {
    const report = await runChecks(
      {
        mp,
        automator,
        withTimeout,
        sleep,
        projectRoot: resolveProject(args.projectPath),
      },
      args.name
    );
    return ok(report);
  } catch (e) {
    return err(`run_check failed: ${e.message}`);
  }
}

// ============ 工具分发 ============

async function dispatch(name, args) {
  switch (name) {
    case 'ensure_ready':
      return handleEnsureReady(args || {});
    case 'auto_test':
      return handleAutoTest(args || {});
    case 'connect':
      return handleConnect(args || {});
    case 'disconnect':
      return handleDisconnect();
    case 'status':
      return handleStatus();
    case 'evaluate':
      return handleEvaluate(args || {});
    case 'page_stack':
      return handlePageStack();
    case 'navigate_to':
      return handleNavigateTo(args || {});
    case 'navigate_back':
      return handleNavigateBack(args || {});
    case 'get_current_page':
      return handleGetCurrentPage();
    case 'call_wx_api':
      return handleCallWxApi(args || {});
    case 'get_data':
      return handleGetData();
    case 'element_tap':
      return handleElementTap(args || {});
    case 'element_input':
      return handleElementInput(args || {});
    case 'element_scroll':
      return handleElementScroll(args || {});
    case 'preflight':
      return handlePreflight(args || {});
    case 'rebuild':
      return handleRebuild(args || {});
    case 'build_npm':
      return handleBuildNpm(args || {});
    case 'list_checks':
      return handleListChecks();
    case 'run_check':
      return handleRunCheck(args || {});
    case 'wechatide_status':
      return handleWechatideStatus(args || {});
    case 'wechatide_poll_task':
      return handleWechatidePollTask(args || {});
    case 'simulator_screenshot':
      return handleSimulatorScreenshot(args || {});
    case 'get_simulator_console':
      return handleSimulatorLog('get_simulator_console', args || {});
    case 'get_simulator_network':
      return handleSimulatorLog('get_simulator_network', args || {});
    case 'create_preview_qrcode':
      return handlePreview('create_preview_qrcode', args || {});
    case 'auto_preview':
      return handlePreview('auto_preview', args || {});
    case 'upload':
      return handleUpload(args || {});
    case 'project_list':
      return handleProjectList(args || {});
    case 'wechatide_call':
      return handleWechatideCall(args || {});
    default:
      return err(`Unknown tool: ${name}`);
  }
}

// ============ MCP Server 启动 ============

const server = new Server(
  { name: 'miniprogram-devtools-mcp', version: '0.4.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await dispatch(name, args);
  } catch (e) {
    return err(e.message);
  }
});

// 优雅退出
process.on('SIGINT', async () => {
  if (mp) {
    try {
      await mp.disconnect();
    } catch (_) {
      /* ignore */
    }
  }
  process.exit(0);
});

// 启动
const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  // stdio 模式下不能 console.log（会污染协议流），用 stderr 输出诊断信息
  process.stderr.write('[miniprogram-devtools-mcp] server started, waiting for ensure_ready/connect...\n');
});
