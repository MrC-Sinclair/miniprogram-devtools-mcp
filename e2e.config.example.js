/**
 * e2e 测试的「项目专属夹具」示例。
 *
 * 为什么要有这个文件：
 *   两个 e2e 脚本（e2e-all-tools.js / e2e-edge-cases.js）要真机跑通页面跳转、
 *   元素输入这类用例，就必须知道**被测小程序自己的**页面路径、选择器、data 字段。
 *   这些值每个人、每个项目都不一样，写死在脚本里既泄露隐私、也让别人 clone 后必失败。
 *
 * 用法：
 *   cp e2e.config.example.js e2e.config.js   （Windows: copy e2e.config.example.js e2e.config.js）
 *   然后按注释填上你自己项目的值。
 *
 * 注意：
 *   - e2e.config.js 已在 .gitignore 中，永远不会被提交；
 *   - 仓库里只提交本示例文件，里面的值是占位符，不涉及任何真实项目；
 *   - 没配置（或值为空）时脚本不会崩——依赖夹具的用例会自动降级为 WARN / SKIP，其余用例照跑。
 */

module.exports = {
  /**
   * 被测小程序根目录。**强烈建议留空**交给 lib/config.js 自动探测，
   * 不要手写成 env 之外的绝对路径 —— 尤其是 Windows 的盘符大小写：
   *
   *   微信开发者工具按路径字符串精确匹配已打开的项目窗口。它自己记录的路径是
   *   小写盘符（如 d:\code\my-miniprogram），你手写 D:\code\my-miniprogram 就会匹配不上，
   *   wechatide 系工具会一直挂到超时才报错（表现是某个工具卡满 120s 后 FAIL，
   *   而同一次运行里其它工具都正常）。自动探测返回的是 DevTools 记录的原值，永远一致。
   *
   * 确实需要固定时用环境变量 WECHAT_DEVTOOLS_PROJECT，或把上面那个小写原值抄过来。
   */
  projectPath: '',

  /**
   * 一个页面级容器选择器，用于 element_tap / element_scroll 的容器滚动用例。
   * 页面上存在即可；不存在时该用例降级为 WARN，不影响其它用例。
   */
  containerSelector: '.page-container',

  /**
   * 「先渲染再输入」用例用的表单页与输入框。
   *   formPage       表单页路径（带前导 /）；该页里有一个默认不渲染、需用 setData 唤出的 input
   *   dialogField    控制该 input 是否渲染的 data 字段名（布尔）
   *   selectedField  配套的数据字段名，唤起对话框时一起写入
   *   valueField     input 最终写入的 data 字段名，脚本会读回它做校验
   * 用例流程：切到表单页 → setData 打开对话框 → 向 input 输入 → 读回 valueField → setData 还原。
   * 这四项任一为空时该用例自动跳过。
   */
  formPage: '/pages/your-form-page/your-form-page',
  dialogField: 'showDialog',
  selectedField: 'selectedItem',
  selectedValue: { id: 'e2e-test' },
  /** 唤起对话框时需要一并清空的其它 data 字段（没有就留空数组） */
  resetFields: [],
  valueField: 'inputValue',

  /** 输入用例实际写入的字符串（脚本会校验它是否被读回，然后还原为空） */
  inputValue: 'e2eTest123',

  /** 输入框选择器（表单页里那个 input 的 class / id） */
  inputSelector: '.your-native-input',

  /** 子包页面路径（带前导 /），用于 navigate_to / page_stack / navigate_back 的子包用例 */
  subPackagePage: '/pagesSub/your-sub-page/your-sub-page',

  /** 一个 tabBar 页面路径（带前导 /），用于验证「跳转 tabBar 页自动降级 switchTab」 */
  tabPage: '/pages/your-tab-page/your-tab-page',

  /** 用于 wechatide_call compile_wxml 的 wxml 相对路径（相对小程序根目录，不带前导 /） */
  wxmlFile: 'pages/your-form-page/your-form-page.wxml',
};
