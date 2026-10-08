//! 局域网模式（daemon LAN）生命周期：把在跑的回环 daemon 换成 `server --bind`
//! 双 listener 实例，手机才可能直连；二维码的 base_url 与证书指纹都取自 discovery。
//!
//! 为什么由壳直接 spawn：`qaqh-client` 的按需拉起只走 `run`（恒回环、明文），LAN
//! 必须显式 `--bind` 且显式 token（审计 H3）。token 经 `QAQH_SERVER_TOKEN` 环境
//! 变量交给子进程——不落命令行，免得被同机进程表与 daemon 日志读走。
//!
//! 停机顺序遵循 D1 的「不静默杀」：默认 `stop-if-idle`，有 Turn 在跑即返回
//! `daemon_busy`，由前端确认后才带 `force` 重来一次。

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use qaqh_client::discovery::{daemon_executable, process_is_running, read_discovery};
use qaqh_client::{Client, ClientOptions, DaemonDiscovery, StopStatus};
use qaqh_types::discovery::CONTROL_PROTOCOL_VERSION;

use crate::daemon::{self, HostState};

/// LAN 端口默认值（与 daemon `ServerNetworkConfig::parse` 同调）。
pub const DEFAULT_LAN_PORT: u16 = 64413;

/// 旧 daemon 优雅收尾（stop/signal → flush）的等待上限。
const STOP_TIMEOUT: Duration = Duration::from_secs(20);
/// 新 daemon 发布 discovery 的等待上限（自签证书生成 + 双 listener 绑定 + 会话预热）。
const START_TIMEOUT: Duration = Duration::from_secs(45);
/// discovery 轮询步长：daemon 冷启动以秒计，120ms 足够跟得上又不刷磁盘。
const POLL_INTERVAL: Duration = Duration::from_millis(120);

/// 壳内重启串行化：连点「开启」不该拉起两个 daemon。
static RESTART_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// discovery → 前端可见的 LAN 视图。**不含 token 材料**（admin token 留在壳内存里
/// 经 `qaqh-client` 使用，webview 永远拿不到）。
fn lan_view(discovery: &DaemonDiscovery) -> Value {
    json!({
        "running": true,
        "active": discovery.lan_endpoint.is_some(),
        "endpoint": discovery.endpoint,
        "lan_endpoint": discovery.lan_endpoint,
        "tls_fingerprint": discovery.tls_fingerprint,
        "pid": discovery.pid,
        "daemon_version": discovery.daemon_version,
        "protocol_version": discovery.protocol_version,
        "app_protocol_version": CONTROL_PROTOCOL_VERSION,
    })
}

/// 没有在跑的 daemon（无 discovery 或 pid 已死）。
fn no_daemon() -> Value {
    json!({
        "running": false,
        "active": false,
        "endpoint": Value::Null,
        "lan_endpoint": Value::Null,
        "tls_fingerprint": Value::Null,
        "pid": Value::Null,
        "daemon_version": Value::Null,
        "protocol_version": Value::Null,
        "app_protocol_version": CONTROL_PROTOCOL_VERSION,
    })
}

/// `() → { running, active, endpoint, lan_endpoint, tls_fingerprint, … }`。
/// 前端据此决定配对面板走「开启 LAN」还是「生成二维码」。
#[tauri::command]
pub fn daemon_lan_status() -> Value {
    match read_discovery() {
        Ok(discovery) if process_is_running(discovery.pid) => lan_view(&discovery),
        _ => no_daemon(),
    }
}

/// 绑定地址校验：留空 = `0.0.0.0`（daemon 自行猜出口网卡并写进 `lan_endpoint`）；
/// 回环直接拒——那既不会启用 TLS，手机也连不上，只会让后面的轮询超时。
fn parse_bind(raw: &str) -> Result<std::net::IpAddr, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    }
    let ip = trimmed.parse::<std::net::IpAddr>().map_err(|_| {
        format!("绑定地址无效：{trimmed}。填本机局域网 IP（如 192.168.1.23），或留空自动选网卡。")
    })?;
    if ip.is_loopback() {
        return Err("绑定地址不能是回环（127.0.0.1）：手机连不到它。留空即自动选出口网卡。".into());
    }
    Ok(ip)
}

/// LAN 模式的 daemon 命令行参数（token 走环境变量，不在这里）。
fn lan_server_args(bind: std::net::IpAddr, port: u16) -> Vec<String> {
    vec![
        "server".into(),
        "--bind".into(),
        bind.to_string(),
        "--port".into(),
        port.to_string(),
    ]
}

/// 一次性 admin token：32 字节随机 → 64 位十六进制。
fn new_server_token() -> String {
    let bytes: [u8; 32] = rand::random();
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(token, "{byte:02x}");
    }
    token
}

fn daemon_executable_path() -> Result<PathBuf, String> {
    if let Some(path) = daemon::daemon_path_override() {
        return Ok(path);
    }
    daemon_executable().map_err(|error| format!("找不到 qaqh-daemon 可执行文件：{error}"))
}

/// 让子进程脱离宿主进程组（与 `qaqh-client` 的 detach 同调）：窗口关闭 / 托盘退出
/// 不能顺带收走 daemon，否则 discovery 悬空、下个客户端被陈旧记录卡死。
fn configure_detached(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

fn spawn_daemon(executable: &Path, args: &[String], token: Option<&str>) -> Result<(), String> {
    let mut command = std::process::Command::new(executable);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    match token {
        Some(token) => {
            command.env("QAQH_SERVER_TOKEN", token);
        }
        // 回环模式必须清掉继承来的 token，否则父进程环境里的值会被 LAN 门禁误判。
        None => {
            command.env_remove("QAQH_SERVER_TOKEN");
        }
    }
    configure_detached(&mut command);
    command
        .spawn()
        .map_err(|error| format!("拉起 daemon 失败（{}）：{error}", executable.display()))?;
    Ok(())
}

/// 用一次性 client 请求停机（不把 `HostState` 的连接搭进去，语义同 D1 的一键停止）。
/// `idle_only` = 只在空闲时停，Busy 由调用方转成确认动作。
async fn stop_running_daemon(idle_only: bool) -> Result<StopStatus, String> {
    let discovery = match read_discovery() {
        Ok(discovery) => discovery,
        Err(_) => return Ok(StopStatus::Stopping),
    };
    if !process_is_running(discovery.pid) {
        return Ok(StopStatus::Stopping);
    }
    let client = Client::connect_async(ClientOptions {
        launch_daemon_if_missing: false,
        ..Default::default()
    })
    .await
    .map_err(|error| format!("连接 daemon 以停机失败：{error}"))?;
    let status = client
        .stop_daemon(idle_only)
        .await
        .map_err(|error| format!("请求停机失败：{error}"));
    client.close();
    status
}

/// 等旧进程真的退场：单实例锁（`daemon.lock`）还被人持着就 spawn，新 daemon 会
/// 立刻拒绝启动并留下一个谁都看不懂的超时。
async fn await_old_daemon_exit(pid: Option<u32>) -> Result<(), String> {
    let Some(pid) = pid else { return Ok(()) };
    let deadline = Instant::now() + STOP_TIMEOUT;
    loop {
        if !process_is_running(pid) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "旧 daemon（pid {pid}）在 {STOP_TIMEOUT:?} 内没有退出，已放弃重启。请确认没有 Turn 在跑后再试。"
            ));
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// 轮询 discovery，直到它指向**新**进程且 LAN 面符合预期。
async fn await_new_discovery(
    previous_pid: Option<u32>,
    want_lan: bool,
) -> Result<DaemonDiscovery, String> {
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if let Ok(discovery) = read_discovery() {
            let is_new = previous_pid.is_none_or(|pid| discovery.pid != pid);
            let face_matches = discovery.lan_endpoint.is_some() == want_lan;
            if is_new && face_matches && process_is_running(discovery.pid) {
                return Ok(discovery);
            }
        }
        if Instant::now() >= deadline {
            return Err(if want_lan {
                format!(
                    "daemon 已在启动，但 {START_TIMEOUT:?} 内没有发布局域网端点。\
                     若本机没有可用的局域网网卡，请手填绑定 IP（如 192.168.1.23）后重试。"
                )
            } else {
                format!(
                    "daemon 未在 {START_TIMEOUT:?} 内发布回环 discovery，请检查 qaqh-daemon 是否可运行。"
                )
            });
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// 停机 → 换参数拉起 → 重连宿主。LAN 与回环两条路只差 spawn 参数与 `want_lan`。
async fn restart_daemon(
    app: &AppHandle,
    args: Vec<String>,
    token: Option<String>,
    want_lan: bool,
    force: bool,
) -> Result<Value, String> {
    let _guard = RESTART_LOCK.lock().await;
    let executable = daemon_executable_path()?;
    let previous = read_discovery().ok().filter(|d| process_is_running(d.pid));
    let previous_pid = previous.as_ref().map(|d| d.pid);
    if previous.is_some() {
        match stop_running_daemon(!force).await? {
            StopStatus::Busy => {
                return Err("daemon_busy".into());
            }
            StopStatus::Stopping | StopStatus::Unsupported => {}
        }
    }
    await_old_daemon_exit(previous_pid).await?;
    // 旧连接到此为止：它的心跳/流对着一个即将消失的 daemon，只会制造报错噪音。
    app.state::<HostState>().detach();
    spawn_daemon(&executable, &args, token.as_deref())?;
    let discovery = await_new_discovery(previous_pid, want_lan).await?;
    if let Err(error) = daemon::ensure_connected(app).await {
        log::warn!("[qaqh-webui-app] reconnect after daemon restart: {error}");
    }
    Ok(lan_view(&discovery))
}

/// `(bind_ip?, port?, force?) → 新 LAN 视图`：留空 bind_ip = `0.0.0.0` 自动选网卡。
/// 错误 `daemon_busy` = 有 Turn 在跑，前端确认后带 `force=true` 重试。
#[tauri::command]
pub async fn daemon_lan_enable(
    app: AppHandle,
    bind_ip: Option<String>,
    port: Option<u16>,
    force: bool,
) -> Result<Value, String> {
    let bind = parse_bind(bind_ip.as_deref().unwrap_or_default())?;
    let port = match port {
        None | Some(0) => DEFAULT_LAN_PORT,
        Some(port) => port,
    };
    restart_daemon(
        &app,
        lan_server_args(bind, port),
        Some(new_server_token()),
        true,
        force,
    )
    .await
}

/// `(force?) → 新视图`：关掉局域网面，回到默认的回环明文 daemon（减少暴露面）。
#[tauri::command]
pub async fn daemon_lan_disable(app: AppHandle, force: bool) -> Result<Value, String> {
    restart_daemon(&app, vec!["run".into()], None, false, force).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_bind_falls_back_to_unspecified() {
        assert_eq!(
            parse_bind("").ok(),
            Some(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED))
        );
        assert_eq!(
            parse_bind("  ").ok(),
            Some(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED))
        );
    }

    #[test]
    fn loopback_bind_is_refused() {
        // 回环不会启用 TLS，写不出 lan_endpoint，配对面板只能拿到一个死端点。
        for raw in ["127.0.0.1", "::1"] {
            let error = parse_bind(raw).expect_err("loopback must be refused");
            assert!(error.contains("回环"), "error: {error}");
        }
        assert!(parse_bind("192.168.1.999").is_err());
        assert!(parse_bind("not-an-ip").is_err());
    }

    #[test]
    fn lan_server_args_match_daemon_cli_flags() {
        let args = lan_server_args(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED), 64413);
        assert_eq!(args, vec!["server", "--bind", "0.0.0.0", "--port", "64413"]);
    }

    #[test]
    fn server_token_is_hex_and_long_enough() {
        let token = new_server_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(token, new_server_token());
    }

    #[test]
    fn lan_view_hides_token() {
        let discovery = DaemonDiscovery {
            endpoint: "http://127.0.0.1:61746".into(),
            token: "super-secret".into(),
            pid: 7,
            server_epoch: "epoch".into(),
            protocol_version: CONTROL_PROTOCOL_VERSION,
            daemon_version: "2.0.0".into(),
            build_id: String::new(),
            channel: "dev".into(),
            executable: String::new(),
            lan_endpoint: Some("https://192.168.1.23:64413".into()),
            tls_fingerprint: Some("sha256:aa".into()),
        };
        let view = lan_view(&discovery);
        assert_eq!(view["active"], true);
        assert_eq!(view["lan_endpoint"], "https://192.168.1.23:64413");
        assert!(view.get("token").is_none(), "token 不得出现在视图里");
        assert!(!view.to_string().contains("super-secret"));
    }
}
