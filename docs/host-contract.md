# 宿主契约:插件用到的每个宿主接口,在真实宿主上各真调一次

这个插件几乎全部的行为都发生在宿主的接口上:它注册工具、改写宿主装配出来的
系统提示、在宿主的执行管线上装守卫、用宿主的限制 API 收窄可见面、从宿主写的
会话日志里恢复状态。这些接口的形状由上游决定,而上游在 **rc 小版本里改过必填
参数**(DSH 0.2.1 把网关 `peer` 从可选改必填,另一个插件因此在四个产品版本上
全坏,而它三千多条打桩用例一路全绿)。

打桩的用例看不见这种变化。所以本仓库有一组**宿主侧一个桩都不打**的用例:

```bash
# staged 宿主的 dsh-plugin-desktop 目录
DSH_HOST_ROOT=<TokensCowork>/.build/desktop/dsh-plugin-desktop npm run check:host
```

没有 `DSH_HOST_ROOT` 时,每条用例显式报 **NOT EXECUTED**、命令退出码非 0 ——
不伪造通过。

## 这条命令跑什么

| 组 | 文件 | 要不要宿主 |
|---|---|---|
| `PT-HOST-01…32` 真实宿主契约 | `tests/live-host.spec.mjs` | 要 |
| `PT-GUARD-01…03` 夹具守卫自检 | 同上 | 不要 |
| `PT-COMPAT-01…07` 跨版本边界(`src/host.ts` 的双向锁定) | `tests/host-contract.spec.ts` | 不要 |
| `PT-SMOKE-01` 真实运行时冒烟 | `scripts/native-smoke.mjs` | 要 |

本地一次跑多个宿主:`DSH_HOST_ROOTS="<根1>;<根2>;<根3>"`。产品门禁只传
`DSH_HOST_ROOT`。本仓库原有的 `DSH_TEST_RUNTIME`(指向宿主 `package.json`)
继续认,内部折算成同一个根。

## 真实宿主契约是怎么跑的

1. 用**宿主自带的 launcher** 起一个一次性 `$DSH_HOME`(`mkdtemp`)里的 profile,
   bundle 是 `@deepseek-ai/dsh-base`,于是宿主自己那一整套真实工具(`read`、
   `pwsh`、`web_search`、`skill`、`subagent`…)都在。
2. **真实加载器**按本包的 `cordis.patch.yml` 把 `@tokensapi/dsh-progressive-tools`
   挂进去,装的是 `files` 白名单声明的那份文件集 —— 所以这组用例顺带钉住
   "发布出去的那份包真能被宿主加载"。
3. profile 的 `node_modules/@deepseek-ai` 指向宿主那一份:运行时包用
   module-local Symbol,多一份物理副本就对不上服务。
4. 探针(`tests/support/live-host-probe.mjs`)作为并排的 profile 条目挂上去,
   用**宿主的 `ctx.agents` 工厂**造真实 Agent 和 Session,然后把插件用到的每个
   宿主接口各真调一次,**只记录,不断言**;断言全部留在用例里,这样契约被破坏
   时看到的是宿主自己的措辞。
5. 本插件有三种模式(`native` / `stable-proxy` / `dynamic`),调用面不同、守卫与
   工具名在同一棵树上会互相干扰,所以**每种模式各起一次宿主**。

### 口径(agent-hub T0047 A″)

- 只断言插件**真正依赖**的东西:它调的接口存在且可调、它读的字段存在且类型对、
  它订阅的事件名在宿主词表里。宿主新增字段、新增事件、新增工具一律算兼容。
- **不**断言宿主的全貌:不比事件词表大小、不逐字对照工具全清单、不看宿主内部
  字段顺序。
- 形状校验交给宿主自己的东西:返回值交给宿主按 `output.schema` 收,内容交给
  `output.render`,结果信封交给宿主的 `createToolResultMessage`,并发口径交给
  宿主的 `executionMode`。
- 夹具绝不碰用户真实的 `~/.dsh`:`$DSH_HOME` 一律 `mkdtemp`,`PT-HOST-29` 断言
  宿主落地的每个路径都在临时目录内,`PT-HOST-30` 比对用户真实 `~/.dsh` 顶层
  条目的大小与 mtime 前后不变。

## 接口 ↔ 用例

| 插件用到的宿主接口 | 用例 |
|---|---|
| 真实加载器装载本包发布的文件集;`@deepseek-ai/*` 解析到宿主那一份 | PT-HOST-01 |
| `inject: ['tools','systemPrompt']`、`ctx.tools.register`、宿主的 schema 投影 | PT-HOST-02 |
| stable-proxy 的固定分发器(`name` / `arguments` 必填) | PT-HOST-03 |
| `ctx.agents.create` 造出的真实 Agent 与 Session | PT-HOST-04 |
| `ctx.on('system-prompt/assemble')` 中间件改写 `resolved.tools` | PT-HOST-05 |
| `ctx.systemPrompt.section`(固定文本与 `({ agent }) => string` 函数文本) | PT-HOST-06 |
| 宿主加载器把 profile 里的配置交给插件(非默认值真的生效) | PT-HOST-07 |
| `ctx.tools.guard` 拒绝一次执行 | PT-HOST-08 |
| `ctx.tools.execute` + `output.schema` / `render` / `presentationMeta` | PT-HOST-09 |
| native:加载后进入下一次装配、守卫放行、目标工具真执行 | PT-HOST-10 |
| native:零命中的恢复路径 | PT-HOST-11 |
| stable-proxy:在真实工具目录上搜索 | PT-HOST-12 |
| stable-proxy:嵌套 `ctx.tools.execute`(`parent` / `rootCallId` / `signal`) | PT-HOST-13 |
| `HarnessError`(`@deepseek-ai/dsh-llm`)的 code/name 经宿主路由 | PT-HOST-14 |
| stable-proxy:`requireDiscovery` 闸门 | PT-HOST-15 |
| `ctx.tools.executionMode` 与 `isConcurrencySafe` 的委托 | PT-HOST-16 |
| `ctx.on('tools/change')` | PT-HOST-17 |
| `deferToolGuidance`:按 `resolved.sections` 的名字摘掉精确指引 | PT-HOST-18 |
| `ctx.tools.restrict({ allow })` | PT-HOST-19、PT-HOST-20 |
| `ctx.on('agent/inbox/claimed')` | PT-HOST-21 |
| `ctx.on('agent/pre-step')`(宿主以 waterfall 调用,要原样交还决定) | PT-HOST-22 |
| 宿主 `Session.append` 接受 `tool/call` / `tool/result` / 子调用事件 | PT-HOST-23 |
| 从真实会话日志恢复(完整历史) | PT-HOST-24 |
| 只有 `tool/result` 时的信封兼容(0.1 包裹 / 0.2 摊平) | PT-HOST-31 |
| 只有 `run_code` 子调用时的事件名兼容(`code-dispatch` / `ptc-dispatch`) | PT-HOST-32 |
| `ctx.on('agent/disposed')`:句柄释放后 agent 离开注册表 | PT-HOST-25 |
| `KNOWN_SESSION_EVENT_TYPES` ∩ 插件读的会话事件名 | PT-HOST-26 |
| 宿主声明的 Cordis 总线事件名 ∩ 插件订阅的 7 个名字 | PT-HOST-27 |
| 宿主自己的 `evaluatePluginCompatibility`(含假 peer 反向对照) | PT-HOST-28 |
| 夹具安全:路径围栏 / 用户 `~/.dsh` 指纹 | PT-HOST-29、PT-HOST-30 |

> `ctx.effect` 的清理路径没有单独编号:它挂在 `agent/disposed`(PT-HOST-25)和
> 进程退出上,后者在一次性 profile 里没有可观测的后果。

## 变异验证:证明这些用例不是空转

契约用例最容易出的毛病是空转 —— 断言的那条路径压根没被走到,或者两边都回落到
同一个默认值。所以每条用例都配一次"把被测路径弄坏 → 必须红"的验证,而且做成
常驻机制:

```bash
npm run check:host -- --list-mutations
npm run check:host -- --mutate no-restrict
```

变异只改**装进 profile 的那份副本**,工作区一个字节都不动;命令要求变红的用例
**恰好**是清单里声明的那些:多红说明用例互相牵连,少红说明那条用例是空转。

| 变异 | 弄坏什么 | 期望变红 |
|---|---|---|
| `no-guard` | 不再登记 `ctx.tools.guard` | PT-HOST-08、17 |
| `no-restrict` | dynamic 不再调 `ctx.tools.restrict` | PT-HOST-05、07、19、20、21、22、24、31、32 |
| `ignore-tools-change` | 不再订阅 `tools/change` | PT-HOST-17 |
| `legacy-nested-only` | 只认 `tool/code-dispatch` | PT-HOST-32 |
| `flat-envelope-only` | 只认 0.2 摊平的结果信封 | PT-HOST-31(**只在 0.1 线上红**) |
| `no-presentation-meta` | native 不再声明 `output.presentationMeta` | PT-HOST-02、09 |
| `peer-0.1-only` | dsh peer 上界压回 `<0.2.0-0` | 24 条(**只在 0.2 线上红**) |

两条"门禁有效性"结论(2026-10-22 实测):

- `peer-0.1-only` 在 **0.2.1-rc.2 与 0.2.0-rc.2 上各 24 条红**,同一个变异在
  **0.1.5-rc.2 上 35 条全绿** —— 复现 T0047 要防的那类事故,同时证明它不是误报。
- `flat-envelope-only` 反过来:**0.1.5-rc.2 上 PT-HOST-31 红**,两条 0.2 线全绿 ——
  证明"两代结果信封都要读得懂"这条契约在两边都真的被检查。

## peer 区间的口径

dsh peer 写**双端区间**,下界是本插件真正验证过的运行时(`0.1.0-rc.8`),上界
只挡下一个大版本(`<1.0.0-0`,带 `-0` 是为了让大版本的预发布版也落在范围外)。

上界不再停在"没核对过的下一个小版本":内核跨 0.x 小版本时,契约全绿的插件不该
只为改一行声明重发一版,而真正的守门人是这份契约门禁 —— 版本号本来就预测不了
兼容性(0.2.0 → 0.2.1 这个 rc 小版本就把另一个插件打坏了)。`dsh.engine` 跟着
核心 peer 走,`tests/package.spec.ts` 把两者钉在一起。

## 宿主升级时怎么用

1. 把新的 staged 宿主目录作为 `DSH_HOST_ROOT` 跑一次 `npm run check:host`。
2. 红了先看是哪一条:每条用例的标题写的就是"插件依赖的是什么",据此判断是插件
   该改,还是上游破坏了契约。
3. 加了新的宿主接口调用,就在探针里加一步、在这里加一条用例和一条变异。
