/**
 * 通用冒烟用例：任何小程序都能跑，不依赖具体页面或组件。
 *
 * 检查项：
 *   1. AppService 可用（getSystemInfoSync 能返回）
 *   2. getApp() 可访问（globalData 存在）
 *   3. 首页可达（tabBar 首个页面或 app.json 的 pages[0]）
 *   4. 每个 tabBar 页面 switchTab 后路由正确、页面 data 可读
 *
 * 这是开箱即用的默认用例，任何小程序都能跑。项目专属断言请参照
 * checks/examples/component-render.js 自行新增，不要改本文件。
 */

const fs = require('fs');
const path = require('path');
const { stripJsonComments } = require('../lib/preflight');

/** 读取 app.json：复用 preflight 的注释剥离（同时支持行注释 // 与块注释，与静态自检保持一致） */
function readAppJson(projectRoot) {
  if (!projectRoot) return null;
  const file = path.join(projectRoot, 'app.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    return null;
  }
}

module.exports = {
  name: 'smoke-basic',
  description: '通用冒烟：AppService 可用 + 首页可达 + tabBar 各页面路由与渲染正常',

  async run(ctx) {
    const { mp, withTimeout, sleep } = ctx;
    const items = [];
    const push = (label, pass, detail, problems) => {
      items.push({ label, pass, problems: problems || [], detail: detail || {} });
    };

    // 1. 系统信息
    let sysInfo = null;
    try {
      sysInfo = await withTimeout(
        mp.evaluate(() => wx.getSystemInfoSync()),
        15000,
        'getSystemInfoSync'
      );
      push('系统信息', !!sysInfo && !!sysInfo.platform, {
        platform: sysInfo && sysInfo.platform,
        model: sysInfo && sysInfo.model,
        windowWidth: sysInfo && sysInfo.windowWidth,
      });
    } catch (e) {
      push('系统信息', false, { error: e.message }, [`getSystemInfoSync 失败: ${e.message}`]);
    }

    // 2. AppService 可访问
    try {
      const appInfo = await withTimeout(
        mp.evaluate(() => {
          const app = typeof getApp === 'function' ? getApp() : null;
          return {
            hasApp: !!app,
            hasGlobalData: !!(app && app.globalData),
            globalKeys: app && app.globalData ? Object.keys(app.globalData) : [],
          };
        }),
        15000,
        'getApp'
      );
      push('AppService', appInfo.hasApp, appInfo, appInfo.hasApp ? [] : ['getApp() 返回空']);
    } catch (e) {
      push('AppService', false, { error: e.message }, [`getApp 失败: ${e.message}`]);
    }

    // 3/4. 页面路由
    const appJson = readAppJson(ctx.projectRoot);
    const tabs = (appJson && appJson.tabBar && appJson.tabBar.list) || [];
    const firstPage = (appJson && appJson.pages && appJson.pages[0]) || null;

    if (!appJson) {
      push('app.json', false, { projectRoot: ctx.projectRoot }, ['未能解析 app.json，跳过页面校验']);
    } else if (!tabs.length && !firstPage) {
      push('页面路由', false, {}, ['app.json 中既无 tabBar 也无 pages']);
    } else {
      // 无 tabBar 的项目只校验首页，用 reLaunch 进入
      const targets = tabs.length
        ? tabs.map((t) => ({ label: t.text || t.pagePath, url: `/${t.pagePath}` }))
        : [{ label: '首页', url: `/${firstPage}` }];

      for (const t of targets) {
        try {
          await withTimeout(
            mp.evaluate(
              // eslint-disable-next-line no-new-func
              new Function(
                'url',
                'return new Promise((r) => wx.switchTab({ url, success: r, fail: r }))'
              ),
              t.url
            ),
            15000,
            'switchTab'
          );
          await sleep(1000);
          const page = await withTimeout(mp.currentPage(), 15000, 'currentPage');
          const currentPath = page && page.path;
          const expected = t.url.replace(/^\//, '');
          const data = page ? await withTimeout(page.data(), 10000, 'page.data') : null;

          const problems = [];
          if (currentPath !== expected) {
            problems.push(`路由不符：期望 ${expected}，实际 ${currentPath}`);
          }
          if (data === null || data === undefined) {
            problems.push('页面 data 读取失败');
          }
          push(
            `页面 ${t.label}`,
            problems.length === 0,
            { path: currentPath, dataKeys: data ? Object.keys(data) : [] },
            problems
          );
        } catch (e) {
          push(`页面 ${t.label}`, false, { error: e.message }, [`切换失败: ${e.message}`]);
        }
      }

      // 回到首页，避免用例结束后停在最后一个 tab 影响后续人工查看
      try {
        const home = tabs.length ? `/${tabs[0].pagePath}` : `/${firstPage}`;
        await withTimeout(
          mp.evaluate(
            // eslint-disable-next-line no-new-func
            new Function(
              'url',
              'return new Promise((r) => wx.switchTab({ url, success: r, fail: r }))'
            ),
            home
          ),
          15000,
          'switchTabHome'
        );
      } catch (_) {
        /* 回首页失败不影响用例结论 */
      }
    }

    const failed = items.filter((i) => !i.pass);
    return {
      pass: failed.length === 0,
      detail: {
        device: sysInfo && sysInfo.model,
        windowWidth: sysInfo && sysInfo.windowWidth,
        projectRoot: ctx.projectRoot,
        total: items.length,
        passed: items.length - failed.length,
        failed: failed.length,
        items,
      },
    };
  },
};
