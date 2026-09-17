/**
 * MCP server 冒烟测试：无需 IDE，直接 spawn 本 server 并走一遍 JSON-RPC。
 *
 * 用法：node smoke.js
 * 验证：进程能起、tools/list 返回全部工具、preflight / list_checks 可正常返回。
 * 用途：换机器或首次安装后先跑一次，确认环境（Node 版本 / 依赖 / 项目路径）没问题再接入 IDE。
 */

const path = require('path');
const { spawn } = require('child_process');

const SERVER = path.join(__dirname, 'index.js');
const CHILD_ARGS = [SERVER];

let seq = 0;
const pending = new Map();

function send(child, method, params) {
  const id = ++seq;
  const payload = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 60000);
  });
}

function notify(child, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

async function main() {
  const child = spawn(process.execPath, CHILD_ARGS, {
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
  child.stderr.on('data', () => {
    /* server 诊断输出，忽略 */
  });

  const fail = (msg) => {
    console.error(`\n[FAIL] ${msg}`);
    child.kill();
    process.exit(1);
  };

  // 1. initialize
  const init = await send(child, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  });
  if (init.error) fail(`initialize: ${JSON.stringify(init.error)}`);
  console.log(`[OK] initialize → ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);
  notify(child, 'notifications/initialized', {});

  // 2. tools/list
  const list = await send(child, 'tools/list', {});
  if (list.error) fail(`tools/list: ${JSON.stringify(list.error)}`);
  const names = list.result.tools.map((t) => t.name);
  console.log(`[OK] tools/list → ${names.length} 个工具`);
  console.log(`     ${names.join(', ')}`);
  const expected = ['auto_test', 'ensure_ready', 'preflight', 'rebuild', 'list_checks', 'run_check'];
  for (const e of expected) {
    if (!names.includes(e)) fail(`缺少工具: ${e}`);
  }

  // 3. preflight（纯静态，不需要开发者工具）
  const pre = await send(child, 'tools/call', { name: 'preflight', arguments: {} });
  if (pre.error) fail(`preflight: ${JSON.stringify(pre.error)}`);
  const preText = pre.result.content[0].text;
  const preJson = JSON.parse(preText);
  console.log(
    `[${preJson.pass ? 'OK' : 'FAIL'}] preflight → pass=${preJson.pass} ` +
      `errors=${preJson.errors.length} warnings=${preJson.warnings.length}`
  );
  if (preJson.errors.length) console.log(`     errors: ${preJson.errors.join(' | ')}`);
  if (preJson.warnings.length) console.log(`     warnings: ${preJson.warnings.join(' | ')}`);

  // 4. list_checks
  const lc = await send(child, 'tools/call', { name: 'list_checks', arguments: {} });
  if (lc.error) fail(`list_checks: ${JSON.stringify(lc.error)}`);
  const lcJson = JSON.parse(lc.result.content[0].text);
  console.log(`[OK] list_checks → ${lcJson.checks.length} 个用例`);
  lcJson.checks.forEach((c) => console.log(`     - ${c.name}: ${c.description}`));

  child.kill();
  const okAll = preJson.pass;
  console.log(`\n${okAll ? 'SMOKE PASS' : 'SMOKE DONE (preflight 有 error，需修复)'}`);
  process.exit(okAll ? 0 : 1);
}

main().catch((e) => {
  console.error('冒烟测试异常:', e);
  process.exit(1);
});
