/**
 * 运行时用例加载器（run_check）。
 *
 * 约定：checks/ 目录下每个 .js 文件导出一个用例对象
 *   module.exports = {
 *     name: '用例名',
 *     description: '用例说明',
 *     async run(ctx) { ... return { pass, detail } 或直接抛错表示失败 }
 *   }
 *
 * ctx 提供：{ mp, automator, withTimeout, projectRoot, log }
 * 使用者只需往 checks/ 丢自己的用例文件，即可被 run_check 统一发现并执行。
 */

const fs = require('fs');
const path = require('path');

const CHECKS_DIR = path.join(__dirname, '..', 'checks');

/** 列出可用用例（只取元信息，不执行） */
function listChecks() {
  if (!fs.existsSync(CHECKS_DIR)) return [];
  return fs
    .readdirSync(CHECKS_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .map((f) => {
      try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const mod = require(path.join(CHECKS_DIR, f));
        return { file: f, name: mod.name || f, description: mod.description || '' };
      } catch (e) {
        return { file: f, name: f, description: `加载失败: ${e.message}` };
      }
    });
}

function loadAll() {
  if (!fs.existsSync(CHECKS_DIR)) return [];
  return fs
    .readdirSync(CHECKS_DIR)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .map((f) => {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(path.join(CHECKS_DIR, f));
      return { file: f, mod };
    })
    .filter((x) => typeof x.mod.run === 'function');
}

/**
 * 执行用例（不传 name 则全部执行）
 * @returns {Promise<{pass: boolean, total: number, passed: number, failed: number, results: Array}>}
 */
async function runChecks(ctx, name) {
  const all = loadAll();
  const targets = name ? all.filter((x) => x.mod.name === name || x.file === name) : all;
  if (name && targets.length === 0) {
    return {
      pass: false,
      total: 0,
      passed: 0,
      failed: 0,
      results: [{ name, pass: false, error: `未找到用例: ${name}` }],
    };
  }

  const results = [];
  for (const t of targets) {
    const started = Date.now();
    try {
      const r = await t.mod.run(ctx);
      results.push({
        name: t.mod.name || t.file,
        file: t.file,
        pass: r && r.pass !== false,
        detail: r && r.detail,
        ms: Date.now() - started,
      });
    } catch (e) {
      results.push({
        name: t.mod.name || t.file,
        file: t.file,
        pass: false,
        error: e.message,
        ms: Date.now() - started,
      });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  return {
    pass: passed === results.length,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}

module.exports = { listChecks, runChecks, CHECKS_DIR };
