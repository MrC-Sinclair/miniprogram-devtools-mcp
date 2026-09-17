/**
 * 用例模板：复制本文件到 checks/ 下并改名（去掉下划线前缀），即可被 run_check 自动发现。
 * 下划线开头的文件不会被执行，可安全保留作为模板。
 *
 * ctx 提供：
 *   mp           MiniProgram 实例（mp.evaluate / mp.currentPage / mp.navigateTo ...）
 *   automator    miniprogram-automator 模块
 *   withTimeout  (promise, ms, label) 带超时的 Promise 包装，避免用例挂死
 *   sleep        (ms)
 *   projectRoot  小程序项目根目录绝对路径
 *
 * 返回值约定：{ pass: boolean, detail: any }，直接抛错也算失败。
 */

module.exports = {
  name: 'my-check',
  description: '一句话说明这个用例在验什么',

  async run(ctx) {
    const { mp, withTimeout, sleep } = ctx;

    // 例：切到某个页面
    await withTimeout(
      mp.evaluate(
        // eslint-disable-next-line no-new-func
        new Function(
          'url',
          'return new Promise((r) => wx.navigateTo({ url, success: r, fail: r }))'
        ),
        '/pages/mine/mine'
      ),
      15000,
      'navigateTo'
    );
    await sleep(1000);

    const page = await withTimeout(mp.currentPage(), 15000, 'currentPage');
    const data = await withTimeout(page.data(), 10000, 'page.data');

    const problems = [];
    if (!data || typeof data !== 'object') problems.push('页面 data 为空');

    return {
      pass: problems.length === 0,
      detail: { path: page.path, dataKeys: data ? Object.keys(data) : [], problems },
    };
  },
};
