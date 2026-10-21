# Handoff — Windows 11 / Fluent 2 前端改造（2026-10-20）

范围：本次会话完成的 Solid 2 升级、Kobalte 接入、Windows Fluent 视觉层、设置页交互修复。
关联：docs/handoff-2026-10-20-solid2-ecosystem.md（Solid 2 生态适配与取舍）。
注意：工作树里还存在本次会话之前就有的未提交改动；本文只记录本次改动。

## 1. 摘要

- Solid 2 RC 从 2.0.0-rc.13 升到 2.0.0-rc.15，Vite 插件升到 3.0.0-next.50。
- 接入 @kobalte/core 2.0.0-alpha.3（目前唯一 peer 指向 Solid 2 RC 的 Solid 原语库）。
- 新增 Windows 专用 Fluent token/组件层，macOS Liquid Glass 保留为可选预设。
- 设置页原生 select / checkbox 全部换成 Kobalte + Fluent 外观。
- 设置页的重新读取、数字输入、档案操作、主题持久化等交互修正。
- Composer / SessionHeader 的下拉统一外部点击与 Esc 关闭。
- Mica 不可用时自动回退实底，不再透明窗口露桌面。

验证：pnpm typecheck、pnpm test（502 项）、pnpm build、cargo check -p qaqh-webui-app 全部通过。

## 2. 关键技术决策

### 2.1 Solid 2 RC 是硬约束

现有生态里绝大多数 Solid UI 库的 peer 还是 Solid 1：Kobalte 1.x、Park UI、Ark UI、SUID、fluent-solid。因此本次只选 Kobalte 2 alpha，并 pin 死版本：

    "@kobalte/core": "2.0.0-alpha.3"

Kobalte 升级到 beta 时要重新跑 Select / Switch / Tooltip 的交互检查。

### 2.2 Fluent 数值从 fluent-svelte 移植

参考 Tropix126/fluent-svelte（MIT）的 theme.css 与组件 SCSS：

- 字阶 12 / 14 / 18 / 20 / 28 / 40 / 68
- 控件圆角 4、浮层 8
- 控件高 32、正文 14/20
- 动效 83 / 167 / 250 / 333ms
- WinUI 双色焦点环
- ToggleSwitch 40×20、12px 滑块

落成本仓纯 CSS：

- src/styles/tokens/fluent.css
- src/styles/components/fluent.css

不引入 vanilla-extract / Tailwind / Panda / CSS-in-JS。

### 2.3 窗口层级

保留原生 caption（Snap Layouts、圆角、DWM 主题由系统负责），不做自定义 titlebar：

- #top 从 40px 升到 48px，去掉整宽下划线。
- 设置页 h1 改为当前分区名，避免与 #top 的设置重复。
- Tools / OAuth 的内容 h1 在 Windows 下隐藏，标题交给 #top。

### 2.4 主题是纯本机偏好

外观区（主题、预设、会话材质、字体、字号）全部是 localStorage，不参与 daemon patch。config.save 仍只负责 daemon 配置，保持 Merge Patch 语义。

### 2.5 Mica 可用性回传

宿主命令 set_window_theme 现在返回 bool：

- Windows：apply_mica 成功返回 true
- macOS：apply_vibrancy 成功返回 true
- 其它平台 / 失败返回 false

前端在 src/lib/theme.ts 里据此切换 html.has-mica：

- 有 Mica：导航/侧栏透明，内容用 --layer-fill
- 无 Mica（Win10、旧 22H2）：撤回透明层，用 --bg 实底

## 3. 文件地图

新增：

| 文件 | 作用 |
|---|---|
| src/styles/tokens/fluent.css | Windows Fluent token |
| src/styles/components/fluent.css | Windows 组件覆盖 |
| src/ui/Select.tsx | Kobalte Select + Fluent 触发/浮层 |
| src/ui/Switch.tsx | Fluent ToggleSwitch |
| src/ui/NumberInput.tsx | 数字输入本地缓冲 |
| src/ui/Tooltip.tsx | Fluent ToolTip |
| src/ui/dismissable.ts | 外部点击 + Esc 统一关闭 |
| src/lib/platform.ts | 平台标记 |

修改（本次相关）：

| 文件 | 改动 |
|---|---|
| package.json / pnpm-lock.yaml | Solid rc.15、Vite 插件 next.50、Kobalte alpha.3 |
| src/styles/app.css | 引入 Fluent token/组件层 |
| src/app/App.tsx | 设置页 Ctrl+S、分层 Esc、读取确认 |
| src/app/GlobalNav.tsx | 图标导航 aria-label + Tooltip |
| src/composer/Composer.tsx | 四个下拉接 useDismissable |
| src/session/SessionHeader.tsx | 菜单关闭改用 useDismissable，补 Esc |
| src/settings/SettingsView.tsx | 标题去重、脏标记、读取确认、Select/NumberInput 替换、主题本地化 |
| src/settings/store.ts | reloadPending / requestReload / confirmReload / cancelReload |
| src/settings/controls.tsx | Switch 改为 Kobalte 版本；TextInput 增加 autocomplete/spellcheck |
| src/settings/byok/Sections.tsx | BYOK 下拉/数字输入替换；档案操作在 dirty 时禁用 |
| src/lib/theme.ts | 记录 Mica 可用性到 html.has-mica |
| src/lib/strings.ts | 简化暴露后端实现细节的文案 |
| src/index.tsx / src/stress.tsx | 使用统一 markPlatform |
| src-tauri/src/lib.rs | set_window_theme 返回 bool |
| tests/genui-decoder-fuzz.test.ts | 20k 轮 fuzz 超时从默认 5s 调到 30s |

## 4. 用户可见的变化

- 设置页：左侧分区导航 + 卡片式内容；下拉是 Fluent 列表而不是浏览器弹窗。
- 设置页：切换分区保留未保存草稿；顶部有「N 项未保存」。
- 重新读取：有未保存改动时先弹确认条。
- 设置页 Ctrl+S 保存；Esc 先退确认条、再关设置。
- Composer 的 profile / workspace / context / effort 菜单：点外部、按 Esc 都会关。
- 数字字段失焦才提交，不会一边输入一边吞值。
- 全局图标导航在 Windows 下是 48px 图标栏，有 Fluent Tooltip。
- Toast 移到右上，不再压住输入区右下角。
- 主题/字体/材质即时生效，且只保存在本机。
- 无 Mica 的系统自动回退实底，不会透出桌面。

## 5. 验证记录

命令：

    pnpm typecheck
    pnpm test
    pnpm build
    cargo check -p qaqh-webui-app

运行时（headless Edge + CDP）已实际验证：

- Kobalte Select：点击打开、Esc 关闭、外部点击关闭、选中后触发器回显。
- Composer profile 菜单：打开、外部点击关闭、Esc 关闭。
- Fluent Switch：渲染为 40×20，点击切换 data-checked。
- 设置重新读取：制造 1 项脏改动后点击，出现确认条。
- 导航 Tooltip：hover 500ms 后出现「消息」。
- 设置页 / 消息页 1280、1920 截图通过。

视觉预览：

    pnpm exec vite --host 127.0.0.1
    node scripts/visual-capture.mjs
    QAQH_VISUAL_FILTER=settings node scripts/visual-capture.mjs

浏览器预览能看到 Fluent 布局，但看不到 Mica；Mica 必须在 pnpm exec tauri dev 里验收。

## 6. 已知问题与风险

1. Kobalte 2 仍是 alpha：API 可能变，已 pin 版本；升级前重跑 Select / Switch / Tooltip。
2. 设置页仍是显式保存：不是逐项自动保存；目前只有 Ctrl+S、脏标记、重载保护。
3. 主包增大：Kobalte 共享依赖进入主 chunk（约 +42KB，gzip +15KB）；SettingsView 仍懒加载。
4. Tooltip 只接了导航：正文里的 title 仍是原生 tooltip。
5. 系统 accent 未接入：仍是 WinUI 默认蓝 #005fb8 / #60cdff。
6. 没有自定义 titlebar：这是有意的，先保留系统 Snap / 圆角 / 主题。
7. 640px visual-capture 仍有一条对齐断言失败：桌面窗口 minWidth=900，不影响实际使用。
8. 右键菜单仍部分依赖 WebView 原生菜单：输入框/可编辑区目前直接返回 null，会弹 WebView 自带菜单；复制全文、复制代码引用、复制整段回答等细节也还没有。

## 7. 下一步：右键菜单（摘要）

详细方案见本次会话说明。核心结论：

- 当前 src/ui/contextMenu.tsx 只处理选中文本、代码块、复制路径、链接；可编辑区交给原生菜单。
- 要完全替代，先扩 ContextMenuItem 为 item / separator / submenu，并补 editable 动作（撤销/重做/剪切/复制/粘贴/全选）。
- 打开菜单前保存 activeElement 与选区，关闭后恢复；动作作用于保存的元素，否则焦点会被菜单按钮抢走。
- 剪贴板：复制用 navigator.clipboard.writeText；剪切/撤销/重做用 execCommand；粘贴优先 clipboard.readText，失败时用官方 tauri-plugin-clipboard-manager。
- 不要用 AreDefaultContextMenusEnabled(false) + HTML 菜单的组合：该开关会关闭整条 WebView2 菜单管线，ContextMenuRequested 不再触发，也可能让 JS 的 contextmenu 自定义菜单失效。正确做法是保留默认开关，在 document 的 capture 阶段对所有 contextmenu 调 preventDefault，再渲染 HTML 菜单；宿主开关只适合完全交给宿主画菜单的场景。
- 自定义菜单会丢掉 WebView 的拼写建议；后续可用 Windows Spell Checking API 补回。

### 7.1 必须补的复制细节

当前只覆盖“复制选中文字”和“复制代码块”，以下都要补齐：

| 场景 | 菜单项 | 复制内容 |
|---|---|---|
| 消息 / 回合 | 复制全文 | 该条消息的完整 Markdown 源文，保留标题、列表、链接、代码围栏与换行 |
| 消息 / 回合 | 复制整段回答 | 仅 assistant 最终回答，不含工具步骤、思考过程与折叠区 |
| 消息 / 回合 | 复制为引用 | 逐行加 > ，可附带来源（会话名 / 轮次 / 时间） |
| 选中文本 | 复制、复制为引用 | 选中内容原样；引用版逐行加 > |
| 代码块 | 复制代码 | 纯代码，不带围栏、不带行号，保留缩进与结尾换行 |
| 代码块 | 复制代码引用 | path:line 或 path:start-end + 语言名 + Markdown 围栏 + 代码 |
| 代码块 | 复制为 Markdown | 带语言围栏的代码块，可直接贴进文档 |
| 工具输出 / 终端 | 复制全部输出 | 完整原始输出，不受折叠、截断、虚拟化影响；默认复制纯文本 |
| 文件路径 | 复制路径、复制路径引用 | 路径；引用版为 path:line |
| 会话行 | 复制会话 ID、复制会话标题 | 原始 ID / 标题，方便在 issue 或日志里引用 |

### 7.2 复制格式约定

复制全文 / 复制整段回答：

- 使用 Markdown 源文，而不是 textContent。
- 代码块要带语言围栏；列表、引用、链接保持原样。
- 末尾保留一个换行，避免粘贴后和下一段粘在一起。
- 流式回合复制当前已经到达的源文，不等待整轮结束；按钮文案可以说“复制当前内容”。

复制代码：

- 纯代码，不带围栏、不带行号、不带高亮 span。
- 保留缩进、空行与文件本身的结尾换行。
- 如果代码被折叠或虚拟化，仍然按源文本复制。

复制代码引用：

- 第一行：path:line 或 path:start-end（没有路径时用“代码块”代替）。
- 之后：带语言名的 Markdown 围栏包住原始代码（语言未知时留空围栏）。
- 示例结构：路径行、空行、语言围栏、代码、闭合围栏。
- 目标是可以直接粘进另一个对话或 issue，读的人知道代码来自哪里。

复制为引用：

- 每行前缀 > ，空行写成 >。
- 可选在末尾追加来源行，例如：— session / turn / 时间。
- 不要复制渲染后的 HTML，复制纯文本 Markdown。

### 7.3 数据来源

不要从 DOM 的 textContent 取“全文”：

- 折叠区可能已卸载（Collapse 会卸载子树）。
- 虚拟化/分页只保留窗口内的条目。
- Shiki 高亮会把代码拆成大量 span，行号也可能混进 textContent。
- 流式回合的 DOM 只是当前可见片段。

建议加一个轻量复制源注册表：

- 组件挂载时 registerCopySource(id, () => string)。
- 元素上只挂 data-copy-id="..."，不把大段文本塞进 attribute。
- 右键菜单按 data-copy-id 取源文本；取不到时再退回 textContent。
- 代码块用 data-copy-code / data-copy-language / data-copy-path / data-copy-line，文件路径沿用现有 data-copy-path。

### 7.4 分阶段

- P1：全局 contextmenu preventDefault、可编辑区动作、焦点/选区恢复、复制全文 / 复制代码 / 复制代码引用 / 复制为引用。
- P2：图标、快捷键、子菜单、Home/End、typeahead、Fluent 视觉；会话/消息动作。
- P3：图片/文件动作、Windows 拼写建议、开发模式 Inspect。

### 7.5 参考

- Kobalte ContextMenu（Solid 原语，已安装）
- VS Code contextMenuHandler（imperative 菜单架构）
- Fluent UI React v9 Menu（ARIA / 视觉）
- fluent-svelte MenuFlyout / ContextMenu（WinUI 度量）
- electron-context-menu（Cut/Copy/Paste / Save Image / Copy Link / spellcheck 功能清单）
- WebView2 自定义右键菜单文档（ContextMenuRequested；不要和 AreDefaultContextMenusEnabled(false) 混用）

## 8. 复现与验收

1. pnpm install
2. pnpm typecheck && pnpm test && pnpm build
3. pnpm exec tauri dev
4. 设置页：切换分区、改数字后失焦、切换下拉、按 Ctrl+S、点重新读取。
5. 消息页：右键内容、打开 Composer 菜单后点外部 / 按 Esc。
6. 检查 Mica：有 Mica 时导航/侧栏应透出桌面材质；Win10 或无 Mica 时应为实底。

## 9. 给下一位工程师的注意事项

- 不要引入 peer 为 Solid 1 的 UI 库；先看 package.json 的 peer。
- 新控件优先复用 ui/Select、ui/Switch、ui/NumberInput、ui/Tooltip、ui/dismissable。
- Windows 视觉只写在 fluent.css 的 html[data-platform="windows"] 下，不要污染 macOS 基线。
- 设置页的 daemon 写路径仍然只有 config.save（Merge Patch）；不要整包写回。
- 外观偏好不要塞进 daemon patch；主题/字体/材质是本地偏好。
- 任何新的浮层都要满足：外部点击关闭、Esc 关闭、滚动/窗口失焦关闭、焦点可恢复。
- 右键菜单在禁用 WebView 原生菜单前，必须先补齐可编辑区的剪切/复制/粘贴/全选/撤销/重做。
- 复制全文/代码引用必须读源文本，不要读 DOM 可见文本；折叠、分页、虚拟化、Shiki 高亮都会让 textContent 不完整。
- 复制格式统一：全文=Markdown 源文，代码=纯代码，代码引用=path:line + 语言 + 围栏代码，引用=逐行加 >。
