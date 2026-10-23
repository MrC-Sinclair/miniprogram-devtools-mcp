/**
 * IDE 窗口几何控制（Windows 实测 / macOS 尽力而为）。
 *
 * 为什么需要这一层：
 *   `simulator_screenshot` 截的是**模拟器面板当前渲染出来的屏幕像素**，不是设备原生分辨率。
 *   IDE 窗口被压小时，模拟器会跟着缩，截图只有一百多像素宽（实测 280×600 窗口 → 149×321），
 *   肉眼验收必然失真。官方 49 个 wechatide 工具里**没有**任何调窗口/调缩放的能力
 *   （automation_viewport_action 的 action 只有 pageScrollTo|screenshot|stopAudits|remote|close），
 *   所以只能在操作系统层动窗口——这就是本模块存在的唯一理由。
 *
 * 设计约束：
 *   - 失败绝不抛给调用方：截图/连接的主流程不该因为「窗口没放大」而失败，
 *     统一返回 { ok:false, reason } 让上层决定是否提示。
 *   - 幂等：已经最大化的窗口不会重复 ShowWindow（避免每次调用都抖一下）。
 *   - 不还原：测试期间窗口就该保持最大，下次截图不必重复拉大。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

const PS_TIMEOUT_MS = Number(process.env.WECHAT_DEVTOOLS_WINDOW_TIMEOUT_MS) || 20000;

/** macOS 开发者工具的 System Events 进程名；不同版本可能不同，可用环境变量覆盖 */
const MAC_PROCESS = process.env.WECHAT_DEVTOOLS_MAC_PROCESS || 'wechatwebdevtools';

/**
 * 从项目目录读 projectname 用于精确匹配窗口标题。
 * 开发者工具的项目窗口标题就是 project.config.json 里的 projectname（实测 `aura`）。
 */
function readProjectName(projectPath) {
  if (!projectPath) return null;
  for (const rel of ['project.config.json', 'project.private.config.json']) {
    try {
      const file = path.join(projectPath, rel);
      if (!fs.existsSync(file)) continue;
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cfg && typeof cfg.projectname === 'string' && cfg.projectname.trim()) {
        return cfg.projectname.trim();
      }
    } catch (_) {
      /* 配置损坏不应阻断窗口控制，退回按面积挑窗 */
    }
  }
  return null;
}

/** 跑一段 PowerShell（EncodedCommand 走 UTF-16LE，彻底绕开中文/引号/换行转义问题） */
function runPowerShell(script, timeoutMs = PS_TIMEOUT_MS) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true }
    );
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`powershell timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      errOut += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`powershell exit ${code}: ${(errOut || out).trim().slice(0, 400)}`));
        return;
      }
      resolve(out);
    });
  });
}

/** 从 PowerShell 输出里抠出 JSON（容忍前后多余行/BOM） */
function parseJsonLoose(text) {
  const s = String(text || '').replace(/^\uFEFF/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`no json in output: ${s.trim().slice(0, 200)}`);
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * Windows 侧脚本：枚举开发者工具进程的顶层窗口 → 挑目标窗 → 最大化/还原 → 回报前后几何。
 * 用 @'...'@ 字面 here-string 包 C#，避免 PowerShell 变量展开。
 */
function buildWindowsScript({ action, projectName }) {
  const safeName = String(projectName || '').replace(/'/g, "''");
  return `$ErrorActionPreference = 'Stop'
# PowerShell 5.1 默认按 OEM 代码页（中文系统为 GBK）写 stdout，Node 侧按 UTF-8 解会静默乱码，
# 表现为中文项目名变成 "????"——JSON.parse 不报错，所以必须在源头钉成 UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$action = '${action}'
$projectName = '${safeName}'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MpWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

$pids = @(Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -match '开发者工具|wechatdevtools|wechatwebdevtools|devtools' } |
  ForEach-Object { [int]$_.Id })
if ($pids.Count -eq 0) { '{"ok":false,"reason":"ide_not_running"}'; exit 0 }

$found = New-Object System.Collections.ArrayList
$cb = [MpWin+EnumProc]{
  param([IntPtr]$h, [IntPtr]$l)
  $wpid = 0
  [void][MpWin]::GetWindowThreadProcessId($h, [ref]$wpid)
  if (($pids -contains [int]$wpid) -and [MpWin]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][MpWin]::GetWindowTextW($h, $sb, 512)
    $title = $sb.ToString()
    if ($title.Length -gt 0 -and $title -ne '项目列表') {
      $r = New-Object 'MpWin+RECT'
      [void][MpWin]::GetWindowRect($h, [ref]$r)
      [void]$found.Add([pscustomobject]@{
        hwnd = $h.ToInt64(); title = $title;
        w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top);
        max = [bool][MpWin]::IsZoomed($h); min = [bool][MpWin]::IsIconic($h)
      })
    }
  }
  return $true
}
[void][MpWin]::EnumWindows($cb, [IntPtr]::Zero)

$cands = @($found)
if ($cands.Count -eq 0) { '{"ok":false,"reason":"project_window_not_found"}'; exit 0 }

$hit = $null
$matchedBy = 'largest'
if ($projectName.Length -gt 0) {
  # 同名窗口可能不止一个（Electron 的辅助窗口有时也带同样的标题），按面积取最大的
  $hit = $cands | Where-Object { $_.title -eq $projectName } | Sort-Object { $_.w * $_.h } -Descending | Select-Object -First 1
  if (-not $hit) {
    $hit = $cands | Where-Object { $_.title -like "*$projectName*" } | Sort-Object { $_.w * $_.h } -Descending | Select-Object -First 1
  }
  if ($hit) { $matchedBy = 'title' }
}
if (-not $hit) { $hit = $cands | Sort-Object { $_.w * $_.h } -Descending | Select-Object -First 1 }

# 只知道 projectname 却匹配不上时，多半是开错了项目窗口（或窗口标题被改过）。
# 仍然兜底挑最大窗口，但要显式告警，别让调用方以为拉的是目标项目。
$warning = $null
if ($projectName.Length -gt 0 -and $matchedBy -eq 'largest') {
  $warning = "未按 projectname（$projectName）匹配到窗口，已退化为面积最大的 IDE 窗口，请确认打开的是目标项目"
}

$h = [IntPtr]$hit.hwnd
$beforeMax = [bool]$hit.max
$beforeMin = [bool]$hit.min
if ($action -eq 'maximize' -and -not $beforeMax) {
  [void][MpWin]::ShowWindow($h, 3)
  Start-Sleep -Milliseconds 700
} elseif ($action -eq 'restore' -and ($beforeMax -or $hit.min)) {
  # 最小化窗口的 IsZoomed 是 false，只判 maximized 会让 restore 变成空操作；
  # 这里把「最小化」也算进需要还原的状态，SW_RESTORE 会同时取消最小化
  [void][MpWin]::ShowWindow($h, 9)
  Start-Sleep -Milliseconds 500
}

$after = New-Object 'MpWin+RECT'
[void][MpWin]::GetWindowRect($h, [ref]$after)
# changed 以「窗口状态真的变了」为准，而不是「我发过 ShowWindow」——
# 命令被系统忽略（窗口在别的虚拟桌面 / cloaked）时不能让调用方误以为已生效
$afterMax = [bool][MpWin]::IsZoomed($h)
$afterMin = [bool][MpWin]::IsIconic($h)
[pscustomobject]@{
  ok = $true
  platform = 'win32'
  title = $hit.title
  hwnd = $hit.hwnd
  windowCount = $cands.Count
  matchedBy = $matchedBy
  warning = $warning
  changed = (($afterMax -ne $beforeMax) -or ($afterMin -ne $beforeMin))
  # 注意：最小化窗口的 GetWindowRect 返回的是图标矩形（约 160×28），
  # 所以 minimized=true 时 before 的宽高不代表窗口真实几何，只看 minimized 标志即可
  before = [pscustomobject]@{ width = $hit.w; height = $hit.h; maximized = $beforeMax; minimized = $beforeMin }
  after = [pscustomobject]@{
    width = ($after.Right - $after.Left); height = ($after.Bottom - $after.Top);
    maximized = $afterMax; minimized = $afterMin
  }
} | ConvertTo-Json -Compress -Depth 5
`;
}

/** macOS：AppleScript 设置窗口 bounds 到整屏（未实测，失败即返回 ok:false） */
function buildMacScript({ action }) {
  const win = `window 1 of process "${MAC_PROCESS}"`;
  if (action === 'info') {
    return `tell application "System Events"
  tell process "${MAC_PROCESS}"
    set p to position of ${win}
    set s to size of ${win}
    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
  end tell
end tell`;
  }
  // 只实现 maximize。AppleScript 这边没有记录原 bounds，还原只能靠瞎猜一个尺寸——
  // 那是假还原，宁可不做：control() 里对 darwin + restore 直接返回 unsupported。
  return `tell application "Finder" to set db to bounds of window of desktop
tell application "System Events"
  tell process "${MAC_PROCESS}"
    set bounds of ${win} to db
    set p to position of ${win}
    set s to size of ${win}
    return (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text)
  end tell
end tell`;
}

function runOsascript(script, timeoutMs = PS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`osascript timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      errOut += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`osascript exit ${code}: ${errOut.trim().slice(0, 300)}`));
      else resolve(out.trim());
    });
  });
}

/**
 * 读取 / 最大化 / 还原开发者工具项目窗口。
 *
 * @param {object} opts
 * @param {string} [opts.projectPath] 小程序项目根目录（用于读 projectname 精确匹配窗口标题）
 * @param {'info'|'maximize'|'restore'} [opts.action='maximize']
 * @returns {Promise<object>} 永远 resolve：{ ok, platform, before, after, changed, ... } 或 { ok:false, reason }
 */
async function control({ projectPath, action = 'maximize' } = {}) {
  const projectName = readProjectName(projectPath);

  if (IS_WIN) {
    try {
      const out = await runPowerShell(buildWindowsScript({ action, projectName }));
      return parseJsonLoose(out);
    } catch (e) {
      return { ok: false, platform: 'win32', action, reason: 'powershell_failed', error: e.message };
    }
  }

  if (IS_MAC) {
    // AppleScript 侧没有记录原 bounds，做不到可靠还原——不做假还原
    if (action === 'restore') {
      return {
        ok: false,
        platform: 'darwin',
        action,
        reason: 'restore_unsupported_on_mac',
        hint: 'macOS 未实现窗口还原（记录不到原 bounds），需要时用窗口按钮手动恢复',
      };
    }
    try {
      const out = await runOsascript(buildMacScript({ action }));
      const [x, y, w, h] = out.split(',').map((n) => Number(n));
      return {
        ok: true,
        platform: 'darwin',
        action,
        note: 'macOS 为 AppleScript 尽力而为实现，未经实测；建议人工确认窗口尺寸',
        before: null,
        after: { x, y, width: w, height: h, maximized: null },
        changed: action !== 'info',
      };
    } catch (e) {
      return { ok: false, platform: 'darwin', action, reason: 'osascript_failed', error: e.message };
    }
  }

  return { ok: false, platform: process.platform, action, reason: 'unsupported_platform' };
}

/** 便捷封装：最大化（幂等，已最大化时 changed=false） */
async function maximize({ projectPath } = {}) {
  return control({ projectPath, action: 'maximize' });
}

/** 便捷封装：还原 */
async function restore({ projectPath } = {}) {
  return control({ projectPath, action: 'restore' });
}

/** 便捷封装：只读查询，不改窗口 */
async function info({ projectPath } = {}) {
  return control({ projectPath, action: 'info' });
}

/**
 * 截图宽度过小时的诊断提示。
 *
 * 阈值取 450 而不是 600：最大化后正常就是 527px（实测），若 527 也报警，每张图都带一条
 * hint，调用方很快就会把它当噪声忽略——真出问题时反而不看。450 以下才是「字都糊成一团」
 * 的区间（280×600 小窗只有 149px）。
 */
function smallScreenshotHint(imageWidth) {
  const w = Number(imageWidth);
  if (!Number.isFinite(w) || w <= 0 || w >= 450) return null;
  return (
    `截图宽度仅 ${w}px（原生 750rpx 设备约 750px），模拟器面板过窄，肉眼验收 UI 不可靠。` +
    '本工具默认会自动最大化 IDE 窗口；若已最大化仍偏小，把模拟器工具条的缩放档位调到 100%，' +
    '或改用 evaluate + createSelectorQuery 做结构化断言'
  );
}

module.exports = {
  IS_WIN,
  IS_MAC,
  readProjectName,
  control,
  maximize,
  restore,
  info,
  smallScreenshotHint,
};
