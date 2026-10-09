# Todo 自动刷新链路审计

日期：2026-10-08。审计范围：桌面前端、Tauri 转发、相邻 `E:/qaqh-backend` 当前源码。未修改或重新部署后端。

## 根因

Todo 写入成功不等于当前 v2 客户端收到资源变更通知。

1. 后端 Todo 工具执行完成后，`qaqh-runtime/src/agent/engine_tool.rs` 和 `tool_runtime.rs` 仍通过 `emit_domain` 发 `ControlEvent::DashboardUpdated` / `DashboardSnapshot`。
2. `PacedEmitter` 把这些事件放进 `WriterEvent::Ringing` 队列；但 `qaqh-runtime/src/actor.rs::publish_worker_event` 的 Ringing 分支已移除 v1 广播，仅保留交互副作用和 activity tracker 更新。旧 dashboard 事件不会自动转换为 v2 fact，也不会传到桌面。
3. v2 资源投影支持 `FactPayload::WorkspaceResourceChanged`。`projection/resource.rs` 将其映射为 `ResourceDelta::WorkspaceResourceChanged`，`projection/replay.rs` 把该资源事件放到 tool 频道。
4. 本次搜索后端 crates 中该 fact 的使用，只找到类型、校验、消费和测试路径，没有在当前 Todo 写入生产路径找到生成它的代码。因此“前端监听 todo 资源变更”虽然匹配协议，却没有实际生产者触发。
5. `qaqh-client` → Tauri `events.rs` → `projection://event` → `SessionStore` 的转发链未见 Todo 专属过滤。前端此前只在激活、投影重置和 todo 资源变更时重读 `todo.list`；`tool_finished` 与 `turn_finished` 只刷新审批。这解释了刷新/切换会话才看见更新。

## 本轮桌面修复

- 收到真实 v2 control `tool_finished` 时刷新 Todo；该终态来自 canonical ledger，不依赖旧 dashboard 广播。
- conversation `turn_finished` / `turn_interrupted` 增加最终对齐；timeline 重新 open 时补读。原有激活、投影重置、资源变更刷新保留。
- `ToolFinished` 不携带工具名称，故不从模型输出或展示文案猜测工具身份。当前对工具终态统一失效 Todo RPC 读模型。
- 同一个 store 的 todo RPC 单飞；请求期间的新信号合并为尾随补读。被后续信号作废的响应不提交，避免异步旧数据覆盖新清单。
- RPC 失败或响应缺少 items 保留上一次成功数据并记录诊断，不误清空清单；真正的 `items: []` 才清空。已 dispose 的 store 不接受迟到结果。
- 不新增周期轮询，不改折叠状态，不从 timeline 展示输出提取 Todo 内容。数据唯一权威仍为 `todo.list`。

## 后端剩余覆盖边界

`qaqh-runtime/src/service.rs` 的 `todo.set` / `todo.cancel` 直接调用 workspace 写入，同样未在此路径看到资源 fact 产生。若外部客户端通过 service 直写且没有工具/回合终态，本轮桌面兼容修复不能保证即时推送，后续只能在重新激活/重连/相关事件时对齐。

完整后端修复应在所有 Todo 成功持久化入口生成 canonical `WorkspaceResourceChanged(ResourceKind::Todo)`，遵守先持久化后发布，覆盖工具、service、取消、全量替换与清空，而不是重新启用已退役的 DashboardUpdated 广播。此举需要后端资源版本、content ref 与 writer 约束的统一设计及后端契约测试。

## 验证

`tests/todo-refresh.test.ts` 覆盖宿主订阅回调到 Todo RPC 的更新、其他 session 事件隔离、回合结束清空、请求中多次失效合并、旧响应丢弃、失败后恢复及 dispose 后迟到响应。`tests/projection.test.ts` 锁定 v2 频道映射与刷新动作。

本轮验证是源码审计与可重复传输测试，不等同于已部署 daemon 上的真实写入实验。
