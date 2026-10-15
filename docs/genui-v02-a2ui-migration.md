# qaqh-ui v0.1 → v0.2（A2UI 对齐）迁移清单

状态：分析稿 · 2026-10-15
依据：A2UI spec v1.0（`a2ui-project/a2ui`，`specification/v1_0/json/*` 已逐字段核对）× 本仓 `src/genui/compiler/ir.ts`（IR 0.1）
结论先行：**wire 协议直接采纳 A2UI v1.0；TSX 围栏保留为 authoring 语法糖；现有 decoder/parse 改造为「TSX → A2UI 消息」的编译前端；Solid renderer 新写，对接 A2UI core 数据模型。**

## 1. 概念对照表

| qaqh v0.1（ir.ts） | A2UI v1.0 | 差异性质 | 迁移动作 |
|---|---|---|---|
| `SurfaceIR`（一次性 IR 对象） | **消息流**：`createSurface` → `updateComponents*` → `updateDataModel*` → `deleteSurface` | **范式差**：A2UI 天然增量，无「部分编译」概念 | ✅ 采纳。这是治流式卡顿的根本：每个 delta = 一条已完整可校验的消息，不再全量重解析 |
| `states: Record<key, {type, initial}>`（扁平 5 型） | **层级 dataModel** + JSON Pointer 路径（`/build/status`） | 范式差 | ✅ 采纳。`updateDataModel {path, value}` 按路径 patch；扁平 key 变成路径约定（`/s/<key>` 兼容层可后续做） |
| `Expr` 解释器（add/sub/mul/eq/…，`eval.ts`） | **无表达式语言**。计算 = catalog 函数 `@call`（args 走 JSON Schema 校验）+ 系统函数 `@index` | **哲学差**：A2UI 把「算」外置成白名单函数 | ⚠️ 分两步：v0.2 先保留 `eval.ts` 作为内置函数族（`qaqh:arith/...` catalog functions），对外暴露 `@call` 形态；表达式语法糖在 TSX 层解析后落到函数调用 |
| `PropValue{lit/expr/binding/repeat}` | `DynamicValue = 字面量 \| {"@path"} \| {"@call"}`；`ChildList = id[] \| {componentId, path}`（模板化列表） | 形状差，语义同构 | ✅ 采纳。`binding`→`{"@path"}`；`repeat`→ChildList template（模板 + 路径，比 v0.1 的 `repeat.as` 更简单） |
| `Action{set/reset/followUp/copy/openLink/append/remove}` | `Action = {event:{name, userMessage?, context}} \| {functionCall}` | A2UI 只留「意图」和「函数」，本地效果全走 renderer function | ✅ 采纳 event；`set/append/remove` 实现为 `qaqh:local` 目录的 renderer functions（`allowedCallers: rendererOnly`）；`followUp` 保留为 qaqh 扩展函数 `qaqh:followUp`（独有语义，A2UI 无对应物） |
| `CATALOG`（TS 硬编码 13 组件） | **catalog 外置**：JSON Schema 定义组件 + `allowedParents/allowedChildren` 结构约束 + `instructions`（给模型的设计指南，Markdown）+ `catalogId` 命名空间，一 surface 可挂多 catalog | **能力差**：A2UI 的目录是数据不是代码 | ✅ 采纳。这是「趁早落地」的核心红利：qaqh 编码代理专属组件（TodoList、DiffView、PlanReview、ToolCard）做成 **`qaqh.dev` 扩展 catalog**，与标准 catalog 并挂——ChatGPT 没做 coding-agent UI 的空档就在这 |
| `validateSurface`（手写：封闭 props、引用完整性、环/深度 16、512 节点预算） | JSON Schema 校验 + 结构约束；**无深度/节点预算**（留给 renderer） | 互补 | ✅ 双轨保留：A2UI schema 管形状，qaqh 保留深度/节点/字符预算作为 renderer 侧 DoS 防线（`MAX_TREE_DEPTH/MAX_NODES` 原样搬） |
| 无 | `AccessibilityAttributes`（label/description/aria-live/hidden，全组件通用） | A2UI 强项 | ✅ 采纳，v0.2 起进组件 envelope |
| 无 | `checks` + `ValidationResult{valid,code,message,severity}`（renderer 侧校验规则） | A2UI 强项 | ✅ 采纳，替换 v0.1 TextInput 的 `required/pattern` |
| `GenUiError` 行号、`warnings`（孤儿节点）、TSX 文本格式、`followUp` 语义 | 无 | **qaqh 资产** | 保留：行号/warnings 留在 TSX 编译层（编译期产物，不进 wire）；`followUp` 作为扩展函数；**TSX 围栏保留**——模型写 TSX 比写 6 种 JSON 消息便宜得多，decoder 分帧逻辑原样复用 |
| `rootId?` + forest 平铺兜底 | `Surface` 规范根容器（`child: "root"`，不可变） | 小差 | ✅ 采纳规范根；TSX 编译层继续容忍省略 root（编译时注入），流式兜底逻辑保留在编译层 |

## 2. 为什么这次迁移值得「趁早」

1. **流式模型反转**：v0.1 的卡顿根因是「文本流 → 重解析 → 重挂」（`AssistantContent.tsx` 的 Show keyed 重挂）。A2UI 的消息粒度天然等齐渲染粒度：`updateComponents` 一条消息 = 一批已校验节点，renderer 按 id patch，DOM 复用是白拿的。
2. **多端对齐**：catalog 是 JSON，TUI（ratatui）/未来移动端按 `renderer_capabilities.json` 声明能力降级——GPT 那个「同一 Agent 输出三端渲染」实验，A2UI 是现成协议底座。
3. **编码代理差异化**：`catalogId` 命名空间 + `instructions` 意味着 qaqh 可以发自己的 `qaqh.dev` catalog（Todo/Diff/PlanReview/ToolCard），标准 catalog 照用。ChatGPT 的 GenUI 服务于通用问答；coding-agent UI 的空档是真实的。

## 3. 迁移步骤（P0 → P2）

### P0：协议地基（~2-3 天）
- [ ] 把 `specification/v1_0/json/*.json` 六个 schema 收进 `src/genui/v2/schema/`（本地 vendored，校验用）
- [ ] 新建 `src/genui/v2/` 包：`message.ts`（6 消息类型 TS 类型，从 schema 生成或手写）、`dataModel.ts`（JSON Pointer get/patch）、`store.ts`（surface 注册表：id → {components, dataModel}，消息驱动的增量 patch）
- [ ] decoder 不动；新增 `parse.ts → A2UI 消息` 的第二编译后端（v0.1 TSX 表达式 → `qaqh:arith` 函数调用的降级编译）
- [ ] 预算防线搬迁：深度/节点/字符预算挂到 message ingress（`createSurface`/`updateComponents` 入口处拒绝）

### P1：Solid renderer v2（~1 周）
- [ ] `render/SurfaceView.tsx` 重写为消息驱动：组件按 `id` keyed，`updateComponents` 只 patch 到达的节点（治 streaming remount）；`updateDataModel` 走 Solid store 细粒度响应
- [ ] 组件目录双轨渲染：标准 A2UI 组件 + `qaqh.dev` 扩展组件（TodoList/DiffView/PlanReview 先迁三个）
- [ ] followUp/openLink/copy 实现为 renderer functions，走现有 `onFollowUp` 队列语义
- [ ] v0.1 → v0.2 兼容期：decoder 按围栏版本分流（`qaqh-ui v=0.1` 走旧管线，`a2ui/v1.0` 走新管线），旧内容不坏

### P2：落地增强（~1-2 周）
- [ ] `qaqh.dev` catalog 正式化：`instructions` 写设计指南（给模型的 prompt 片段，替代 GPT 模板里的自然语言目录）
- [ ] `qaqh-sandbox:` 自定义协议 + 沙箱帧桥（OpenAI 19 端口裁剪版），跑 HTML/mermaid 级重内容
- [ ] conformance：拿 A2UI 官方 `specification/v1_0/test/` 套件跑 renderer 符合性
- [ ] daemon 侧：`a2ui/v1.0` 消息进 conversation 频道 delta（复用现有 replaceable slot），UI 操作回传走 `conversation` 命令新 action（意图 + surfaceId + revision，进授权层）

## 4. 明确不迁的

- `renderer_to_agent.json` 的 A2A 传输假设：qaqh 用自己的 ringing/delta 事实流（durable + 可恢复，比 AG-UI 事件流强），只采纳其消息语义
- AG-UI：不引。事件分类学可参考，传输不需要
- 完整表达式语言：不进 v0.2 wire。计算一律 catalog function，白名单扩张走目录版本化

## 5. 风险

- A2UI v1.0 仍是候选（spec 目录里 v0_9_1 并存）：锁 `specification/v1_0` 的当前 commit，follow 上游但 vendored，不裸追
- TSX→消息编译器是本项目独有的胶水（上游只有 JSON authoring）：parser 现有 555 行是资产，改后端即可，但需要补「表达式 → @call」的映射测试
- Solid 无官方 renderer（上游 React/Lit）：web_core 的数据模型层是框架无关的，渲染层自担
