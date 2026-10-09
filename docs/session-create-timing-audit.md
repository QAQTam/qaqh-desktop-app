# 会话创建时机与工作区归属：前端根因 + 请求后端裁决的三项契约提案

审计日期：2026-10-09。
基线：桌面仓 `main@dd5e1d5` **加工作树未提交改动**（"工作区"功能整体尚未提交，本文描述的前端行为以工作树为准，不以 dd5e1d5 为准）；后端只读参考 `E:/qaqh-backend` `main@dd57215`（该仓工作树另有未跟踪的 `.zcode/`、`prompt.md`，非本文产物）。
口径：本轮只读后端，未改变后端源码、配置或数据；本报告保存在桌面仓库。

---

## 0. 结论与请求（先看这段）

**用户报告的现象"改了工作区后端没收到"，后端无缺口。** 根因在前端两处，但前端要根治它，需要后端裁决三项契约（P1/P2/P3）。

- **不是后端没持久化**：`meta.cwd` 逐会话落盘、`workspaces.json` 记录归属、`session.list[].workspace_id` 回传，全部在位。
- **不是后端不在流里发**：时间线流不带会话级元数据是分层正确；会话元数据另有推送面（`metadata_changed` → 前端重拉 `session.list`），且创建后前端会立即重拉。
- **是前端**：① 点「新建会话」就立即建（时机太早），picker 改的是"下一条的种子"；② "新建会话的目标工作区"只存在内存 signal 里，刷新即归零。

请求后端裁决：

| 提案 | 内容 | 为什么需要后端 |
| --- | --- | --- |
| **P1** | `session_create` 接受可选 `first_input`，一条命令完成 create + 首条发送 | 消除"先建空会话、再单独发消息"的两步窗口，这是空 cwd/孤儿会话的结构性来源 |
| **P2** | "draft 会话"语义：可提前建、但**不进列表、不计入归属**，未提升即回收 | 前端想预热 agent 启动却不想污染 `session.list`。**后端可能已有八成**（见 §6） |
| **P3** | 让 `session.new` 算出的 `session_id` 能到达前端 | 现在拿不到，前端只能轮询 6 秒撞 diff（见 §7） |

---

## 1. 现象

用户在桌面端新建对话时选择了工作区，结果：① 侧栏里该会话仍归「未分组」；② 刷新整个 Tauri 页面后，输入框的工作区选择又回到「不设置」。用户怀疑是后端不支持"每个对话切换不同 cwd"。

## 2. 现场证据（本机 daemon 数据，只读）

数据目录 `C:\Users\tsy3m\.qaqh`：

| 事实 | 证据 |
| --- | --- |
| 工作区已注册，但没挂任何会话 | `workspaces.json`：`E:\win-sandbox-rs` 的 `session_ids: []` |
| 那次新建**压根没带 cwd** | `sessions/01a11ec1-…/meta.json` 无 `cwd` 键；`events.jsonl` 首条 `session_created.cwd = "C:\Users\tsy3m\AppData\Local\QAQ-Harness"`（daemon 兜底值，非用户所选） |
| 管线本身是通的 | 同目录另外两条会话 `meta.cwd = "E:\qaqh-backend"`，且在 `workspaces.json` 里正常挂着 |
| 时序 | 注册工作区（`ws-1791517319795`）→ **34 秒后**才建会话，而这次 cwd 是 null |

即：不是"传了被后端丢掉"，而是**请求发出的那一刻 cwd 已经是 null**。

## 3. 后端现状盘点：能力齐备，无缺口

逐条核对（后端仓）：

| 能力 | 位置 | 核对结论 |
| --- | --- | --- |
| 创建请求带 cwd | `qaqh-domain/src/command.rs:49-55` `SessionCreate { close_current, cwd, tool_mode, custom_tools }` | 字段在位 |
| 每次创建都读 cwd | `qaqh-runtime/src/service.rs:385-396` `params.get("cwd")` → `allocate_session(cwd.as_deref())` | **每次都读**，无"仅首条生效"分支 |
| cwd 逐会话落盘 | `qaqh-session/src/manager.rs:866` `meta.cwd = cwd.map(canonical_cwd)` | `SessionMeta.cwd` 是 per-session |
| 创建即自动归属 | `manager.rs:874-879` `if index_session { … attach_by_cwd(session_id, cwd) }`；`grouping.rs:278-292` | 相等或子目录即认领，已属他处则迁移 |
| 归属回传 | `service.rs:883` `session.list[].workspace_id = workspaces.workspace_of(…)` | 前端侧栏就吃这个键 |
| 事后改会话 cwd | `service.rs:486-501` `workspace.set` → `set_cwd(path, true)` + `AgentReloadConfig` | **后端支持，但前端从未调用**（只在注释里提到） |

**结论：per-conversation cwd 后端支持得很好。** 本文的后端请求不是"补缺口"，而是"减少前端对错误的容忍面"。

## 4. 根因（前端）

**① 创建时机太早。** `+` / Ctrl+T（`src/app/App.tsx:355`、`:199`）→ `createSession()` **立即**用当时的 `newSessionCwd()` 创建（`src/tabs/store.ts:144-149`）。会话建好后 Composer 才带工作区 picker 出现（`App.tsx:447-456`），此时改 picker 只改"下一条的种子"——`store.ts:51-55` 的注释自陈"只作用于**新建**"。用户在会话页改工作区并继续在该会话发送，必然"改了没生效"。

**② 选择不持久化。** `newSessionCwd` 是模块级 `createSignal`（`store.ts:57`），写点只有两处（`:200`、`App.tsx:326`），**不落任何存储**。全仓在用的持久化只有 `localStorage` 两处（`lib/theme.ts:87`、`lib/visual.ts:28`）与设置项 `config.save`。刷新重建模块 → 归零 → 显示 `workspaceUngrouped`（"不设置"）。

**③ 先建后输入，与成熟实现的准入规则相反。** 现在是"建会话 → 等用户输入"，没有任何"空输入拒绝"环节，于是每次点击都留下一条真实会话。

## 5. 提案 P1：`session_create` 接受可选 `first_input`

**动机**：把"创建"和"发首条消息"合成一条命令，是消除空 cwd / 孤儿会话的结构性做法（现在前端必须两步，中间那一瞬就是空的）。

**契约建议**：

```
SessionCreate {
  close_current: bool,
  cwd: Option<String>,
  tool_mode: Option<String>,
  custom_tools: Vec<String>,
  first_input: Option<FirstInput>,   // 新增；缺省 = 只建会话（现状）
}
FirstInput { text: String, attachments: Vec<…>, … }
```

**准入规则**：带 `first_input` 但文本与附件皆空时，**必须在落盘前拒绝**，不得留下无效会话（参考实现的设计动因原文见 §8）。

**影响面**：`qaqh-domain/src/command.rs:49`、`qaqh-runtime/src/service.rs` 的 `session.new` 分支、以及启动首轮 turn 的写路径（需与 `conversation_send_message` 复用同一条 prompt-turn 路径，避免两套写逻辑）。

**待裁决**：放进既有 `SessionCreate` 还是新增独立命令？若复用 `SessionCreate`，是否要让"带 first_input 的 create"直接产出 **indexed** 会话（一步到位），而"不带 first_input 的 create"默认走 P2 的 draft 语义？

## 6. 提案 P2：draft 会话语义 —— 后端可能已有八成

前端想"提前建会话以预热 agent 进程"，但不想让它污染侧栏。**后端已经存在一条"不进索引、不归属、不进列表"的创建路径**：

- `qaqh-session/src/manager.rs:896-903` `allocate_agent_session(cwd)` → `allocate_session_with_index(cwd, false)`
- `manager.rs:862` `meta.ephemeral = !index_session`
- `manager.rs:874-879`：`if index_session` 之外分支**既不 `upsert_index` 也不 `attach_by_cwd`**

也就是说 `index_session=false` 已经能造出"对 `session.list` 不可见"的会话，只是它现在绑在 **subagent** 语义上，且 `ephemeral` 的生命周期由调用方的 V2 策略决定。

**待裁决**：
1. draft 直接复用 `index_session=false` 这条路，还是新增显式的 `persistence: deferred | immediate` 字段（语义更自述，但要动 wire 与 `SessionMeta`）？
2. **回收责任在谁**：未被提升为 indexed 的 draft 由 daemon 超时回收，还是由 client 显式 `session.delete`？参考实现是 client 侧状态机回收，且明确规定"pending 态不得回收"（避免误杀正在首发的会话）。
3. 是否允许**事后提升**（draft → indexed + 归属），即首条消息 admitted 时才真正进入 `session.list` 与被 `attach_by_cwd`。

## 7. 提案 P3：让 `session.new` 的 session_id 到达前端

**现状**：`service.rs:431` 的 `session.new` 分支**已经算出并返回** `Ok(json!(session_id))`，但：

- `qaqh-ringing/src/envelope.rs:23-35` 的 `RingingCommandAck` **只有** `command_id / status / code / message / retry_after_ms`，**没有结果字段**；
- 前端 `src/lib/transport/tauri.ts:71-76` → `commands.rs:301-317` → `ack_to_result`（`commands.rs:98-110`）序列化整个 ack，拿不到 `session_id`；
- 于是前端在 `src/tabs/store.ts:150-159` **轮询 `session.list` 最多 20×300ms = 6 秒**去 diff 出新 seed；`commands.rs:296` 的注释自陈"新 seed 由前端轮询 sessions diff 发现（与现状一致）"。

**另有一条可能已通的路**（**未验证，请裁决时确认**）：`qaqh-runtime/src/ringing/pending_store.rs:42-52` 的 `CommandReceipt` 有 `result: Option<RingingV2CommandResult>`，注释称"ACK 丢失后重放 command_id 或轮询 `command_status` 时返回"。若控制通道的 create 确实落 receipt 且有可用的 `command_status` 查询入口，则**不必改协议**，前端改走该入口即可省掉轮询。

**待裁决**：是给 ack 加结果字段（改 ring envelope，影响面大），还是确认 receipt/`command_status` 路径可达并让前端改用它？本机 `ringing-command-receipts.json` 里**没有** `session_create` 条目，倾向说明当前控制通道未落 receipt。

## 8. 参考实现：ZCode v3.14.3（`E:/ZCode`，Apache-2.0）

成熟实现的做法（本地只读参考，非本文改动对象）：

| 设计点 | 位置 | 做法 |
| --- | --- | --- |
| 点击不建会话 | `packages/ui/src/store/zcodeSessionStoreWorkspaceSlice.ts:510` | `startDraft()` 只重置本地草稿态，**零 RPC**；同入口重复点击**复用同一草稿实体**（`:565-580`） |
| create + 首发一条命令 | `packages/shared/src/zcode-protocol-v4/command.ts:44-56` | `createSession { workspaceId, firstInput? }`；注释："firstInput 缺省 → phase=draft 空会话；携带 → 直接 turnHeader+userInput rows" |
| 创建与持久化解耦 | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-mgmt.ts:25-27` | "新会话一律 deferred（不进 sqlite），首条发送时由 prompt-turn 提升 immediate" |
| 提升时机 | `…/commands/prompt-turn.ts:87` | `if (record.persistence === "deferred") record.persistence = "immediate";` |
| 空输入建前拒绝 | `session-mgmt.ts:43-49` | "完全空的 firstInput 必须在创建 record 前拒绝，避免失败请求遗留无效 deferred session" |
| 未提升自动回收 | `packages/ui/src/v4/composer/useDraftSessionPrewarm.ts:53-67,135-144` | 仅 `promotionState === "draft"` 才回收；pending 必须等原命令收口，避免误杀运行中会话 |
| 归属粒度（不适用我们） | — | ZCode **没有** per-session cwd/worktree：workspace 绑在 pane/tab，一个 workspace 下所有会话共用一个 cwd |

**对本提案最直接的两条**：draft 期不建真会话；目标 workspace 在 draft 头部可切换，并**把已输入的草稿迁移到目标 workspace**（`packages/ui/src/layout/WorkspaceShellLayout.tsx:1128-1135`）。

注意 ZCode 用**更粗的粒度**（per-pane workspace）绕开了"建会话时必须知道 cwd"这个矛盾；本项目选了更细的 **per-session cwd**，因此必须配套延迟创建或 draft 语义，二者至少取一。

## 9. 需要裁决的问题清单

- [ ] **P1**：`first_input` 放 `SessionCreate` 还是新命令？带 `first_input` 的 create 是否直接产出 indexed 会话？
- [ ] **P2**：draft 复用 `index_session=false`，还是新增 `persistence: deferred | immediate` 字段？draft 的回收责任在 daemon 还是 client？是否允许事后提升？
- [ ] **P3**：给 ack 加结果字段，还是让前端改走 `command_status` / receipt？（请顺便确认控制通道的 create 当前是否落 receipt）
- [ ] 是否需要后端支持"已建会话改 cwd"的**前端可达面**（`workspace.set` 已存在但前端未接，本身无需后端改动，仅确认其语义边界：它会触发 `AgentReloadConfig`，适合"空会话改运行目录"吗）？

## 10. 本轮未验证项（不要当结论用）

- **receipt / `command_status` 路径是否对控制通道可达**：只读到了结构与注释，未实测调用（见 §7）。
- **`first_input` 与现有 `conversation_send_message` 的写路径能否复用**：未读透 daemon 内部 prompt-turn 实现，P1 的影响面估计可能偏小。
- 后端仓工作树另有未跟踪文件（`.zcode/`、`prompt.md`），未纳入本次只读范围。
