#!/usr/bin/env node
/**
 * 全量端到端测试：spawn 本 MCP server，按依赖顺序调用全部 30 个工具，输出结构化报告。
 *
 * 用法：
 *   node e2e-all-tools.js
 *
 * 产物：
 *   e2e-report.json   机器可读结果
 *   e2e-report.md     人读表格
 *
 * 判定：
 *   PASS  返回符合预期
 *   FAIL  报错或内容不符预期
 *   WARN  工具行为正确但结果待人工确认（pending / blocker / 环境限制）
 *   SKIP  前置依赖失败，未能执行
 *
 * 断言约定：expect() 返回
 *   true / 字符串 → PASS（字符串作为补充说明）
 *   OK(note) / NO(note) / WA(note) → 显式判定
 *   false → FAIL
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { resolveProject } = require('./lib/config');

const SERVER = path.join(__dirname, 'index.js');
const REPORT_JSON = path.join(__dirname, 'e2e-report.json');
const REPORT_MD = path.join(__dirname, 'e2e-report.md');

// ---------- 项目专属夹具 ----------
// 页面路径 / 选择器 / data 字段这些「只有被测小程序才知道」的值，一律从 e2e.config.js 读。
// e2e.config.js 已 gitignore（含本机真实项目信息）；仓库里只有占位用的 e2e.config.example.js。
function loadE2EConfig() {
  for (const f of ['./e2e.config', './e2e.config.example']) {
    try {
      return require(f);
    } catch (_) {
      /* 本机配置不存在时回落到仓库内的示例，相关用例会自动降级 */
    }
  }
  return {};
}

const CFG = Object.assign(
  {
    projectPath: '',
    containerSelector: '',
    formPage: '',
    dialogField: '',
    selectedField: '',
    selectedValue: null,
    resetFields: [],
    valueField: '',
    inputValue: 'e2eTest123',
    inputSelector: '',
    subPackagePage: '',
    tabPage: '',
    wxmlFile: '',
  },
  loadE2EConfig()
);

/** 子包页的最后一段路径，用于校验页面栈确实进入了该页（未配置时相关用例降级） */
const SUB_MARKER = String(CFG.subPackagePage || '')
  .split('/')
  .filter(Boolean)
  .pop();

const OK = (note) => ({ v: 'PASS', note: note || '' });
const NO = (note) => ({ v: 'FAIL', note: note || '' });
const WA = (note) => ({ v: 'WARN', note: note || '' });

const results = [];

// ---------- 基础工具 ----------

function log(s) {
  process.stdout.write(s + '\n');
}

function short(s, n = 200) {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  if (!t) return '';
  const one = t.replace(/\s+/g, ' ');
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return { __raw: text };
  }
}

// ---------- JSON-RPC 客户端 ----------

let seq = 0;
const pending = new Map();
let child;

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

function send(method, params, timeoutMs = 60000) {
  const id = ++seq;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout ${timeoutMs}ms waiting for ${method}`));
      }
    }, timeoutMs);
  });
}

function record(rec) {
  results.push(rec);
  log(`  [${rec.verdict}] ${rec.tool}${rec.ms ? ` (${rec.ms}ms)` : ''} ${short(rec.note, 300)}`);
  return rec;
}

/** 调用一个 MCP 工具并记录判定 */
async function step(group, name, args, expect, timeoutMs = 60000) {
  const startedAt = Date.now();
  let res;
  try {
    res = await send('tools/call', { name, arguments: args || {} }, timeoutMs);
  } catch (e) {
    return record({
      tool: name,
      group,
      verdict: 'FAIL',
      ms: Date.now() - startedAt,
      note: `协议层超时/异常: ${e.message}`,
      raw: '',
    });
  }

  if (res.error) {
    return record({
      tool: name,
      group,
      verdict: 'FAIL',
      ms: Date.now() - startedAt,
      note: `RPC error: ${short(JSON.stringify(res.error))}`,
      raw: '',
    });
  }

  const content = (res.result && res.result.content) || [];
  const text = content[0] ? content[0].text : '';
  const json = parse(text);
  const isError = !!(res.result && res.result.isError);
  const ms = Date.now() - startedAt;

  let verdict = 'PASS';
  let note = '';
  try {
    const r = expect({ json, text, isError });
    if (r === true) {
      note = short(text, 160);
    } else if (typeof r === 'string') {
      verdict = 'PASS';
      note = r;
    } else if (r && r.v) {
      verdict = r.v;
      note = r.note || '';
    } else {
      verdict = 'FAIL';
      note = '断言返回 false，详见原始返回';
    }
  } catch (e) {
    verdict = 'FAIL';
    note = `断言异常: ${e.message}`;
  }

  return record({ tool: name, group, verdict, ms, note, raw: short(text, 2000) });
}

function skip(name, group, reason) {
  return record({ tool: name, group, verdict: 'SKIP', ms: 0, note: reason, raw: '' });
}

// ---------- 用例 ----------

/**
 * 报告的静态段落（环境说明 + 缺陷清单）。放在这里是为了让重跑生成的报告自带结论，
 * 不用每次手工补写。
 *
 * 头部字段全部运行时生成：刻意不写死登录昵称、绝对路径、AppID、本机端口等机器专属信息 ——
 * 报告是要提交进仓库的，写死等于把本机隐私公开。
 */
function reportHeader() {
  const project =
    CFG.projectPath || process.env.WECHAT_DEVTOOLS_PROJECT || resolveProject() || '（未探测到）';
  return `# miniprogram-devtools-mcp 全量测试结果

## 测试环境

| 项 | 值 |
|---|---|
| 传输 / 协议 | stdio + JSON-RPC 2.0（2024-11-05），真实 spawn \`index.js\` |
| 判定口径 | 正向用例 + 负例（非法参数 / 未连接 / 护栏拦截）双层校验 |
| 运行环境 | Node ${process.version} · ${process.platform} |
| 被测小程序 | \`${project}\`（自动探测，可用 WECHAT_DEVTOOLS_PROJECT 覆盖） |

> 自动化测试会拉起/重开开发者工具窗口，并执行一次 \`rebuild\` 与 \`build_npm\`，属预期副作用。
> 发布类工具（upload / auto_preview / create_preview_qrcode）只验证参数校验路径，不真实发布。
> 报告含本机路径与登录态等隐私信息，**提交前请确认 e2e-report.* 已被 .gitignore 排除**。

`;
}

const REPORT_FOOTER = `
## 修复记录（本轮）

| # | 位置 | 问题与修复 |
|---|---|---|
| 1 | \`lib/wechatide.js\` \`const result = first.json.result \|\| {}\` | 官方在「grep 无命中 / 日志缓冲区为空」时返回 \`result: ""\`，空字符串被 falsy 兜底吞掉 → \`handleSimulatorLog\` 的 \`typeof result === 'string'\` 分支不命中，README 承诺的 \`{matched, output}\` 静默消失。改为仅对 \`undefined\` 兜底。修复后缓冲区为空时返回 \`matched: false, output: ""\` |
| 2 | \`index.js\` \`handleWechatideCall\` | 透传工具不自动探测项目路径，不传 \`projectPath\` 时官方 CLI 直接报 \`missing required arguments: --project\`，与其余 9 个 wechatide 工具的自动探测行为不一致。改为未显式指定且 args 里无 \`project\`/\`appid\` 时用 \`resolveProject()\` 自动注入（官方 CLI 对多余参数只告警不报错）。修复后 \`compile_wxml\` / \`simulator_refresh\` / \`cloud_env_list\` 零参数可跑通 |
| 3 | \`index.js\` \`handleEnsureReady\` | 连接成功即返回，未等 AppService 编译完成 → Agent 拿到 \`ready:true\` 后首个 automator 调用有概率 10s 超时（实测：status 超时 / evaluate 8.6s，第三次才 4ms）。补 \`waitRuntimeReadyBestEffort()\`（60s 上限，不改写成功结论）并新增返回字段 \`runtimeReady\`。修复后紧随的 \`status\` 由 10005ms 降到 5ms |

## 遗留观察（非缺陷）

- \`project_list\` 默认 \`scope=miniprogram\` 返回 0 条、\`scope=all\` 才有 1 条：被测项目 \`compileType=weapp\` 却不在 miniprogram 列表里，属官方 CLI 分类逻辑。文档可补一句「找不到项目时改用 \`scope: "all"\`」。
- \`element_input\` 在首页找不到 e2e.config.js 里配置的 \`inputSelector\`：该 input 位于未激活的 \`wx:if\` 分支，工具报错正确。换自己项目的选择器即可。
- \`get_simulator_console\` 依赖 IDE 项目窗口处于活跃状态；窗口未聚焦时官方 CLI 会回退到 auth 握手并报 \`Cannot read properties of undefined (reading 'winId')\`，属官方侧行为。
`;

/** 生成 Markdown 报告 */
function writeReport(summary) {
  const md = [];
  md.push(reportHeader());
  md.push(
    `## 结论\n\n**${summary.total} 项检查：通过 ${summary.PASS} / 失败 ${summary.FAIL} / 待确认 ${summary.WARN} / 跳过 ${summary.SKIP}**\n`
  );
  md.push('| 分组 | 工具 / 用例 | 结果 | 耗时 | 说明 |');
  md.push('|---|---|---|---|---|');
  for (const r of summary.results) {
    md.push(
      `| ${r.group} | \`${r.tool}\` | **${r.verdict}** | ${r.ms || '-'}ms | ${String(r.note)
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')} |`
    );
  }
  md.push(REPORT_FOOTER);
  fs.writeFileSync(REPORT_MD, md.join('\n'), 'utf8');
}

/** 只根据已有 JSON 重新渲染 Markdown（`--report-only`），用于补写结论不改数据 */
function reportOnly() {
  const summary = JSON.parse(fs.readFileSync(REPORT_JSON, 'utf8'));
  writeReport(summary);
  log(`已从 ${path.basename(REPORT_JSON)} 重新生成 ${path.basename(REPORT_MD)}`);
  log(`PASS ${summary.PASS} / FAIL ${summary.FAIL} / WARN ${summary.WARN} / SKIP ${summary.SKIP}`);
}

async function main() {
  if (process.argv.includes('--report-only')) {
    reportOnly();
    return;
  }
  child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: __dirname,
  });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.stderr.on('data', () => {});

  try {
    // ===== 协议层 =====
    log('\n=== 协议层 ===');
    const init = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1.0.0' },
    });
    if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
    notify('notifications/initialized', {});
    record({
      tool: 'initialize',
      group: '协议',
      verdict: 'PASS',
      ms: 0,
      note: `${init.result.serverInfo.name} v${init.result.serverInfo.version}，protocol=${init.result.protocolVersion}`,
      raw: '',
    });

    const list = await send('tools/list', {});
    const tools = list.result.tools;
    const names = tools.map((t) => t.name);
    record({
      tool: 'tools/list',
      group: '协议',
      verdict: names.length === 30 ? 'PASS' : 'FAIL',
      ms: 0,
      note: `${names.length} 个工具${names.length === 30 ? '' : '（README 声明 30）'}`,
      raw: names.join(','),
    });
    const bad = tools.filter((t) => !t.name || !t.description || !t.inputSchema || t.inputSchema.type !== 'object');
    const noDesc = tools.filter((t) => !t.inputSchema.properties || Object.keys(t.inputSchema.properties).length === 0);
    record({
      tool: 'tools/list:schema',
      group: '协议',
      verdict: bad.length === 0 ? 'PASS' : 'FAIL',
      ms: 0,
      note: bad.length
        ? `缺失字段的工具: ${bad.map((t) => t.name)}`
        : `30 个工具 schema 完整；${noDesc.length} 个无参工具`,
      raw: '',
    });

    // ===== 组1：无需 IDE 的只读工具 =====
    log('\n=== 组1 · 无需 IDE ===');
    await step('只读', 'status', {}, ({ json }) =>
      json.connected === false ? '未连接时返回 connected:false' : NO(`非预期: ${short(json)}`)
    );
    await step('只读', 'preflight', {}, ({ json }) => {
      if (json.pass === undefined || !Array.isArray(json.errors)) return NO(`缺 pass/errors: ${short(json)}`);
      return `pass=${json.pass} errors=${json.errors.length} warnings=${json.warnings.length} stats=${short(json.stats, 80)}`;
    }, 60000);
    await step('只读', 'list_checks', {}, ({ json }) =>
      Array.isArray(json.checks) && json.checks.length > 0
        ? `${json.checks.length} 个用例: ${json.checks.map((c) => c.name).join(',')}`
        : NO(`checks 为空: ${short(json)}`)
    );
    await step('只读', 'evaluate', { fn: '() => 1' }, ({ isError, text }) =>
      isError && /Not connected/.test(text) ? '未连接时正确报错 Not connected' : NO(`期望报错，实际: ${short(text)}`)
    );
    await step('只读', 'get_data', {}, ({ isError, text }) =>
      isError && /Not connected/.test(text) ? '未连接时正确报错' : NO(`期望报错，实际: ${short(text)}`)
    );
    await step('只读', 'page_stack', {}, ({ isError, text }) =>
      isError && /Not connected/.test(text) ? '未连接时正确报错' : NO(`期望报错，实际: ${short(text)}`)
    );
    await step('只读', 'unknown_tool_xyz', {}, ({ isError, text }) =>
      isError && /Unknown tool/.test(text) ? '未知工具名正确报错' : NO(`期望报错，实际: ${short(text)}`)
    );

    // ===== 组2：automator 连接 =====
    log('\n=== 组2 · automator 连接 ===');
    const ready = await step(
      '连接',
      'ensure_ready',
      {},
      ({ json, isError }) => {
        if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
        if (json.connected === true) return `connected port=${json.port} startedBySelf=${json.startedBySelf}`;
        return NO(`未返回 connected:true → ${short(json)}`);
      },
      180000
    );
    const connected = ready.verdict === 'PASS';

    if (!connected) {
      log('  ensure_ready 失败 → automator 组全部 SKIP');
      for (const t of [
        'page_stack',
        'get_current_page',
        'get_data',
        'call_wx_api',
        'element_tap',
        'element_input',
        'element_scroll',
        'navigate_to',
        'navigate_back',
        'run_check',
        'connect',
        'disconnect',
      ]) {
        skip(t, 'automator', '前置 ensure_ready 未通过');
      }
    } else {
      log('\n=== 组3 · automator 直连能力 ===');
      await step('automator', 'status', {}, ({ json }) =>
        json.connected === true && json.port
          ? `port=${json.port} pageStackDepth=${json.pageStackDepth} currentPage=${json.currentPagePath}`
          : NO(`连接态异常: ${short(json)}`)
      );
      await step('automator', 'evaluate', { fn: '() => 1 + 2 + 3' }, ({ json, isError }) =>
        !isError && json.result === 6 ? 'result = 6' : NO(`期望 6，实际 ${short(json)}`)
      );
      await step('automator', 'evaluate', { fn: '() => JSON.stringify(getApp().globalData)' }, ({ json, isError }) =>
        !isError && json.result !== undefined ? `globalData=${short(json.result, 100)}` : NO(short(json))
      );
      await step('automator', 'evaluate', { fn: '() => getCurrentPages().length' }, ({ json, isError }) =>
        !isError && typeof json.result === 'number' ? `页面栈深度=${json.result}` : NO(short(json))
      );
      await step('automator', 'evaluate', { fn: 'function(){ return wx.getSystemInfoSync().platform }' }, ({ json, isError }) =>
        !isError && !!json.result ? `function 形式可用 → ${json.result}` : NO(short(json))
      );
      await step('automator', 'evaluate', { fn: '1 + 2' }, ({ isError, text }) =>
        isError ? '裸表达式（非函数）正确报错' : NO(`期望报错，实际: ${short(text)}`)
      );
      await step('automator', 'evaluate', {}, ({ isError, text }) =>
        isError ? '缺少 fn 参数时正确报错' : NO(`期望报错，实际: ${short(text)}`)
      );

      await step('automator', 'page_stack', {}, ({ json, isError }) =>
        !isError && Array.isArray(json.pages) ? `depth=${json.depth} → ${short(json.pages.map((p) => p.path))}` : NO(short(json))
      );
      await step('automator', 'get_current_page', {}, ({ json, isError }) =>
        !isError && json && json.route ? `route=${json.route} dataKeys=${Object.keys(json.data || {}).length}` : NO(short(json))
      );
      await step('automator', 'get_data', {}, ({ json, isError }) =>
        !isError && json && typeof json === 'object' ? `keys=${Object.keys(json).length}` : NO(short(json))
      );
      await step('automator', 'call_wx_api', { method: 'getSystemInfoSync' }, ({ json, isError }) =>
        !isError && json.result && json.result.platform ? `platform=${json.result.platform} SDKVersion=${json.result.SDKVersion}` : NO(short(json))
      );
      await step('automator', 'call_wx_api', { method: 'getAccountInfoSync' }, ({ json, isError }) =>
        !isError && json.result ? short(json.result, 100) : NO(short(json))
      );
      await step('automator', 'call_wx_api', { method: 'getStorageSync', args: ['__e2e_not_exist__'] }, ({ json, isError }) =>
        !isError ? `带 args 调用 → ${JSON.stringify(json.result)}` : NO(short(json))
      );
      await step('automator', 'call_wx_api', { method: 'noSuchMethodXYZ' }, ({ isError, text }) =>
        isError ? '不存在的 wx API 正确报错' : NO(`期望报错，实际: ${short(text)}`)
      );

      log('  --- 元素操作 ---');
      await step('automator', 'element_tap', { selector: CFG.containerSelector || '.page' }, ({ json, isError, text }) =>
        !isError ? text.trim() : WA(`容器选择器（e2e.config.js 的 containerSelector）未命中或被拦截: ${short(text, 120)}`)
      );
      await step('automator', 'element_tap', { selector: '.definitely-not-exist-xyz' }, ({ isError, text }) =>
        isError && /not found/i.test(text) ? '未命中选择器正确报错' : NO(`期望 not found，实际: ${short(text)}`)
      );
      await step('automator', 'element_input', { selector: CFG.inputSelector, value: CFG.inputValue }, ({ json, isError, text }) =>
        !isError ? text.trim() : WA(`当前页面该 input 可能不在渲染分支内（检查 e2e.config.js 的 inputSelector）: ${short(text, 120)}`)
      );
      await step('automator', 'element_input', { selector: '.definitely-not-exist-xyz', value: 'x' }, ({ isError, text }) =>
        isError && /not found|required/i.test(text) ? '未命中/缺参时正确报错' : NO(`期望报错，实际: ${short(text)}`)
      );
      await step('automator', 'element_scroll', { y: 120 }, ({ json, isError, text }) =>
        !isError ? '页面级滚动 ok' : WA(short(text, 120))
      );
      await step('automator', 'element_scroll', { selector: '.definitely-not-exist-xyz', y: 10 }, ({ isError, text }) =>
        isError ? '容器不存在时正确报错' : NO(`期望报错，实际: ${short(text)}`)
      );

      log('  --- 页面导航 ---');
      if (CFG.subPackagePage) {
        await step(
          'automator',
          'navigate_to',
          { url: CFG.subPackagePage },
          ({ isError, text }) => (isError ? WA(`跳转子包页失败: ${short(text, 120)}`) : text.trim()),
          60000
        );
        await step('automator', 'page_stack', {}, ({ json, isError }) => {
          if (isError) return NO(short(json));
          return JSON.stringify(json.pages).includes(SUB_MARKER)
            ? `已进入 ${SUB_MARKER}`
            : WA(`页面栈未命中子包页（可能渲染未完成）: ${short(json.pages, 120)}`);
        });
        await step('automator', 'navigate_back', { delta: 1 }, ({ isError, text }) =>
          isError ? NO(short(text)) : '返回成功'
        );
        await step('automator', 'page_stack', {}, ({ json }) =>
          !JSON.stringify(json.pages).includes(SUB_MARKER)
            ? `已退出 ${SUB_MARKER}`
            : WA(`返回后仍在 ${SUB_MARKER}: ${short(json.pages, 120)}`)
        );
      } else {
        log('  [SKIP] 子包导航用例：e2e.config.js 未配置 subPackagePage');
      }
      if (CFG.tabPage) {
        await step('automator', 'navigate_to', { url: CFG.tabPage }, ({ isError, text }) => {
          if (isError) return NO(short(text));
          return /switchTab/i.test(text) ? 'tabBar 页自动降级 switchTab ✓' : text.trim();
        });
      } else {
        log('  [SKIP] tabBar 降级用例：e2e.config.js 未配置 tabPage');
      }
      await step('automator', 'navigate_to', { url: '/pages/no-such-page-xyz' }, ({ isError, text }) =>
        isError ? '不存在的页面正确报错' : NO(`期望报错，实际: ${short(text)}`)
      );

      log('  --- 护栏 / 负例 ---');
      await step('automator', 'wechatide_call', { tool: 'automation_evaluate' }, ({ json, isError }) =>
        isError && json.blocker === 'automation_conflict'
          ? 'automation_* 抢连接护栏生效 ✓'
          : NO(`期望 automation_conflict，实际: ${short(json)}`),
        60000
      );
      await step('automator', 'connect', { port: 9420 }, ({ isError, text }) =>
        isError && /Already connected/.test(text) ? '重复 connect 正确提示' : NO(`期望报错，实际: ${short(text)}`)
      );

      log('  --- 运行时用例 ---');
      await step(
        'automator',
        'run_check',
        { name: 'smoke-basic' },
        ({ json, isError }) => {
          if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
          if (json.pass === true) return `${json.passed}/${json.total} 通过`;
          const bad = (json.results || []).filter((r) => !r.pass);
          return NO(
            `${json.passed}/${json.total} 通过，失败项: ` +
              bad.map((r) => {
                const d = r.detail || {};
                const items = (d.items || []).filter((i) => !i.pass);
                return `${r.name}[${items.map((i) => `${i.label}:${(i.problems || []).join(';')}`).join(' | ')}]`;
              }).join(' / ')
          );
        },
        180000
      );
      await step('automator', 'run_check', { name: 'no-such-check-xyz' }, ({ json, isError }) =>
        !isError && json.pass === false ? '不存在的用例返回 pass:false ✓' : NO(short(json)), 60000
      );
      await step('automator', 'run_check', {}, ({ json, isError }) => {
        if (isError) return NO(short(json.error || json));
        return json.pass ? `全跑 ${json.passed}/${json.total} 通过` : NO(`${json.passed}/${json.total} 通过`);
      }, 180000);
    }

    // ===== 组4：wechatide CLI 通道 =====
    log('\n=== 组4 · wechatide CLI 通道 ===');
    await step(
      'wechatide',
      'wechatide_status',
      {},
      ({ json, isError }) => {
        if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
        if (json.pending) return WA(`首次授权待确认 taskId=${json.taskId}`);
        return `loginExpired=${json.loginExpired} tokenRequired=${json.tokenRequired} user=${json.loginUser && json.loginUser.nickName}`;
      },
      120000
    );
    await step('wechatide', 'project_list', {}, ({ json, isError }) => {
      if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
      if (json.pending) return WA(`待确认 taskId=${json.taskId}`);
      const n = (json.projects || []).length;
      return n ? `${n} 个项目，首个=${short((json.projects[0] || {}).projectPath, 60)}` : WA('项目列表为空');
    }, 120000);
    await step('wechatide', 'project_list', { scope: 'all' }, ({ json, isError }) => {
      if (isError) return NO(short(json.error));
      return `scope=all → ${(json.projects || []).length} 个`;
    }, 120000);
    await step('wechatide', 'simulator_screenshot', {}, ({ json, isError }) => {
      if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
      if (json.pending) return WA(`待确认 taskId=${json.taskId}`);
      return json.path ? `${json.imageWidth}x${json.imageHeight} → ${short(json.path, 90)}` : NO(`无 path: ${short(json)}`);
    }, 120000);
    await step('wechatide', 'simulator_screenshot', { optimize: false }, ({ json, isError }) => {
      if (isError) return NO(short(json.error));
      return json.path ? `原始 PNG → ${short(json.path, 90)}` : NO(short(json));
    }, 120000);
    await step('wechatide', 'get_simulator_console', { command: 'grep -n .' }, ({ json, isError }) => {
      if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
      if (json.pending) return WA(`待确认 taskId=${json.taskId}`);
      const logLines = (json.output || '').split('\n').filter(Boolean).length;
      return `matched=${json.matched} 行数=${logLines}`;
    }, 120000);
    await step('wechatide', 'get_simulator_console', { command: 'grep -i error' }, ({ json, isError }) => {
      if (isError) return NO(short(json.error));
      return `自定义 grep 可用 matched=${json.matched}`;
    }, 120000);
    await step('wechatide', 'get_simulator_network', { command: 'grep -n .' }, ({ json, isError }) => {
      if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
      if (json.pending) return WA(`待确认 taskId=${json.taskId}`);
      return `matched=${json.matched} 行数=${(json.output || '').split('\n').filter(Boolean).length}`;
    }, 120000);

    log('  --- 透传 wechatide_call ---');
    const projectPath = CFG.projectPath || process.env.WECHAT_DEVTOOLS_PROJECT || undefined;
    await step('wechatide', 'wechatide_call', { tool: 'get_user_appids' }, ({ json, isError }) => {
      if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
      if (json.pending) return WA(`待确认 taskId=${json.taskId}`);
      return short(json.result || json.output, 140);
    }, 120000);
    await step(
      'wechatide',
      'wechatide_call',
      { tool: 'compile_wxml', projectPath, args: { filePath: CFG.wxmlFile } },
      ({ json, isError }) => {
        if (isError) return WA(`（需 IDE 打开该项目）${short(json.error, 120)}`);
        return short(json.result || json.output, 140);
      },
      120000
    );
    await step('wechatide', 'wechatide_call', { tool: 'simulator_refresh', projectPath }, ({ json, isError }) => {
      if (isError) return WA(`（需 IDE 打开该项目）${short(json.error, 120)}`);
      return short(json.result || json.output, 120);
    }, 120000);
    await step('wechatide', 'wechatide_call', { tool: 'cloud_env_list', projectPath }, ({ json, isError }) => {
      if (isError) return WA(`（项目未开云开发时会失败）${short(json.error || json.result, 120)}`);
      return short(json.result || json.output, 140);
    }, 120000);
    await step('wechatide', 'wechatide_call', { tool: 'debug_clear_cache' }, ({ isError, text }) =>
      isError && /confirm/i.test(text) ? '破坏性操作 confirm 护栏生效 ✓' : NO(`期望要求 confirm，实际: ${short(text)}`), 60000
    );
    await step('wechatide', 'wechatide_call', { tool: 'bad tool name!' }, ({ isError, text }) =>
      isError ? '非法工具名正确拒绝 ✓' : NO(`期望报错，实际: ${short(text)}`), 60000
    );
    await step('wechatide', 'wechatide_call', {}, ({ isError, text }) =>
      isError ? '缺少 tool 参数正确报错' : NO(`期望报错，实际: ${short(text)}`), 60000
    );
    await step('wechatide', 'wechatide_poll_task', { taskId: 'not-a-real-task-id' }, ({ isError, json }) =>
      isError ? `非法 taskId 正确报错（${short(json.error, 100)}）` : WA(`非预期成功: ${short(json, 120)}`), 60000
    );

    // ===== 组5：发布类（只走参数校验，不真正发布）=====
    log('\n=== 组5 · 发布类（仅参数校验，不真正发布）===');
    await step('发布', 'upload', {}, ({ isError, text }) =>
      isError && /version is required/i.test(text) ? '缺 version 正确报错 ✓' : NO(`期望报错，实际: ${short(text)}`), 60000
    );
    skip('upload:real', '发布', '真实上传会写入体验版，需用户显式要求后单独执行');
    skip('auto_preview:real', '发布', '真实推送会发到开发者微信，需用户显式要求后单独执行');
    skip('create_preview_qrcode:real', '发布', '真实预览会生成二维码，需用户显式要求后单独执行');

    // ===== 组6：断开 / 重连 / 重建 =====
    log('\n=== 组6 · 断开 / 重连 / 重建 ===');
    await step('连接', 'disconnect', {}, ({ text }) =>
      /Disconnected|not connected/i.test(text) ? text.trim() : NO(short(text)), 30000
    );
    await step('连接', 'status', {}, ({ json }) =>
      json.connected === false ? '断开后 connected:false ✓' : NO(`非预期: ${short(json)}`), 30000
    );
    const rc = await step('连接', 'connect', { port: 9420 }, ({ json, isError }) => {
      if (isError) return WA(`blocker=${json.blocker || '-'} ${short(json.error, 120)}`);
      return '重连成功 ✓';
    }, 40000);
    if (rc.verdict === 'PASS') {
      await step('automator', 'evaluate', { fn: '() => 1' }, ({ json, isError }) =>
        !isError && json.result === 1 ? '重连后 evaluate 可用 ✓' : NO(short(json))
      );
      await step('连接', 'disconnect', {}, () => true, 30000);
    }

    await step(
      '重建',
      'rebuild',
      { reconnect: false },
      ({ json, isError }) => {
        if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
        return json.ok === true ? `重编译完成 steps=${short(json.steps, 120)}` : NO(`重编译失败: ${short(json)}`);
      },
      240000
    );
    await step(
      '重建',
      'ensure_ready',
      {},
      ({ json, isError }) => {
        if (isError) return NO(`rebuild 后重连失败: ${short(json.error)}`);
        return `rebuild 后重连成功 port=${json.port}`;
      },
      180000
    );
    await step(
      '重建',
      'build_npm',
      {},
      ({ json, isError }) => {
        if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
        return `exitCode=${json.exitCode} timedOut=${json.timedOut} miniprogram_npm 包数=${json.miniprogramNpmPackages}`;
      },
      240000
    );

    // ===== 组7：auto_test 一键流水线 =====
    log('\n=== 组7 · auto_test 一键流水线 ===');
    await step(
      '一键',
      'auto_test',
      {},
      ({ json, isError }) => {
        if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
        const s = json.steps || {};
        const summary = `ensure_ready.connected=${s.ensure_ready && s.ensure_ready.connected} preflight.pass=${s.preflight && s.preflight.pass} run_check=${s.run_check && s.run_check.passed}/${s.run_check && s.run_check.total}`;
        if (json.pass) return `pass=true ${summary} duration=${json.durationMs}ms`;
        return NO(`pass=false blocker=${json.blocker} ${summary}`);
      },
      300000
    );
  } catch (e) {
    log(`\n[FATAL] ${e.stack || e.message}`);
    record({ tool: '__fatal', group: '-', verdict: 'FAIL', ms: 0, note: String(e.message), raw: '' });
  } finally {
    child.kill();
  }

  // ---------- 报告 ----------
  const count = (v) => results.filter((r) => r.verdict === v).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    total: results.length,
    PASS: count('PASS'),
    FAIL: count('FAIL'),
    WARN: count('WARN'),
    SKIP: count('SKIP'),
    results,
  };
  fs.writeFileSync(REPORT_JSON, JSON.stringify(summary, null, 2), 'utf8');
  writeReport(summary);

  log('\n=== 汇总 ===');
  log(`PASS ${summary.PASS} / FAIL ${summary.FAIL} / WARN ${summary.WARN} / SKIP ${summary.SKIP}`);
  log(`报告：${REPORT_MD}`);
  process.exit(0);
}

main();
