/**
 * 跨机器/跨平台的环境探测：微信开发者工具 CLI 路径 + 小程序项目根目录。
 *
 * 可移植性设计（拷贝本目录到任意机器即可用，不依赖任何人的绝对路径）：
 * 1. 环境变量优先：WECHAT_DEVTOOLS_CLI / WECHAT_DEVTOOLS_PROJECT
 * 2. 其次常见安装位置候选（Windows + macOS）
 * 3. 最后做一次常见安装目录的浅扫描兜底
 */

const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

/** 环境变量可覆盖的 CLI 绝对路径（Windows 指向 cli.bat，macOS 指向 cli） */
const CLI_ENV = 'WECHAT_DEVTOOLS_CLI';
/** 环境变量可覆盖的小程序项目根目录 */
const PROJECT_ENV = 'WECHAT_DEVTOOLS_PROJECT';

/** 常见安装位置候选，findCli 依次探测 */
function cliCandidates() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const list = [];

  if (process.env[CLI_ENV]) list.push(process.env[CLI_ENV]);

  if (IS_WIN) {
    list.push(
      process.env.WECHAT_DEVTOOLS_PATH || null,
      'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
      'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
      home ? path.join(home, 'AppData', 'Local', '微信开发者工具', 'cli.bat') : null,
      home ? path.join(home, 'AppData', 'Local', '微信web开发者工具', 'cli.bat') : null
    );
  } else {
    list.push(
      '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
      home ? path.join(home, 'Applications', 'wechatwebdevtools.app', 'Contents', 'MacOS', 'cli') : null,
      '/opt/wechatwebdevtools/cli'
    );
  }
  return list.filter(Boolean);
}

/** 浅扫描兜底：常见盘符/目录下找 cli.bat（Windows 深度 2 层，macOS 扫 /Applications） */
function scanCli() {
  const roots = IS_WIN
    ? ['C:\\', 'D:\\', 'E:\\'].filter((d) => fs.existsSync(d))
    : ['/Applications', process.env.HOME ? path.join(process.env.HOME, 'Applications') : null].filter(
        Boolean
      );
  const target = IS_WIN ? 'cli.bat' : 'cli';

  for (const root of roots) {
    try {
      const top = fs.readdirSync(root, { withFileTypes: true });
      for (const d1 of top) {
        if (!d1.isDirectory()) continue;
        const deeper = root !== 'C:\\'; // C 盘靠默认路径候选，跳过深层避免扫 Windows 卡死
        const hit1 = IS_WIN ? d1.name.toLowerCase().includes('微信') : d1.name.toLowerCase().includes('wechat');
        if (hit1) {
          for (const sub of IS_WIN ? ['', 'Contents', path.join('Contents', 'MacOS')] : ['']) {
            const c = path.join(root, d1.name, sub, target);
            if (fs.existsSync(c)) return c;
          }
        }
        if (!deeper) continue;
        // 二级：root/<任意目录>/<含微信目录>/cli.bat（覆盖装在 D:\工具目录\... 等子目录的情形）
        const d2s = fs.readdirSync(path.join(root, d1.name), { withFileTypes: true });
        for (const d2 of d2s) {
          if (!d2.isDirectory()) continue;
          if (!(IS_WIN ? d2.name.toLowerCase().includes('微信') : d2.name.toLowerCase().includes('wechat'))) continue;
          for (const sub of IS_WIN ? ['', 'Contents', path.join('Contents', 'MacOS')] : ['']) {
            const c = path.join(root, d1.name, d2.name, sub, target);
            if (fs.existsSync(c)) return c;
          }
        }
      }
    } catch (_) {
      /* 无权限读取的根目录跳过 */
    }
  }
  return null;
}

/** 返回本机可用的 CLI 路径，找不到返回 null */
function findCli() {
  for (const p of cliCandidates()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {
      /* 单个路径探测失败继续下一个 */
    }
  }
  return scanCli();
}

/**
 * 读取微信开发者工具自己记录的「最近打开项目」列表。
 *
 * DevTools 把每个项目的本地存储写成 hash 命名的 json，映射表在
 * `WeappLocalData/hash_key_map_2.json`（key 是 hash，value 是语义名），
 * 其中 value 为 `last_all_projects` 的那份内容形如
 * `[{ projectid: "d:\\code\\my-miniprogram" }, ...]`，末尾为最近打开。
 *
 * 这样无需任何硬编码路径：MCP 放在项目外、cwd 也不在项目内时仍能自动定位项目。
 * @returns {string[]} 去重、按最近使用排序、且磁盘上仍存在 project.config.json 的绝对路径
 */
function findRecentProjects() {
  const roots = IS_WIN
    ? [path.join(process.env.LOCALAPPDATA || '', '微信开发者工具', 'User Data')]
    : [
        path.join(
          process.env.HOME || '',
          'Library',
          'Application Support',
          '微信开发者工具',
          'User Data'
        ),
      ];

  const found = [];
  const seen = new Set();

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    let profiles;
    try {
      profiles = fs.readdirSync(root, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const profile of profiles) {
      if (!profile.isDirectory()) continue;
      const dir = path.join(root, profile.name, 'WeappLocalData');
      const mapFile = path.join(dir, 'hash_key_map_2.json');
      if (!fs.existsSync(mapFile)) continue;
      try {
        const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
        const hash = Object.keys(map).find((k) => map[k] === 'last_all_projects');
        if (!hash) continue;
        const listFile = path.join(dir, `localstorage_${hash}.json`);
        if (!fs.existsSync(listFile)) continue;
        const list = JSON.parse(fs.readFileSync(listFile, 'utf8'));
        // 倒序取：数组按打开顺序追加，末尾即最近使用的项目
        for (let i = list.length - 1; i >= 0; i--) {
          const entry = list[i];
          const id = entry && (entry.projectid || entry.projectPath || entry.path);
          if (!id || typeof id !== 'string') continue;
          // DevTools 会同时存 "d:\code\my-miniprogram" 和 "D:\code\my-miniprogram"，按规范化路径去重
          const norm = id.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
          if (seen.has(norm)) continue;
          seen.add(norm);
          if (fs.existsSync(path.join(id, 'project.config.json'))) found.push(path.resolve(id));
        }
      } catch (_) {
        /* 单个 profile 解析失败不影响其它 profile */
      }
    }
  }
  // 组内仍按最近使用排序；跨组时把「根上有 app.json 的」整体提前。
  // 原因：Taro / uni-app 等框架项目同样会被引进 DevTools 并写入 project.config.json，
  // 但它们的根目录没有 app.json（编译产物在 dist/ 之类），拿它当小程序根会让
  // preflight / ensure_ready / 所有用例全部踏空。先挑真正的原生小程序根目录。
  const isMiniprogramRoot = (p) => fs.existsSync(path.join(p, 'app.json'));
  const roots2 = found.filter(isMiniprogramRoot);
  const rest = found.filter((p) => !isMiniprogramRoot(p));
  return [...roots2, ...rest];
}

/**
 * 解析小程序项目根目录：
 * 1. 显式参数优先
 * 2. 环境变量 WECHAT_DEVTOOLS_PROJECT
 * 3. 从 cwd 向上查找含 project.config.json 的目录
 * 4. 从 MCP 自身目录向上查找（MCP 放在项目内 mcp/ 子目录时命中）
 * 5. 兜底：微信开发者工具「最近打开的项目」列表
 */
function resolveProject(explicit) {
  if (explicit) {
    return fs.existsSync(explicit) ? path.resolve(explicit) : null;
  }
  if (process.env[PROJECT_ENV]) {
    const p = path.resolve(process.env[PROJECT_ENV]);
    if (fs.existsSync(p)) return p;
  }
  for (const start of [process.cwd(), __dirname]) {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'project.config.json'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return findRecentProjects()[0] || null;
}

/**
 * 把 CLI 的原始字节流转成字符串。
 *
 * 中文 Windows 上的坑：同一条输出里**混着两种编码**——
 *   - wechatide / cli 自己打印的 JSON 是 UTF-8
 *   - cmd.exe 自身的报错（如「'xxx' 不是内部或外部命令」）是 GBK(cp936)
 * 直接 chunk.toString() 会把 GBK 部分变成乱码，导致所有依赖中文文案的错误识别
 * （服务端口关闭 / 登录失效 / 命令引号被吞）全部静默失效，只剩一堆问号方块。
 * 整段按单一编码解必有一边是乱码，所以这里**逐行**用 fatal UTF-8 试探，失败再回落 GBK。
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function decodeCliOutput(buf) {
  if (!IS_WIN) return buf.toString('utf8');
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let gbk = null;
  const out = [];
  const len = buf.length;
  let start = 0;
  for (let i = 0; i < len; i++) {
    const isNl = buf[i] === 0x0a;
    if (!isNl && i !== len - 1) continue;
    const end = isNl ? i : len;
    const slice = buf.subarray(start, end);
    try {
      out.push(utf8.decode(slice));
    } catch (_) {
      if (!gbk) gbk = new TextDecoder('gbk');
      try {
        out.push(gbk.decode(slice));
      } catch (__) {
        out.push(slice.toString('utf8'));
      }
    }
    if (isNl) {
      out.push('\n');
      start = i + 1;
    }
  }
  return out.join('');
}

/**
 * 跨平台 spawn CLI。Windows 的 cli.bat 必须经 cmd.exe /c 执行；macOS 直接执行二进制。
 * @returns {import('child_process').ChildProcess}
 */
function spawnCli(cliPath, args) {
  // eslint-disable-next-line global-require
  const { spawn } = require('child_process');
  if (IS_WIN) {
    return spawn('cmd.exe', ['/c', cliPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }
  return spawn(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
}

module.exports = {
  IS_WIN,
  CLI_ENV,
  PROJECT_ENV,
  cliCandidates,
  findCli,
  findRecentProjects,
  resolveProject,
  spawnCli,
  decodeCliOutput,
};
