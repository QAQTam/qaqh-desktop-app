//! IPC 请求/响应面(plan §3 命令表)。`invoke_handler` 注册即白名单。
//!
//! 命令与前端 `TauriTransport` 方法一一对应;daemon token / lease 只存在于
//! Rust 宿主侧的 `qaqh-client`,任何命令都不向 webview 返回凭据。

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, State};

use qaqh_client::{
    ClientV2CommandAck, CommandOptions, ConversationCommand, ConversationInputPurpose,
    RingingCommand, RingingCommandAckStatus,
};
use qaqh_types::SessionListEntry;

use crate::challenge::{command_for, command_options};
use crate::daemon::{self, HostState};

/// `service_rpc` 方法白名单(与 gateway 代理面一致;未列入的方法拒绝)。
const SERVICE_METHODS: &[&str] = &[
    "daemon.version",
    "session.list",
    "session.meta",
    "session.activity",
    "session.dashboard",
    "session.get_activity",
    "workspace.get",
    "workspace.list",
    "fs.list",
    "fs.read",
    "todo.status",
    "todo.list",
    "plan.read",
    "plan.context_stats",
    "stats.token_usage",
    "git.diff",
    "git.branch",
    "git.branches",
    "git.file_diff",
    // 设置页读写面(qaqh-config-api 契约):全局配置 + profile 名录。
    // 档位不单开 `config.set_permission_level`——它与 `config.save` 的
    // permissionLevel 走同一个单写口与同一份 validate(service.rs:537-556),
    // 双写口只会让「未保存草稿」和「已生效档位」在 UI 里对不齐。
    "config.load",
    "config.save",
    "profile.apply",
    "profile.save_current",
    "profile.delete",
];

/// 这些方法之外都要注入 active session_id(gateway 语义平移)。
///
/// config.*/profile.* 一律豁免:配置是 daemon 全局态,与活动会话无关。注入会
/// 在无活动 seed 时(引导失败/零会话)直接报 `no_active_seed`,设置浮层就打不开了。
fn service_requires_session(method: &str) -> bool {
    !matches!(
        method,
        "daemon.version"
            | "session.list"
            | "session.activity"
            | "workspace.list"
            | "config.load"
            | "config.save"
            | "profile.apply"
            | "profile.save_current"
            | "profile.delete"
    )
}

/// `fs.*` 还需要 `scope_session_id`。
fn service_scope_session(method: &str) -> bool {
    method.starts_with("fs.")
}

fn string_of(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// ack 序列化 + rejected 判定(gateway 语义:rejected 视为错误抛给前端)。
fn ack_to_result(ack: ClientV2CommandAck) -> Result<Value, String> {
    let rejected = ack.status == RingingCommandAckStatus::Rejected;
    let value = serde_json::to_value(&ack).map_err(string_of)?;
    if rejected {
        Err(format!(
            "command rejected ({}): {}",
            ack.code.as_deref().unwrap_or("unknown"),
            ack.message.as_deref().unwrap_or("")
        ))
    } else {
        Ok(value)
    }
}

fn active_seed_of(state: &HostState) -> Option<String> {
    state.lock_active_seed().clone()
}

/// 侧栏卡片字段 = 前端 `SidebarSession`(src/tabs/store.ts)的同名镜像。
///
/// 展示面裁剪归桌面自己:字段集由这个类型声明,而不是后端与 TUI 共享的
/// `sanitize_session_list` 字符串白名单——那份白名单剥掉的 `workspace_id`/`cwd`
/// 正是侧栏分组与悬浮路径要吃的键,漏字段不报错,只让功能永远显示缺省值。
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct SidebarSession {
    session_id: String,
    title: Option<String>,
    cwd: Option<String>,
    updated_at: u64,
    turn_count: usize,
    busy: bool,
    archived: bool,
    workspace_id: Option<String>,
}

/// `SessionRunStatus` → 侧栏状态点的「还挂着事」判据。
///
/// 后端 2026-10-06 起用 agentloop 状态取代 `running: bool`(worker 进程存在性语义
/// 已废除,`qaqh-types/src/session.rs:251-280`)。差别是要命的:`idle` 是 loop
/// 空闲等输入;`not_running` 是**根本没加载**,不等于空闲;`canceled`/`error`
/// 只是上一回合的终态驻留。字段叫 `busy` 而不是继续叫 `running`,就是因为
/// 判据已经换了:回合在跑,或者卡在用户这一侧(授权/ask/计划评审)。
fn session_is_busy(status: qaqh_types::SessionRunStatus) -> bool {
    matches!(
        status,
        qaqh_types::SessionRunStatus::Working
            | qaqh_types::SessionRunStatus::WaitingPermission
            | qaqh_types::SessionRunStatus::WaitingAsk
            | qaqh_types::SessionRunStatus::WaitingPlan
    )
}

/// `session.list` 回包(前端契约 G2)→ 侧栏卡片。
///
/// 解码直接吃权威类型 `qaqh_types::SessionListEntry`:字段改名/删除(本轮就是
/// `last_summary` 被删、`running` 换成 `status`)在这里是编译错误,而不是像字符串
/// 白名单那样静默把某个功能永久留在缺省值上。
fn sidebar_sessions(raw: Value) -> Result<Value, String> {
    let entries = serde_json::from_value::<Vec<SessionListEntry>>(raw).map_err(string_of)?;
    serde_json::to_value(
        entries
            .into_iter()
            .map(|entry| SidebarSession {
                session_id: entry.meta.session_id,
                title: entry.meta.title,
                cwd: entry.meta.cwd,
                updated_at: entry.meta.updated_at,
                turn_count: entry.meta.turn_count,
                busy: session_is_busy(entry.status),
                archived: entry.meta.archived,
                workspace_id: entry.workspace_id,
            })
            .collect::<Vec<_>>(),
    )
    .map_err(string_of)
}

/// `() → Vec<SidebarSession>`(G2 条目投影;宿主细节不进 webview)。
#[tauri::command]
pub async fn session_list(app: AppHandle) -> Result<Value, String> {
    let client = daemon::ensure_connected(&app).await?;
    let raw: Value = client
        .service_v2("session.list", json!({}))
        .await
        .map_err(string_of)?;
    sidebar_sessions(raw)
}

/// `(seed) → ()`:attach(归属)+ 激活 timeline 流(单活动标签持流)。
#[tauri::command]
pub async fn attach(
    app: AppHandle,
    state: State<'_, HostState>,
    seed: String,
    limit: Option<u32>,
) -> Result<(), String> {
    let client = daemon::ensure_connected(&app).await?;
    let previous = {
        let mut active = state.lock_active_seed();
        let previous = active.clone();
        if previous.as_deref() != Some(seed.as_str()) {
            *active = Some(seed.clone());
        }
        // 同 seed 重入不视为切换。
        previous.filter(|previous| previous.as_str() != seed.as_str())
    };
    if let Some(previous) = previous {
        client.deactivate_timeline(&previous).await;
    }
    client.attach(&seed).await.map_err(string_of)?;
    // 首页大小由前端指定:宿主取的那一页会作为 timeline://snapshot 推给 webview,
    // 前端因此不必再补一次 resnapshot(一次 attach 两页、整表重建两遍)。
    client
        .activate_timeline_with(&seed, limit)
        .await
        .map_err(string_of)?;
    Ok(())
}

/// `(seed) → Vec<ApprovalView>`(challenge 由宿主签发并按 session 隔离)。
#[tauri::command]
pub async fn pending_approvals(
    app: AppHandle,
    state: State<'_, HostState>,
    seed: String,
) -> Result<Vec<Value>, String> {
    let client = daemon::ensure_connected(&app).await?;
    let pending = client.pending_approvals(&seed).await.map_err(string_of)?;
    state
        .approvals
        .issue_views(&seed, &pending)
        .map_err(|code| format!("approval projection failed: {code}"))
}

/// `(seed, challenge_id, decision, payload) → ()`。challenge 一次性消费 + scope
/// 校验先于任何 daemon 调用(失败的命令不能复用同一 challenge)。
#[tauri::command]
pub async fn respond_approval(
    app: AppHandle,
    state: State<'_, HostState>,
    seed: String,
    challenge_id: String,
    decision: String,
    payload: Value,
) -> Result<(), String> {
    let challenge = state
        .approvals
        .consume(&challenge_id, &seed)
        .map_err(str::to_string)?;
    let command = command_for(&challenge, &decision, &payload).map_err(str::to_string)?;
    let client = daemon::ensure_connected(&app).await?;
    let ack = client
        .send_command(Some(&seed), command, command_options())
        .await
        .map_err(string_of)?;
    ack_to_result(ack).map(|_| ())
}

/// `(seed, text) → ack`。
#[tauri::command]
pub async fn send_message(app: AppHandle, seed: String, text: String) -> Result<Value, String> {
    let client = daemon::ensure_connected(&app).await?;
    let ack = client
        .send_command(
            Some(&seed),
            RingingCommand::Conversation(ConversationCommand::ConversationSendMessage {
                text,
                images: Vec::new(),
                attachments: None,
                message_id: None,
                input_purpose: ConversationInputPurpose::TriggerTurn,
                as_system: false,
                inter_agent: None,
                subagent_terminal: None,
            }),
            CommandOptions::default(),
        )
        .await
        .map_err(string_of)?;
    ack_to_result(ack)
}

/// `(seed) → ack`。
#[tauri::command]
pub async fn cancel_turn(app: AppHandle, seed: String) -> Result<Value, String> {
    let client = daemon::ensure_connected(&app).await?;
    let ack = client
        .send_command(
            Some(&seed),
            RingingCommand::Conversation(ConversationCommand::ConversationCancel { turn_id: None }),
            CommandOptions::default(),
        )
        .await
        .map_err(string_of)?;
    ack_to_result(ack)
}

/// `() → ack`。新 seed 由前端轮询 sessions diff 发现(与现状一致)。
#[tauri::command]
pub async fn create_session(app: AppHandle) -> Result<Value, String> {
    let client = daemon::ensure_connected(&app).await?;
    let ack = client
        .send_command(
            None,
            RingingCommand::Control(qaqh_client::ControlCommand::SessionCreate {
                close_current: false,
                cwd: None,
                tool_mode: None,
                custom_tools: Vec::new(),
            }),
            CommandOptions::default(),
        )
        .await
        .map_err(string_of)?;
    ack_to_result(ack)
}

/// `(seed, limit, before_index) → page(含 server_epoch/has_more/truncated_before)`。
#[tauri::command]
pub async fn timeline_page(
    app: AppHandle,
    seed: String,
    limit: Option<u32>,
    before_index: Option<u64>,
) -> Result<Value, String> {
    let client = daemon::ensure_connected(&app).await?;
    let page = client
        .fetch_timeline_page(&seed, before_index, limit)
        .await
        .map_err(string_of)?;
    serde_json::to_value(&page).map_err(string_of)
}

/// `(seed) → bootstrap`(per-session 三频道快照,刷新 activity 用)。
#[tauri::command]
pub async fn session_bootstrap(app: AppHandle, seed: String) -> Result<Value, String> {
    let client = daemon::ensure_connected(&app).await?;
    let bootstrap = client.bootstrap_v2(&seed).await.map_err(string_of)?;
    serde_json::to_value(&bootstrap).map_err(string_of)
}

/// `(method, params) → Value`,方法白名单 + active session 注入。
#[tauri::command]
pub async fn service_rpc(
    app: AppHandle,
    state: State<'_, HostState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if !SERVICE_METHODS.contains(&method.as_str()) {
        return Err(format!("service method not allowed: {method}"));
    }
    let client = daemon::ensure_connected(&app).await?;
    let mut params = params;
    if service_requires_session(&method) {
        let Some(seed) = active_seed_of(&state) else {
            return Err("no_active_seed".into());
        };
        let Some(object) = params.as_object_mut() else {
            return Err("params must be an object".into());
        };
        object
            .entry("session_id".to_string())
            .or_insert(json!(seed));
        if service_scope_session(&method) {
            let scope = object.get("session_id").cloned().unwrap_or(Value::Null);
            object
                .entry("scope_session_id".to_string())
                .or_insert(scope);
        }
    }
    client
        .service_v2::<_, Value>(&method, params)
        .await
        .map_err(string_of)
}

/// `(url) → ()`,仅 http/https,走系统浏览器。
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http/https urls are allowed".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(string_of)
}

/// `(seed) → TimelineStatus | null`:查询该 seed 的 timeline 流当前状态
/// (宿主 `watch` 侧值,`None` = 从未激活)。兜底事件竞态:webview 订阅晚于
/// `timeline://status: open` 发出时(Tauri 事件不保留给晚到订阅者),前端订阅
/// 完成后主动查询一次对齐,避免 UI 永远停在「重连中」。
#[tauri::command]
pub async fn timeline_status(app: AppHandle, seed: String) -> Result<Option<Value>, String> {
    let client = daemon::ensure_connected(&app).await?;
    match client.timeline_status_for(&seed).await {
        Some(status) => serde_json::to_value(&status).map(Some).map_err(string_of),
        None => Ok(None),
    }
}

/// `(seed?) → ()`:宿主侧重连(用户点「重试」/窗口聚焦)。同时兜底建立连接。
#[tauri::command]
pub async fn streams_retry(
    app: AppHandle,
    state: State<'_, HostState>,
    seed: Option<String>,
) -> Result<(), String> {
    let client = daemon::ensure_connected(&app).await?;
    let target = match seed {
        Some(seed) => seed,
        None => active_seed_of(&state).ok_or_else(|| "no_active_seed".to_string())?,
    };
    client.activate_timeline(&target).await.map_err(string_of)?;
    Ok(())
}

/// `() → "stopping" | "busy" | "unsupported"`(D1 不兼容路径的一键停止)。
#[tauri::command]
pub async fn stop_stale_daemon() -> Result<&'static str, String> {
    let status = daemon::stop_stale_daemon().await?;
    Ok(match status {
        qaqh_client::StopStatus::Stopping => "stopping",
        qaqh_client::StopStatus::Busy => "busy",
        qaqh_client::StopStatus::Unsupported => "unsupported",
    })
}

/// Exit the desktop shell, optionally asking the daemon to stop first.
/// `stop_active_work` is only true after the user confirms that every connected
/// session may be interrupted; the safe default uses stop-if-idle.
#[tauri::command]
pub async fn exit_app(
    app: AppHandle,
    stop_daemon: bool,
    stop_active_work: bool,
) -> Result<(), String> {
    if stop_daemon {
        let client = daemon::ensure_connected(&app).await?;
        let status = client
            .stop_daemon(!stop_active_work)
            .await
            .map_err(string_of)?;
        match status {
            qaqh_client::StopStatus::Stopping => {}
            qaqh_client::StopStatus::Busy => {
                return Err("后台任务状态刚刚变化；为保护任务，daemon 未停止".into());
            }
            qaqh_client::StopStatus::Unsupported => {
                return Err("当前 daemon 不支持安全停止".into());
            }
        }
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use qaqh_types::{SessionMeta, SessionRunStatus};

    /// daemon 侧一条 `session.list` 条目(契约 G2):`SessionMeta` 的键经 flatten
    /// 平铺,同层再加 `status` / `workspace_id`(`service.rs:839-859`)。用权威类型
    /// 序列化出来,就是线上真正吃到的那份形状。
    fn wire_entry(status: SessionRunStatus, workspace_id: Option<&str>) -> Value {
        let entry = SessionListEntry {
            meta: SessionMeta {
                session_id: "0123abcd".into(),
                updated_at: 7,
                model: "test-model".into(),
                title: Some("Bun 引导 daemon".into()),
                cwd: Some("E:\\code\\qaqh".into()),
                turn_count: 3,
                ..Default::default()
            },
            status,
            workspace_id: workspace_id.map(str::to_string),
        };
        serde_json::to_value(entry).expect("SessionListEntry 可序列化")
    }

    #[test]
    fn sidebar_projection_keeps_grouping_keys_and_holds_back_host_detail() {
        let out = sidebar_sessions(json!([wire_entry(SessionRunStatus::Working, Some("w1"))]))
            .expect("投影成功");
        let card = &out.as_array().expect("回包是数组")[0];
        let keys: std::collections::BTreeSet<&str> = card
            .as_object()
            .expect("卡片是对象")
            .keys()
            .map(String::as_str)
            .collect();
        // 与前端 `SidebarSession`(src/tabs/store.ts)一一对应。
        assert_eq!(
            keys,
            std::collections::BTreeSet::from([
                "session_id",
                "title",
                "cwd",
                "updated_at",
                "turn_count",
                "busy",
                "archived",
                "workspace_id",
            ])
        );
        // 这两键是被退役的 `sanitize_session_list` 白名单剥掉的:侧栏分组与悬浮
        // 路径全靠它们。
        assert_eq!(card["workspace_id"], json!("w1"));
        assert_eq!(card["cwd"], json!("E:\\code\\qaqh"));
        assert_eq!(card["busy"], json!(true));
        for leak in [
            "model",
            "effort",
            "profile",
            "skills",
            "usage_totals",
            "context_stats",
            "frozen_annotation",
            "tool_mode",
            "custom_tools",
            // 前端目前不读 ephemeral(子代理临时会话的过滤是另一件事),
            // 留着它只会让人以为侧栏已经分得开。
            "ephemeral",
            "created_at",
            "message_count",
            // 状态词汇表不过 IPC:侧栏只看 `busy` 一个判据。
            "status",
        ] {
            assert!(card.get(leak).is_none(), "宿主细节 {leak} 不该进 webview");
        }
    }

    #[test]
    fn busy_covers_working_and_user_waits_but_not_terminals() {
        // `running: bool` 时代这四种都算「在跑」;归一化后 `idle`/终态/未加载都不算。
        for status in [
            SessionRunStatus::Working,
            SessionRunStatus::WaitingPermission,
            SessionRunStatus::WaitingAsk,
            SessionRunStatus::WaitingPlan,
        ] {
            assert!(session_is_busy(status), "{status:?} 应当点亮状态点");
        }
        // `not_running` ≠ `idle`:未加载连投影都不读,两者都不该亮。
        for status in [
            SessionRunStatus::NotRunning,
            SessionRunStatus::Idle,
            SessionRunStatus::Canceled,
            SessionRunStatus::Error,
        ] {
            assert!(!session_is_busy(status), "{status:?} 不该点亮状态点");
        }
    }

    #[test]
    fn sidebar_projection_survives_old_wire_and_fails_loudly_on_shape_drift() {
        // 未分组(旧磁盘 meta:`workspace_id` 缺省)→ 键存在且为 null,前端据此进「未分组」。
        let out =
            sidebar_sessions(json!([wire_entry(SessionRunStatus::Idle, None)])).expect("投影成功");
        assert_eq!(out[0]["workspace_id"], Value::Null);
        assert_eq!(out[0]["busy"], json!(false));

        // 旧 daemon 的回包:`running: bool` + 没有 `status`。扁平条目里多出来的
        // `running` 被 meta 的 flatten 吸收,`status` 走 `#[serde(default)]`
        // (NotRunning)→ 列表照常出,只是状态点不亮。升级不炸,但降级要提示。
        let mut legacy = serde_json::to_value(SessionMeta {
            session_id: "old1".into(),
            created_at: 1,
            updated_at: 2,
            model: "m".into(),
            message_count: 0,
            ..Default::default()
        })
        .expect("SessionMeta 可序列化");
        legacy
            .as_object_mut()
            .expect("条目是对象")
            .insert("running".into(), json!(true));
        let out = sidebar_sessions(json!([legacy])).expect("旧回包兼容");
        assert_eq!(out[0]["session_id"], json!("old1"));
        assert_eq!(out[0]["busy"], json!(false));

        // 回包形状不符必须报错:字符串白名单时代的失败模式是静默空列表。
        assert!(sidebar_sessions(json!({"unexpected": "envelope"})).is_err());
    }
}
