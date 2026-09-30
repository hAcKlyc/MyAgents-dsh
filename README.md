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

### Agent 工具清单

当前构建使用 `dsh_first`。下表列出基础模型可见工具的**实际名称**；`bash` 与 `pwsh` 按平台二选一，因此每个平台通常可见 26 项。MCP、Host 和组件工具由对应配置动态加入，不在这份固定清单内。

| 工具 | 能力 | 备注 |
| --- | --- | --- |
| `read` | 读取文本文件 | DSH 原生定义；由 MyAgents 接入工作区与权限策略 |
| `read_image` | 读取图片 | DSH 原生定义；需模型支持图片 |
| `write` | 写入文件 | DSH 原生定义；由 MyAgents 接入权限与检查点 |
| `edit` | 编辑文件 | DSH 原生定义；由 MyAgents 接入权限与检查点 |
| `glob` | 按路径模式找文件 | DSH 原生定义 |
| `grep` | 搜索文件内容 | DSH 原生定义 |
| `web_fetch` | 获取网页内容 | DSH 原生定义；网络后端和策略由 Host 配置 |
| `web_search` | 搜索网页 | DSH 原生定义；搜索后端由 Host 配置 |
| `bash` | 执行 Shell 命令 | DSH 原生定义；MyAgents 接入进程和权限策略；macOS、Linux 可见 |
| `pwsh` | 执行 PowerShell 命令 | DSH 原生定义；MyAgents 接入进程和权限策略；Windows 可见 |
| `job_output` | 读取后台任务输出 | DSH 原生定义；MyAgents 接入后台任务管理 |
| `job_list` | 列出后台任务 | DSH 原生定义；MyAgents 接入后台任务管理 |
| `job_kill` | 停止后台任务 | DSH 原生定义；MyAgents 接入后台任务管理 |
| `ls` | 列出工作区目录 | MyAgents 提供 |
| `AskUserQuestion` | 向用户提问 | MyAgents 提供，交互由 Host 承接 |
| `EnterPlanMode` | 进入计划模式 | MyAgents 提供 |
| `ExitPlanMode` | 结束计划模式 | MyAgents 提供；未启用 DSH 的 `exit_plan_mode` |
| `Skill` | 调用已配置的技能 | MyAgents 提供 |
| `subagent` | 新建独立子 Agent | DSH 原生定义与生命周期；MyAgents 接入 Host 权限 |
| `fork_agent` | 继承已完成用户回合的历史创建子 Agent | DSH 原生定义与生命周期；MyAgents 接入 Host 权限 |
| `send_message` | 给可延续子 Agent 发消息 | DSH 原生定义与投递 |
| `interrupt_agent` | 中断子 Agent 当前轮次 | DSH 原生定义；不会关闭整棵子树 |
| `list_agents` | 列出子 Agent | 通过 DSH 原生目录能力提供 |
| `TaskCreate` | 在个人或共享列表创建任务 | MyAgents 提供；默认个人列表 |
| `TaskGet` | 查询可见任务 | MyAgents 提供 |
| `TaskList` | 列出个人或可见的共享任务 | MyAgents 提供 |
| `TaskUpdate` | 更新进度、依赖、负责人或开放对象 | MyAgents 提供 |

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

- [开发环境与本地集成](./specs/tech_docs/assurance/development-and-local-integration.md)：新电脑初始化、生成本机 handoff，并用它构建 MyAgents 开发版。
- [整体架构](./specs/ARCHITECTURE.md)：所有权、进程边界与数据流。
- [协议与生命周期](./specs/tech_docs/runtime/protocol.md)：接入方法、事件及版本协商。
- [Host 反向接口](./specs/tech_docs/boundaries/host-reverse-ports.md)：凭证、交互、工具、Hooks 与附件。
- [工具与执行策略](./specs/tech_docs/execution/tool-runtime-and-policy.md)：模型可见工具及执行约束。
- [交付与验证](./specs/tech_docs/assurance/verification-artifacts-and-handoff.md)：版本绑定、构建产物和校验。
- [项目文档索引](./specs/README.md)：架构、设计决策与模块文档。

## 开源许可

MyAgents-dsh 自有代码采用 [Apache License 2.0](./LICENSE)。所依赖的 DeepSeek Harness 采用 [MIT License](./specs/dsh/UPSTREAM_LICENSE)；其他依赖及发行产物中的第三方内容保留各自的许可和声明。MyAgents 客户端是独立仓库，适用其自己的许可证。

<a id="english"></a>

## English

**An Agent Runtime built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), officially integrated into the [MyAgents](https://github.com/hAcKlyc/MyAgents) desktop client and offering a reusable Host interface for other applications.**

### What it is

MyAgents-dsh assembles DSH's Agent execution capabilities into a Runtime that runs in its own process. It gives desktop clients a complete Agent experience while keeping application configuration, credentials, permission interactions, and system resources on the Host side.

The [MyAgents desktop client](https://github.com/hAcKlyc/MyAgents) officially integrates MyAgents-dsh through this interface. The interface does not depend on the MyAgents UI: other desktop applications or trusted Hosts can implement the same protocol and use the same Runtime. This repository also provides a local Reference Web Host that demonstrates the boundary between an application and the Runtime.

### Architecture

```text
MyAgents client        Other Hosts        Reference Web Host
       │                   │                     │
       └───────────────────┴─────────────────────┘
                           │
            Versioned bidirectional stdio JSON-RPC
                           │
                  MyAgents-dsh Runtime
                   ├─ Product capabilities and execution policy
                   ├─ Host reverse ports
                   └─ DSH / Cordis
                      ├─ Session and AgentLoop
                      ├─ Models, tools, and extensions
                      └─ Persistence and compaction
```

**DSH owns Agent execution.** DSH manages Sessions, the AgentLoop, the tool pipeline, and conversation events. MyAgents-dsh adds product capabilities through DSH/Cordis services, plugins, and scopes. It does not run a second AgentLoop.

**The Host owns application resources.** Model credentials, network proxy policy, user interactions, Host tools, Hooks, and attachments are supplied through explicit reverse ports. The Runtime uses these capabilities within the scope of the request that needs them; the application decides where they come from, how they are configured, and when they are released.

**The process boundary is explicit.** The Host communicates with the Runtime over standard input and output. One Runtime process represents one generation and admits at most one active primary Session. An application with multiple Sessions manages their processes and recovery.

### What it provides

- **A complete Agent workflow:** File, search, Shell, and Web tools work with permission approvals, plans, Skills, MCP, Hooks, child Agents, background work, and a task graph.
- **Configurable model routes:** The native DSH DeepSeek route remains available. DSH model adapters can also handle Host-declared Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses routes.
- **Durable Sessions:** DSH stores conversation events. The Runtime provides Session reads, recovery, cancellation, forks, rewinds, and checkpoints for governed file changes.
- **One execution policy:** Tools run through the same DSH pipeline and recheck workspace, permission, and current operation state at execution time. The build can select product tool definitions or native DSH definitions while keeping the Host interface consistent.
- **Verifiable delivery:** The Runtime, protocol, compatibility declaration, and platform evidence can be packaged and verified together, then pinned to an exact version by the Host.

#### Agent tool catalog

The current build uses `dsh_first`. The table lists the **actual names** in the base model-visible catalog. A platform exposes either `bash` or `pwsh`, so it normally has 26 effective tools. MCP, Host, and component tools are added dynamically by their configuration and are outside this fixed catalog.

| Tool | Capability | Source note |
| --- | --- | --- |
| `read` | Read text files | Native DSH definition; MyAgents supplies workspace and permission policy |
| `read_image` | Read images | Native DSH definition; requires an image-capable model |
| `write` | Write files | Native DSH definition; MyAgents supplies permissions and checkpoints |
| `edit` | Edit files | Native DSH definition; MyAgents supplies permissions and checkpoints |
| `glob` | Find files by path pattern | Native DSH definition |
| `grep` | Search file contents | Native DSH definition |
| `web_fetch` | Fetch web content | Native DSH definition; the Host configures the network backend and policy |
| `web_search` | Search the web | Native DSH definition; the Host configures the search backend |
| `bash` | Run Shell commands | Native DSH definition; MyAgents supplies process and permission policy; visible on macOS and Linux |
| `pwsh` | Run PowerShell commands | Native DSH definition; MyAgents supplies process and permission policy; visible on Windows |
| `job_output` | Read background job output | Native DSH definition; MyAgents integrates background job management |
| `job_list` | List background jobs | Native DSH definition; MyAgents integrates background job management |
| `job_kill` | Stop background jobs | Native DSH definition; MyAgents integrates background job management |
| `ls` | List workspace directories | Provided by MyAgents |
| `AskUserQuestion` | Ask the user a question | Provided by MyAgents; the Host handles the interaction |
| `EnterPlanMode` | Enter plan mode | Provided by MyAgents |
| `ExitPlanMode` | Leave plan mode | Provided by MyAgents; DSH `exit_plan_mode` is not installed |
| `Skill` | Invoke a configured Skill | Provided by MyAgents |
| `subagent` | Start a fresh child Agent | Native DSH definition and lifecycle; MyAgents connects Host permissions |
| `fork_agent` | Start a child inheriting completed user-turn history | Native DSH definition and lifecycle; MyAgents connects Host permissions |
| `send_message` | Message a continuable child Agent | Native DSH definition and delivery |
| `interrupt_agent` | Interrupt a child's current turn | Native DSH definition; does not close a subtree |
| `list_agents` | List child Agents | Exposed through DSH's native catalog |
| `TaskCreate` | Create a personal or shared task | Provided by MyAgents; personal by default |
| `TaskGet` | Read an accessible task | Provided by MyAgents |
| `TaskList` | List personal or accessible shared tasks | Provided by MyAgents |
| `TaskUpdate` | Update progress, dependencies, owner, or recipients | Provided by MyAgents |

Exact capabilities depend on the selected version's [compatibility declaration](./specs/tech_docs/assurance/compatibility-and-capability-truth.md) and the negotiated protocol capabilities.

### Integrating another application

The public interface is a [versioned bidirectional protocol](./specs/tech_docs/runtime/protocol.md): the Host starts a Runtime process, initializes it and negotiates capabilities, creates or resumes a Session, starts Turns, receives events, and handles reverse requests from the Runtime. The repository provides a protocol Schema, a generated TypeScript Host client, and a [Reference Web Host](./specs/tech_docs/hosts/reference-web-host.md) implementation as integration starting points.

| Host provides | Runtime provides |
| --- | --- |
| Process management, application UI, workspace and Session routing | DSH AgentLoop, tool execution, and Session events |
| Model configuration, credentials, and network policy | Model calls and context management |
| Permission interactions, Host tools, Hooks, and attachments | Tool policy, extension coordination, and result projection |
| Version selection and delivery verification | Protocol negotiation, runtime status, and capability declarations |

This interface is independent of the official DSH SDK protocol. Third parties currently integrate through the native protocol and generated client; this repository does not yet offer a separately installable Agent SDK. Custom Runtime plugins are installed by trusted builders at composition time. Ordinary Host requests carry declarative configuration only.

### Learn more

- [Development setup and local integration](./specs/tech_docs/assurance/development-and-local-integration.md): Prepare a new machine, build a native handoff, and package a MyAgents Dev build with it.
- [Architecture](./specs/ARCHITECTURE.md): Ownership, process boundaries, and data flow.
- [Protocol and lifecycle](./specs/tech_docs/runtime/protocol.md): Integration methods, events, and version negotiation.
- [Host reverse ports](./specs/tech_docs/boundaries/host-reverse-ports.md): Credentials, interactions, tools, Hooks, and attachments.
- [Tools and execution policy](./specs/tech_docs/execution/tool-runtime-and-policy.md): Model-visible tools and execution constraints.
- [Delivery and verification](./specs/tech_docs/assurance/verification-artifacts-and-handoff.md): Version binding, artifacts, and verification.
- [Documentation index](./specs/README.md): Architecture, design decisions, and module documentation.

### Open-source license

Original MyAgents-dsh code is licensed under [Apache-2.0](./LICENSE). DeepSeek Harness retains its [MIT license](./specs/dsh/UPSTREAM_LICENSE), and other third-party components retain their respective licenses. The MyAgents desktop client is licensed separately.
