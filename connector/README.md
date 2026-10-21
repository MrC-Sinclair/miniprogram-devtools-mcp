# 连接器包（WorkBuddy 连接器市场）

这个目录是提交到 WorkBuddy 开放平台的**连接器包**，与仓库根目录的 npm 包是同一份能力的两种分发形态。

## 关键前提：npm 上必须先有这个包

`mcp.json` 用的是 `npx miniprogram-devtools-mcp@0.5.0`，所以**连接器本身只有几 KB，真正的代码在 npm 上**。

如果 npm 上还没有这个包，连接器装上后会拉不到代码、直接失败。发布顺序不能反：

```
1. npm publish            ← 必须先做
2. 提交连接器审核
```

之所以不用「把 node_modules 打进 zip」的方案：生产依赖 43MB，平台限制 20MB，塞不进去。
官方支持 `npx` + 托管 Node 运行时 + npm 镜像，这是正解。

## 包结构

```
connector/
├── connector-meta.json                    # 连接器元信息（必须）
├── mcp.json                               # MCP Server 配置（必须）
├── icon.svg                               # 市场图标（必须）
└── skills/miniprogram-devtools/SKILL.md   # 使用说明（可选，但强烈建议保留）
```

## 打包

PowerShell：

```powershell
$root = "D:\code\.agents\mcp\miniprogram-devtools-mcp"
$stage = Join-Path $env:TEMP "connector-build\wechat-miniprogram-devtools"
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item (Join-Path $root "connector\*") -Destination $stage -Recurse -Force
Compress-Archive -Path (Split-Path $stage) -DestinationPath (Join-Path $root "dist\wechat-miniprogram-devtools-connector.zip") -Force
```

产物：`dist/wechat-miniprogram-devtools-connector.zip`（约 5 KB）

## 提交

开放平台 → 应用管理 → 连接器 → 发布连接器 → 上传 zip → 确认信息 → 提交审核。
审核通过后进入连接器市场，后续更新重新提交即可，通常 10–15 分钟生效。

## 发新版时要同步改三处

| 位置 | 字段 |
|---|---|
| `package.json` | `version` |
| `connector/connector-meta.json` | `version` |
| `connector/mcp.json` | `args` 里的 `miniprogram-devtools-mcp@<version>` |

漏改 `mcp.json` 的版本号，用户装到的还是旧版——因为 `args` 是写死的。

## 字段说明

### connector-meta.json

- `source`：全局唯一标识，kebab-case，**一旦提交不要改**（连接器身份）
- `type`：`mcp`
- `minWorkbuddyVersion`：`5.0.0` —— 因为用了 `runtime` 和 `npmRegistry` 字段（5.0.0 起支持）
- `examples_zh/en`：需要 4.24.0+；用真实用户会说的话，不要写成 API 文档

### mcp.json

- `type: stdio` —— 本地进程，操作本机微信开发者工具
- `runtime.type: node` + `version: "20"` —— 由 WorkBuddy 托管 Node，用户不用自己装
- `npmRegistry: https://registry.npmmirror.com` —— 国内镜像，避免拉包超时
- 一个连接器只能配一个 MCP Server

## 只做本地能力，不需要认证

这个连接器不访问任何云端账号，所以 `connector-meta.json` 里**省略 `auth_mode`**，也不提供 `token-schema.json`。

用户侧唯一的前置是：本机装了微信开发者工具、已登录、已开启「服务端口」、目标项目已导入。
这些在 `skills/miniprogram-devtools/SKILL.md` 的「前置条件」里写明了，AI 会在动手前先自检。
