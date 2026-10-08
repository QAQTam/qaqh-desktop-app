//! 设备配对(m0-daemon-authz):壳代签发一次性配对令牌 + 设备管理。
//! 规范:docs/spec-daemon-auth-devices.md §11;daemon 处理器在
//! crates/qaqh-daemon/src/axum_server/axum_impl/pairing.rs。
//!
//! 职责边界:QR payload 由**壳**拼装(daemon 不生成二维码)。discovery 里两个面
//! 各有用途(`server.rs` 双 listener 起):`endpoint` 是回环明文,壳自己签发/管理
//! 设备走它(admin token,authz.rs 全程豁免);`lan_endpoint` 是局域网 TLS 面
//! (`https://<局域网IP>:<port>`),那才是手机要访问的 base_url。证书指纹取自
//! discovery 的 `tls_fingerprint`(自签证书 SHA-256),与签发响应的 `tls_fp` 同源。
//! 二维码只在用户显式点击时签发:桌面确认 = 发 token。

use serde_json::{Value, json};
use tauri::State;

use qaqh_client::read_discovery;

use crate::daemon::HostState;

const PAIRING_SCOPES: &[&str] = &["view", "interact", "admin"];

fn string_of(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// 当前 daemon 的两个面:本地管理通道 + 手机可达的局域网通道。
struct DaemonFaces {
    /// 回环明文面(签发/设备管理用;LAN 模式下它也恒为回环,见 `server.rs`)。
    admin: reqwest::Url,
    token: String,
    /// 局域网 TLS 面;`None` = daemon 没开 LAN 模式,无法配对。
    lan: Option<reqwest::Url>,
    tls_fingerprint: Option<String>,
}

fn read_faces() -> Result<DaemonFaces, String> {
    let discovery =
        read_discovery().map_err(|error| format!("读取 daemon discovery 失败: {error}"))?;
    let parse = |raw: &str, label: &str| -> Result<reqwest::Url, String> {
        reqwest::Url::parse(raw)
            .map_err(|error| format!("discovery 的 {label} 非法({raw}): {error}"))
    };
    Ok(DaemonFaces {
        admin: parse(&discovery.endpoint, "endpoint")?,
        token: discovery.token,
        lan: match discovery.lan_endpoint.as_deref() {
            Some(raw) => Some(parse(raw, "lan_endpoint")?),
            None => None,
        },
        tls_fingerprint: discovery.tls_fingerprint,
    })
}

/// daemon 的 ringing v2 HTTPS 面走自签证书:信任边界是 admin token(与
/// qaqh-client 的控制通道同一条),证书只用于传输加密,不做链式校验。
async fn admin_json(
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    // reqwest 是 rustls-no-provider:ring provider 由 qaqh-client 在 connect 时装,
    // 但配对命令不依赖 client 连接,这里幂等兜底(重复 install 是无害 no-op)。
    let _ = rustls::crypto::ring::default_provider().install_default();
    let faces = read_faces()?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| format!("HTTP 客户端构建失败: {error}"))?;
    let mut request = client
        .request(method, faces.admin.join(path).map_err(string_of)?)
        .bearer_auth(faces.token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("daemon 请求失败: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("daemon 响应 {status}: {text}"));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|error| format!("daemon 响应解析失败: {error}"))
}

fn host_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "qaqh-desktop".into())
}

/// `(scope_grant, device_name, platform?) → { qr_payload, expires_in_ms, base_url }`。
/// qr_payload 是规范 §11 的 JSON 字符串,前端直接喂给二维码编码器。
#[tauri::command]
pub async fn pairing_create(
    _state: State<'_, HostState>,
    scope_grant: String,
    device_name: String,
    platform: Option<String>,
) -> Result<Value, String> {
    let scope = scope_grant.trim();
    if !PAIRING_SCOPES.contains(&scope) {
        return Err(format!(
            "scope 仅允许 {}，收到 {scope}",
            PAIRING_SCOPES.join("|")
        ));
    }
    let faces = read_faces()?;
    let base = faces.lan.ok_or_else(|| {
        "daemon 当前只在回环地址上运行,手机无法访问,不能配对。\
         请先在上方「局域网模式」里开启并重启 daemon(会短暂中断当前会话)。"
            .to_string()
    })?;
    let response = admin_json(
        reqwest::Method::POST,
        "/ringing/v2/pairing/tokens",
        Some(json!({
            "scope_grant": scope,
            "device_name": device_name.trim(),
            "platform": platform.unwrap_or_else(|| "mobile".into()),
        })),
    )
    .await?;
    let pairing_token = response["pairing_token"]
        .as_str()
        .ok_or_else(|| "daemon 响应缺 pairing_token".to_string())?
        .to_string();
    let expires_in_ms = response["expires_in_ms"].as_u64().unwrap_or(120_000);
    // 优先用签发响应里的指纹(与运行态同源),缺失时回落 discovery 的记录值。
    let tls_fp = response["tls_fp"]
        .as_str()
        .filter(|fp| !fp.is_empty())
        .map(str::to_owned)
        .or(faces.tls_fingerprint)
        .unwrap_or_default();
    let payload = json!({
        "v": 1,
        "kind": "qaqh-pair",
        "base_url": base.as_str().trim_end_matches('/'),
        "pairing_token": pairing_token,
        "tls_fp": tls_fp,
        "host_name": host_name(),
    });
    Ok(json!({
        "qr_payload": serde_json::to_string(&payload).map_err(string_of)?,
        "expires_in_ms": expires_in_ms,
        "base_url": base.as_str(),
    }))
}

/// `() → { devices: [...] }`(不含任何 token 材料)。
#[tauri::command]
pub async fn devices_list() -> Result<Value, String> {
    admin_json(reqwest::Method::GET, "/ringing/v2/devices", None).await
}

/// `(device_id) → ()`:吊销并强制断开该设备的 SSE 租约。
#[tauri::command]
pub async fn device_revoke(device_id: String) -> Result<(), String> {
    // id 只进 URL path:白名单字符,不给注入留面。
    if device_id.is_empty()
        || !device_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("device_id 非法".into());
    }
    admin_json(
        reqwest::Method::POST,
        &format!("/ringing/v2/devices/{device_id}/revoke"),
        None,
    )
    .await
    .map(|_| ())
}
