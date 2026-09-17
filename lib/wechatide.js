/**
 * 官方 wechatide CLI 薄封装：补齐 miniprogram-automator 覆盖不到的能力
 * （模拟器截图、console/network 日志、预览推送、上传体验版、项目列表）。
 *
 * 设计（对应官方 skill 的编排规则，在这里代码化，Agent 只见结构化结果）：
 * - 只调用开发者工具自带的 wechatide.cmd / wechatide 命令，不复制不内嵌；
 *   命令随官方工具升级，本层只在命令名/参数变化时才需要调整
 * - 调用前门禁：findWechatide 找不到 → blocker wechatide_not_installed；
 *   CLI 报服务端口/登录态问题时 → blocker port_disabled / wechatide_not_logged_in
 * - 异步任务（上传/预览/首次授权等需用户动手）：绝不静默久等——授权短等 12s、
 *   其余等 pollTimeoutMs（默认 45s），超时返回 { pending: true, taskId, userAction }，
 *   Agent 把 userAction 转告用户后用 wechatide_poll_task 续查
 * - 与本 MCP 的 automator 连接（ws 9420）互不干扰：这里只封装 IDE HTTP 侧能力，
 *   不封装 automation_*（那会和我们已持有的自动化会话抢连接）
 */

const fs = require('fs');
const path = require('path');
const { IS_WIN, spawnCli, decodeCliOutput } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 环境变量可覆盖的 wechatide CLI 绝对路径 */
const WECHATIDE_ENV = 'WECHAT_DEVTOOLS_WECHATIDE';
/** 官方 -c 客户端简称（须与授权弹窗一致）；环境变量可覆盖 */
const CLIENT_ENV = 'WECHATIDE_CLIENT';
const DEFAULT_CLIENT = 'miniprogram-mcp';
/** 官方 CLI 访问令牌（设置-安全设置里可选开启）；环境变量可覆盖 */
const TOKEN_ENV = 'WECHATIDE_TOKEN';

/**
 * 需要用户动手的任务（授权/人工确认）的等待策略：
 * 授权先等一小段（用户常在屏幕前，秒回则免二次轮询）；超时即返回 pending 让 Agent 转告用户，
 * 绝不长时间静默阻塞——用户不知道 AI 在等他，AI 也不知道用户没看见弹窗。
 */
const AUTH_QUICK_WAIT_MS = 12000;
const DEFAULT_POLL_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 3000;

/** 从 CLI 原始输出里识别「需要用户处理」的已知故障，返回结构化 blocker/hint */
function classifyCliFailure(raw) {
  const text = raw || '';
  if (/服务端口已关闭|service port disabled/i.test(text)) {
    return {
      blocker: 'port_disabled',
      hint:
        '微信开发者工具的服务端口未开启：打开工具 → 设置 → 安全设置 → 打开「服务端口」' +
        '（2.x 首次开启可能要求确认 CLI 能力），然后重试',
    };
  }
  if (/loginExpired|not logged in|未登录|需要登录|login required|请先登录/i.test(text)) {
    return {
      blocker: 'wechatide_not_logged_in',
      hint: '微信开发者工具登录已失效：请用户打开工具扫码登录后重试（可先调 wechatide_status 确认）',
    };
  }
  // 官方 CLI 在「项目窗口没打开 / 没激活」时取不到窗口句柄，回退到 auth 握手后抛
  // `Cannot read properties of undefined (reading 'winId')`。这是 IDE 侧行为，但落到通用
  // wechatide_error 就完全没有可执行提示，Agent 只会原地重试。单独分类出来。
  if (/reading\s+['"]?winId['"]?\s*\)/i.test(text)) {
    return {
      blocker: 'ide_window_not_active',
      hint:
        '开发者工具里的项目窗口未打开或未激活（官方 CLI 取不到窗口 winId）：' +
        '先调 ensure_ready 拉起项目窗口，或手动把该项目的开发者工具窗口切到前台，然后重试。' +
        '窗口最小化到托盘时也会触发，需先从托盘打开',
    };
  }
  // Windows 陷阱：command 里写双引号（如 `grep -iE "a|b"`）会被 cmd.exe 当成命令分隔符吃掉，
  // 表现为 `'xxx' 不是内部或外部命令` 且输出不再是 JSON。AI 很难从这条报错反推原因。
  if (/不是内部或外部命令|is not recognized as an internal or external command/i.test(text)) {
    return {
      blocker: 'command_quote_issue',
      hint:
        'command 参数里的引号被 Windows 命令行吞掉了：正则 / 含空格的模式请用单引号，' +
        "例如 `grep -iE 'error|fail'`，不要写成 `grep -iE \"error|fail\"`",
    };
  }
  return null;
}

/** 带结构化 blocker 的错误，index.js 据此转 errBlock 返回 */
class WechatideError extends Error {
  constructor(blocker, message, hint) {
    super(message);
    this.blocker = blocker;
    this.hint = hint;
  }
}

/** 候选路径：环境变量 → 与 cli.bat 同目录 → 常见安装位置 → PATH */
function wechatideCandidates(cliPathHint) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const name = IS_WIN ? 'wechatide.cmd' : 'wechatide';
  const list = [process.env[WECHATIDE_ENV]];

  if (cliPathHint) list.push(path.join(path.dirname(cliPathHint), name));

  if (IS_WIN) {
    list.push(
      'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\wechatide.cmd',
      'C:\\Program Files\\Tencent\\微信web开发者工具\\wechatide.cmd',
      home ? path.join(home, 'AppData', 'Local', '微信开发者工具', 'wechatide.cmd') : null,
      home ? path.join(home, 'AppData', 'Local', '微信web开发者工具', 'wechatide.cmd') : null
    );
    // PATH 兜底（wechatide.cmd 不在候选位置时，机器可能配置过全局 PATH）
    for (const dir of (process.env.PATH || '').split(';')) {
      if (dir) list.push(path.join(dir.trim(), name));
    }
  } else {
    list.push(
      '/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide',
      home
        ? path.join(home, 'Applications', 'wechatwebdevtools.app', 'Contents', 'MacOS', 'wechatide')
        : null
    );
  }
  return list.filter(Boolean);
}

/** 返回本机可用的 wechatide 路径，找不到返回 null */
function findWechatide(cliPathHint) {
  for (const p of wechatideCandidates(cliPathHint)) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {
      /* 单个路径探测失败继续下一个 */
    }
  }
  return null;
}

/** wechatide 输出是「日志行 + pretty JSON（+ 可能追加的非 JSON 尾巴）」：平衡扫描取出首个完整 JSON */
function parseCliJson(raw) {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 执行一条 wechatide 命令并解析 JSON 输出
 * @returns {Promise<{code: number|null, raw: string, json: object|null, timedOut: boolean}>}
 */
function runWechatide(wechatidePath, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    try {
      const child = spawnCli(wechatidePath, args);
      // JSON 结果在输出开头；结尾可能是巨大字节流（如二维码）。保头部，丢弃超长尾部。
      // 收 Buffer 而非字符串：中文 Windows 上同一条输出混着 UTF-8（wechatide 的 JSON）
      // 与 GBK（cmd.exe 自己的报错），必须在收齐后按行做 uft8→gbk 回落解码，否则中文全是乱码
      let chunks = [];
      let size = 0;
      const push = (chunk) => {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        chunks.push(b);
        size += b.length;
        if (size > 2000000) {
          const merged = Buffer.concat(chunks);
          chunks = [merged.subarray(Math.max(0, merged.length - 2000000))];
          size = chunks[0].length;
        }
      };
      const rawOf = () => decodeCliOutput(Buffer.concat(chunks));
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('error', (e) =>
        finish({ code: null, raw: size ? rawOf() : String(e.message), json: null, timedOut: false })
      );
      child.on('close', (code) => {
        const raw = rawOf();
        finish({ code, raw, json: parseCliJson(raw), timedOut: false });
      });
      setTimeout(() => {
        const raw = rawOf();
        finish({ code: null, raw, json: parseCliJson(raw), timedOut: true });
      }, timeoutMs);
    } catch (e) {
      finish({ code: null, raw: e.message, json: null, timedOut: false });
    }
  });
}

/** 轮询一次异步任务结果 */
async function pollTask(wechatidePath, client, token, taskId) {
  const args = ['-c', client, 'polling_task_result', '--task-id', taskId];
  if (token) args.push('--token', token);
  return runWechatide(wechatidePath, args, 30000);
}

/**
 * 高层调用：执行工具 → 命中 pending 时内部轮询至完结/超时
 * @param {object} opts
 * @param {string} opts.wechatidePath CLI 绝对路径
 * @param {string} opts.tool 工具名（下划线命名，如 simulator_screenshot）
 * @param {string[]} [opts.args] 已展开的 flags（如 ['--project', 'D:\\x', '--command', 'grep -n .']）
 * @param {string} [opts.client] 客户端简称，默认 miniprogram-mcp（须与首次授权弹窗一致）
 * @param {string} [opts.token] CLI 访问令牌，工具未启用令牌校验时可省略
 * @param {number} [opts.timeoutMs] 单次命令超时
 * @param {number} [opts.pollTimeoutMs] 异步任务最长等待；仍 pending 时返回 {pending:true, taskId}
 * @returns {Promise<{ok: true, result: object}>} result 为官方返回的 result 字段；
 *          未完结的异步任务 result = { pending: true, taskId, taskType, message }
 */
async function callWechatide(opts) {
  const {
    wechatidePath,
    tool,
    args = [],
    client = process.env[CLIENT_ENV] || DEFAULT_CLIENT,
    token = process.env[TOKEN_ENV] || null,
    timeoutMs = 180000,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  } = opts;

  const cliArgs = ['-c', client, tool, ...args];
  if (token) cliArgs.push('--token', token);

  const first = await runWechatide(wechatidePath, cliArgs, timeoutMs);
  if (first.timedOut && !first.json) {
    throw new WechatideError(
      'wechatide_timeout',
      `${tool} 没有在 ${Math.round(timeoutMs / 1000)}s 内返回。cli output: ${first.raw.slice(-500)}`,
      '命令可能仍在后台执行（如上传编译中），稍后用 wechatide_poll_task 或重试确认状态'
    );
  }
  if (!first.json) {
    const known = classifyCliFailure(first.raw);
    if (known) throw new WechatideError(known.blocker, `${tool} 失败：${known.blocker}`, known.hint);
    throw new WechatideError(
      'wechatide_error',
      `${tool} 输出无法解析为 JSON。cli output: ${first.raw.slice(-800)}`,
      '命令可能执行失败，检查 wechatide 版本（工具更新可能变更参数）；也可先调 wechatide_status 诊断'
    );
  }
  if (first.json.ok === false) {
    const known = classifyCliFailure(first.raw);
    if (known) throw new WechatideError(known.blocker, `${tool} 失败：${known.blocker}`, known.hint);
    throw new WechatideError(
      'wechatide_error',
      `${tool} 执行失败：${JSON.stringify(first.json).slice(0, 600)}`,
      '可先调 wechatide_status 检查登录态与授权；参数问题看工具描述里的说明'
    );
  }

  // ⚠️ 不能写成 `first.json.result || {}`：官方在「grep 无命中 / 缓冲区为空」时返回 result: ""，
  // 空字符串是 falsy，会被兜底掉 —— 上层 handleSimulatorLog 依赖 typeof result === 'string'
  // 才有 {matched, output}，被吞掉后调用方拿不到约定字段，也分不清「真没日志」和「工具坏了」。
  // 这里只对 undefined 兜底，保留 "" / 0 / false 等合法空值。
  const result = first.json.result !== undefined ? first.json.result : {};

  // 异步任务：需要用户动手的（授权/人工确认）不能静默久等——
  // 授权先短等一次（用户在场则秒回免轮询），超时立刻返回 pending 让 Agent 转告用户
  if (result.taskId && result.status === 'pending') {
    const isAuth = result.taskType === 'auth';
    const waitMs = isAuth ? AUTH_QUICK_WAIT_MS : pollTimeoutMs;
    const deadline = Date.now() + waitMs;
    let last = result;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      // eslint-disable-next-line no-await-in-loop
      const polled = await pollTask(wechatidePath, client, token, result.taskId);
      const r = polled.json && polled.json.result;
      if (!r) continue;
      last = r;
      if (r.status && r.status !== 'pending') break;
    }
    if (last.status === 'pending') {
      return {
        ok: true,
        result: {
          pending: true,
          taskId: result.taskId,
          taskType: result.taskType || null,
          userAction: isAuth
            ? `微信开发者工具应已弹出「${client} 请求授权」确认框：请在工具内点击同意（若工具最小化到托盘，先从托盘打开）`
            : '请在微信开发者工具内确认操作弹窗（上传/预览类操作需要用户在工具里点头）',
          message: last.message || result.message || '等待用户在微信开发者工具内操作',
          hint:
            `这是需要用户动手的步骤：先把上面 userAction 原样转告用户，` +
            `用户操作完成后用 wechatide_poll_task 传 taskId=${result.taskId} 续查，或直接重试本工具`,
        },
      };
    }
    if (last.status === 'fail' || last.ok === false) {
      const known = classifyCliFailure(JSON.stringify(last));
      if (known) throw new WechatideError(known.blocker, `${tool} 异步任务失败：${known.blocker}`, known.hint);
      throw new WechatideError(
        'wechatide_task_failed',
        `${tool} 异步任务失败：${JSON.stringify(last).slice(0, 600)}`,
        '详情见上方 result；登录态失效可先调 wechatide_status 确认'
      );
    }
    return { ok: true, result: last };
  }

  return { ok: true, result };
}

/** 把 flags 对象展开成 CLI 参数数组；值为 undefined/null 的跳过，camelCase 转 kebab-case */
function buildFlags(obj) {
  const flags = [];
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined || value === null) continue;
    const flag = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    flags.push(flag, String(value));
  }
  return flags;
}

module.exports = {
  WECHATIDE_ENV,
  CLIENT_ENV,
  TOKEN_ENV,
  DEFAULT_CLIENT,
  WechatideError,
  wechatideCandidates,
  findWechatide,
  parseCliJson,
  classifyCliFailure,
  runWechatide,
  callWechatide,
  buildFlags,
  sleep,
};
