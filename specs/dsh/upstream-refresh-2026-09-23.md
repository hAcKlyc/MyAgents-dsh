# DSH rc.2 → rc.3 源码与维护记录

日期：2026-09-23。用户已授权实施 rc.3 更新。以下保留固定源码比较及逐 seam 判定；新制品验收以本文件末尾的实施记录及 Host 交付记录为准。

## 结论

rc.3 是依赖发布修正。源码比较没有 Runtime 行为改动，现有 9 个 DSH 补丁无需改动即可顺序精确应用。没有新增公共能力可使补丁进一步退役。用户随后授权本次维护更新；不增加产品功能或改变现有验收范围。

源码比较本身不证明新构建或跨平台运行正确；实施验证记录见末尾。

## 固定身份

| 项目 | rc.2 | rc.3 |
|---|---|---|
| Commit | fb2c4b9e698e30edb738bca4cf0618587db7d203 | a4c74a91e06b00fe0b0937bde982170c526cc842 |
| Tree | bd7dd6d90010a35d3d6ff9f12c1f6207d5b6fe38 | bf4fd1ddccc211107ffb8b7074c83afac2bd7ea1 |
| 上游 tag | dsh-v0.1.5-rc.2 | dsh-v0.1.5-rc.3 |
| pnpm | 11.7.0 | 11.7.0 |

Host 观察点：96f565ee；MyAgents-dsh 观察点：b5117ed7da513199ccfb34c62a07826c7b08dfc7。当前产品 Node/npm 仍为 24.20.0/11.19.0。

## 上游实际改动

GitHub 比较为 3 个提交：依赖锁定修复、版本发布、合并。逐文件比较两份固定提交归档，各有 10,167 个普通文件，共 277 个文件变化：274 个 package.json、pnpm-lock.yaml、发布依赖检查器及其测试。272 处 manifest version 从 rc.2 改为 rc.3；其余 manifest 字段变化均为 vendor 依赖从 workspace:^ 改为 workspace:*。未发现 exports、引擎工具链、运行时源码、原生会话格式或许可证正文变化。lock 的全部 375 处差异均为对应 specifier，不涉及已解析依赖版本/完整性变动。

发布后的代表包 dsh-agent-loop 将 Cordis 从 ^4.0.2 改为 4.0.2、Schemastery 从 ^3.18.2 改为 3.18.2。含义是锁定发布线依赖，不是任意 npm 通配符。

当前项目和交付 Runtime 的 lock 已固定 Cordis 4.0.2、Cosmokit 1.8.3、Schemastery 3.18.2、pi-ai 0.85.1。因此当前已交付 Runtime 没有因 npm 上游新版本自动漂移；rc.3 的直接收益主要在未来打包/安装约束。没有测量到性能或模型效果收益，也不应据此宣称这类收益。

## 全部 12 项 seam 处置矩阵

所有现存补丁的退役条件均未被 rc.3 的新能力满足。已移除的 003、007 不恢复；004 保持公开 Provider 组合。下表记录本次源码层升级处置；产品与制品层证据单独记录。

| Seam / 产品语义 | 建议处置 | 官方能力与缺口 | 本轮证据与限制 |
|---|---|---|---|
| DSH-SEAM-001 既有 Inbox 身份唤醒 | rebase（保留原补丁字节） | 缺口仍在；rc.3 未增加替代语义 | 逐项补丁精确应用及每一步 post-image 等同性通过；源码回归通过；产品证据见实施记录 |
| DSH-SEAM-002 工具参数提交前权威变换 | rebase（保留原补丁字节） | 缺口仍在；rc.3 未增加替代语义 | 逐项补丁精确应用及每一步 post-image 等同性通过；源码回归通过；产品证据见实施记录 |
| DSH-SEAM-003 Product 必需事件识别 | retire（继续保持已移除） | 沿用现有公开组合；相关源码未变 | 相关实现无上游变更；公开组合保持不变；产品证据见实施记录 |
| DSH-SEAM-004 持久化锁与不可变 rewind | keep public composition | 沿用现有公开组合；相关源码未变 | 相关实现无上游变更；公开组合保持不变；产品证据见实施记录 |
| DSH-SEAM-005 Root/Session 发布前守卫 | rebase（保留原补丁字节） | 缺口仍在；rc.3 未增加替代语义 | 逐项补丁精确应用及每一步 post-image 等同性通过；源码回归通过；产品证据见实施记录 |
| DSH-SEAM-006 可继续子 Agent 生命周期 | rebase（保留原补丁字节） | 缺口仍在；rc.3 未增加替代语义 | 逐项补丁精确应用及每一步 post-image 等同性通过；源码回归通过；产品证据见实施记录 |
| DSH-SEAM-007 DeepSeek 流式工具身份 | retire（继续保持已移除） | 沿用现有公开组合；相关源码未变 | 相关实现无上游变更；公开组合保持不变；产品证据见实施记录 |
| DSH-SEAM-008 容量安全压缩与修复 | rebase（保留原补丁字节） | 缺口仍在；rc.3 未增加替代语义 | 逐项补丁精确应用及每一步 post-image 等同性通过；源码回归通过；产品证据见实施记录 |
| DSH-SEAM-009 字面量提示词与子 persona | rebase（保留原补丁字节） | 缺口仍在；rc.3 未增加替代语义 | 逐项补丁精确应用及每一步 post-image 等同性通过；源码回归通过；产品证据见实施记录 |
| DSH-SEAM-010 项目指令候选选择 | rebase（保留原补丁字节） | 缺口仍在；rc.3 未增加替代语义 | 逐项补丁精确应用及每一步 post-image 等同性通过；源码回归通过；产品证据见实施记录 |
| DSH-SEAM-011 Provider 原始内容与同路由回放 | rebase（保留原补丁字节） | 缺口仍在；rc.3 未增加替代语义 | 逐项补丁精确应用及每一步 post-image 等同性通过；源码回归通过；产品证据见实施记录 |
| DSH-SEAM-012 官方文件工具与发布回调 | rebase（保留原补丁字节） | 缺口仍在；rc.3 未增加替代语义 | 逐项补丁精确应用及每一步 post-image 等同性通过；源码回归通过；产品证据见实施记录 |

各行的实际消费方、精确移除条件、应运行的语义场景来自现有 seam-decisions-v1.json 与 ADR 0001–0012，未创建新的权限、持久化、协议或进程 owner。

| 验证组 | 升级后必须保持的产品事实 |
|---|---|
| 001/006 | FIFO、无重新插入唤醒、子任务归属、冷祖先恢复、严格最终 flush |
| 002/005 | 参数在历史/权限/执行之间一致；发布前拒绝额外 Root |
| 003/004/007 | 必需事件校验、单写者、事务恢复、空增量不丢工具身份 |
| 008/009/010 | 压缩容量/修复/usage、字面量 persona 冷恢复、首选工作区指令 |
| 011/012 | Provider 内容不冒充本地工具；同路由回放；文件权限/checkpoint/CRLF/原子发布 |

## 已执行检查

- 解析上游精确 commit/tree，读取完整 GitHub 比较，并独立逐文件比较固定提交源码归档。
- rc.2 的全部 146 项 seam authority 文件 SHA-256 与项目登记一致。
- 校验全部 9 个补丁的登记 SHA-256。
- 对 rc.2 与 rc.3 隔离副本分别顺序执行 git apply --check --verbose 和应用；没有 offset 匹配，每个补丁应用后的所有目标文件字节相等。
- 对全部包清单做结构化差异检查；上游公共 exports 和非版本/依赖范围字段不变。
- 抽查实际 npm 发布包 dsh-agent-loop、dsh-session、dsh-llm-pi-ai：各自两版普通文件仅 package.json 不同，dist 实现和声明未变。
- 对当前仓库与 staged Runtime lock 检查 vendor/pi-ai 实际版本。

Git 全历史浅抓取较慢，已终止本轮自建临时抓取，改用固定 commit 的官方 codeload 归档完成比较；未修改原上游 checkout。

npm 元数据未提供 gitHead。上述抽查不建立“全部 registry tarball 来自该源码提交”的完整构建证明，registry 与源码 authority 仍分别记录。

## 补丁与制品身份

当前 core patch 数为 9；建议升级后仍为 9，补丁文件保持原字节。当前有序 patchSeries 摘要为 13b108f38d68b914a7cb553192f3eb58d7630de1f75b6f293bd3bb82f2ae823e；原样保留时有序补丁内容不变，但源码身份、包版本、构建输入和制品摘要需要重新生成。

pi-ai 0.85.1 的独立 Provider-content 补丁没有被本次上游改动替代，继续保留。升级前 Runtime 为 55ac058296091312bc8dcac8b01400ff1d680e753bc5d788192d0903b397b2ed，handoff 为 d277191cfaea10ceaac19b4977b5130ba611dbfe4d98c668684a1ff2218d583f；它们仍只证明 rc.2 基础的旧字节。这些为升级前观察点；新字节的验收不能继承它们。

## 实施与验收顺序

1. 在专门分支同步源码 baseline、所有受影响 manifest/lock、精确 blob authority 和生成 registry；不要只修改版本字符串。
2. 保持当前产品策略、协议和会话格式；本次差异没有显示需要清空开发 Session 或修改 Host UI 的依据。
3. 构建两次 patched DSH 包并比较完整字节，验证独立 consumer 与依赖闭包，尤其确认 vendor 精确约束没有造成重复 Cordis 实例。
4. 执行既有 source/seam、公有接口编译、Runtime composition、typecheck/lint/test/build 和上述 seam 回归。
5. 生成新 Runtime，完成新字节的故障/恢复/生命周期验证，生成新的不可变 handoff 并由 Host 接纳；重跑 Host 的恢复、交互、工具、会话操作与包内 smoke。
6. 原生平台和真实 Provider 证据按实际执行范围记录，旧结果不移植为新版本结果；原先 H6 未完成的验收也不因升级而关闭。

## 来源

- https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.5-rc.2...dsh-v0.1.5-rc.3
- https://github.com/deepseek-ai/deepseek-harness/commit/943af81a185ea4d70eda2b36598938857b1f851b
- https://github.com/deepseek-ai/deepseek-harness/tree/a4c74a91e06b00fe0b0937bde982170c526cc842
- https://registry.npmjs.org/@deepseek-ai%2fdsh-agent-loop
- 外部只读证据：`../MyAgents-dsh-release-work/rc3-audit-20260923/source-patch-audit.json` 与 `upstream-compare.json`
- MyAgents-dsh/.agents/skills/dsh-upstream-maintenance/SKILL.md、specs/dsh/seam-decisions-v1.json、ADR 0001–0012、构建 policy、当前 package-lock

## 源码冻结前的实施记录

- 固定上游 rc.3 commit/tree 及 146 项 blob/SHA-256 校验通过；九个补丁与 patchSeries 摘要保持不变。
- 根与工作区 manifest、registry lock、baseline、seam registry、精确版本守卫及协议/profile 投影已更新。Lock 包清单仍为 653 项，没有新增/删除包，没有非 DSH 包版本或元数据漂移；许可证计数、义务及公共编译 surface 均未变化。
- 新 77 包制品 manifest 为 `1b8993435731e12bab50095d8692a3aacad6dfaf71fadcca9133fa4b4051b165`；独立 verifier 已通过。Clean consumer 与构建内两轮打包校验通过。完整独立构建重复性结果保存在外部 `rc3-upgrade-20260923/reproducibility.json`，作为交付前必需检查。
- patched source：27 个文件，1,070 测试通过、1 项跳过；版本/制品针对性回归：4 文件、52 测试通过；TypeScript 和基础不变量检查通过。
- 协议仍为 5.0.0，44 Host / 7 reverse / 4 notification 操作不变；仅握手版本字面值导致 schema 摘要变为 `e9f32098b73b657976c1c91170662bda41bf09097c8aad9174175cd48c7c1fa4`。不新增模型路由、权限、持久化 owner 或用户数据重置。

完整 clean-source pre-artifact、packed Runtime composition、平台声明、不可变 handoff 和 Host 验收必须在源码冻结后运行。其精确 commit/摘要/结果记录在 Host 的 `specs/tech_docs/myagents_dsh_integrated_runtime.md` 及外部 `rc3-upgrade-20260923/development-receipt.json`；不在 Runtime 源码中回填自引用制品摘要。三平台完整原生验收及真实 Provider/GUI 验收仍单独标记，不能由本轮源码测试代替。九个补丁仍待上游公开语义满足各 ADR 移除条件后退役。
