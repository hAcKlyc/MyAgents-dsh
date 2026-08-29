---
name: start-dev
description: "Full MyAgents-dsh workflow from the plan and an active Stage/Batch PRD or settled conversation through DSH-native implementation, source migration, verification, cross-review, commits, and acceptance summary. One Stage/Batch PRD is one atomic delivery; internal workstreams only organize implementation/review/commit. Use for /start-dev, 'start dev', '开始开发', '按 PRD 开发', or equivalent end-to-end implementation requests; small conversational requirements use the same workflow through a devplan."
---

# MyAgents-dsh 需求开发全流程

你即将独立完成一个完整的开发周期。用户通常不在场，可能几小时后才回来做**一次**真机验收——中间的设计判断、验证、review、提交全由你负责。两样东西决定这次交付的质量：**磁盘上的执行台账**（你的工作记忆，防长任务/上下文压缩后失忆）和**最后的交付摘要**（用户重新进入上下文的唯一入口）。

## 项目入口与迁移基线

任何实现动作前，先完整读取 `AGENTS.md`、`specs/prd/plan.md`、当前 Stage/Batch PRD、相关 RFC 和 owning ledger。`plan.md` 是开发入口和唯一 Stage/Batch 状态/依赖/切换权威：Pre-Batch 未通过时不得偷跑 Batch 1；Batch 1 未验收时不得把缺失 Runtime 能力塞进 Batch 2 facade；Batch 3 的产品代码归 `MyAgents/` 仓库，不在这里越权实现。

`myagents-runtime` 是已经实现的 Pi 版本，也是功能、代码和测试迁移蓝本。默认动作是先审计并复制/提取 engine-neutral 合同、工具体、状态机、fixtures 和测试，再把 Pi 集成 seam 改造成 DSH/Cordis service、Provider、plugin、scope、event 与 `ctx.tools` 接入。禁止把它加成运行时依赖，也禁止搬入 Pi AgentLoop、Session/entry 模型、事件名、工具注册层或修复 wrapper。

DSH 是唯一 AgentLoop、持久模型对话与 ToolRuntime 权威。使用 DSH 前必须核对 plan 锁定的精确 revision、已安装类型/源码和公共导出；禁止导入 package-private `src/*` 或 `dist/*`。若现有公共 seam 无法表达已批准语义，先完成可复现证据并按 RFC/ADR 设计最小 upstream-ready 改动，不得在外层另造兼容 kernel。

## Step 0: 定位需求源，建立执行台账

先判断需求来源，进入对应模式：

**模式 A：有 PRD**（`specs/prd/` 下的文档，或用户指明的路径）
- 先读 `specs/prd/plan.md`，再完整读 PRD 和 owning ledger；按其引用主动 Read 相关 ARCHITECTURE / RFC / 协议 / 研究报告。
- readiness 由 plan 与 active PRD 共同决定，状态枚举遵守 plan 的 `not_started | in_progress | blocked | complete`。Pre-Batch 可在 `in_progress` 且台账有效时续跑；后续 Batch 从 `not_started` 进入开发前，必须确认依赖已 `complete`、用户已明确确认该 Batch scope，并在 plan/PRD/ledger 同步切换为 `in_progress`。`blocked` 只有阻塞决策已解决且契约同步后才能恢复；`complete` 不重复开发。
- plan 之外的新独立 PRD 若采用 `draft | ready-for-development | in-progress | implemented` 状态，则只有 `ready-for-development` 可首次启动，`in-progress` 可在台账有效且无未决产品/架构岔路时续跑；显式 `draft` 必须退回 `prd-writer` / `prd-discuss`。
- 旧式、缺失或部分交付状态不能直接执行。先提炼已上线基线、剩余原子范围、反向边界、真实外部兼容责任和全部发布门槛；这会重定义交付契约，必须先由 `prd-writer` 形成 draft 并获得用户确认。
- 把 active PRD 已有的 `Action ledger` / `Batch gate ledger` 作为唯一 owning ledger，直接续用，不另建一份平行行动清单。若它还缺开发契约、当前 review baseline、待决策或进展日志，就在该 ledger 附近补齐下方字段；任何零上下文 session 拿到 PRD 就应同时拿到范围和进展。
- readiness 通过且台账建立后、动第一行代码前，立即把 active PRD、plan 对应状态行/程序台账更新为一致的 `in_progress` 并刷新 `updated`；plan 之外的独立 PRD 沿用自身 `in-progress` 枚举。不要让长任务执行期间仍显示成尚未启动，诱发另一个 session 重复开发。

**模式 B：无 PRD**（需求在对话里聊清楚了，通常较小）
- 新建 `specs/prd/devplan_<YYMMDD>_<slug>.md`，frontmatter 直接写 `status: in-progress`：第一节用几句话把需求钉住（目标、必赢场景、明确不做什么），写到零上下文 session 也能接手的程度；然后同样建 `## 执行台账`。
- 需求再小也走完整流程（自验证、cross-review、提交）；台账按规模精简，契约和清单不省。

### 原子交付契约

**一份 PRD / devplan = 一次原子交付。** 范围内的所有功能、平台、Runtime、迁移、测试、文档与验收项必须在同一个开发周期全部完成，整体验收后统一上线。开发批次只是实现、自验证、cross-review、commit 的工程事务边界，不是产品阶段、发布阶段、兼容边界或部分完成定义。

因此：

- 禁止把同一 PRD 执行成“一期先上、二期补齐”；也禁止只因 Batch 之间暂时共存就增加 flag、双写、fallback、临时迁移层或兼容壳。
- 某个 Batch 完成，只表示仓库处于可构建、可验证、可回退的内部稳定点，不表示形成了可对用户发布或长期支持的中间产品状态。
- 真正已发布的旧客户端、持久数据或外部协议造成的兼容责任仍须处理；判断依据是现实中已有外部 owner，不是本 PRD 的 Batch 边界。
- 所有必做 internal workstream / development batch 全部完成并通过整体验收前，不得把 active Stage/Batch 标记为 `complete`（独立 PRD 为 `implemented`）、不得宣告完整交付，也不得进入产品发布。

### 执行台账的形态

```markdown
## <复用 active PRD 的既有 Action ledger；无既有 ledger 时才新建 Execution ledger>

### 开发契约（动第一行代码前写完）
- 必赢场景：<端到端跑通长什么样，即最终验收基线>
- 原子交付：<确认整份 PRD 范围一次完成、统一上线；列出任何真实的外部兼容责任>
- 必须保证：<本次交付承诺的行为、可靠性与兼容边界>
- 明确不做 / 不保证：<例如不自动重试、不跨重启恢复、不提供跨文件事务；从 PRD 反向边界提炼>
- 本次负责的问题：<本次改动引入、显著放大，或 PRD 明确要求解决的问题>
- 复用的既有抽象：<grep 核实过的真实符号/模块名；写不出来就先去搜，别凭印象>
- 新增架构机制：<新增 state/store/owner/protocol/retry/fallback 及其必要性；目标是无>
- 触及的红线：<AGENTS.md 架构不变量与 plan/RFC 中本次相关的规则>
- 旧版复用清单：<核实过的 myagents-runtime 源文件/测试、迁移方式、Pi 假设移除点、provenance 记录>
- DSH seam 依据：<精确 revision、公共 export/type/source、采用 direct/plugin/Provider/fork 的证据>

### 验收与结束条件（动第一行代码前写完）
- 验收标准：<哪些结果成立才算完成>
- 事实依据：<每项验收分别以哪段代码、测试、构建产物、运行结果或人工检查为准>
- 改动与检查的对应关系：<哪些类型的改动会影响哪些已有检查结果；修改后只重跑受影响的检查>
- 结束条件：<哪些检查和 review 通过后必须结束开发；哪些已知限制只记录、不阻塞>

### 开发批次与行动清单
- Batch 1：<内聚的实现 / 根因；覆盖的验收点；为什么适合作为一次独立 review + commit>
  - [ ] <批次内行动项>

### 当前批次 Review 基线
- 批次：<Batch N>
- Batch base：<开始本批次时的 HEAD；用于只审本批次，不回卷此前已提交批次>
- 预期范围：<本批次预计触及的模块 / 文件；review 前按实际结果更新>

### 待用户决策
<被产品岔路阻塞的问题记在这里，不要擅自替用户拍产品决策>

### 进展日志
<每完成一项加一行：日期 + 结论 / 与计划的偏离>
```

三条铁律：

- **契约先行。** 契约没写完不动代码。写契约就是强制回答 Step 1 的归零自检；「复用的既有抽象」「旧版复用清单」或「DSH seam 依据」填不出来，说明设计还没做完。
- **重新锚定。** 每完成一个行动项、或察觉上下文被压缩过（对话里出现 summary），先重读台账（模式 A 连同 PRD 执行须知）再继续。长任务里你最大的风险不是不会做，而是忘了任务的形状、陷进眼前文件的细节。
- **按影响验证。** 不同检查证明不同事实。修改后先判断哪些事实依据已经受到影响，只重跑对应检查；不要因为仓库里任意文件发生变化，就机械地重做所有高成本验证。

### 开发批次规划与执行

**开发批次**是围绕一个内聚根因、owner 边界或 reviewable change set，完整走完 Step 1–5 的工程事务作用域。默认整份 PRD 只用一个批次；只有候选分组各自都能保持仓库内部正确、独立验证和回退，并形成清晰的 review / commit 边界时才拆分。PRD 章节、验收项、技术层级、跨模块或行动项数量本身都不是拆分理由；共享同一 source of truth、核心不变量或端到端证据的事项留在同一批次。

规划批次时做一次反向检查：**这个拆法是否迫使我为 Batch 之间的共存状态新增兼容层、临时 flag、双路径或半成品 UI？** 如果是，批次边界切错了——合并批次或把共同基础归回正确 owner，而不是把中间态产品化。

每个开发批次完整走一遍 Step 1–5，更新台账再进下一批次。批次内完成行动项时更新台账并运行必要的针对性测试，但不触发 cross-review 或提交。每批次开始先记录当前 HEAD 为 `Batch base`；cross-review 只审 `Batch base` 之后属于本批次的范围，不用 `main` merge-base 把此前批次重新卷入。

## Step 1: 实现需求

遵循需求目标、`AGENTS.md`（`CLAUDE.md` 是其软链）、`specs/prd/plan.md`、相关架构/RFC 与项目现有代码模式。方案定型前做归零自检：

- (a) 引入了几个新概念？趋向零——若需要新的 enum、优先级体系或注册协议，视为设计异味，项目中几乎必然存在同构结构尚未被识别。
- (b) 仅用已有原语的最简实现是什么？
- (c) 开发者遗漏某步时，系统是编译失败还是静默腐坏？
- (d) 这是 root-fix（移除错位）还是 band-aid？实现中途发现自己正在加 cache / guard / flag / retry / wrapper、且它唯一作用是让症状消失——停下，先回答「这个 work 的正确 owner 是谁」。
- (e) `myagents-runtime` 是否已有可迁移实现/测试？若重写，具体是哪条 Pi 耦合或已批准契约差异迫使重写？
- (f) 这项能力是否能完全走 DSH 公共 seam？若不能，最小 seam 改动的 executable evidence 和 upstream 边界是什么？

实现只需满足「必须保证」并守住现有架构不变量，不得为了消除所有可想象风险而突破「明确不做 / 不保证」。发现的风险若只能通过新增 owner、持久状态、协议、重试、恢复、补偿事务或并行路径解决，先判断是否属于本次负责的问题；不属于则记录并停止扩张，属于但会改变架构形状则交给用户决策。

若开发中发现会改变产品范围、默认体验、通信模式、owner / source of truth、架构形状或完成定义的岔路，整份 PRD 的 readiness 立即失效：把证据写入「待用户决策」，停止新的实现 / review / commit，等待用户决定并更新 PRD 契约。不得自行引入架构变更，也不得继续其它 Batch。既有架构内、不改变 PRD 契约的日常技术问题由你自己解决。

开发过程中保持 task list 与台账行动清单同步更新。

## Step 2: 自验证

代码写完不等于做完。按层级验证，每层通过再进下一层。修复后重新运行直接受影响的检查；代码变更至少重新执行适用的静态检查和针对性测试。只有修复改变了某项构建、集成或运行检查所依赖的代码或前提时，才重新执行该项高成本检查。

### 2a. 静态验证 + 测试

Pre-Batch 创建 package scripts 之前，只有 active ledger 明确建立的 targeted check 才是规范门禁；不得假装尚不存在的命令已经通过。scripts 锁定后，代码改动至少执行适用的 targeted tests，并在 Batch release commit 前运行：

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

默认测试必须使用 fake Provider、fake Host port、临时 home/workspace，且不访问真实网络或凭据。修 bug 补回归；迁移代码时把 engine-neutral 行为测试一起迁入，并补 DSH authority、replay、cancellation 和 cleanup 证据。

### 2b. 构建验证

按 active ledger 构建受影响 package；涉及 Runtime 交付时还必须构建/pack 精确 sidecar artifact 并验证版本、协议、profile/tool digest 与 clean-install 内容。构建失败或 artifact 身份不明确意味着交付物有问题。

### 2c. 针对性烟测

选最便宜的真实运行时检查证明变更行为：

- **CLI 命令变更** → 实际执行命令，检查输出
- **API 端点变更** → curl / fetch 验证响应格式和内容
- **配置 / 逻辑变更** → 写临时脚本验证读写和边界情况
- **JSON-RPC / reverse port 变更** → 用 Standard Test Host 覆盖 framing、correlation、terminal、cancel、malformed input 与 shutdown
- **工具/权限/Hook 变更** → 通过统一 `ctx.tools` 路径运行真实 tool call，核对 trace、rewrite 后重校验与 secret canary
- **Session/持久化变更** → 用临时数据目录验证 resume/replay/recovery/mutation/cleanup 和故障注入
- **Agent 能力或工具组合变更** → 对 packed Runtime 运行独立 Tester Agent 的自然 prompt 场景，检查 sealed trace/artifact；Tester Agent 只提供证据，Development Main Agent 负责裁决
- **平台边界变更** → macOS 在当前机器完成原生 artifact 验证；Windows/Linux 在代码、adapter、fixture 与 CI 层面完成后标记 `implementation-complete_pending-native-validation`，不得冒充 native-verified

烟测脚本放 `/tmp/myagents-verify-*`，用完即删。**所有「自动验证覆盖不到」的项，当场记入台账并标记 `mandatory` 或 `advisory`**：属于 PRD 验收、关键技术假设、安全 / 权限、跨平台或 OS 集成正确性的都是发布硬门槛 `mandatory`；仅用于主观观感微调或额外观察、且不影响完成定义的才是 `advisory`。Step 6 聚合成真机验收指南——不要靠最后回忆，也不要把 mandatory 写成建议项来绕过完成门禁。

### 2d. 回归风险评估

改了共享模块（strict peer、Runtime generation、DSH Session/事件投影、`ctx.tools`、Host reverse ports、WorkRegistry/TaskGraph、SQLite Provider、checkpoint journal、component generation、平台 adapter 等）时，对相邻路径和组合态做基本验证。

## Step 3: 需求符合性检查

重读需求源（PRD / devplan）逐条对照：

- 功能点是否完整覆盖？边界情况和细节是否处理？
- 有没有引入需求范围之外的行为（scope creep）？
- 是否还有验收标准未被任何验证覆盖？
- 本次变更是否让 `AGENTS.md`、`specs/prd/plan.md`、ARCHITECTURE、PRD、RFC、协议或 migration inventory 陈述失真，或新增了必须教给后续开发者的承重抽象？有则在本次开发内更新，不留给周期性文档审计。

Step 2 验证「代码能不能跑」，这一步验证「跑出来的对不对」。检查完同步勾选台账行动清单。

## Step 4: Cross Review

调用前先从台账与当前工作树形成一份 Review Contract：

- mode：默认 `repair`；只有用户明确说“仅 review / 不修改代码”才用 `audit-only`；
- requirement source：PRD/devplan 与本批次验收点；
- target/base：本批次 `Batch base`；
- in-scope：本批次实际拥有的 tracked + untracked 文件；
- out-of-scope：共享工作树里其它 session / 用户的改动；
- 必须保证 / 明确不做：直接抄录开发契约，不允许 reviewer 提高保证等级；
- 本次负责的问题：只让本次引入、显著放大或 PRD 明确拥有的问题阻塞交付；
- 允许新增的架构机制：开发契约中已获授权的新增机制，通常为空；
- required lenses：按 `cross-review-code` 的能力规则标记，本项目正常代码批次原则上三路都 required。

通过当前 runtime 的 skill 机制执行一次 `cross-review-code`，把 Review Contract 交给协调器；不要自行模拟子 reviewer。`repair` 模式先并行运行 requirements / adversarial，再由主 Agent裁决并修复当前契约内的阻塞问题，最后由全新上下文的 architecture reviewer 审查修复后的完整代码。派遣、等待、定向复核与失败处理都由协调器负责。

若 required lens 不可用（无法生成 fresh-context 子智能体、reviewer 失败且没有等价独立覆盖等），如实记录缺失能力并停止本批次提交；不许由主 Agent 补做，也不许用“另外两路成功”假装完整 cross-review。

同一批改动只执行一轮完整 cross-review。修复后由原 reviewer 定向复查对应问题；除非后续修改明显影响了原评审范围内的其它行为，否则不得重新发起一轮完整 review。达到 Review Contract 与本批次结束条件后，结束本批次，不再以“还能继续寻找问题”为由追加评审。

## Step 5: 提交 Git

只有 required lenses 全部完成、当前契约内的阻塞问题已根因修复、验收要求的证据缺口已关闭、最终 architecture 审查结论为 PASS，且修复后的受影响验证通过，才进入提交。已裁决为超出范围、既有问题或误报的审查发现不阻塞提交，也不得继续驱动加固。工作分支、显式 `git add <files...>`、Conventional Commit 与非空 body 纪律按 `AGENTS.md` 执行；不得 `git add .` 或 `git add -A`。

### Commit message 硬闸

- 每个 commit MUST 同时包含 Conventional Commits subject（`feat:` / `fix:` / `refactor:`）和非空 body，二者不可拆；禁止只提交标题，必须使用 `git commit -m "<subject>" -m "<body>"` 或 `git commit -F <file>`。subject 必须表达真实动机或根因，禁止 `fix: update X`、`fix: harden Y` 这类只复述 diff 的空话。
- body 要让一个看不到 diff 的半年后维护者读懂：真实故障模式或产品动机、关键方案取舍及为何不用更显然的 move/delete/cache/guard、以及副作用、残留风险或后人不能踩的坑。错别字或纯机械小改的 body 可以只有一句理由，但不得省略。
- 输入 `git commit` 前逐项核对 subject + body，并确认 message 与 staged code 一致；任一项缺失就先重写，不得提交，任何改动规模都没有省略 body 的例外。

每个开发批次一个 commit；提交后把 commit hash 记入台账进展日志。

## Step 5.5: 整份 PRD 原子交付门禁

所有开发批次完成后，**不能把多个局部绿灯直接相加成“整份 PRD 已完成”**。在进入交付摘要和 `status: implemented` 前，对最终 HEAD 做一次 PRD 级闭环：

1. 从头重读 PRD / devplan，不按 Batch 分组，逐条核对全部交付范围、反向边界、关键决策和验收标准；任何未覆盖项都回到新的修复批次，不能用“它属于前一个 Batch”跳过。
2. 运行覆盖最终组合态的整体验证：至少重跑所有 Batch 的共同静态门禁，并根据「改动与检查的对应关系」选择受影响的端到端、跨模块、跨进程和回归检查，证明各 Batch 组合后仍共享正确的 source of truth、owner 与不变量。
3. 检查中间态残留：不得留下只为 Batch 共存服务的临时 flag、双写、fallback、兼容壳、迁移桥或半成品入口。真实旧版本 / 外部协议兼容必须能指向现实 owner 和删除门槛。
4. 聚合整个 run 中“自动验证覆盖不到”的事项，区分**发布硬门槛**与普通观察项。任何属于 PRD 验收、关键技术假设、安全/权限或本 Batch 承诺的 native-verified 平台检查，在实际完成前都算未完成。Batch 1 当前明确允许 Windows/Linux 以 `implementation-complete_pending-native-validation` 交付；只要实现、可复用验收 campaign 和 claim 状态都符合 PRD，它不是伪装成 advisory 的缺口，也不得写成 native-verified。
5. 若本 PRD 拆成多个 Batch，以第一个 `Batch base` 到最终 HEAD 为整体范围形成 Final Review Contract，requirement source = 整份 PRD 与全部验收点，再通过 `cross-review-code` 检查跨 Batch 组合态；仍遵守相同保证范围、责任边界和最终 architecture 审查。单 Batch 且 review 后代码未再变化时，原 review 已覆盖整体，无需机械重复。

若整体门禁或 Final Review 发现代码问题，把修复作为 Final Integration Batch，走完整 Step 1–5。重新执行本门禁时，只重跑被该修复影响的检查；只有修复明显改变了原评审范围内的其它行为，才重新执行完整 cross-review。若发现会改变 PRD 契约的产品 / 架构岔路，按 Step 0 readiness 失效处理，停止并交还用户决策。

最终组合态满足验收标准、required review 已完成、受影响检查全部通过后，原子交付门禁即告完成。此后发现的事项若不违反本 PRD 的需求、现有架构规则或「必须保证」，记录为后续事项，不继续扩大本次交付。

## Step 6: 交付摘要

收尾动作：模式 A 的 Stage/Batch PRD 与模式 B 的 devplan 使用同一终态门禁——只有全部必做范围、实现内验证、发布硬门槛真机验收与 Step 5.5 整体门禁完成，才把 plan-connected Stage/Batch 写成 `complete`（独立 PRD/devplan 写成 `implemented`）；任何一项未完成都保持 `in_progress` / `in-progress`，在台账说明剩余项，并明确**不得把部分完成当成可发布交付**；`updated` 更新为当天。

状态与最终台账不能只留在工作树：显式 stage tracked 的需求源、ledger 和 `specs/prd/plan.md` 状态更新，并创建只承载交付状态/最终证据的收尾 commit；不得 force-add ignored material。Windows/Linux mandatory 原生验收若安排在后续真机 campaign，当前状态必须保持 plan/RFC 规定的 pending-native-validation，并在真机确认后更新证据和平台 claim，不能提前宣称全平台 verified。

然后输出产品导向的摘要。不要以逐文件变更清单或测试命令清单开头——那是工程记录，不是用户的验收框架。只有 plan-connected Stage/Batch 为 `complete`（或独立 PRD 为 `implemented`）才使用“开发完成”；若仍是 `in_progress` / `in-progress`，标题必须是“开发进展（未完成，不可发布）”，置顶说明缺失的必做范围，不能用完成态措辞制造部分交付已经成立的印象。结构：

```markdown
## 开发完成
<!-- 若 status: in_progress / in-progress，改为：## 开发进展（未完成，不可发布） -->

### 1. 本次目标 / 问题现象
[功能：目标产品体验是什么。bug：用户可见症状与暴露它的具体场景。]

### 2. 根因判断 / 关键张力
[bug：第一性根因，指名放错位置的 owner/scope/state/config 边界。功能：塑造实现的关键产品或架构张力。]

### 3. 关键解决方案
[少数几个决定行为正确性的结构性决策，不是实现流水账，不逐文件罗列。]

### 4. 架构判断与影响
[方案是否符合 MyAgents 架构；行为变化、权限/安全影响、兼容与迁移风险、已知负面影响。没有就明说。]

### 5. 待决策 + 真机验收指南
[「待用户决策」条目置顶（如有）。然后聚合整个 run 中所有自动验证覆盖不到的点，按风险排序给 3–7 个验收场景，每个：操作步骤（点哪里、输入什么）/ 预期结果 / 为什么测这个（一句话说明覆盖了什么风险）。桌面/OS 集成类给 OS 级硬证据步骤。这是用户唯一需要亲手做的事。]

### 6. 备忘：关键变更
[工程备忘：commit hash（按开发批次列）、关键模块/文件、验证命令与结果、跳过的检查及原因、刻意未动的无关工作树变更。]
```

1–5 保持简洁、面向决策；6 可以机械，但只放对日后重建工作有用的信息。小需求压缩结构，但保持同样的优先级：产品语境在前，工程日志在后。
