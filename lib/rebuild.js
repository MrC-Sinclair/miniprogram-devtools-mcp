/**
 * 触发开发者工具重新编译（rebuild）。
 *
 * 背景：开发者工具偶发进入「解析 project.config.json 失败 / 未找到 xxx.js」的坏状态，
 * 此时自动化端口仍在监听但运行时不可用，必须重新打开项目才会恢复编译。
 * 本模块把这套人工操作（关闭项目 → 重新打开 → 重启自动化端口 → 重连）自动化。
 *
 * 命令取自微信开发者工具官方 CLI：
 *   cli close --project <path>   关闭指定项目窗口
 *   cli open  --project <path>    打开并编译指定项目
 *   cli auto  --project <path> --auto-port <port>  开启自动化端口（同时拉起项目）
 */

const { spawnCli, decodeCliOutput } = require('./config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 识别 CLI 输出中的「服务端口未开启」错误。
 * 2.x 两种文案：中文「工具的服务端口已关闭」/ 英文「IDE service port disabled」。
 * 注意：这是 IDE 的 HTTP 服务端口（设置-安全设置里那个），不是 9420 自动化端口。
 */
function isServicePortDisabled(output) {
  return /服务端口已关闭|service port disabled/i.test(output || '');
}

/** 探测本机端口是否可连接 */
function checkPort(port) {
  // eslint-disable-next-line global-require
  const net = require('net');
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      socket.destroy();
      resolve(v);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(2000, () => done(false));
  });
}

/**
 * 执行一条 CLI 命令并收集输出；超时则放弃等待（进程不强制 kill，因为 open 常驻）
 * @returns {Promise<{code: number|null, output: string, timedOut: boolean}>}
 */
function runCli(cliPath, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    try {
      const child = spawnCli(cliPath, args);
      // 收 Buffer 后再统一解码：中文 Windows 上输出混着 UTF-8 与 GBK，
      // 逐 chunk toString() 会让 cmd.exe 的中文报错变成乱码
      const chunks = [];
      const push = (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      };
      const outputOf = () => {
        const buf = Buffer.concat(chunks);
        return decodeCliOutput(buf.length > 200000 ? buf.subarray(buf.length - 200000) : buf);
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('error', (e) =>
        finish({ code: null, output: chunks.length ? outputOf() : String(e.message), timedOut: false })
      );
      child.on('close', (code) => finish({ code, output: outputOf(), timedOut: false }));
      setTimeout(() => finish({ code: null, output: outputOf(), timedOut: true }), timeoutMs);
    } catch (e) {
      finish({ code: null, output: e.message, timedOut: false });
    }
  });
}

/** spawn `cli auto` 并轮询端口直到就绪或超时（进程保持常驻，不 kill） */
async function startAutoPort(cliPath, projectPath, port, timeoutMs = 90000, intervalMs = 3000) {
  const child = spawnCli(cliPath, [
    'auto',
    '--project',
    projectPath,
    '--auto-port',
    String(port),
  ]);
  const chunks = [];
  const push = (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    while (chunks.length > 200) chunks.shift(); // 只留诊断用的尾部，避免长期累积
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => push(e.message));

  const cliOutputOf = () => {
    const buf = Buffer.concat(chunks);
    return decodeCliOutput(buf.length > 200000 ? buf.subarray(buf.length - 200000) : buf);
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkPort(port)) return { ok: true, cliOutput: cliOutputOf(), child };
    await sleep(intervalMs);
  }
  return { ok: false, cliOutput: cliOutputOf(), child };
}

/**
 * 重新编译项目并恢复自动化连接所需的端口
 * @param {{cliPath: string, projectPath: string, port: number, timeoutMs?: number, withAutoPort?: boolean}} opts
 */
async function rebuild(opts) {
  const { cliPath, projectPath, port, timeoutMs = 120000, withAutoPort = true } = opts;
  const steps = [];

  const closed = await runCli(cliPath, ['close', '--project', projectPath], 15000);
  steps.push({ step: 'close', code: closed.code, timedOut: closed.timedOut, output: closed.output });

  await sleep(1000);

  const opened = await runCli(cliPath, ['open', '--project', projectPath], 20000);
  steps.push({ step: 'open', code: opened.code, timedOut: opened.timedOut, output: opened.output });

  if (!withAutoPort) {
    return { ok: opened.code === 0 || opened.timedOut, steps, portListening: null };
  }

  await sleep(2000);
  const started = await startAutoPort(cliPath, projectPath, port, timeoutMs);
  steps.push({ step: 'auto', ok: started.ok, output: started.cliOutput });

  return {
    ok: started.ok,
    steps,
    port,
    portListening: started.ok,
    cliOutput: started.cliOutput,
  };
}

/**
 * 构建 npm（`cli build-npm --project <path>`）
 * 用途：preflight 报「miniprogram_npm 为空」时一键修复，替代人工点「工具 → 构建 npm」。
 */
function buildNpm(cliPath, projectPath, timeoutMs = 180000) {
  return runCli(cliPath, ['build-npm', '--project', projectPath], timeoutMs);
}

module.exports = { checkPort, runCli, startAutoPort, rebuild, buildNpm, sleep, isServicePortDisabled };
