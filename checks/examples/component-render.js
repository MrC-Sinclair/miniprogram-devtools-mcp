/**
 * 运行时用例（示例 / 参考，不执行）：通用组件渲染校验。
 *
 * 这是一个「项目专属用例」的范本：演示如何针对你自己小程序里的某个自定义组件，
 * 在多个页面上校验它确实被注册、能渲染，并可选地校验样式 / 文案。
 *
 * 刻意不绑定任何具体业务：页面列表从 app.json 的 tabBar 自动推导，
 * 组件名 / 断言项都集中在文件顶部常量，复制后改这几处即可。
 *
 * 注意：本文件位于 examples/，run_check 不会加载执行，仅作参考。
 *       真正要跑的用例请复制到 checks/ 下（去掉 examples/）并改名（去掉 _ 前缀的模板除外）。
 */

const fs = require('fs');
const path = require('path');

/** 要校验的组件标签名（改成你项目里真实存在的组件，如 'my-card'） */
const COMPONENT = 'demo-component';

/** 组件根节点的 class（用于取样式；按你组件实际结构改，没有就留空字符串 ''） */
const ROOT_CLASS = '.root';

/**
 * 期望断言：留空对象 {} 则只校验「组件存在且能渲染」。
 * 想校验具体样式 / 文案时再填，例如：
 *   backgroundColor: 'rgba(0, 0, 0, 0.05)'
 *   textIncludes: '示例文本'
 */
const EXPECT = {
  // backgroundColor: null,
  // textIncludes: null,
};

/** 读取 app.json（兼容带注释的配置） */
function readAppJson(projectRoot) {
  if (!projectRoot) return null;
  const file = path.join(projectRoot, 'app.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
  } catch (e) {
    return null;
  }
}

async function inspectComponent(ctx, page, label) {
  const { withTimeout, sleep } = ctx;
  const detail = {};
  try {
    const host = await withTimeout(page.$(COMPONENT), 15000, 'page.$');
    if (!host) {
      return { pass: false, detail: { error: `未查到 <${COMPONENT}> 节点（组件可能未注册）` } };
    }
    const el = ROOT_CLASS ? (await host.$(ROOT_CLASS)) || host : host;

    const size = await el.size();
    const text = await el.text();
    let bg = null;
    try {
      bg = await el.style('background-color');
    } catch (e) {
      detail.styleError = e.message;
    }

    Object.assign(detail, {
      width: size.width,
      height: size.height,
      text: (text || '').trim(),
      backgroundColor: bg,
    });

    const problems = [];
    if (EXPECT.backgroundColor && bg !== EXPECT.backgroundColor) {
      problems.push(`背景色期望 ${EXPECT.backgroundColor}，实际 ${bg}`);
    }
    if (EXPECT.textIncludes && !(text || '').includes(EXPECT.textIncludes)) {
      problems.push(`文本应包含 "${EXPECT.textIncludes}"，实际 "${text}"`);
    }

    return { pass: problems.length === 0, detail, problems };
  } catch (e) {
    return { pass: false, detail: Object.assign(detail, { error: e.message }) };
  }
}

module.exports = {
  name: 'component-render',
  description: `通用示例：校验 <${COMPONENT}> 组件在各 tabBar 页面的渲染`,

  async run(ctx) {
    const { mp, withTimeout, sleep } = ctx;
    const appJson = readAppJson(ctx.projectRoot);
    const tabs = (appJson && appJson.tabBar && appJson.tabBar.list) || [];
    const targets = tabs.length
      ? tabs.map((t) => ({ label: t.text || t.pagePath, url: `/${t.pagePath}` }))
      : [];

    if (!targets.length) {
      return {
        pass: false,
        detail: { error: 'app.json 中未找到 tabBar 页面，请在 COMPONENT 上方自行指定页面列表' },
      };
    }

    const results = [];
    for (const item of targets) {
      try {
        // eslint-disable-next-line no-new-func
        await withTimeout(
          mp.evaluate(
            new Function(
              'url',
              'return new Promise((r) => wx.switchTab({ url, success: r, fail: r }))'
            ),
            item.url
          ),
          15000,
          'switchTab'
        );
        await sleep(1000);
        const page = await withTimeout(mp.currentPage(), 15000, 'currentPage');
        results.push(Object.assign({ label: item.label }, await inspectComponent(ctx, page, item.label)));
      } catch (e) {
        results.push({ label: item.label, pass: false, detail: { error: e.message } });
      }
    }

    const failed = results.filter((r) => !r.pass);
    return {
      pass: failed.length === 0,
      detail: {
        component: COMPONENT,
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        items: results.map((r) => ({ label: r.label, pass: r.pass, problems: r.problems, detail: r.detail })),
      },
    };
  },
};
