# Tokens 渐进式工具

默认 `native` 模式只发送常用工具和有长度限制的能力目录。搜索后加载精确
工具的完整定义，由宿主按原始工具身份直接执行。

[English](./docs/README.en-US.md)

## 仓库导航

- `src/`：运行时代码；`tests/`：回归测试。
- `scripts/`：会话审计、可复现评估、运行时冒烟测试和发布校验。
- `docs/`：[架构](./docs/architecture.md)、[配置](./docs/configuration.md)、
  [评估证据](./docs/evaluation.md)、[发布](./docs/publishing.md)。
- `.github/workflows/ci-and-release.yml`：多版本 Node 兼容性检查，通过后按标签发布到私有仓库。
- `lib/`、`node_modules/`：构建产物和本地依赖，不提交 Git。
  `.validation/` 为临时测试输出，由评估脚本按需重建。

双语 README、许可证声明保留；`CLAUDE.md` 仅指向唯一规则入口 `AGENTS.md`。

## 原生按需加载（默认）

```text
能力目录 -> tool_search -> 完整原生定义 -> 直接调用真实工具
```

- `search` 搜索名称、描述、参数文本和配置的多语言别名，不要求只能使用英文。
- `status` 分页浏览全部工具，用 `offset` / `nextOffset` 继续；浏览不会激活工具。
- `load` 用 `names` 精确加载最多 32 个名字，避免搜索排序成为能力访问上限。
- 只加载选中的工具，不自动放行未返回定义的同族工具。完整参数由下一次请求
  的工具字段提供，搜索结果不重复塞入整份定义。
- 已加载工具及其精确 `tool:<name>` 使用规则在会话中保留，不按轮次或家族上限淘汰。
- 原始身份、展示、内容、权限与并发由宿主管理；代码工具接口使用同一加载集合。
- 无法识别归属的规则保持原样。可配置家族描述、多语言别名和技能绑定，
  不需要针对某个插件建立特殊白名单。

已有配置明确设置 `mode: stable-proxy` 的用户需要改为 `mode: native`。
省略模式时现在默认使用 native。旧代理会话的发现记录不自动迁移，需要重新搜索；
新原生模式支持会话恢复。

原生加载会改变工具前缀，可能降低缓存命中；本版未实现模型提供商的原生延迟引用协议。
只使用少量工具时可以减少定义开销，长会话最终加载全部工具时未必节省。
`pnpm eval:offline` 验证固定调用流程；配置 `EVAL_BASE_URL`、`EVAL_MODEL`、
`EVAL_API_KEY` 后用 `pnpm eval:live` 做合成任务对照。测试不执行真实业务工具。
评估方法见 [evaluation](./docs/evaluation.md)。

## stable-proxy 兼容模式

每个可见工具的名称、描述和参数 schema 都会重复占用请求 token。如果后续
再动态改变工具列表，请求前缀也会变化，导致上下文缓存无法继续复用。

显式选择的 `stable-proxy` 模式同时保证：

- 第一次请求就是精简工具面；
- 搜索前后顶层工具定义和系统文本保持逐字节稳定。

```text
完整工具注册表（仅进程内）
        │
        ├── 可搜索的精确工具定义
        │
        └── 固定请求工具面
              ├── tool_search
              ├── tool_dispatch
              └── 少量高频直连工具
                       │
tool_search 结果 ─────┴──► 把命中的精确定义追加到对话历史
                                  │
                                  └── tool_dispatch ──► DSH 原有执行管线
```

搜索只追加对话历史，不改变顶层 `tools` 数组。真实工具原有的审批、guard、
参数校验、超时、结果策略、延迟上下文和取消信号仍然生效。

## 兼容模式能力

- 真实 AgentLoop 第一次请求即发送最小工具定义。
- 搜索前后原生工具数组和 Code Mode SDK 保持稳定。
- 返回精确工具名称、完整描述和参数 schema，不再激活整个工具族。
- 工具族级发现：每条命中同时列出所属工具族的全部成员名，一次搜索即可
  铺开一个插件的完整可分发工具面。
- `status` 动作可浏览完整目录；可选 `statusGrantsDiscovery` 供受信任部署
  一次性解锁全部名字。
- 对话体量有界增长：搜索结果只记录本次新增的发现名单，恢复所需的累积
  状态走呈现元数据，不占对话 token。
- 确定性的 BM25 风格词法排序，覆盖工具名、描述、嵌套参数说明、枚举、
  工具族元数据及多语言别名。
- `tool_dispatch` 使用原始工具定义进行运行时参数校验和执行。
- 单调 guard 阻止隐藏工具被直接调用，只允许分发器拥有的嵌套调用树进入。
- 同时支持继承工具和 Agent 自有工具的渐进式隐藏。
- 从顶层结果和 Code Mode 日志恢复已发现工具。
- 可选 Skill 到工具族的发现联动。
- 保留 `dynamic` 兼容模式，供必须动态暴露原生 schema 的场景使用。
- Cordis effect 完整可逆，支持卸载和配置重载。

## 要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- Cordis `4.0.1` 或 `4.0.2`
- DeepSeek Harness `0.1.0-rc.8`，或桌面版 `0.4.3` 内置的
  `0.1.3-alpha.1` 运行时
- 从源码安装和开发时使用 pnpm

## 安装

```sh
dsh plugin --profile web add @tokensapi/dsh-progressive-tools
```

如果 pnpm 要求授权源码构建，把错误信息中给出的精确包名加入对应 profile 的
`pnpm-workspace.yaml`：

```yaml
allowBuilds:
  '@tokensapi/dsh-progressive-tools': true
```

安装后检查组合结果：

```sh
dsh --profile web --dump-config
```

输出中应包含本 bundle 提供的 `tokens-progressive-tools` 配置行。

## stable-proxy 使用

stable-proxy 直连工具面包括：

- `tool_search`；
- `tool_dispatch`；
- 已注册的 `read`、`write`、`edit`、`glob`、`grep`、`bash`、`skill`、
  `ask_user_question`、`todo_write`、`dsh_im_return_file`、`report`、
  `submit_*` 和 `structured_output*`；
- 当前工具呈现模式所需的 Harness 保留传输工具。

正常对话不需要用户强制说明先调用 `tool_search`。插件会提供一段固定系统
说明，要求在判断能力不可用前先搜索。

搜索工具定义：

```json
{
  "query": "浏览器页面操作",
  "max_results": 3
}
```

按搜索返回的精确 schema 分发：

```json
{
  "name": "browser_open",
  "arguments": {
    "url": "https://example.com"
  }
}
```

每条命中还会列出所属工具族的全部成员名，整个工具族在同一次搜索后即可
分发——没进入 Top-N 的兄弟工具可以直接按名字分发，或用一次精确名搜索
先取回它的 schema。

`tool_search` 也支持 `{"action":"status"}`，会列出全部延迟工具族及其成员
工具名，并附带目录规模和 token 估算。status 默认只用于浏览：分发未见过
的名字仍需一次精确名搜索，拒绝信息会明确指路。需要即时放行的部署可以
开启 `statusGrantsDiscovery: true`。搜索结果不会把命中工具加入下一次
请求的顶层工具数组。

## 配置

默认配置：

```yaml
- id: tokens-progressive-tools
  config:
    mode: stable-proxy
    toolName: tool_search
    dispatchToolName: tool_dispatch
    maxResults: 5
    requireDiscovery: true
    statusGrantsDiscovery: false
    deferToolGuidance: true
    alwaysVisible:
      - read
      - write
      - edit
      - glob
      - grep
      - bash
      - skill
      - ask_user_question
      - todo_write
      - dsh_im_return_file
      - report
      - submit_*
      - structured_output*
```

工具族只参与搜索排序，不会改变稳定请求工具面：

```yaml
- id: tokens-progressive-tools
  config:
    groups:
      - id: browser
        description: 浏览器导航与页面交互
        aliases: [browser, web page, 浏览器]
        include: [browser_*]
      - id: database
        description: 数据库检查与查询
        aliases: [database, sql, 数据库]
        include: [db_*, sql_*]
```

完整字段、既有插件生态的接入清单（高频工具配 `alwaysVisible`、带 Skill
的插件配 `skillBindings`、命名不规范的插件写显式 `groups` 规则）以及
`dynamic` 迁移说明见[配置参考](./docs/configuration.md)。
[发现机制边界](./docs/architecture.md#discovery-boundaries)进一步说明 Skills、工具定义、
执行层和供应方能力边界之间的关系。

## 执行与安全语义

稳定模式在官方 `system-prompt/assemble` 边界过滤最终请求，不改变注册表本身。
如果直接调用被延迟的工具名，单调工具 guard 会拒绝它。`tool_dispatch` 使用
原 Agent、取消信号、根调用标识、真实工具名和参数创建嵌套执行，因此真实
工具仍会经过 DSH 的完整策略链。

该 guard 只维护调用路由，不替代 approval、sandbox 或其他安全策略。

## 取舍

- 延迟工具不会出现在顶层请求的原生参数 grammar 中；DSH 会在分发时使用原始
  schema 校验。
- 一项任务可能先增加一次搜索调用。
- 同族兄弟工具在 schema 展示之前即可分发；执行管线仍会校验每次调用，但
  参数复杂或有副作用的兄弟工具建议先用一次精确名搜索取回 schema。
- 搜索是确定性词法排序，不依赖向量服务。
- 只有命中的定义进入对话，但会一直保留到常规 compaction。
- 工具注册或插件组合发生真实变化时，下一次系统前缀仍可能变化；普通搜索
  不会引起变化。

## 开发

```sh
pnpm install
pnpm run check
```

测试包含真实 AgentLoop 请求捕获，验证首个请求已经精简，并验证搜索后
`tools` 数组和系统文本完全不变。

实现依据官方的[架构参考](https://deepseek-harness.github.io/deepseek-harness/reference/)、
[系统提示子系统](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/system-prompt)、
[工具子系统](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools)、
[Skills 子系统](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/skills)
和[插件发布规范](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)。

## 许可证

[MIT](./LICENSE)。上游来源和保留的版权归属记录在
[THIRD_PARTY_NOTICES.md](./docs/THIRD_PARTY_NOTICES.md)。
