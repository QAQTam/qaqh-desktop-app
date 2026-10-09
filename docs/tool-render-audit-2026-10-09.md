# Desktop 工具渲染精简审计与调整

## 结论

截图中的差异不是 stdio 被误识别成聊天正文，而是 **desktop 将工具展开态设计成了调试面板**：原始请求和响应一次性展示，缺少“语义详情 → 原始数据”的第二道折叠。Codex 截图展示的是紧凑工作记录；这里只对其可见信息层级作比较，不推断 Codex 内部实现。

`old_str/new_str` 是编辑请求的参数，不是执行结果；读取工具的文件全文是输出。两者都不应该在默认工作记录中占据整屏。此处 stdio 指命令 stdout/stderr，不是设置页 MCP 的 stdio 传输方式。

## 原渲染链路盘点

| 层 | 原逻辑 | 影响 |
| --- | --- | --- |
| timeline → Step | `session/reducer.ts`：`display.body` 优先，缺失时从旧 `output/diff` 回退；实时进度进入 `progressTail` | 后端确实传递了日志、文件内容和原始入参，前端不是凭空生成 |
| 工作段 | `turn/TurnView.tsx`：活动工作段默认展开；回复边界关闭工作段；思考详情另有折叠 | 外层“工作过程”展开并不等于只显示摘要 |
| 工具行 | `tools/StepRow.tsx`：普通工具默认收起；组件初次挂载时若已失败则展开 | 历史失败编辑会立即暴露大段参数；运行中后来失败并不会自动展开 |
| 单行摘要 | `tools/registry.ts`：header → 已知参数 → 原始 argsJson；中文名称仅映射工具名 | 未识别参数可能连整份 JSON 都进入摘要/title；`display.summary` 没有成为最终回退 |
| 输入详情 | shell 展示命令；其他工具 `Object.entries(args)` 无选择逐项展示 | `old_str/new_str/content` 和普通 path 同等级，被全文铺开 |
| 输出详情 | `ToolDetail` 直接挂载 text、diff、实时进度、stderr、exit code、error | shell 日志、read 文件全文都一次展开；原判断中 `status !== running || true` 实际恒真 |
| body 分类 | text → 文本；shell/streams → stdio；diff → DiffList；subagent → 名称/会话 ID 文本；默认分支 → legacy | 显式 `body:none` 也误入默认分支，恢复旧 output |
| 折叠/样式 | `ui/Collapse.tsx` 收起后卸载；原 `.tool-text` 普通输出没有统一限高；参数表无限高 | 已收起工具不是巨大隐藏 DOM 问题；主要问题发生在展开后的信息密度 |

工具页 `app/ToolsPage.tsx` 是能力目录，不是调用时间线；审批 `approval/ApprovalCards.tsx` 是独立决策界面。本次不改变授权信息或协议，也不改事件顺序与工作段分组。

## 当前规则（第二轮收敛，替代初轮二次折叠方案）

| 工具类别 | 用户可见内容 | 不再渲染 |
| --- | --- | --- |
| read/write/edit/patch | 对象绝对路径；成功后由后端确认的 diff | 原始参数、old/new 字符串、读取全文、工具收据 |
| exec | 命令摘要；运行 progress；终态 stdout/stderr | 原始 JSON、重复的命令输入块、进度与终态重复叠加、常规退出码细节 |
| todo | 已更新待办 / 已创建待办 / 已读取待办 | 完整待办参数、ID、收据 JSON；清单由待办面板展示 |
| skills | 已调用 skills / 已读取 skills | 技能全文、资源路径、激活协议与参数 |
| 通用工具 | 紧凑摘要与必要失败诊断 | 原始请求/响应和工程调试入口 |

原始参数渲染组件与入口已删除，不只是默认折叠。文件全文也没有隐藏的展开入口；请求数据仍留在 store 供协议使用，不再进入用户可见详情。文件对象路径只显示在卡片顶层，结果内不再另设重复路径块；没有 diff 或诊断时不展示空折叠入口。

### 结果真实性

- 文件路径优先取后端 header / diff 文件清单，兼容 path/file_path/file/filename；相对路径以工具明确 cwd/workdir 或当前会话目录解析。支持 Windows、UNC、Unix、多文件和父路径。旧归档若既无绝对路径也无 cwd，只能保留真实相对路径，不能借浏览器 location 或开发者机器目录伪造绝对路径；这是当前数据契约限制。
- 只显示成功终态的权威 diff；失败请求的 old_str/new_str 不转换成“修改结果”。移除流式参数行数估算，保留成功结果的权威行差。
- exec 默认展开输出；progress 按 timeline 事件到达顺序呈现。终态 output 到来即替换旧 progress；没有终态 output 则保留最后 progress 尾窗。终态重复投影也会刷新，而非只在状态第一次改变时更新。
- 后端 Streams 的 interleaved=false 不承诺交织时序，因此 stdout/stderr 分区，不伪造重排。不会将两份内容反复拼接。
- 活动输出自动跟随末尾；用户上滚可停随。日志局部限高；用户折叠意图不被终态重置，关闭后仍卸载子树。
- 下一段 assistant 文本开启时，上一工作段播放约 140ms 高度收缩＋淡出的回收动画，随后卸载工具详情；回复 Markdown 不重挂。历史闭合段直接展示收起态，减少动态效果时不播放视觉过渡。自动收起只处理 open→closed 边界，完成事件不能再次覆盖用户重开旧工作段的意图。
- skills 按后端当前 skill_activate / skill_list / skill_resource 三件套识别；read 读取 SKILL.md 同样只展示读取 skills 的语义。
- todo_write 是全量覆写，不据此宣称创建；使用“已更新待办”。只有明确创建动作使用“已创建待办”。失败/运行中不加“已”。
- 错误诊断、拒绝状态与授权等待仍保留，避免用成功语义掩盖失败。

### 顺带修正 ANSI 输出泄露

原 ANSI 解析对 fg/bg=null 调用 includes 会异常，回退为控制码原文；现在正确处理默认/复位槽，将 RGB 三元组转为 CSS 颜色，并保留多重装饰。同样式片段合并，避免同色逐行 reset 导致过多节点。

## 验证与产物

- pnpm run typecheck：通过。
- pnpm test：15 个测试文件、156 项通过；覆盖绝对路径、多文件、语义状态、progress → 终态替换/重刷新、none 回退与 ANSI。
- pnpm run build：通过；既有大 chunk 提示未改。
- node scripts/tool-render-check.mjs：浅/深色 × 1000/480px 的真实 StepRow 全通过。覆盖无原始参数/文件全文、skills/todo 纯语义、实时/终态输出替换、ANSI 无控制码、折叠卸载、成功 diff 与无横向溢出；此组件夹具无运行时 warning/error。
- 最新 12 张真实渲染截图：artifacts/tool-render-review/semantic/（default、diff、terminal）。上层目录的 16 张是初轮方案记录，不代表当前界面。
- 复现：pnpm dev 后访问 /tool-render-check.html?theme=light|dark。dev-only 夹具不连接 daemon，也不进入生产打包入口。
- 完整 SessionView/TurnView 的 progressSmall 压力回归也跑过：150 个 progress chunk、无横向溢出、采样无 jank。结果保存于 semantic/progress-regression.json。完整夹具仍报告 SessionView/preview 既有未跟踪读取，以及 ANSI 列表的 HOT_SCOPE_TIME 累计开销告警；不将此压力检查称为“所有诊断已清零”，也未关闭诊断或提高阈值。

验证范围为 renderer 与 Headless Edge，不是已安装 Tauri/WebView2 的端到端重打包。没有改后端、审批规则或其他不相关工作区修改。
