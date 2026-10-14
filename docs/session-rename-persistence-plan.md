# 会话重命名持久化 — 方案B(后端 `session.rename`)落地计划

> 状态:**已落地**(2026-10-14)。daemon `session.rename`(WRITE_SEEDED)+ 宿主
> `SERVICE_METHODS` 白名单 + 前端 `commitRename` RPC 全链贯通;方案A 保留为
> 乐观显示与断线兜底。已知窄窗口竞态:会话首回合内的 LLM 标题总结若晚于
> 用户重命名完成,仍会覆盖用户标题(§2.1 写侧保护待后续收紧)。

## 1. 背景与现状

- SessionHeader 的内联重命名目前走**方案A**:写 `localStorage["qaqh.session.title.<seed>"]`
  并投影到侧栏目录,展示优先级为**后端标题恒优先** —— 用户重命名只在 daemon 尚未
  生成标题(`title_changed` 尚未到达)前有效。
- 缺口:重命名不进 `SessionMeta`,后端生成标题后本地覆盖自动退场;且跨端
  (TUI / 其他客户端)不可见。要真正持久化,必须由 daemon 落盘。

## 2. 方案B 设计

### 2.1 daemon 侧(qaqh-daemon,本仓库外的 sidecar)

新增 service 方法 `session.rename`:

- 语义:会话级写,**WRITE_SEEDED** —— `session_id` 由参数显式携带,不做 active seed
  注入(与 `workspace.move_session` 同类,daemon 按 seed 做归属校验)。
- 行为:写 `SessionMeta.title`,`TitleSource::User`;向 meta 频道广播
  `MetaDelta::TitleChanged { title, source: "user" }`。
- 幂等:同名 no-op,不递增 revision。
- 写侧保护:若当前标题 `source == user` 且调用方未再次声明 user 语义,
  拒绝被 auto-title 覆盖(auto-title 只在 source 为空/auto 时可写)。

### 2.2 宿主侧(`src-tauri/src/commands.rs`)

- `SERVICE_METHODS` 白名单(L20 起)追加 `"session.rename"`。
- `service_requires_session`(L78)**不豁免**也行(缺 seed 时注入活动会话是合理
  默认),但更推荐与 `workspace.move_session` 同批豁免 —— 侧栏可能重命名的是
  非活动会话;前端永远显式传 seed(`rpc(..., seed)`),两条路都通。
- 无需新的 Tauri command:复用既有 `service_rpc` 透传面。

### 2.3 前端(`src/session/SessionHeader.tsx` + `src/tabs/store.ts`)

- `commitRename` 改为:
  `await transport.rpc("session.rename", { title: next }, props.tab.seed)`;
  回灌完全依赖 title_changed echo(`onSessionTitleChanged` 既有路径,零改动)。
- 删除方案A:`TITLE_PREFIX`/`readStoredTitles`/`localTitleOf`/
  `renameLocalSession`/`applySessionList` 的本地叠加逻辑与
  `src/session/title-override.ts`;`applySessionList` 退回直写 `setSessionCatalog`。
  localStorage 旧键无需迁移,后端标题到达后自然不再被读取,可在下一个大版本清理。
- `TitleSource` 语义已经就位(`src/api/qaqh/TitleSource.ts`:
  `"user" | "auto" | "migration"`),`MetaDelta.title_changed` 已携带 source,
  前端如需区分「他端重命名」可按 `source === "user"` 做轻提示。

## 3. 竞态与边界

| 场景 | 行为 |
| :--- | :--- |
| rename 与 auto-title 同时在飞 | 后端按 revision 单调化;auto-title 写侧保护(§2.1)保证 user 标题不被覆盖 |
| rename 目标会话已删除 | daemon 报 unknown_session,前端 toast,本地不动 |
| 断线时 rename | rpc 失败,方案A 的本地覆盖仍兜底显示(若方案A 已删则回退旧标题) |

## 4. 为什么现在不做

daemon 是外部 sidecar(`binaries/qaqh-daemon`,Tauri `externalBin`),新增 service
方法要改 daemon 侧分发表,跨仓库改动;方案A 已消除用户可见的「重命名即丢」,
方案B 属于跨端一致性收尾,独立成 PR。

## 5. 验收清单

1. `pnpm run typecheck` / `pnpm run test` / `pnpm run build` 全绿;
2. 手动:重命名 → 刷新页面 → 标题保持(来自 SessionMeta);
3. 手动:重命名 → 首个 turn 完成 auto-title 到达 → user 标题不被覆盖;
4. 手动:TUI 侧 `session.list` 能看到 user 标题。
