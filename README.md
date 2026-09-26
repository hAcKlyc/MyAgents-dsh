# MyAgents-dsh

**基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent Runtime，为 [MyAgents](https://github.com/hAcKlyc/MyAgents) 客户端提供官方集成，也为其他应用提供可复用的 Host 接口。**

[中文](#chinese) · [English](#english) · [架构文档](./specs/ARCHITECTURE.md) · [协议文档](./specs/tech_docs/runtime/protocol.md) · [Apache-2.0 许可](./LICENSE)

<a id="chinese"></a>

## 它是什么

MyAgents-dsh 将 DSH 的 Agent 执行能力组装为一个独立进程中的 Runtime。它为桌面客户端提供完整的 Agent 能力，同时把应用自己的配置、密钥、权限交互和系统资源留在 Host 一侧。

[MyAgents 客户端](https://github.com/hAcKlyc/MyAgents)通过这套接口正式集成 MyAgents-dsh。接口本身不依赖 MyAgents 的 UI：其他桌面应用或可信 Host 也可以实现同一协议，使用相同的 Runtime。仓库还提供一个本地 Reference Web Host，展示如何在应用与 Runtime 之间建立这条边界。

## 架构

```text
MyAgents 客户端       其他 Host         Reference Web Host
      │                  │                    │
      └──────────────────┴────────────────────┘
                         │
              版本化双向 stdio JSON-RPC
                         │
                 MyAgents-dsh Runtime
                  ├─ 产品能力与执行策略
                  ├─ Host 反向接口
                  └─ DSH / Cordis
                     ├─ Session 与 AgentLoop
                     ├─ 模型、工具与扩展
                     └─ 持久化与上下文压缩
```

**DSH 负责 Agent 执行。** Session、AgentLoop、工具流水线和对话事件由 DSH 管理。MyAgents-dsh 通过 DSH/Cordis 的服务、插件与作用域加入产品能力，不另外运行一套 AgentLoop。

**Host 负责应用资源。** 模型凭证、网络代理策略、用户交互、Host 工具、Hooks 和附件通过明确的反向接口提供。Runtime 在请求所需的作用域内使用这些能力；应用仍然决定它们从哪里来、如何配置和何时释放。

**进程边界清晰。** Host 通过标准输入输出与 Runtime 通信。一个 Runtime 进程对应一个运行代际，最多承载一个活跃的主 Session；拥有多个会话的应用自行管理对应进程与恢复流程。

## 能提供什么

- **完整的 Agent 工作流：** 文件、搜索、Shell、Web 等工具，与权限确认、计划、Skills、MCP、Hooks、子 Agent、后台任务和任务图共同工作。
- **可配置的模型入口：** 保留 DSH 原生 DeepSeek 路径，也可通过 DSH 的模型适配器接入 Host 声明的 Anthropic Messages、OpenAI Chat Completions 与 OpenAI Responses 路由。
- **持久会话：** DSH 保存对话事件；Runtime 提供会话读取、恢复、取消、分叉、回退及受管理文件修改的检查点能力。
- **统一的执行策略：** 工具经过同一条 DSH 执行流水线，并在实际执行时校验工作区、权限和当前操作状态。构建时可选择产品工具定义或 DSH 原生定义，Host 对接边界保持一致。
- **可验证的交付：** Runtime、协议、兼容声明和平台证据可以一起打包、校验并由 Host 固定到具体版本。

具体能力以所选版本的[兼容声明](./specs/tech_docs/assurance/compatibility-and-capability-truth.md)和协议协商结果为准。

## 在其他应用中集成

公开接口是[版本化的双向协议](./specs/tech_docs/runtime/protocol.md)：Host 启动 Runtime 进程，完成初始化与能力协商，创建或恢复 Session，然后发起 Turn、接收事件并处理 Runtime 的反向请求。仓库提供协议 Schema、生成的 TypeScript Host 客户端和 [Reference Web Host](./specs/tech_docs/hosts/reference-web-host.md) 实现，可作为接入起点。

| Host 提供 | Runtime 提供 |
| --- | --- |
| 进程管理、应用 UI、工作区与会话路由 | DSH AgentLoop、工具执行与会话事件 |
| 模型配置、凭证和网络策略 | 模型调用与上下文管理 |
| 权限交互、Host 工具、Hooks、附件 | 工具策略、扩展协调和结果投影 |
| 版本选择与交付校验 | 协议协商、运行状态和能力声明 |

这套接口独立于 DSH 官方 SDK 协议。第三方目前通过原生协议及生成客户端接入；本仓库尚未提供可直接安装的独立 Agent SDK。需要自定义 Runtime 插件时，由可信的构建方在组装阶段安装，普通 Host 请求只传递声明式配置。

## 进一步了解

- [整体架构](./specs/ARCHITECTURE.md)：所有权、进程边界与数据流。
- [协议与生命周期](./specs/tech_docs/runtime/protocol.md)：接入方法、事件及版本协商。
- [Host 反向接口](./specs/tech_docs/boundaries/host-reverse-ports.md)：凭证、交互、工具、Hooks 与附件。
- [工具与执行策略](./specs/tech_docs/execution/tool-runtime-and-policy.md)：模型可见工具及执行约束。
- [交付与验证](./specs/tech_docs/assurance/verification-artifacts-and-handoff.md)：版本绑定、构建产物和校验。
- [项目文档索引](./specs/README.md)：产品需求、设计决策与模块文档。

## 开源许可

MyAgents-dsh 自有代码采用 [Apache License 2.0](./LICENSE)。所依赖的 DeepSeek Harness 采用 [MIT License](./specs/dsh/UPSTREAM_LICENSE)；其他依赖及发行产物中的第三方内容保留各自的许可和声明。MyAgents 客户端是独立仓库，适用其自己的许可证。

<a id="english"></a>

## English

**MyAgents-dsh is a DeepSeek Harness based Agent Runtime. It is officially integrated into the [MyAgents desktop client](https://github.com/hAcKlyc/MyAgents) and exposes the same versioned interface to other trusted Hosts.**

DSH owns the AgentLoop, Session events, tool pipeline, model execution, and compaction. MyAgents-dsh composes product capabilities as DSH/Cordis services and plugins. The application Host retains ownership of credentials, network policy, user interactions, Host tools, Hooks, attachments, and process lifecycle.

Hosts communicate with the Runtime over bidirectional stdio JSON-RPC. The repository provides the [protocol](./specs/tech_docs/runtime/protocol.md), generated TypeScript Host client and Schema, plus a [Reference Web Host](./specs/tech_docs/hosts/reference-web-host.md). One Runtime process admits at most one active primary Session; a Host manages multiple Sessions as separate Runtime processes. The native protocol is independent of the upstream DSH SDK protocol. A separately installable Agent SDK is not currently provided.

The distribution adds governed coding and Web tools, permissions and interactions, MCP, Skills, Hooks, child and background work, durable Session operations, and verifiable versioned artifacts. Exact availability is determined by the selected artifact's compatibility manifest and negotiated capabilities.

See the [architecture](./specs/ARCHITECTURE.md), [Host reverse ports](./specs/tech_docs/boundaries/host-reverse-ports.md), [tool policy](./specs/tech_docs/execution/tool-runtime-and-policy.md), and [delivery model](./specs/tech_docs/assurance/verification-artifacts-and-handoff.md) for the implementation boundaries.

Original MyAgents-dsh code is licensed under [Apache-2.0](./LICENSE). DeepSeek Harness retains its [MIT license](./specs/dsh/UPSTREAM_LICENSE), and other third-party components retain their respective licenses. The MyAgents desktop client is licensed separately.
