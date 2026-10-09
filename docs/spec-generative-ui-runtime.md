# QAQH Generative UI Runtime Spec

版本：0.1 · 日期：2026-10-09 · 状态：架构与选型草案，尚未实施。

范围：**先在当前 Tauri + SolidJS 2 客户端交付完整的受限生成式界面能力，再将经过验证的 IR、Catalog 和行为契约标准化并分发给其他客户端。**

本文件是技术方案，不表示依赖已安装、fork 已建立、兼容性已验证或功能已上线。本轮只新增文档，不修改应用代码、生成绑定、前端框架或手机仓库。

## 1. 产品目标与关键裁决

### 1.1 目标

模型在正常 assistant 回复中组织 Markdown、布局、卡片、表单、图表和交互内容。客户端逐步呈现，并能在本地处理输入、筛选、切换、计算和状态恢复。外部操作仍由受控执行层处理。

**界面呈现不是模型工具调用。** 模型通过受信提示词注入或版本化 skill 学习输出格式；客户端将输出编译为受限 UI 描述，而不是注册 `ui.render` 工具来执行模型代码。

### 1.2 决策表

| ID | 裁决 |
| --- | --- |
| D01 | 首个交付对象是当前 Solid 2 RC + Tauri，不以同时完成手机、XAML、TUI 为前置条件。 |
| D02 | 模型主编写语言是 TSX 风格的受限 DSL；同时提供等价 JSONL IR 输入，用于验证、回放和不擅长 DSL 的模型。 |
| D03 | 两种输入汇聚到同一个版本化 QAQH UI IR。完整 TypeScript、React/Solid 代码、HTML 文档都不是运行协议。 |
| D04 | 首阶段编译器可在桌面 TypeScript 层运行，消费现有 assistant text；后续移到 daemon 或共享 Core，不改变 IR 语义。 |
| D05 | UI 混合内容分段位于 Markdown 之前。Markdown 与 Solid UI 子树拥有不同 DOM 容器。 |
| D06 | 不创建用于呈现界面的模型工具，不以 tool-call arguments 承载整份 UI，不引入第二条工具执行通道。 |
| D07 | 本地动作、宿主受限动作、Ringing 工具动作、明确的模型续答分别建模。 |
| D08 | 模型描述不能获得 `invoke`、RPC、文件、进程、网络、审批或配置权限。 |
| D09 | 优秀库优先：直接复用 → 小范围 Solid 2 fork/适配 → 自行实现。Solid 1.x 依赖范围不是放弃优秀库的充分理由。 |
| D10 | 优先评选 json-render 的 Core/目录生成与 Solid Renderer；允许 fork Solid 适配包，不迁移 QAQH 框架。 |
| D11 | Headless 控件首选评估 Ark UI + Zag 的 Solid 适配；Kobalte 为正式备选。未通过验证前不得宣称 Solid 2 兼容。 |
| D12 | 图表首选 Apache ECharts 的框架无关 API，由 QAQH 写薄适配层；不要求第三方 Solid wrapper。 |
| D12a | 数据表首选评估 TanStack Table Core 的框架无关行模型；Solid adapter 未通过时写薄桥接，不重写整套排序/筛选/分页。 |
| D13 | 受信 Catalog 同源生成运行校验、模型提示、组件文档和契约样本；注入提示不是权限授予。 |
| D14 | 现有 timeline 仍是正文唯一权威来源；桌面解析出的 UI 是该正文的派生视图，不是第二份 transcript。 |
| D15 | 标准化前保留稳定身份、版本、语义组件、纯表达式和 fallback，避免把 DOM/CSS 或第三方库内部格式固化为标准。 |

### 1.3 非目标

- 不声称复制 ChatGPT Intelligent UI 的内部实现；`DIL`、`GenUI` 等模型自述接口不作为本协议依据。
- 不迁移到 React、Vue、Flutter 或 WebView 手机前端。
- 不执行模型任意 JS；不提供 eval、Function、动态 import、npm 安装或模型自定义组件代码。
- 首版不承诺任意游戏、任意动画脚本、3D、在线地图服务、第三方 HTML 应用或无限计算能力。
- 不为本功能替换 Ringing v2、审批体系或既有 session 生命周期。
- 本轮不实际安装包、建立 fork、创建发布包或部署；后续实施按本文里程碑推进。

## 2. 当前仓库与多端基线

| 事实 | 当前来源 | 接入影响 |
| --- | --- | --- |
| Solid 2 RC | `package.json`：`solid-js`、`@solidjs/web` 均为 `2.0.0-rc.13`；`@solidjs/vite-plugin` 为 next 版本 | 依赖支持 Solid 不等于支持当前运行时；旧版预编译 JSX 也要审计。 |
| 正文事件 | `src/api/qaqh/TimelineEntry.ts`、`TimelineEvent.ts`、`TimelineBlock.ts` | 块、增量、checkpoint、快照已有；尚无原生 UI 块。 |
| TS 绑定生成 | `src/api/qaqh/*.ts` 为后端 ts-rs 生成物 | 标准化阶段从后端权威类型生成，禁止手改绑定。 |
| 流式 Store | `src/session/store.ts` | consumedSeq、水位、顺序屏障、rAF 与后台兜底继续保留。 |
| 消息呈现 | `src/turn/TurnView.tsx`、`src/turn/segments.ts` | 首阶段在 text segment 内新增 ContentParts；以后增加真正 UI segment。 |
| Markdown | `src/markdown/Markdown.tsx`、`render.ts`、`patch.ts` | 不放宽净化，不把 Solid 子树插入 Markdown patch 范围。 |
| 宿主边界 | `src/lib/transport/tauri.ts`、`src-tauri/src/commands.rs` | 当前无通用 ToolInvoke IPC；完成外部动作必须补受控入口。 |
| 工具执行 | 后端 `ToolCommand::ToolInvoke`、`handle_ui_tool_call`、`ToolRuntime` | 可复用准入和执行；独立工具回合与 Surface 的关联需补齐。 |
| Android | `E:/qaqh-android`：Kotlin/Compose、timeline 模型与 BlockItem | 后续实现 IR Runtime 与原生组件映射，不要求运行 TS 源码。 |
| Harmony | `E:/qaqh-harmony`：ArkTS/ArkUI、protocol/client/view 分层 | 后续增加 IR 协议与节点 VM；ArkTS 不等于完整 TS/TSX 运行环境。 |

已有未提交代码按当前工作树审阅；本文不覆盖或改写它们。视觉沿用 [ui-visual-spec.md](ui-visual-spec.md) 的最新修订，Markdown 沿用 [markdown-typography.md](markdown-typography.md)，性能基线见 [streaming-performance.md](streaming-performance.md)。

## 3. “Tauri 完整能力”的交付定义

这里的完整能力指 **Desktop Profile 0.1** 全部通过验收，不指未知的 OpenAI 全量组件集合。

| 能力域 | Desktop Profile 0.1 必须支持 |
| --- | --- |
| 内容混合 | 同一 assistant text 块内 Markdown → 多个 UI Surface → Markdown；多轮中途回复与最终回复均可。 |
| 布局/展示 | Stack、Row、Grid、Card、Divider、Text、Title、Badge、Metric、Alert、Progress、Skeleton。 |
| 交互结构 | Button、Link、Tabs、SegmentedControl、Disclosure、List、受限 Repeat。 |
| 输入/表单 | TextInput、TextArea、NumberInput、Select、RadioGroup、Checkbox、Switch、Slider、DateInput、Form；验证、dirty、错误提示和提交。 |
| 数据呈现 | Table：分页、排序、筛选、选择；CodeBlock；LineChart、BarChart、AreaChart、ScatterChart、PieChart。 |
| 资源 | Image 使用宿主提供的资源引用与可访问替代文本，不任意加载远程地址。 |
| 本地行为 | 状态读写/重置、条件显示、派生计算、列表过滤/排序/汇总、图表与表单联动。 |
| 外部行为 | 明确的模型续答、受限外链/复制、已准入 Ringing 工具动作及结果回写；不把 accepted ACK 当成功。 |
| 生命周期 | 流式渐进呈现、生成中可用的本地交互、中断、checkpoint、切会话、历史淘汰、状态恢复、资源释放。 |
| 体验 | 深浅主题、缩放、窄窗口、键盘、中文 IME、无障碍、减少动态效果、纯文本 fallback。 |

DateInput 可使用原生日期控件；DatePicker 日历弹层为扩展控件，不因库缺失擅自手写复杂日历。在线地图、Video、Canvas simulation、Diagram 为后续扩展，不列入本版完成声明。

## 4. 分层架构与阶段边界

```text
受信 Generation Contract / Catalog 摘要 / Skill
                      ↓
模型正常 assistant 回复：Markdown + 显式 UI 围栏
                      ↓ 既有 timeline / text_delta / checkpoint
ContentDecoder：MarkdownPart / UiSourcePart
                      ↓
DSL Compiler 或 JSONL Decoder → 校验后的 QAQH UI IR 更新
                      ↓
SurfaceStore + State/Expression/Action Runtime
                      ↓
QAQH Adapter → json-render Solid 2 fork / 自有薄 Renderer
                      ↓
QAQH 控件 → Ark UI/Zag Solid 2 fork 或 Kobalte / 原生控件
                      ↓
图表适配 → ECharts；Markdown → 既有 Markdown

用户事件 → Local Runtime
         → 受限 Host Action
         → Action Gateway → Rust → Ringing v2 → 工具准入/审批/执行
         → 明确 Model Action → 普通 conversation 输入
```

桌面阶段原始 assistant text 是持久化真相。IR、渲染缓存和本地草稿分别管理；不把 model source 作为脚本执行。标准阶段让 daemon 产生有序 UI 内容块和快照，桌面仍消费相同 IR。

Rust 层不必首日拥有完整 DSL 编译器，但外部动作的类型、策略、作用域和权限验证必须由宿主/后端执行，不能只靠前端编译成功。

## 5. 模型交付契约：正常回复，不是工具

### 5.1 Generation Contract

开启 GenUI 时，受信运行层向本次生成提供：

- `profileId`、DSL/IR/Catalog 版本与内容 hash；
- 本次允许的组件、props、表达式、事件与动作类别；
- 能力和资源预算、语言/时区/无障碍要求；
- 当前可用的受控动作别名和输入 schema，不含 token/lease/内部审批 ID；
- 普通 Markdown、UI 围栏、fallback、不得执行代码等输出规则。

这些字段来自客户端/daemon，不接受模型自己输出一份同名对象来开启权限。未开启的会话按普通文本处理；只有直接 assistant 回答正文可被解析为 UI，不解析 reasoning、工具 stdout、diff、用户输入或引用附件。

### 5.2 注入与 Skill

推荐两级：小型、常驻的协议提示 + 按需加载的详细编写 skill。小型提示保证基本编码可用；skill 提供组件说明和完整配方。不能只依赖模型碰巧激活 skill。

Catalog 同源生成：运行校验 schema、DSL intrinsics 声明、组件 props/事件说明、模型提示、配方与契约样本。外部动作描述经策略过滤后追加；描述不是准入凭证。

不注册 `ui.render` / `ui.patch` 为模型工具。DSL 中的 `ui.node(...)` 是被解析的文字语法，不是函数执行或 Tool Call。SDK 的 tool-calling 示例、AI Gateway 或 Experimental composer 不属于必要依赖。

skill 包的后续结构建议：`SKILL.md`、`catalog.md`、`recipes/`、`failure-and-fallback.md`。本文件附录给出提示词契约草案，不安装或激活未实现的 skill。

## 6. 正文 Framing 与混合内容

### 6.1 编码

顶层独立行的围栏 info string 必须为以下一种：

- `qaqh-ui v=0.1 format=tsx`
- `qaqh-ui v=0.1 format=jsonl`

围栏按 Markdown 的 backtick/tilde 长度配对规则处理。只有顶层、非引用、非缩进代码的显式 UI 围栏有语义；普通 `tsx` / `json` 围栏仍是代码。展示语法本身时必须使用普通代码围栏或更长的外层围栏，不能误触发编译。

一个围栏对应一个 Surface。`ui.surface` / `surface.open` 必须第一条，`ui.end` / `surface.seal` 必须最后一条。一个消息内 Surface ID 不重复；不同消息经 source namespace 隔离。

模型在 UI 外保留必要说明及有意义的文本 fallback。旧客户端阶段可能把 UI 源码显示成代码；不宣称现有手机端已能隐藏围栏或渲染 UI。标准阶段由能力协商提供真正的文本降级。

### 6.2 分段要求

- ContentDecoder 在 Markdown 前运行，生成稳定的 ContentPart 列表；不从已经净化的 HTML 再取出 UI。
- MarkdownPart 的完成边界与 UiSourcePart 的源码边界独立，不能以 CSS 或正则替换 HTML“变出组件”。
- 高速 append 只处理新后缀；可能的围栏前缀先缓冲有限长度，不能先绘为 Markdown 再销毁。
- 同一源码围栏的普通增量不重挂 Surface；非前缀 checkpoint 从源重编译并校正 IR，保留兼容的 local 状态。
- 复制回答默认复制正常文本与 fallback；“查看/复制 UI 源码”是显式次级操作。
- 摘要/hover excerpt 从 ContentParts 派生，不把 DSL 源码当最终答案摘要。

## 7. TSX 风格 DSL 0.1

### 7.1 语义：解析而非执行

允许源码是一组按顺序完成的语句。`ui.*` 是 compiler intrinsics；解析后直接降低到 IR，不调用对应的 JavaScript 函数，也不转译成可执行 JSX。

| Intrinsic | 语义 |
| --- | --- |
| `ui.surface(id, { root, title?, fallback })` | 开 Surface，声明根节点；根节点到达后可显示。 |
| `const x = ui.state(key, type, initial)` | 定义 local 状态，符号 x 降低为状态读取。 |
| `const x = ui.data(key, value)` | 定义文档数据；后续在明确的更新记录中修改。 |
| `const x = ui.derive(key, expression)` | 定义纯派生值，检查引用与依赖环。 |
| `ui.node(id, <Component ... />)` | 创建/更新一个语义节点；同 ID 保持控件身份。 |
| `ui.append(key, rows)` | 追加有界 data 数组；不重复复制整个数据集。 |
| `ui.set(key, expression)` / `ui.reset()` | local Action 描述，仅在用户事件事务中求值。 |
| `ui.request(alias, payload)` | 受控外部 Action 提案，不是执行。 |
| `ui.followUp(prompt, fields?)` | 明确的模型续答描述，不伪装成 system 输入。 |
| `ui.copy(expression)` / `ui.openLink(expression)` | 宿主限制的用户触发动作。 |
| `ui.remove(id)` | 移除节点及其挂载；不得残留事件监听/图表实例。 |
| `ui.end()` | 校验引用、根树与动作；标记生成完成。 |

`type` 首版为 string、number、integer、boolean，以及由 Catalog 定义的有界数组/对象类型。声明允许引用此前的声明；派生引用不能循环。UI children 可前向引用尚未到达的节点，期间显示有限占位，未解析引用不得产生可执行外部动作。

Component 只接受注册属性与事件。布局 children 为稳定 ID 列表或受限 Repeat 模板；首版不要求解析任意嵌套 TSX module。首版事件使用 `onPress`、`onChange`、`onSubmit` 等 Catalog 名称，其值为 Action 描述；不接受任意箭头函数体。

### 7.2 计数器完整配方

以下是编写源示例，不是可直接 import 的 Solid 组件：

```tsx
ui.surface("counter", { root: "card", fallback: "计数器，初始值为 0，可增加或重置。" });
const count = ui.state("count", "integer", 0);
ui.node("card", <Card title="计数器" children={["value", "increment", "reset"]} />);
ui.node("value", <Metric label="当前计数" value={count} />);
ui.node("increment", <Button label="增加" onPress={ui.set("count", count + 1)} />);
ui.node("reset", <Button label="重置" onPress={ui.set("count", 0)} />);
ui.end();
```

Card 与已到达的子节点可先出现；无需等待后续 Markdown 或整条模型回复结束。count 在点击时读当前 local 值，不能捕获生成时的 0。重复点击按 Surface 内事件队列串行事务处理。

### 7.3 明确禁止

- import/export、任意函数/类、new、this、Promise、async/await、循环、递归、generator、动态属性调用；
- eval、Function、fetch、XHR、WebSocket、DOM/window/document/globalThis、文件/进程 API；
- JSX spread、任意 HTML 标签、dangerouslySetInnerHTML、原始 CSS、脚本字符串、动态组件 URL；
- 用户提供的 `.map()` / `.filter()` 回调；使用注册的 Repeat 和纯集合操作替代；
- 通过 typescript 类型断言、any 或 parser errorRecovery 绕过语义校验。

即使通用 parser 能解析这些节点，QAQH compiler 也必须拒绝。表达式允许有限字面量、读取、数值/比较/逻辑/条件操作和注册纯操作；不继承 JS 隐式类型转换。受限箭头函数将来可以作为语法糖，但必须编译成同样的 Action IR。

## 8. 平台无关 UI IR 与 JSONL

### 8.1 Surface snapshot

规范字段：`irVersion`、`catalogVersion`、`profileId`、`surfaceId`、`revision`、`rootId`、`nodes`、`data`、`localStateSpec`、`derived`、`actions`、`fallback`、`generationState`。执行凭证不进入模型产物或可移植 snapshot。

Node 为类型区分联合：`type`、受约束 `props`、children/slots、visibility、事件绑定；绑定与表达式不能以任意字符串 JS 表达。类型定义必须关闭未知属性，拓扑检查单独执行。

Source AST 与第三方 json-render Spec 都不是 wire 标准。QAQH Adapter 负责将自己的 IR 降低到选定 Renderer 可消费的形状；不把第三方 `$computed` 函数、watcher 副作用或内部 Store 对象直接暴露给模型。

### 8.2 逻辑更新操作

| op | 行为 |
| --- | --- |
| surface.open | 建立 Surface namespace 和元数据。 |
| state.define / derived.define | 定义状态 schema/初值或纯派生式。 |
| node.upsert / node.remove | 更新节点；节点 type 变化按显式替换处理。 |
| data.replace / data.append | 文档数据更新，不覆盖用户 local 草稿。 |
| surface.checkpoint | 原子替换文档 IR；local 与 Execution 独立协调。 |
| surface.seal | 完成生成校验；后续工具结果更新使用独立文档 revision。 |
| surface.cancel | 生成中断；保留已验证内容并关闭不完整操作。 |

JSONL 模式每行必须是完整 JSON 对象。以下是与计数器等价的简化流，未提供外部执行能力：

```jsonl
{"op":"surface.open","surface":"counter","root":"card","fallback":"计数器，初始值为 0，可增加。"}
{"op":"state.define","surface":"counter","key":"count","type":"integer","initial":0}
{"op":"node.upsert","surface":"counter","id":"card","node":{"type":"Card","props":{"title":"计数器"},"children":["value","increment"]}}
{"op":"node.upsert","surface":"counter","id":"value","node":{"type":"Metric","props":{"label":"当前计数","value":{"op":"state.read","key":"count"}}}}
{"op":"node.upsert","surface":"counter","id":"increment","node":{"type":"Button","props":{"label":"增加"},"on":{"press":{"kind":"local","op":"state.set","key":"count","value":{"op":"add","args":[{"op":"state.read","key":"count"},{"op":"literal","value":1}]}}}}}
{"op":"surface.seal","surface":"counter"}
```

标准化前 JSONL 是上述逻辑操作的输入表示；compiler/decoder 为已验证操作分配 revision，不能相信模型自报的执行序号。标准化后后端赋 timeline 序号和权威 revision。

### 8.3 表达式

基础读取：literal、state.read、data.read、derived.read、item.read、event.read。基础运算：add/subtract/multiply/divide、比较、and/or/not、条件、注册的 format 操作。有界集合操作：filter/sort/sum/count/groupBy，谓词为 Expr IR，不是 JS callback。

数值采用有限 number；integer 必须为安全整数。禁止 NaN/Infinity；除零或类型不匹配返回具名 evaluation error，显示局部错误而不触发工具。金额/高精度计算将来使用明确 decimal 类型；不能声称普通 JS number 已满足该类精度要求。日期用明确 ISO 值和受信时区，不解析模糊自然语言日期。

字符串拼接、排序 locale、null/缺失值、舍入等必须在契约样本中固定。路径只能读取 Surface 的四个状态域，不访问原型链；拒绝 `__proto__`、`prototype`、`constructor` 等危险路径片段。

## 9. 流式编译与恢复

### 9.1 提交单位

- TSX 模式：词法扫描器识别完成的顶层语句，处理字符串、转义、注释、括号、模板限制和 JSX 边界；不能简单按换行/分号 split。
- JSONL 模式：缓冲至完整行，严格 JSON parse，再进行 schema/语义校验。
- 原子提交单位是一个合法操作或显式操作事务，不修复半截代码来创造可执行节点。
- 通用 parser 的 errorRecovery 只帮助诊断，存在恢复错误的单元不能提交；缺结尾/引用未齐不能伪造 seal。
- 节点、声明和数据均有已消费/已应用位置。取消后旧异步解析结果不能回写新 Surface。

### 9.2 调度

沿用 Store rAF/后台兜底，但 UI 操作保持完整顺序。创建、删除、checkpoint、seal 是屏障；文本拼接的 pendingFragments 不能直接复用于所有 UI 操作。同帧只批量通知一次，并按节点/属性订阅，不能全量重建消息列表。

local 事件与模型更新进入同一个 Surface 顺序协调器，但写入不同状态域。图表更新按帧合并，不对每个 token dispose/init。隐藏/卸载暂停绘制，仍按契约维护必要数据。

### 9.3 交互可用性

状态声明、节点、绑定和 local action 完整后，本地交互可以在 building 阶段启用。外部/模型续答 action 至少等待对应 Surface seal 和宿主准入；无需等待整条 assistant 回复结束。生成过程不得修改已被用户确认的外部操作含义。

### 9.4 Checkpoint/历史

桌面首阶段：累计 source checkpoint 非前缀变化时重编译文档；相同语义 ID 的节点和兼容 state schema 保留 local 状态。检查旧 parser 任务的 generation，清除陈旧 buffer 与 handle。

标准阶段：`snapshot(W) + events(seq > W)` 与完整回放生成等价 Document IR；陈旧快照不能回滚，同 epoch 去重，epoch 切换重建流基线。不把 epoch 变化简单等同于用户草稿清空。

历史重建、重连和 render 不执行 Action，也不重放用户点击。generation seal 表示生成完毕，不等于整个 Surface 永远不能由受信工具结果更新。

## 10. 状态、身份与持久化

| 域 | 所有者 | 内容 |
| --- | --- | --- |
| Document | 原始 assistant source 的派生视图；以后后端权威 IR | 节点、模型数据、声明、fallback。 |
| Local | 用户与客户端 Runtime | 输入、选择、展开、dirty、验证结果。 |
| Derived | 纯表达式 Runtime | 指标、筛选、图表派生数据；可以重算。 |
| Execution | 宿主/后端权威操作状态 | command/tool 关联、审批、运行、终态、结果引用。 |

- Surface 身份包含 session、权威 turn 身份、round/block、Surface ID；实时缺 turn_index 时采用可重绑定的本地别名，不能仅依赖可复用的 turn_id 或源码 offset。
- local 初值只在创建时应用；模型 patch 不覆盖 dirty 字段。类型变化需要显式冲突/迁移，禁止静默类型转换。
- SurfaceStore 位于会话级，不能把草稿只放在控件内部；历史窗口淘汰、切标签、虚拟化不等于删除草稿。
- 持久化是受信应用功能，有界 LRU/按需恢复，不由模型选择本地文件路径。密码/敏感字段不持久化，不回传模型。
- 清除、删除会话和 state schema 升级有显式策略；不得用旧数据错误恢复到另一个消息实例。
- 图表实例、ResizeObserver、portal、订阅和 worker 请求全部有 owner/dispose；关闭消息不能残留事件。

## 11. Action 与 Ringing v2

### 11.1 四类动作

| kind | 执行方式 | 是否调用模型 |
| --- | --- | --- |
| local | 有限 reducer/表达式，更新 Surface local | 否 |
| host | 用户触发的复制/受限外链等固定宿主 API | 否 |
| request | Gateway → Rust → Ringing v2 → 工具准入/审批/ToolRuntime | 默认否 |
| followUp | 白名单字段摘要作为普通 conversation 输入 | 是，明确展示 |

`ui.request(alias, payload)` 不能绑定任意 tool name / RPC method / Tauri command。alias 由宿主受信动作目录映射到真实工具及参数 schema。未准入 action 显示禁用原因，不能自动退化为偷偷发起模型调用。

host 不提供任意网络请求、文件选择路径访问或系统 API。资源读取、文件导出、远程查询等外部操作通过已批准的 request 路线；资源引用由受信层签发。资源/外链 scheme 必须校验，不新增 `file:`、`javascript:`、自定义 IPC URL 面。

### 11.2 宿主边界

后续拟新增窄 IPC：注册/失效 Action 提案、提交已准入 handle、查询关联状态。具体命令名由实施确定，不能新增通用 `invoke_any` / `rpc_any` / `tool_invoke_any`。

宿主必须检查提案的 source 身份/hash 是否对应已知 assistant 内容、Catalog/action alias、当前会话/工作区、revision、参数 schema/范围、lease/driver 与权限策略。注册信息和输入值都是不可信数据；前端声称 `validated=true` 不构成依据。

成功准入返回不透明 action handle，绑定 source、action revision、固定参数/允许编辑字段、期限与 scope。注册不执行工具。执行时重新检查时效与策略，并进入现有工具授权；用户点击不等于信任模型参数，也不授予更高权限。

受信审批 UI 继续来自 pending_approvals/challenge，模型不能用同名 Card 模仿宿主审批或构造 approve/trust 请求。审计保留“模型提出、用户点击”的来源。

### 11.3 关联、幂等与结果

持久关联：`interactionRequestId ↔ command_id ↔ tool_call_id ↔ source/surface/actionRevision`。同一次点击网络重试使用原 command_id；ACK 丢失先查状态，不重新生成 ID 执行。新一次有意执行是新请求。

accepted ACK 仅表示接收。显示 submitting/accepted/running/awaiting_approval/succeeded/failed/rejected/uncertain；工具取消按真实终态展示，不能臆造 Ringing enum。

既有 UI ToolInvoke 会创建独立工具回合，可保留为审计信息。结果回原卡片需结构化关联和受信结果数据，不能靠工具输出文本匹配。关闭 Surface 不自动取消工具；取消是明确、受控动作。与运行中的模型回合并发、Stop token 和 session 切换的语义必须在上线前验证。

模型续答提交选定字段，不上传完整私有状态，不使用 `as_system`。用户可见其将发起新一轮或按现有会话输入语义排队。

## 12. Solid Renderer 与现有组件接线

首阶段新增 `AssistantContent`，替换 text segment 中单一 Markdown 的呈现位置，但不改变原始 Step.text 的权威地位。其结构 memo 只依赖 ContentPart 结构；数据增量只通知所属节点。

建议模块边界（后续实施目录，不是本轮已创建）：

```text
src/genui/
  source/        # 围栏/词法分帧、SourceIdentity、checkpoint
  compiler/      # TSX intrinsics → IR；JSONL → 同一 IR
  ir/            # 版本、类型、schema、预算、拓扑检查
  runtime/       # SurfaceStore、local reducer、表达式、依赖
  catalog/       # 组件/事件/props、提示与配方生成
  renderer/      # QAQH ↔ json-render 或薄 Solid Renderer
  components/    # QAQH 视觉封装 + headless primitives
  charts/        # ECharts 生命周期与受限配置映射
  actions/       # UI 事件分派，不直接持有 daemon 凭据
```

- 既有 Collapse、Field、TextInput、Switch 可提取视觉原语；设置保存与审批业务不能被 Catalog 一并暴露。
- 每个 node ID 对应稳定 owner；输入 caret/selection/IME composition 和焦点在流式更新后保持。
- Surface 高度变化通知滚动协调器，local 交互也能更新贴底状态；用户上滚后不能被图表/流式强拉回底。
- 全局 message list 与侧栏不订阅每个节点/字符；图表和大表格使用有界视图。
- Portal 限制在 GenUI 承载区/指定 layer，不覆盖应用安全提示或控制窗口。
- 样式复用现有 token，模型选择语义 variant/density/size，而非任意颜色/定位。图表库默认样式不能成为第二套主题。

## 13. 库评选与采用裁决

### 13.1 调研口径

2026-10-09 查询官方文档、公开源码与 npm 发布元数据。Context7 当前会话无可调用接口，故使用上述一手来源。版本是研究快照，不是已安装版本；peer 范围不是运行实测证明，文档 main 与 npm release 也不能混为同一提交。

| 候选 | 已核对版本/范围 | 评选结果 | Solid 2 / 成本边界 |
| --- | --- | --- | --- |
| `@json-render/core` | 0.21.0；Zod 4；Apache-2.0 | **GenUI 核心首选候选**：目录、schema/提示生成、Spec/stream 机制可复用 | 无 Solid peer；仍需限制 expression/actions/watchers，适配 QAQH source、IR 和持久化。 |
| `@json-render/solid` | 0.21.0；`solid-js ^1.9.0`；Apache-2.0 | **首选 fork 候选**，不是现成兼容包 | Renderer、state/actions/validation providers、列表和构建产物需移植；不只改 peer。 |
| `@ark-ui/solid` + `@zag-js/solid` | 5.39.3 / 1.45.0；peer 分别 `>=1.6.0` / `>=1.1.3`；MIT | **完整 headless 控件首选评估**，允许 fork Solid 桥接 | 组件覆盖较广，但 machine adapter 与传递依赖较多；宽泛范围不证明 RC 可用。 |
| `@kobalte/core` | 0.13.14；`solid-js ^1.9.8`；MIT | **正式备选**：成熟的无样式控件、焦点与键盘行为 | utils、presence、Solid primitives 等需检查；选择它时按需移植控件，不双栈铺满 Catalog。 |
| `echarts` | 6.1.0；无 Solid peer；Apache-2.0 | **图表引擎首选**，直接调用框架无关 API | 按需打包、容器 resize/dispose、主题适配；不接受模型完整 option/callback。 |
| `@tanstack/table-core` | 9.2.8；无 Solid peer；MIT | **复杂数据表首选候选**：行模型、排序/筛选/分页/选择 | 通过 QAQH 薄桥接接入 Surface local 状态；审计其 Store 订阅。不要套用 v8 或 React 专属 API。 |
| `@tanstack/solid-table` | 9.2.8；`solid-js >=1.3`；MIT | **可选 adapter/fork 候选** | 先验证 Solid 2，再决定复用/小 fork；失败不影响 table-core 路线。 |
| `@babel/parser` | 8.0.7；MIT；发布包声明 Node engine | **桌面 DSL parser 首选候选** | 支持 TS/JSX 解析，但不是安全校验/增量编译器；浏览器 worker 构建与实际 Node 工具链需验证。 |
| `zod` | 4.6.5；MIT | **Catalog/校验候选** | 不用 type-only 判断 wire 正确；Rust Gateway 仍进行独立验证。 |
| 既有 marked + DOMPurify、Lucide、原生输入 | 已在仓库 | **继续复用** | 不为 GenUI 放宽净化；原生控件是可靠回退。 |

### 13.2 为什么不是全部自行手绘

决定为“json-render 受限适配 + 优秀 headless 控件 + ECharts + TanStack Table Core + QAQH 视觉封装”。自行实现保留给协议、编译器、权限、Store/恢复，以及不能复用的小布局/适配节点。

不用手写完整日期日历、select/combobox 焦点系统和大图表引擎。所谓手绘只能指受信组件的有限 DOM/CSS/SVG 实现，不能指模型 SVG/HTML/JS 直接执行。

### 13.3 Solid 2 fork 工作范围

用户已允许为适配 Solid 2 考虑 fork；本 spec 记录技术路线，不在本轮创建仓库或改库。

1. 对 json-render：保留无框架 Core，优先只 fork `packages/solid`；以已发布 release 为基线，记录上游 commit/版本，避免带入 main 未发布的实验功能。
2. 对 Ark UI：先验证/移植 `@zag-js/solid` 的 machine→reactivity 桥，再移植需要的 `@ark-ui/solid` 包；尽量保持纯机器核心不变。
3. 对 Kobalte：若 Ark 路径成本不合理，按同一验收选择 Kobalte。检查 utils/presence/primitives 等依赖，禁止混用第二份 Solid 1 runtime。
4. 检查 effects/memo/cleanup、Accessor/props/context、children/ref/portal、For keyed 行为、DOM 生命周期、类型与新 JSX 运行时入口。
5. 从源码用当前 Solid 2 编译链重新构建；不能仅 alias `solid-js/web` 到 `@solidjs/web`，或修改 package.json peer 后宣称完成。
6. Renderer 采用受控 SurfaceStore，禁止上游 initialState 重设覆盖 dirty 输入。所有外部 Action 由 QAQH Gateway 接管；上游通用 confirm dialog 不替代宿主审批。
7. 使用隔离 package/checkout 做兼容验证，不在当前 app 里引入两套 provider 或 runtime。fork package 用 QAQH 私有名称/固定版本；保留上游 LICENSE/NOTICE 和补丁记录。
8. 主动跟踪上游安全修复和 release；区分上游变更与 QAQH 语义修改，兼容后争取回馈最小补丁，但不以 PR 接受为发布前提。

### 13.4 验收后才生效的采用门槛

候选必须在当前 RC 版本通过：生产构建、唯一 Solid runtime、controlled 表单、连续增量、checkpoint、焦点/IME、portal/cleanup、深浅主题、CSP 和实际 WebView2 测试。

若 fork 必须修改大量纯核心语义、无法隔离依赖、破坏状态身份或持续失控，则裁决为自有薄 Renderer/原生控件；继续复用已通过的 Core/ECharts。不能因为 renderer fork 失败而改用 React，也不能因为控件 fork 失败而从零写整个 Runtime。

Ark/Kobalte 二选一作为主要复杂控件基础；允许个别缺失控件独立补充，但要有说明，不能无意中维护两套完整焦点/portal 系统。不得捏造性能评分；通过样本比较构建增量、帧时间、泄漏和迁移补丁面。

## 14. ECharts 与数据组件约束

Chart IR 描述类型、数据引用、字段/系列、轴语义、legend/selection、单位、替代文本。QAQH Adapter 构造 option，不能接受任意模型 ECharts option，也不接受 formatter/renderItem JS 或 HTML tooltip。

- 按需使用 core/charts/components/renderers；默认 Canvas，特殊 SVG 需求通过单独能力声明。
- init 在容器有尺寸后进行；ResizeObserver 合帧 resize；换主题保留选择；卸载 dispose。
- 流式数据使用受信 schema 与容量限制，必要时采样/分页；相同 series ID 保持颜色和选择。
- tooltip 使用受控文本/richText；点击点/区域产生类型化 local event，不能调用任意模型函数。
- 图表下提供标题、单位、数据摘要/表格替代；不能用颜色作为唯一含义。
- Table 的 sort/filter 不调用模型，分页视图不复制整个历史；有界 Repeat 必须有稳定 item key。
- Table Core 的模型与 Surface local 状态有单一归属，不能由两套 Store 各自持有冲突的 selection/filter 真相。列 accessor、排序/筛选回调由 QAQH 注册并从 IR 映射，模型不能提供函数。简单静态表可直接使用语义 table，无需为每张小表创建完整数据引擎。
- CodeBlock 复用仓库已有 Shiki 依赖，按需加载已打包语言/主题；选择满足现有 CSP 的引擎，验证 worker、首次加载与大块代码成本。不能为高亮放宽 unsafe-eval 或执行代码块。

## 15. 安全与资源预算

### 15.1 不变量

- 不修改现有 CSP 来允许 unsafe-eval、模型 script 或远程库加载；依赖构建时打包。
- Renderer 不接受任意 DOM props、transport/invoke/store 对象或用户源码 callback。
- 只有受信 Action Adapter 能到 Gateway；挂载、watch、数据更新、恢复、图表 callback 都不能自动触发外部操作。
- 副作用 watcher 默认关闭；纯依赖更新与自动 I/O 分开。后续自动动作必须另立契约，不能继承上游库默认行为。
- 格式校验、拓扑校验、表达式预算、Rust 参数/权限校验均不可省略。
- 原始源码/模型输出/工具结果作为不可信内容处理；不能借模仿应用控件获得可信权限提示。

### 15.2 初始预算（待实测调整，不是已有性能保证）

| 项目 | 初始上限 |
| --- | --- |
| 每条回复 Surface 数 | 8 |
| 单 Surface 源码/序列化 IR | 各 1 MiB |
| 单 DSL 语句/JSONL 记录 | 64 KiB |
| 单 Surface 节点/树深度 | 512 / 16 |
| 表达式深度/单事件求值步数 | 24 / 10,000 |
| 单生成的逻辑操作数 | 10,000 |
| 表格/图表数据记录 | 10,000；实际挂载行必须窗口化/分页 |
| 本地持久状态 | 每 Surface 64 KiB；每 session 缓存配额另测 |

超额保留已验证可读内容、显示具名错误/fallback、禁用未完成操作。不得通过无限反复修复/重试模型继续占用预算。长解析进入 worker；暂停 UI 绘制不能导致缓冲无限增长。

## 16. 阶段实施与标准分发

| 阶段 | 交付物 | 完成条件 |
| --- | --- | --- |
| T0 库/fork 裁决 | 固定候选版本、上游基线、最小兼容样本、Ark/Kobalte 选择记录 | 当前 Solid 2 生产链与关键交互通过；没有仅改 peer 的伪兼容。 |
| T1 核心闭环 | ContentDecoder、DSL/JSONL→IR、Catalog、SurfaceStore、Renderer | 混合回复、计数器、表单、本地计算、流式、checkpoint、状态恢复。 |
| T2 Desktop Profile | 全部 §3 组件、ECharts、Table、资源、主题/无障碍 | 不是只有静态卡片；所有 advertised 组件与动作经过样本验证。 |
| T3 操作与端到端 | Rust Gateway、Ringing 准入/关联/结果、续答、注入/skill 接线 | 外部动作真实闭环，重试不重复执行，权限/会话/取消语义正确。 |
| S0 冻结标准 | IR/Catalog/action/schema 包、golden fixtures、迁移规则 | 完成 Tauri 经验回收；不将第三方内部 API 锁入 wire。 |
| S1 后端归一 | 后端权威 UI 内容/增量/快照、客户端能力协商 | ts-rs 等生成绑定；旧客户端获得文本降级，单一消息事实源。 |
| S2 原生客户端 | Kotlin/Compose、ArkTS/ArkUI、XAML、ratatui 适配 | 同一语义数据与行为；不要求网页或完整 TS 引擎。 |

**Tauri 完整能力交付 = T0–T3 全部通过。** T1 demo 或仅 Renderer 可挂载不允许写“完成”。阶段可以局部开发，但标准化和所有端完成不阻塞 Tauri。

后续标准包至少包含：规范/版本说明、JSON Schema、组件 Catalog、Expression/Action 语义、快照/事件样本、能力/降级矩阵、模型提示/skill 生成模板和 conformance suite。平台包实现 Renderer，不必共享 UI 框架。

能力采用共同基础 + 可选扩展，而不是将全部客户端压到最弱能力。需要新标准或宿主能力的扩展显式版本化；不支持的动作必须禁用/说明，不能默默调用模型替代。根据行为复杂度再评估共享 Rust Core，不把它作为本阶段强制前置工程。

## 17. 验收场景与检查

| 场景 | 必须证明 |
| --- | --- |
| Markdown + counter + Markdown | 首个有效节点到达即出现；local 点击无模型请求、无工具调用。 |
| 表单 + 模型持续补充节点 | caret/IME/焦点与 dirty 值不丢失；重置仅由显式动作发生。 |
| 数据表 + 图表联动 | 筛选/系列选择本地完成；后续 rows 不重置选择或整实例重建。 |
| 明确模型续答 | 按钮说明会继续对话；只提交白名单字段，不使用 system 绕过。 |
| Ringing 导出/查询 | 准入/审批/执行/结果回写全链路；accepted 不冒充成功。 |
| ACK 丢失与重复点击 | 同请求原 command_id 查状态；新请求与网络重试区分。 |
| 中断/错误/超额 | 已验证内容可读，未完成外部按钮不可点击；错误不拖垮消息列表。 |
| checkpoint 与同帧更新 | 不丢/重放操作；非前缀重编译与缓冲对齐；新旧 parser 任务不串写。 |
| 分页淘汰/切会话/重启恢复 | 身份不串，兼容草稿恢复；恢复不执行工具。 |
| 错误来源/伪造参数/跨 session | 无权限升级；未知 alias、过期 handle、陈旧 revision 被拒绝。 |
| 亮暗/缩放/窄屏/键盘 | 与现有 token 一致，320px 可承载嵌入内容，实际 app 在现有窗口矩阵验收。 |
| 关闭/隐藏/大量历史 | graph/subscription/worker/图表/portal 正确释放，后台 buffer 有界。 |

纯逻辑检查：任意 token/UTF-8/转义拆包、围栏嵌套、字符串内分号、缺引用、循环、未知 props、危险路径、表达式超限、两个输入模式等价、snapshot+delta 等价。

组件检查：actual Solid 2 build、稳定 node DOM 身份、受控输入、键盘/ARIA/focus/IME、图表清理、CSP 无违规。协议与 Ringing 检查跨 desktop/backend，不用纯前端 mock 冒充全链路。

性能建议初始目标：既有文本流正确性门槛不回退；受限混合负载的帧间隔 P95 ≤33.3ms，增量 UI 从完整单元到 DOM 提交 P95 ≤100ms；超预算采取降采样/窗口化/合帧而不是丢操作。必须记录 CPU/GPU、WebView2、DPI、数据规模、冷/热启动；这些数字是待验证目标，不是本轮测量结果。

实现期按变更运行 typecheck、相关单测、生产 build、合成流夹具和真实 Tauri 验证。本轮为文档研究，不运行应用测试或宣称上述检查通过。

## 18. 后续实施需裁决的有限问题

1. T0 后选择 Ark UI/Zag 或 Kobalte 主控件基座，记录实际 fork 补丁面与通过样本。
2. 固定 json-render release 与 QAQH Adapter 支持子集；若 fork 不通过，选择薄 Renderer，但保留已验证 Core。
3. 固定 parser/worker 版本与词法分帧实现；用同一模型任务比较 DSL/JSONL 的失败率、token 和首屏延迟，不凭直觉宣称 TSX 一定更好。
4. 确认 Rust Gateway 的 source registry、action alias 定义和 Ringing origin/result 关联持久化归属。
5. 实测预算、持久化配额与图表更新成本；修订 Profile 而不是放宽任意代码执行。

这些问题在对应阶段解决，不重新讨论已确定的“正常回复呈现、Tauri 优先、不迁移框架、外部操作受控”四项方向。

## 附录 A：最小注入提示草案

以下是将来由受信 Catalog/Capability 生成的提示契约，不是当前已经启用的功能：

```text
你可以在正常 assistant 回复中使用 QAQH Generative UI。
它不是工具调用，不要调用或虚构 ui.render 工具。
普通说明使用 Markdown；交互内容使用顶层 qaqh-ui 围栏。
使用当前提供的版本、组件、属性、表达式、动作别名和预算。
默认使用 format=tsx 的 QAQH 受限 DSL，也可以使用等价 format=jsonl。
这不是完整 TS/React/Solid，不要输出 import、函数、循环、HTML 文档、脚本或网络请求。
一份围栏一个 Surface：先声明 surface/state/data，再逐条输出完整 node 语句，最后 end。
使用稳定、可读的 ID；优先让容器和有效内容早出现，再补充后续内容。
本地选择、表单、计算、筛选不需要模型续答。
外部操作只能引用当前受信目录提供的别名；它们是提案，客户端可能拒绝。
只在用户确实需要时添加明确“继续分析”的模型续答按钮。
UI 外提供有意义的文字结论；Surface 必须包含纯文本 fallback。
没有可用能力时用普通文字回答，不输出未知组件，不把未知操作改成偷偷续答。
```

详细 skill 配方必须覆盖：counter/模式切换、表单验证、表格筛选、图表联动、工具结果、生成中断与源码展示。生成提示只列当前已经验收的能力；未上线组件不能提前 advertised。

## 附录 B：一手来源与版本快照

以下外部能力作为可复用机制和选型依据，不作为 ChatGPT 内部实现证明：

- [OpenAI Intelligent UI 官方介绍](https://openai.com/ja-JP/index/gpt-6-for-everyone/)：公开方向为可流式组件库与生成期间的编译；没有据此确认内部 DSL。
- [ChatKit Widgets](https://developers.openai.com/api/docs/guides/chatkit-widgets)、[Actions](https://developers.openai.com/api/docs/guides/chatkit-actions)：组件/动作分离参考，不接管 QAQH 传输与审批。
- [MCP Apps 已发布规范](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)：HTML/sandbox host 路线，未来独立适配，不混入本 Runtime。
- [A2UI 组件结构](https://a2ui.org/concepts/components/)：语义组件和邻接表参考，不在本阶段承诺完整兼容。
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification)：通信规则，batch 不提供 UI 顺序保证。
- [json-render 官方说明](https://json-render.dev/docs)、[Skills](https://json-render.dev/docs/skills)、[Streaming](https://json-render.dev/docs/streaming)、[Generation modes](https://json-render.dev/docs/generation-modes)。其 Catalog/stream/inline 能力值得复用；不是必须采用其工具调用或模型服务集成。
- json-render 源码研究基线：[fc2a696](https://github.com/vercel-labs/json-render/tree/fc2a696a50a30cb30c878ab1eb65e102487eea0f)。[Solid Renderer](https://github.com/vercel-labs/json-render/blob/fc2a696a50a30cb30c878ab1eb65e102487eea0f/packages/solid/src/renderer.tsx)、[StateProvider](https://github.com/vercel-labs/json-render/blob/fc2a696a50a30cb30c878ab1eb65e102487eea0f/packages/solid/src/contexts/state.tsx)、[Actions](https://github.com/vercel-labs/json-render/blob/fc2a696a50a30cb30c878ab1eb65e102487eea0f/packages/solid/src/contexts/actions.tsx)；这是研究 main，不是声称 npm 0.21.0 与其相同。
- [json-render/solid 0.21.0 发布元数据](https://registry.npmjs.org/%40json-render%2Fsolid/0.21.0)、[core 0.21.0](https://registry.npmjs.org/%40json-render%2Fcore/0.21.0)。
- [Ark UI 官方说明](https://ark-ui.com/docs/overview/getting-started)、[Zag 官方说明](https://zagjs.com/overview/introduction)、[Ark 5.39.3 元数据](https://registry.npmjs.org/%40ark-ui%2Fsolid/5.39.3)、[Zag Solid 1.45.0 元数据](https://registry.npmjs.org/%40zag-js%2Fsolid/1.45.0)。Ark 源码研究基线：[687b9dc](https://github.com/chakra-ui/ark/tree/687b9dcba7c56f98da4db7bb8fac7d764ecd3f65)。
- [Kobalte 官方说明](https://kobalte.dev/docs/core/overview/introduction)、[0.13.14 元数据](https://registry.npmjs.org/%40kobalte%2Fcore/0.13.14)。
- [ECharts 按需导入](https://echarts.apache.org/handbook/en/basics/import/)、[容器/resize/dispose](https://echarts.apache.org/handbook/en/concepts/chart-size/)、[6.1.0 元数据](https://registry.npmjs.org/echarts/6.1.0)。
- [TanStack Table 行模型与实例](https://tanstack.com/table/latest/docs/guide/tables)、[Core 9.2.8 元数据](https://registry.npmjs.org/%40tanstack%2Ftable-core/9.2.8)、[Solid adapter 9.2.8 元数据](https://registry.npmjs.org/%40tanstack%2Fsolid-table/9.2.8)。
- [Shiki 引擎说明](https://shiki.style/guide/regex-engines)：代码高亮的引擎与 CSP 需实际核对，不以 npm 包已存在作为可用性证明。
- [Babel parser](https://babeljs.io/docs/babel-parser)、[8.0.7 元数据](https://registry.npmjs.org/%40babel%2Fparser/8.0.7)、[Zod 4.6.5 元数据](https://registry.npmjs.org/zod/4.6.5)。解析器支持 TS/JSX，不代表允许执行或能自动安全增量提交。
- [Solid 2 RC.13 元数据](https://registry.npmjs.org/solid-js/2.0.0-rc.13)：当前仓库版本；不要把旧 JSX runtime 路径当作新包可用接口。

最后裁决：**优先利用优秀库并允许小范围 Solid 2 fork；协议、受限编译、权限和恢复由 QAQH 掌握。先让 Tauri 完整消费模型正常回复里的界面，再冻结可分发标准。**
