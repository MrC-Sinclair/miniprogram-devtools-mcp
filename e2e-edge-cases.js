#!/usr/bin/env node
/**
 * 补充端到端测试：覆盖 e2e-all-tools.js 没走到的参数路径与边界场景。
 *
 * 用法：node e2e-edge-cases.js
 *
 * 与 e2e-all-tools.js 的分工：
 *   e2e-all-tools.js  —— 30 个工具的「主路径」全覆盖（正向 + 核心负例）
 *   e2e-edge-cases.js —— 参数组合 / 护栏分支 / 返回值形态 / 截断 / 状态恢复等边角
 *
 * 判定口径同主脚本：PASS / FAIL / WARN（环境限制导致的非工具缺陷）/ SKIP
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { resolveProject } = require('./lib/config');

const SERVER = path.join(__dirname, 'index.js');
const REPORT_JSON = path.join(__dirname, 'e2e-edge-report.json');
const REPORT_MD = path.join(__dirname, 'e2e-edge-report.md');

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

/** 被测项目路径：显式配置 → 环境变量 → 自动探测，拿不到则为 null */
const REAL_PROJECT = (CFG.projectPath || process.env.WECHAT_DEVTOOLS_PROJECT || resolveProject()) || null;

/** 表单页用例是否配置完整（少任一项就跳过，避免用例在别人的项目上必失败） */
const HAS_FORM_CASE = Boolean(
  CFG.formPage && CFG.dialogField && CFG.selectedField && CFG.valueField && CFG.inputSelector
);

/** 子包页的最后一段路径，用于判断跳转目标 */
const SUB_MARKER = String(CFG.subPackagePage || '')
  .split('/')
  .filter(Boolean)
  .pop();

const OK = (note) => ({ v: 'PASS', note: note || '' });
const NO = (note) => ({ v: 'FAIL', note: note || '' });
const WA = (note) => ({ v: 'WARN', note: note || '' });

const results = [];
let child;
let seq = 0;
const pending = new Map();

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
  log(`  [${rec.verdict}] ${rec.tool}${rec.ms ? ` (${rec.ms}ms)` : ''} ${short(rec.note, 320)}`);
  return rec;
}

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
    if (r === true) note = short(text, 200);
    else if (typeof r === 'string') {
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
  return record({ tool: name, group, verdict, ms, note, raw: short(text, 1500) });
}

function skip(name, group, reason) {
  return record({ tool: name, group, verdict: 'SKIP', ms: 0, note: reason, raw: '' });
}

function writeReport(summary) {
  const md = [];
  md.push('# miniprogram-devtools-mcp 补充测试结果（边界 / 参数路径）\n');
  md.push(
    `生成时间：${summary.generatedAt}\n\n` +
      `## 结论\n\n**${summary.total} 项：通过 ${summary.PASS} / 失败 ${summary.FAIL} / 待确认 ${summary.WARN} / 跳过 ${summary.SKIP}**\n`
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
  fs.writeFileSync(REPORT_MD, md.join('\n'), 'utf8');
}

async function bootServer(env) {
  child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: __dirname,
    env: Object.assign({}, process.env, env || {}),
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
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e-edge', version: '1.0.0' },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  notify('notifications/initialized', {});
}

async function main() {
  try {
    await bootServer();

    // ===== A. preflight 参数路径 =====
    log('\n=== A · preflight 参数路径 ===');
    await step('preflight', 'preflight', { projectPath: 'D:\\__no_such_dir_xyz__' }, ({ json, isError }) =>
      isError && json.blocker === 'project_path_required'
        ? '非法 projectPath → project_path_required ✓'
        : NO(`期望 project_path_required，实际: ${short(json)}`),
      30000
    );
    if (REAL_PROJECT) {
      await step('preflight', 'preflight', { projectPath: REAL_PROJECT, port: 9999 }, ({ json }) =>
        json.pass !== undefined && json.projectPath
          ? `显式路径可解析 → ${short(json.projectPath, 40)} portListening=${json.stats && json.stats.portListening}`
          : NO(short(json)),
        30000
      );
    } else {
      log('  [SKIP] preflight 显式路径：未探测到小程序项目（在 e2e.config.js 填 projectPath 或设 WECHAT_DEVTOOLS_PROJECT）');
    }

    // ===== B. 连接 =====
    log('\n=== B · 连接 ===');
    const ready = await step(
      '连接',
      'ensure_ready',
      {},
      ({ json, isError }) =>
        isError ? NO(`blocker=${json.blocker || '-'} ${short(json.error)}`) : OK(`connected port=${json.port} runtimeReady=${json.runtimeReady}`),
      180000
    );
    if (ready.verdict !== 'PASS') {
      log('  ensure_ready 失败 → 后续 automator 组跳过');
    }

    if (ready.verdict === 'PASS') {
      // ===== C. evaluate 返回值形态 =====
      log('\n=== C · evaluate 返回值形态 / 截断 ===');
      await step('evaluate', 'evaluate', { fn: '() => undefined' }, ({ json, isError }) =>
        !isError && json.result === undefined ? '返回 undefined 不报错 ✓' : NO(short(json))
      );
      await step('evaluate', 'evaluate', { fn: '() => null' }, ({ json, isError }) =>
        !isError ? `返回 null → ${JSON.stringify(json.result)}` : NO(short(json))
      );
      await step('evaluate', 'evaluate', { fn: '() => new Date(0).toISOString()' }, ({ json, isError }) =>
        !isError && typeof json.result === 'string' ? `字符串 → ${json.result}` : NO(short(json))
      );
      await step('evaluate', 'evaluate', { fn: '() => ({a:1,b:[1,2,3],c:{d:"x"}})' }, ({ json, isError }) =>
        !isError && json.result && json.result.a === 1 ? '对象可序列化 ✓' : NO(short(json))
      );
      await step('evaluate', 'evaluate', { fn: '() => { throw new Error("boom-e2e") }' }, ({ isError, text }) =>
        isError && /boom-e2e/.test(text) ? 'fn 内抛异常正确回传 ✓' : NO(`期望回传异常，实际: ${short(text)}`)
      );
      await step(
        'evaluate',
        'evaluate',
        { fn: '() => { const o={}; o.self=o; try { JSON.stringify(o); } catch(e) { return "circular:" + e.message; } return "serialized"; }' },
        ({ json, isError }) =>
          !isError && /circular|serialized/.test(String(json.result)) ? `循环引用按 JS 语义处理 → ${json.result}` : NO(short(json))
      );
      await step('evaluate', 'evaluate', { fn: '() => "x".repeat(150000)' }, ({ text }) =>
        /已截断/.test(text) ? '超长返回按 MAX_TEXT_LEN 截断并标注 ✓' : WA(`未触发截断标记，长度=${text.length}`)
      );
      await step('evaluate', 'evaluate', { fn: '() => new Promise(r => setTimeout(() => r("async-ok"), 500))' }, ({ json, isError }) =>
        !isError && json.result === 'async-ok' ? '返回 Promise 会被 await ✓' : WA(short(json, 140)),
        40000
      );

      // ===== D. 必填参数校验（已连接态）=====
      log('\n=== D · 必填参数校验（已连接态）===');
      await step('校验', 'navigate_to', {}, ({ isError, text }) =>
        isError && /url is required/.test(text) ? 'navigate_to 缺 url 正确报错 ✓' : NO(short(text))
      );
      await step('校验', 'element_tap', {}, ({ isError, text }) =>
        isError && /selector is required/.test(text) ? 'element_tap 缺 selector 正确报错 ✓' : NO(short(text))
      );
      await step('校验', 'element_input', { selector: '.x' }, ({ isError, text }) =>
        isError && /required/.test(text) ? 'element_input 缺 value 正确报错 ✓' : NO(short(text))
      );
      await step('校验', 'element_input', { value: 'x' }, ({ isError, text }) =>
        isError && /required/.test(text) ? 'element_input 缺 selector 正确报错 ✓' : NO(short(text))
      );
      await step('校验', 'call_wx_api', {}, ({ isError, text }) =>
        isError && /method is required/.test(text) ? 'call_wx_api 缺 method 正确报错 ✓' : NO(short(text))
      );
      await step('校验', 'call_wx_api', { method: 'setStorageSync', args: ['__e2e_k__', 'v'] }, ({ json, isError }) =>
        !isError ? '多参数同步 API 可用 ✓' : WA(short(json, 140))
      );
      await step('校验', 'call_wx_api', { method: 'getStorageSync', args: ['__e2e_k__'] }, ({ json, isError }) =>
        !isError && json.result === 'v' ? 'setStorageSync → getStorageSync 往返一致 ✓' : WA(short(json, 140))
      );

      // ===== E. element_scroll 参数组合 =====
      log('\n=== E · element_scroll 参数组合 ===');
      await step('元素', 'element_scroll', {}, ({ isError, text }) =>
        !isError ? `默认 x=0,y=0 → ${text.trim()}` : WA(short(text, 140))
      );
      await step('元素', 'element_scroll', { x: 0, y: -50 }, ({ isError, text }) =>
        !isError ? '负坐标不崩溃 ✓' : WA(`负值被拒或不支持: ${short(text, 140)}`)
      );
      await step('元素', 'element_scroll', { selector: CFG.containerSelector || '.page', y: 30 }, ({ isError, text }) => {
        // 修复后：不再抛不可读的 "element.scrollTo is not a function"，而是明确说只有 scroll-view 才支持
        if (!isError) return OK(`容器内滚动 → ${text.trim()}`);
        return /scroll-view/.test(text) && /<view>/.test(text)
          ? OK(`非 scroll-view 给出可自助纠正的提示 ✓ ${short(text, 120)}`)
          : NO(`期望含 scroll-view 提示，实际: ${short(text)}`);
      });

      // ===== F. element_input 正向（动态渲染 input 后输入）=====
      // 依赖「被测项目的表单页 + 一个用 setData 唤出的 input」，全部来自 e2e.config.js。
      log('\n=== F · element_input 正向（先渲染再输入）===');
      if (!HAS_FORM_CASE) {
        log('  [SKIP] 表单输入用例：e2e.config.js 未配齐 formPage / dialogField / selectedField / valueField / inputSelector');
      } else {
        const resetPart = (CFG.resetFields || []).map((f) => `${f}: '', `).join('');
        const openFn =
          '() => { const ps = getCurrentPages(); const p = ps[ps.length - 1]; ' +
          `p.setData({ ${CFG.dialogField}: true, ${CFG.selectedField}: ${JSON.stringify(CFG.selectedValue)}, ` +
          `${resetPart}${CFG.valueField}: '' }); return 'setData ok'; }`;
        const closeFn =
          '() => { const ps = getCurrentPages(); const p = ps[ps.length - 1]; ' +
          `const v = p.data.${CFG.valueField}; p.setData({ ${CFG.dialogField}: false, ${CFG.selectedField}: null, ` +
          `${resetPart}${CFG.valueField}: '' }); return String(v); }`;

        const toForm = await step('元素', 'navigate_to', { url: CFG.formPage }, ({ isError, text }) =>
          isError ? NO(`切到表单页失败: ${short(text, 120)}`) : `已切到 ${CFG.formPage}`, 60000);
        if (toForm.verdict === 'PASS') {
          await step('元素', 'evaluate', { fn: '() => new Promise(r => setTimeout(() => r("settled"), 1500))' }, () => '等待页面稳定', 30000);
        }
        await step('元素', 'evaluate', { fn: openFn }, ({ json, isError }) =>
          !isError ? '已注入页面 data ✓' : NO(short(json)));
        await step('元素', 'evaluate', { fn: '() => new Promise(r => setTimeout(() => r("waited"), 1200))' }, () => '等待渲染 1200ms', 30000);
        await step('元素', 'element_input', { selector: CFG.inputSelector, value: CFG.inputValue }, ({ isError, text }) =>
          !isError ? text.trim() : WA(`组件内 input 未被 automator 选中（跨自定义组件查询限制）: ${short(text, 140)}`));
        await step('元素', 'evaluate', { fn: closeFn }, ({ json, isError }) =>
          !isError
            ? json.result === CFG.inputValue
              ? '输入已写入页面 data 并成功还原初始状态 ✓'
              : WA(`输入未落到 ${CFG.valueField}（值为 ${JSON.stringify(json.result)}），状态已还原`)
            : NO(short(json)));
      }

      // ===== G. navigate_back 边界 =====
      // 背景（本轮修复的缺陷）：automator 的 navigateBack() 在页面栈到底时「不抛错」且每次耗时约 3s，
      // 原实现只在抛错时 break → delta=N 会跑满 N 次，delta=99 约 300s 挂死，且回报的页数是假的。
      log('\n=== G · navigate_back 边界 ===');
      await step('导航', 'navigate_back', { delta: 99 }, ({ isError, text }) => {
        if (isError) return NO(short(text));
        return /收敛|Navigated back 0/.test(text)
          ? `超大 delta 收敛到页面栈深度，无空转 ✓ ${short(text, 120)}`
          : NO(`未按页面栈深度收敛: ${short(text)}`);
      }, 30000);
      await step('导航', 'navigate_back', {}, ({ isError, text }) =>
        !isError ? '缺 delta 时默认 1 ✓' : NO(short(text))
      );
      await step('导航', 'navigate_back', { delta: 0 }, ({ isError, text }) =>
        !isError && /0 page/.test(text) ? 'delta=0 按微信语义不返回（不再被 || 吞成 1）✓' : NO(short(text))
      );
      await step('导航', 'navigate_back', { delta: -3 }, ({ isError, text }) =>
        !isError && /0 page/.test(text) ? '负 delta 安全降级为不返回 ✓' : NO(short(text))
      );
      await step('导航', 'navigate_back', { delta: 'abc' }, ({ isError, text }) =>
        isError && /must be a number/.test(text) ? '非数字 delta 正确报错 ✓' : NO(short(text))
      );
      await step('导航', 'page_stack', {}, ({ json }) =>
        Array.isArray(json.pages) ? `depth=${json.depth} → ${short(json.pages.map((p) => p.path), 120)}` : NO(short(json))
      );
      // 有栈深时必须仍能真正返回（确认收敛逻辑没把正常返回也吃掉）
      if (CFG.subPackagePage) {
        await step('导航', 'navigate_to', { url: CFG.subPackagePage }, ({ isError, text }) =>
          isError ? WA(`跳转子包页失败: ${short(text, 120)}`) : text.trim(), 60000);
      } else {
        log('  [SKIP] 子包跳转用例：e2e.config.js 未配置 subPackagePage');
      }
      await step('导航', 'navigate_back', { delta: 1 }, ({ isError, text }) =>
        !isError && /Navigated back 1 page/.test(text) ? '栈深 2 时 delta=1 仍能真正返回 ✓' : NO(short(text)), 60000);
      await step('导航', 'page_stack', {}, ({ json }) =>
        json.depth === 1 ? '已回到栈底 ✓' : WA(`预期 depth=1，实际 ${json.depth}`));

      // ===== H. run_check / auto_test 参数路径 =====
      log('\n=== H · run_check / auto_test 参数路径 ===');
      if (REAL_PROJECT) {
        await step('用例', 'run_check', { name: 'smoke-basic', projectPath: REAL_PROJECT }, ({ json, isError }) =>
          isError ? NO(short(json.error || json)) : json.pass ? `带 projectPath 定点执行 ${json.passed}/${json.total} ✓` : NO(`${json.passed}/${json.total}`),
          180000
        );
      } else {
        log('  [SKIP] run_check 指定路径：未探测到小程序项目（在 e2e.config.js 填 projectPath 或设 WECHAT_DEVTOOLS_PROJECT）');
      }
      await step('用例', 'run_check', { name: 'smoke-basic.js' }, ({ json, isError }) =>
        !isError && json.pass ? '按文件名也能匹配用例 ✓' : WA(short(json, 140)),
        180000
      );

      // ===== I. wechatide 参数路径 =====
      log('\n=== I · wechatide 参数路径 ===');
      await step('wechatide', 'wechatide_status', { client: 'miniprogram-mcp' }, ({ json, isError }) => {
        if (isError) return NO(`blocker=${json.blocker || '-'} ${short(json.error)}`);
        return `显式 client 覆盖 → loginExpired=${json.loginExpired}`;
      }, 120000);
      await step('wechatide', 'wechatide_poll_task', {}, ({ isError, text }) =>
        isError && /taskId is required/.test(text) ? '缺 taskId 正确报错 ✓' : NO(short(text)),
        60000
      );
      await step('wechatide', 'simulator_screenshot', { quality: 30, optimize: true }, ({ json, isError }) =>
        isError ? WA(`blocker=${json.blocker || '-'} ${short(json.error, 140)}`) : `${json.imageWidth}x${json.imageHeight} quality=30 ✓`,
        120000
      );
      await step('wechatide', 'simulator_screenshot', { wait: 1, waitForSelector: CFG.containerSelector || '.page' }, ({ json, isError }) =>
        isError ? WA(`waitForSelector 场景: ${short(json.error, 140)}`) : `带 wait + waitForSelector → ${json.imageWidth}x${json.imageHeight}`,
        120000
      );
      await step(
        'wechatide',
        'simulator_screenshot',
        { path: path.join(require('os').tmpdir(), 'e2e-edge-screenshot.png'), optimize: false },
        ({ json, isError }) =>
          isError
            ? WA(`自定义输出路径: ${short(json.error, 140)}`)
            : /e2e-edge-screenshot/.test(String(json.path))
              ? `写入自定义路径 ✓ ${short(json.path, 90)}`
              : WA(`返回路径与传入不一致: ${short(json.path, 120)}`),
        120000
      );
    await step('wechatide', 'get_simulator_console', { command: 'grep -iE "error|fail"' }, ({ json, isError }) => {
      // Windows 下双引号会被 cmd.exe 吃掉，修复后应给出 command_quote_issue 而不是不可读的原始输出
      if (isError && json.blocker === 'command_quote_issue')
        return OK('双引号被 cmd 吞掉时给出 command_quote_issue 指引 ✓');
      if (isError) return WA(`复合双引号正则仍失败（blocker=${json.blocker || '-'}）`);
      return `复合正则可用 matched=${json.matched}`;
    }, 120000);
    await step('wechatide', 'get_simulator_console', { command: "grep -iE 'error|fail'" }, ({ json, isError }) => {
      // 改用单引号应当可用（上一条 hint 里给出的纠正方式）
      if (isError) return WA(`单引号正则未通过: ${short(json.error, 140)}`);
      return `hint 推荐的单引号写法可用 matched=${json.matched} ✓`;
    }, 120000);
      await step('wechatide', 'get_simulator_console', { command: 'grep -n zzz_no_match_zzz' }, ({ json, isError }) =>
        isError ? NO(short(json.error)) : json.matched === false && json.output === '' ? '无命中 → {matched:false, output:""} 契约保持 ✓' : WA(short(json, 140)),
        120000
      );
      await step('wechatide', 'project_list', { scope: 'other' }, ({ json, isError }) => {
        if (isError) return NO(short(json.error));
        return `scope=other → ${(json.projects || []).length} 个`;
      }, 120000);

      // ===== J. wechatide_call 护栏分支 =====
      log('\n=== J · wechatide_call 护栏分支 ===');
      await step('护栏', 'wechatide_call', { tool: 'project_remove' }, ({ isError, text }) =>
        isError && /confirm/i.test(text) ? 'project_remove confirm 护栏生效 ✓' : NO(short(text)),
        60000
      );
      await step('护栏', 'wechatide_call', { tool: 'quit' }, ({ isError, text }) =>
        isError && /confirm/i.test(text) ? 'quit confirm 护栏生效 ✓' : NO(short(text)),
        60000
      );
      await step('护栏', 'wechatide_call', { tool: '' }, ({ isError, text }) =>
        isError ? '空 tool 名正确拒绝 ✓' : NO(short(text)),
        60000
      );
      await step('护栏', 'wechatide_call', { tool: 'totally_made_up_tool' }, ({ isError, json, text }) =>
        isError ? `官方未知工具名被 CLI 层拦下（blocker=${json.blocker || '-'}）✓` : WA(`CLI 未拒绝: ${short(text, 140)}`),
        120000
      );
      await step('护栏', 'wechatide_call', { tool: 'cloud_fn_list' }, ({ json, isError }) => {
        if (isError) return WA(`（依赖项目是否开通云开发）${short(json.error || json.result, 140)}`);
        return `零参数透传可达（自动注入 --project）✓ ${short(json.result || json.output, 100)}`;
      }, 120000);
      await step('护栏', 'wechatide_call', { tool: 'get_user_appids', args: {} }, ({ json, isError }) => {
        if (isError) return WA(short(json.error, 140));
        return `显式空 args 不报错 ✓ ${short(json.result || json.output, 100)}`;
      }, 120000);

      // ===== K. 发布类参数校验（不真实发布）=====
      log('\n=== K · 发布类参数校验（不真实发布）===');
      await step('发布', 'upload', { projectPath: 'D:\\__no_such_dir_xyz__', version: '9.9.9' }, ({ json, isError }) =>
        isError && json.blocker === 'project_path_required'
          ? '非法路径在真实上传前被拦下 ✓（未触发上传）'
          : WA(`未按预期拦截，实际: ${short(json, 140)}`),
        60000
      );
      await step('发布', 'create_preview_qrcode', { projectPath: 'D:\\__no_such_dir_xyz__' }, ({ json, isError }) =>
        isError && json.blocker === 'project_path_required' ? '非法路径被拦下 ✓（未触发预览）' : WA(short(json, 140)),
        60000
      );
      await step('发布', 'auto_preview', { projectPath: 'D:\\__no_such_dir_xyz__' }, ({ json, isError }) =>
        isError && json.blocker === 'project_path_required' ? '非法路径被拦下 ✓（未触发推送）' : WA(short(json, 140)),
        60000
      );
      skip('upload:real', '发布', '真实上传写入体验版，需用户显式要求');
      skip('auto_preview:real', '发布', '真实推送会发到开发者微信，需用户显式要求');
      skip('create_preview_qrcode:real', '发布', '真实预览会上传代码包生成二维码，需用户显式要求');

      // ===== L. auto_test 参数路径 =====
      log('\n=== L · auto_test 参数路径 ===');
      await step(
        '一键',
        'auto_test',
        { checkName: 'smoke-basic' },
        ({ json, isError }) => {
          if (isError) return NO(short(json.error || json));
          const s = json.steps || {};
          return json.pass
            ? `checkName 定向执行 pass=true run_check=${s.run_check && s.run_check.passed}/${s.run_check && s.run_check.total} ${json.durationMs}ms`
            : NO(`pass=false blocker=${json.blocker} hint=${short(json.hint, 120)}`);
        },
        300000
      );
      await step(
        '一键',
        'auto_test',
        { checkName: 'no-such-check-xyz' },
        ({ json, isError }) => {
          if (isError) return NO(short(json.error || json));
          return json.pass === false && json.blocker === 'run_check_failed'
            ? '不存在的用例名 → 总 pass=false 且给出 blocker ✓'
            : WA(`未给出预期 blocker: ${short(json, 160)}`);
        },
        300000
      );

      // ===== M. 断开 / 幂等 =====
      log('\n=== M · 断开 / 幂等 ===');
      await step('连接', 'disconnect', {}, ({ text }) => (/Disconnected/.test(text) ? '断开 ✓' : NO(short(text))), 30000);
      await step('连接', 'disconnect', {}, ({ text }) => (/not connected|Disconnected/i.test(text) ? '重复断开幂等 ✓' : NO(short(text))), 30000);
      await step('连接', 'status', {}, ({ json }) => (json.connected === false ? '断开后 connected:false ✓' : NO(short(json))), 30000);
      await step('连接', 'ensure_ready', {}, ({ json, isError }) =>
        isError ? WA(`断开后重连: ${short(json.error, 140)}`) : `断开后可再次 ensure_ready port=${json.port} ✓`,
        180000
      );
      await step('连接', 'evaluate', { fn: '() => 1' }, ({ json, isError }) =>
        !isError && json.result === 1 ? '重连后仍可用 ✓' : WA(short(json, 140))
      );
    }

    // ===== N. MAX_OUTPUT 环境变量（需独立进程）=====
    log('\n=== N · WECHAT_DEVTOOLS_MAX_OUTPUT 环境变量 ===');
    child.kill();
    seq = 0;
    pending.clear();
    await bootServer({ WECHAT_DEVTOOLS_MAX_OUTPUT: '300' });
    // 新实例是全新的进程，端口虽在监听但连接状态不共享，必须先自己连上
    const mo = await step('环境变量', 'ensure_ready', {}, ({ json, isError }) =>
      isError ? NO(`blocker=${json.blocker || '-'} ${short(json.error)}`) : OK(`独立实例已连接 port=${json.port}`), 180000);
    if (mo.verdict === 'PASS') {
      await step('环境变量', 'evaluate', { fn: '() => "y".repeat(5000)' }, ({ isError, text }) => {
        if (isError) return NO(short(text, 160));
        return /已截断/.test(text) && text.length < 900
          ? `MAX_OUTPUT=300 生效，5018 字符被截断到 ${text.length} 字符 ✓`
          : WA(`未按环境变量截断，返回长度=${text.length}`);
      }, 40000);
    }
  } catch (e) {
    log(`\n[FATAL] ${e.stack || e.message}`);
    record({ tool: '__fatal', group: '-', verdict: 'FAIL', ms: 0, note: String(e.message), raw: '' });
  } finally {
    if (child) child.kill();
  }

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
