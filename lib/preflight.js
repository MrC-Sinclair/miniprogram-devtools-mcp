/**
 * 联调前静态自检（preflight）：在启动开发者工具之前把「一编译就报找不到文件」的坑提前拦掉。
 *
 * 覆盖：
 *  1. 关键 JSON 可解析（app.json / project.config.json / sitemap.json / project.private.config.json）
 *  2. app.json 的 pages 与分包 pages 有对应源码（.ts|.js + .wxml，.json/.wxss 可选）
 *  3. usingComponents 指向的自定义组件四件套齐全（.json + .wxml + .ts|.js）
 *  4. tabBar 图标文件存在
 *  5. miniprogram_npm 已构建（package.json 有依赖但目录缺失/为空 → 警告）
 *  6. 自动化端口监听状态（可选，仅提示）
 */

const fs = require('fs');
const path = require('path');

const CRITICAL_JSON = [
  'app.json',
  'project.config.json',
  'sitemap.json',
  'project.private.config.json',
];

/** 去掉 JSON 中的注释与尾逗号，兼容微信配置文件里常见的手写注释 */
function stripJsonComments(text) {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n || '';
        i++;
      } else if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  // 尾逗号：, 后面只允许空白再跟 } 或 ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // 空文件（0 字节或纯空白）在小程序里等价于 {}，不算解析失败
  if (!raw.trim()) return {};
  return JSON.parse(stripJsonComments(raw));
}

/** 文件存在性：任一候选存在即返回命中的那个 */
function firstExist(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 解析 usingComponents 里的路径：
 * - 以 '/' 开头 → 相对项目根
 * - 以 'plugin://' 开头 → 插件，跳过检查
 * - 其余 → 相对引用方 json 所在目录
 */
function resolveComponentPath(projectRoot, referrerJson, value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('plugin://')) return null;
  if (value.startsWith('/')) return path.join(projectRoot, value.slice(1));
  if (value.startsWith('.')) {
    return path.resolve(path.dirname(referrerJson), value);
  }
  // 非相对写法（微信不支持，但容错按相对处理）
  return path.resolve(path.dirname(referrerJson), value);
}

/** 收集所有需要检查的页面路径（主包 + 分包） */
function collectPages(projectRoot, appJson) {
  const pages = [];
  for (const p of appJson.pages || []) pages.push(p);
  const subs = appJson.subPackages || appJson.subpackages || [];
  for (const sub of subs) {
    const root = sub.root ? sub.root.replace(/\/$/, '') : '';
    for (const p of sub.pages || []) {
      pages.push(root ? `${root}/${p}` : p);
    }
  }
  return pages.map((p) => p.replace(/^\//, ''));
}

/**
 * 执行静态自检
 * @param {string} projectRoot 小程序项目根目录
 * @param {{checkPort?: () => Promise<boolean>, port?: number}} opts
 * @returns {Promise<{pass: boolean, errors: string[], warnings: string[], stats: object}>}
 */
async function preflight(projectRoot, opts = {}) {
  const errors = [];
  const warnings = [];
  const stats = { json: 0, pages: 0, components: 0 };

  // 1. 关键 JSON 可解析
  for (const rel of CRITICAL_JSON) {
    const file = path.join(projectRoot, rel);
    if (!fs.existsSync(file)) {
      // project.private.config.json 是本地私有配置，缺失属正常
      if (rel === 'project.private.config.json') continue;
      errors.push(`缺少关键配置文件: ${rel}`);
      continue;
    }
    try {
      readJson(file);
      stats.json++;
    } catch (e) {
      errors.push(`${rel} 解析失败: ${e.message}`);
    }
  }

  let appJson = {};
  try {
    appJson = readJson(path.join(projectRoot, 'app.json'));
  } catch (e) {
    errors.push(`app.json 无法解析，后续页面/组件检查跳过: ${e.message}`);
  }

  // 2. 页面源码齐全
  const pageList = collectPages(projectRoot, appJson);
  stats.pages = pageList.length;
  const pageJsons = [];
  for (const p of pageList) {
    const base = path.join(projectRoot, p);
    const script = firstExist([`${base}.ts`, `${base}.js`]);
    if (!script) {
      errors.push(`页面缺少脚本文件: ${p}.ts / ${p}.js`);
    }
    if (!fs.existsSync(`${base}.wxml`)) {
      errors.push(`页面缺少模板文件: ${p}.wxml`);
    }
    // 页面级 usingComponents 必须入队，否则页面引用的自定义组件检查不到
    if (fs.existsSync(`${base}.json`)) pageJsons.push(`${base}.json`);
  }

  // 3. usingComponents 组件四件套（广度遍历，避免环）
  const queue = [path.join(projectRoot, 'app.json'), ...pageJsons];
  const visited = new Set();
  const globalComponents = appJson.usingComponents || {};

  while (queue.length) {
    const jsonFile = queue.shift();
    if (visited.has(jsonFile)) continue;
    visited.add(jsonFile);
    if (!fs.existsSync(jsonFile)) continue;

    let json;
    try {
      json = readJson(jsonFile);
    } catch (e) {
      errors.push(`${path.relative(projectRoot, jsonFile)} 解析失败: ${e.message}`);
      continue;
    }

    const using = Object.assign(
      {},
      jsonFile === path.join(projectRoot, 'app.json') ? globalComponents : {},
      json.usingComponents || {}
    );

    for (const [tag, value] of Object.entries(using)) {
      const target = resolveComponentPath(projectRoot, jsonFile, value);
      if (!target) continue; // 插件协议，跳过
      stats.components++;

      const hasJson = fs.existsSync(`${target}.json`);
      const hasWxml = fs.existsSync(`${target}.wxml`);
      const script = firstExist([`${target}.ts`, `${target}.js`]);
      const rel = path.relative(projectRoot, target).replace(/\\/g, '/');

      if (!hasJson && !hasWxml && !script) {
        errors.push(`组件 <${tag}> 指向的目录不存在: ${value} → ${rel}`);
        continue;
      }
      if (!hasJson) errors.push(`组件 <${tag}> 缺少 ${rel}.json`);
      if (!hasWxml) errors.push(`组件 <${tag}> 缺少 ${rel}.wxml`);
      if (!script) errors.push(`组件 <${tag}> 缺少 ${rel}.ts / ${rel}.js`);
      if (hasJson) queue.push(`${target}.json`);
    }
  }

  // 4. tabBar 图标
  const tabBar = appJson.tabBar;
  if (tabBar && Array.isArray(tabBar.list)) {
    for (const item of tabBar.list) {
      for (const key of ['iconPath', 'selectedIconPath']) {
        const rel = item[key];
        if (!rel) continue;
        const file = path.join(projectRoot, rel.replace(/^\//, ''));
        if (!fs.existsSync(file)) errors.push(`tabBar ${key} 文件不存在: ${rel}`);
      }
    }
  }

  // 5. miniprogram_npm 构建产物
  let pkgDeps = 0;
  const pkgFile = path.join(projectRoot, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = readJson(pkgFile);
      pkgDeps = Object.keys(pkg.dependencies || {}).length;
    } catch (_) {
      /* package.json 坏了不影响小程序编译，只在 JSON 检查里体现 */
    }
  }
  const npmDir = path.join(projectRoot, 'miniprogram_npm');
  let built = 0;
  try {
    if (fs.existsSync(npmDir)) {
      built = fs
        .readdirSync(npmDir, { withFileTypes: true })
        .filter((d) => d.isDirectory()).length;
    }
  } catch (_) {
    /* 读取失败按未构建处理 */
  }
  if (pkgDeps > 0 && built === 0) {
    warnings.push(
      `package.json 声明了 ${pkgDeps} 个依赖但 miniprogram_npm 为空：请在开发者工具执行「工具 → 构建 npm」`
    );
  }

  // 6. 端口监听（可选）
  let portListening = null;
  if (typeof opts.checkPort === 'function' && opts.port) {
    try {
      portListening = await opts.checkPort(opts.port);
      if (!portListening) {
        warnings.push(
          `自动化端口 ${opts.port} 未监听：调用 ensure_ready 会自动拉起，无需人工`
        );
      }
    } catch (_) {
      /* 端口探测失败忽略，不影响静态检查结论 */
    }
  }

  return {
    pass: errors.length === 0,
    errors,
    warnings,
    stats: Object.assign({}, stats, {
      npmDeps: pkgDeps,
      npmBuilt: built,
      portListening,
    }),
  };
}

module.exports = { preflight, readJson, stripJsonComments };
