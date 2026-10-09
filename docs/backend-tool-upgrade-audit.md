# 后端工具升级与合规盘点

审计日期：2026-10-08。基线：`E:/qaqh-backend` 的 `main@bba13cc`。
口径：“违规”指不符合现有 SDK 约定或 RC 架构不变量，不表示违法，也不等于已证明可利用的安全漏洞。
本轮只读审计后端；报告保存在桌面仓库，未改变后端源码、配置或数据。

## 1. 你记得的升级计划

主记录：[工具体系现代化研究与实施记录](E:/qaqh-backend/docs/archive/research-tool-system-modernization-2026-10-06.md:211)。
早期交接：[Tool SDK v2 P1/P2](E:/qaqh-backend/docs/archive/tool-sdk-v2-2026-10-06.md)。
后续施工单：[架构收敛 CLEAN-0–7](E:/qaqh-backend/docs/spec-architecture-convergence.md:412)。
判定标准：[架构不变量 I1–I21](E:/qaqh-backend/AGENTS-x.md)。它是本次审计依据，不将历史文档中的派工或删除命令当作用户授权。

| 阶段 | 当前代码核对 | 判定 |
| --- | --- | --- |
| P1 typed 工具、Args 生成 schema、skills 拆三、能力表 | SDK、工具实现与注册表存在；40 个原有工具迁移与记录相符 | 主体完成，不能把全部工具说成仍是旧 SDK |
| P2 SDK/permission/fs/git/file/process crate 拆分 | 各 crate 与门面 re-export 存在 | 结构拆分完成；ambient/TLS/fn 钩子仍在，并非架构收敛完成 |
| P3-1 Deferred/tool_search | API、prepare 拦截、搜索与提升存在；`defer_tools` 全 crates 搜索仅测试调用 | 框架实现，当前未找到生产启用 Deferred 的调用点 |
| P3-2 MCP 名字空间聚合 | `aggregate_mcp_namespaces` 实现与测试存在；全 crates 搜索仅实现和测试调用 | 未找到生产接线；实施记录也明确把接入留给调用方 |
| P3-3 exposure 过滤 | `all_defs` 过滤存在 | 机制已实现，不代表实际开启按需工具暴露 |
| 后续 CLEAN-1–7 | 施工单记录未实施；当前代码仍保留其针对的关键路径 | 未完成，不能用归档 SDK “完成”代替 RC 完成 |

## 2. 已确认的问题

### A. todo_write / todo_update：变更通知断链（当前用户可见问题）

- 成功写入后仍构造旧 `DashboardUpdated`，actor Ringing 分支不再广播事件本体。
- v2 的 `WorkspaceResourceChanged(Todo)` 有类型、校验、消费与测试，无当前 Todo 写入生产者。
- service `todo.set` / `todo.cancel` 与 Goal 相关 `save_todo` 路径同样需要纳入正式变更发布契约。
- 修法：所有成功持久化入口统一产出 canonical 资源 fact，不重新启用旧 dashboard 广播。
- 依据：I7/I8，CLEAN-2/3。详情见 [刷新链审计](todo-refresh-audit.md)。

另：Todo 使用进程级 `TODO_LOCK`，持锁读写 todo.json；写采用临时文件+rename，未见文件 fsync。前两项与 I10/I11 的目标不符；fsync 是否需要由 Todo 作为 canonical 数据还是可重建投影的最终归属决定，不能把现有 todo.json 写入称为完整 durable-before-publish。

### B. tool_search：SDK 单源约定的明确例外，且有实质漂移

- `manager.rs::register_tool_search` 手写输入 schema，直接插 `builtins`，不走 `register_typed`。
- `prepare_req_with_cancel` 手工取 `query` / `max_results`：缺失/类型错误会缺省，不遵守 schema 的 required query / integer 约束；`additionalProperties: false` 也没有 typed Args 的解析来落实。
- 能力表为 READ_ONLY（Parallel / 幂等 / 1s），注册和 prepare descriptor 却是 `ToolCapabilities::default()`（Serial / 非幂等 / 5s），已有两个事实源。
- 搜索还会改变 Deferred exposure，应明确其注册表副作用，而非仅因名字叫 search 就认定全路径纯读。
- 修法：Args/schema/校验/能力声明收回单源，明确 promotion 的执行边界。
- 证据：[prepare 特判](E:/qaqh-backend/crates/qaqh-workspace/src/manager.rs:523)、[手写登记](E:/qaqh-backend/crates/qaqh-workspace/src/manager.rs:1465)、[能力表](E:/qaqh-backend/crates/qaqh-tool-core/src/tool_capabilities.rs:128)。

### C. exec / process：取消不止一套

- exec direct 和 sandbox bypass 同时读取 per-call cancel 与 ambient `is_cancel()`。
- process wait 也同时读取 per-call cancel 与 ambient cancel。
- 当前功能有取消检查，不能说“完全不支持取消”；但不符合 I12 单一 CancelToken 树与 I10 显式状态目标。
- 风险：取消归属/生命周期复杂，存在残留状态与跨路径语义不一致的风险；本轮没有复现跨会话误取消。
- 证据：[exec direct](E:/qaqh-backend/crates/qaqh-process-tools/src/exec/direct.rs:331)、[process wait](E:/qaqh-backend/crates/qaqh-process-tools/src/process_registry.rs:833)。

### D. read_image 的附件登记路径：落盘失败静默降级

- `store_image` 返回 `()`；图片落盘失败只 warn 后 return，条目丢弃，调用者无法处理具名错误。
- actor 输入及恢复路径实际调用此函数。以后 peek 不到图片会表现为需要重新附加，但上传失败与图片离开上下文被混为同一种结果。
- 这是 I20/I21 所针对的失败路径，不只是排版/通知问题。
- 另有进程全局 session-keyed 图片表，属 CLEAN-4 的状态归属项；当前按 session 分键，不据此声称已发生串会话。
- 证据：[附件登记](E:/qaqh-backend/crates/qaqh-file-tools/src/read_image/mod.rs:61)。

### E. 文件/进程工具边界：结构拆分后仍靠隐藏状态与反向 fn 钩子

- 文件组 `hooks.rs` 的 ambient provider，进程组 exec 输出预算/process display provider，在 workspace 注册时注入 OnceLock 回调。
- 这与 I13 禁止运行时 fn 钩子绕过依赖方向的目标冲突，并保留 I10 的 TLS/ambient 来源。
- `read`、文件 mutation 的部分兼容入口仍从 current_workspace/current_session 重建 context。
- 不把这个结论扩展成“read/write/edit/apply_patch 的 typed handler 全部忽略 ctx”：主 typed handler 的显式 ctx 路径确实存在。
- 证据：[文件 hooks](E:/qaqh-backend/crates/qaqh-file-tools/src/hooks.rs:33)、[进程 hooks](E:/qaqh-backend/crates/qaqh-process-tools/src/hooks.rs:7)、[注入点](E:/qaqh-backend/crates/qaqh-workspace/src/registration.rs:36)。

### F. 多数工具共用的 canonical 持久化接缝：终态有了，正文归属没收齐

- `ToolRuntime::append_finished` 正常执行仍写 `output_ref: None`。
- 准入 intent 的 `effective_args_ref` 直接由 args hash 构造，当前此路径没有对应正文落盘步骤。
- 这是 shared runtime/CLEAN-3 问题，不是某个工具没有 TypedTool 的证明；`None` 本身也不直接违反“每个已存在 ref 必须可解析”，两件事要分开。
- 需要 canonical 输出/参数进入持久 blob，再提交引用它的 fact；终态字段不能代替可重建的结果内容。
- 证据：[参数引用](E:/qaqh-backend/crates/qaqh-runtime/src/agent/tool_runtime.rs:518)、[终态输出](E:/qaqh-backend/crates/qaqh-runtime/src/agent/tool_runtime.rs:597)。

## 3. 不应误判为违规的项目

- `todo_list` 是只读查询，缺“写变更推送”不是它本身的通知责任。
- todo 三件套的 typed run 已用 `ctx.session_id`；skills 三件套及文件工具主 handler 已有 typed/显式 ctx 路径。
- MCP/LSP 的 DynamicToolAdapter 是动态工具的合法入口；第三方 schema 不由本地 Args 生成是合理边界，不等于漏迁。
- `to_tool_result` 是当前统一收敛出口，不能因为兼容字样就删。
- ask/plan 交互终态已有近期修复，不能照抄旧 spec 的 E21 当作仍未修复的事实。

## 4. 实测与结论边界

- `cargo test -p qaqh-workspace --test tool_sdk_parity -- --test-threads=1`：1 passed。
- `cargo test -p qaqh-runtime --test tool_surface_schema_shape -- --test-threads=1`：1 passed。
- 测试只证明词表覆盖与 schema 形态，不能证明工具全部 typed、能力值与表相等、变更推送存在或失败不丢数据。tool_search 的问题恰好不在现有断言内。
- 未执行完整 fmt/clippy/workspace 门禁、全部工具运行、故障注入或已部署 daemon 实验。编译输出仍有 workspace/MCP/runtime 的 unused_* 告警，不声称严格 clippy 门禁通过。

## 5. 优先顺序

1. Todo 所有 mutation 入口的资源 fact，覆盖当前刷新故障。
2. read_image 失败显式传播；tool_search typed/schema/capabilities 收敛。
3. CLEAN-3 的持久 blob/工具结果/有效参数接缝。
4. CLEAN-4 的取消单树和显式状态、CLEAN-5 的 fn 钩子与门面收敛。
5. P3 接入：生产 Deferred 策略与 MCP namespace aggregation，单独验证上下文成本及刷新行为。

不要把这些合成“重做全部工具”的大改，也不要仅把归档文件改成已完成来代替接线与验收。
