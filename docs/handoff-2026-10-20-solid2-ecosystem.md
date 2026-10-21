# Handoff — Solid 2 生态适配与右键菜单前置决策（2026-10-20）

关联文档：docs/handoff-2026-10-20-fluent-windows.md（本次 Fluent 改造的完整 handoff）。

这份文档解决两个问题：

1. 接下来继续以 **Solid 2** 为硬要求，不回退到 Solid 1。
2. 盘点那些「本来合适、但因为 Solid 2 限制而落选」的库，判断哪些值得投入升级/适配，哪些应该永久放弃。

## 1. 当前基线

- solid-js / @solidjs/web：2.0.0-rc.15
- @solidjs/vite-plugin：3.0.0-next.50
- @kobalte/core：2.0.0-alpha.3（pin 死）
- 依赖树检查：pnpm why solid-js 只有 rc.15，没有 Solid 1 副本。
- 视觉层：自研 Fluent CSS（src/styles/tokens/fluent.css + src/styles/components/fluent.css）
- 设置页控件：Kobalte Select / Switch / Tooltip + 自研 NumberInput

原则：**先看 peer 是否显式支持 Solid 2，再做运行时 smoke test；peer 范围宽松不等于兼容。**

## 2. 兼容性矩阵

| 库 | 最新版 / peer | 状态 | 结论 |
|---|---|---|---|
| @kobalte/core | 2.0.0-alpha.3 / solid 2.0.0-rc.15 | 已接入 | 继续用，pin 版本，跟进 beta |
| @solidjs/router | 2.0.0-next.40 / solid ^2.0.0-rc.15 | 官方 Solid 2 | 需要路由时优先采用 |
| @solidjs/meta | 1.0.0-next.2 / solid ^2.0.0-rc.0 | 官方 Solid 2 | 需要 head 管理时采用 |
| @solid-primitives/* | next 版本 / 随 Kobalte 引入 | 已有可用版本 | 新增时只用 next，并验证 |
| @tanstack/solid-table | 9.3.1 / peer >=1.3 | 未验证 | peer 宽松但很可能仍按 Solid 1 写；需要表格时再评估 |
| @tanstack/solid-virtual | 3.13.48 / peer ^1.3.0 | 未验证 | 需要大列表虚拟化时再评估 |
| @ark-ui/solid | 5.39.3 / peer >=1.6；next 6.0.0-next.0 仍 >=1.6 | 未验证，风险高 | 暂不引入；除非 Kobalte 缺关键组件 |
| Park UI | 基于 Ark UI + Panda CSS | 受阻 | 不引入；样式运行时方向也不合 |
| @suid/material | 0.19.0 / peer ^1.9.7 | 明确 Solid 1 | 不引入；Material 风格也不合 |
| fluent-solid | 0.2.14 / peer ^1.9.9，且无许可证 | 明确 Solid 1 + 法律风险 | 不引入；需要的控件已用 Kobalte + 自研 CSS 覆盖 |
| @fluentui/web-components | 3.1.3 / 无 Solid peer | 框架无关，可用 | 可选兜底；shadow DOM 限制样式，非首选 |
| @fluentui/tokens | 1.0.0-alpha.24 / 无框架依赖 | 可用 | 只作为数值参考，不进运行时 |
| fluent-svelte | 1.6.0 / Svelte | 仅参考 | MIT；已把 token/组件度量移植到自研 Fluent 层 |

## 3. 逐项判断

### 3.1 Kobalte 2 alpha（已适配，P0）

- 现状：唯一显式 peer 指向 Solid 2 RC 的 Solid 原语库；已有 Select / Switch / Tooltip / Dialog / ContextMenu / Menu / Combobox / NumberField 等。
- 风险：alpha，API 可能变；目前 2.0.0-alpha.3 发布于 2026-10-15。
- 策略：
  - pin 死版本，不写 ^ 或 ~。
  - 每次升级前跑 Select / Switch / Tooltip / ContextMenu 的 smoke test。
  - 遇到 bug 先看上游是否已修；小问题用 pnpm patchedDependencies，并尽量提 PR。
  - 不 fork 整个库。

### 3.2 Ark UI Solid 2（P3，暂不投入）

- 现状：peer 写的是 >=1.6.0，看似宽松；next 6.0.0-next.0 也没有声明 Solid 2。
- 适配成本：Ark UI 的 Solid 绑定依赖 Zag.js 状态机 + Solid 1 的响应式/组件写法，移植面大；不是改一个 peer 就能解决。
- 结论：除非 Kobalte 缺少我们必需的关键组件（例如复杂日期选择、Tags Input），否则不碰。
- 如果将来要碰：先开 issue 询问 Solid 2 计划，再评估上游 PR，不要先 fork。

### 3.3 Park UI（永久放弃）

- 它同时依赖 Ark UI 和 Panda CSS。
- 即使 Ark UI 支持 Solid 2，Park UI 仍会把 Panda CSS 带进来；本项目已经确定纯 CSS + token，不应引入第二套样式运行时。
- 结论：只参考其组件分层与主题命名，不作为依赖。

### 3.4 SUID（永久放弃）

- Material UI 的 Solid 移植，peer 明确 Solid 1。
- 视觉方向是 Material，不是 WinUI/Fluent；移植成本高、收益低。
- 结论：不投入。

### 3.5 fluent-solid（永久放弃）

- 唯一的 Solid-first Fluent 组件库，但：
  - peer 是 Solid 1.9；
  - 仓库没有许可证（法律风险）；
  - 2 star，产物是 vanilla-extract 的 hash 类名；
  - 样式不可直接复用。
- 结论：不投入。我们需要的 Select / Switch / Tooltip / NumberInput 已经用 Kobalte + 自研 Fluent CSS 覆盖。

### 3.6 TanStack Solid Table / Virtual（P2，按需）

- peer 写得很宽（>=1.3 / ^1.3.0），但这不代表 Solid 2 兼容；它们大概率仍按 Solid 1 写。
- 适配成本：TanStack 的 Solid adapter 主要包一层响应式 store，移植面中等，但需要上游配合。
- 结论：现在不需要数据网格/虚拟列表，不引入；如果 Tools 页或会话列表出现性能瓶颈，再开 issue/PR 评估。
- 不要因为 pnpm 不报 peer 错就直接用；先做 smoke test。

### 3.7 官方 Solid 2 next 包（P1，按需）

- @solidjs/router 2.0.0-next.40 和 @solidjs/meta 1.0.0-next.2 的 peer 已指向 Solid 2。
- 如果要做设置页深链、页面路由、标题管理，直接用官方 next，不要自己 port 一个路由器。
- 注意 next 版本的 API 也可能变，pin 版本。

### 3.8 @fluentui/web-components（可选兜底）

- 自定义元素，框架无关，Solid 2 可以渲染；Fluent 2 的 40+ 控件、32px 文本输入、4px 圆角。
- 但它使用 shadow DOM，现有全局 CSS 进不去，只能靠 design token；也没有 NavigationView。
- 结论：不作为主路径；如果某个复杂控件（Dialog/Menu）不想手写，可以按需 import 单个 define.js 作为兜底，并先测 CSP 下 adoptedStyleSheets。

## 4. 适配/升级决策规则

1. **官方 next 显式声明 Solid 2** → 优先采用。
2. **peer 宽松但未声明** → 先写 smoke test；运行时通过才采用。
3. **小型补丁** → pnpm patchedDependencies + 上游 PR；不打整包 fork。
4. **大型 Solid 1 库** → 不 fork；等上游，或者用现有 Kobalte + 自研 CSS 替代。
5. **样式运行时**（Panda / vanilla-extract / Tailwind）→ 不为了用某个库而引入。
6. **许可证不明** → 直接排除，不投入适配。

## 5. 需要建立的护栏

### 5.1 依赖树护栏

每次依赖变更后执行：

    pnpm why solid-js

期望只有 solid-js@2.0.0-rc.15。出现第二个版本立即回退。

### 5.2 Solid 2 smoke fixture

建议新增一个 dev-only 页面（例如 src/dev/solid2-smoke.tsx），至少挂载：

- Kobalte Select
- Kobalte Switch
- Kobalte Tooltip
- Kobalte ContextMenu
- Kobalte Dialog
- Kobalte Menu / Submenu

检查：

- 挂载无 console error
- 键盘可操作
- Esc / 外部点击可关闭
- 焦点能回到触发器
- 没有 Solid 1 的运行时警告

这个 fixture 以后可以给 Kobalte beta、Router next、TanStack adapter 共用。

### 5.3 CI

- 现有 pnpm typecheck / pnpm test / pnpm build 已覆盖编译与逻辑。
- 可加一个 solid2-compat job，跑 smoke fixture 的 headless 检查。
- 不建议把 alpha 库的升级做成自动 PR；人工确认 + smoke test 更稳。

## 6. 投入顺序

| 优先级 | 事项 | 触发条件 |
|---|---|---|
| P0 | Kobalte 2 alpha 跟踪与 smoke test | 现在就做 |
| P1 | 官方 Solid Router / Meta next | 需要路由/深链/标题时 |
| P2 | TanStack Solid Table / Virtual | 出现大数据表格或虚拟列表需求时 |
| P3 | Ark UI Solid 2 | Kobalte 缺关键组件时 |
| 不做 | Park UI / SUID / fluent-solid | 方向或成本不合 |
| 可选 | Fluent Web Components | 不想手写某个复杂控件时 |

## 7. 与右键菜单的关系

右键菜单不需要新的 Solid 库：

- 行为层优先用自己的 src/ui/contextMenu.tsx，或迁移到已经安装的 Kobalte ContextMenu。
- Kobalte ContextMenu 已经包含 Sub / CheckboxItem / RadioItem / Separator / 键盘 / 碰撞处理，是 Solid 2 下最稳的选择。
- React 侧的 Radix / shadcn / Fluent UI React 只作为行为与视觉参考，不移植。
- 详情见 docs/handoff-2026-10-20-fluent-windows.md 第 7 节。

## 8. 结论

- **继续以 Solid 2 为唯一目标，不回退 Solid 1。**
- **Kobalte 2 alpha 是当前最值得投入的适配点**：它已经把 Solid 2 的坑填了大半，我们只需要 pin、测、跟进。
- **Ark UI / Park UI / SUID / fluent-solid 不值得现在投入**：要么移植面过大，要么方向不合，要么许可证有问题。
- **TanStack Solid 适配按需再评估**；官方 Router/Meta 有 Solid 2 next，需要时直接用。
- 下一步先完成右键菜单 P1（不引入新库），同时建立 smoke fixture 与 pnpm why solid-js 护栏。
