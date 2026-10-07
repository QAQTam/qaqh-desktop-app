//! Loopback-only bridge used by `/?preview=tauri` in a normal browser.
//!
//! This is compiled only into debug builds. Vite proxies the same-origin
//! `__qaqh_preview` path here, so browser preview reuses the host's daemon
//! client, challenge store, and event handlers without exposing daemon tokens.

use std::convert::Infallible;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, sse::{Event, KeepAlive, Sse}},
    routing::{get, post},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio_stream::wrappers::BroadcastStream;

use crate::{commands, daemon::HostState};

const PREVIEW_PORT: u16 = 5174;

fn browser_origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(axum::http::header::ORIGIN).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    matches!(origin, "http://127.0.0.1:5173" | "http://localhost:5173")
}

fn error_response(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": message.into() })))
}

fn required_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("missing string argument: {key}"))
}

async fn invoke(
    State(app): State<AppHandle>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    if !browser_origin_allowed(&headers) {
        return Err(error_response(StatusCode::FORBIDDEN, "browser preview origin denied"));
    }
    let command = request.get("command").and_then(Value::as_str).unwrap_or_default();
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    let run = async {
        match command {
            "session_list" => commands::session_list(app.clone()).await,
            "attach" => {
                let seed = required_string(&args, "seed")?;
                let limit = args.get("limit").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
                commands::attach(app.clone(), app.state::<HostState>(), seed, limit).await?;
                Ok(Value::Null)
            }
            "pending_approvals" => {
                let seed = required_string(&args, "seed")?;
                let views = commands::pending_approvals(app.clone(), app.state::<HostState>(), seed).await?;
                serde_json::to_value(views).map_err(|error| error.to_string())
            }
            "respond_approval" => {
                let seed = required_string(&args, "seed")?;
                let challenge_id = required_string(&args, "challengeId")?;
                let decision = required_string(&args, "decision")?;
                let payload = args.get("payload").cloned().unwrap_or_else(|| json!({}));
                commands::respond_approval(app.clone(), app.state::<HostState>(), seed, challenge_id, decision, payload).await?;
                Ok(Value::Null)
            }
            "send_message" => {
                let seed = required_string(&args, "seed")?;
                let text = required_string(&args, "text")?;
                commands::send_message(app.clone(), seed, text).await
            }
            "cancel_turn" => {
                let seed = required_string(&args, "seed")?;
                commands::cancel_turn(app.clone(), seed).await
            }
            "create_session" => commands::create_session(app.clone()).await,
            "timeline_page" => {
                let seed = required_string(&args, "seed")?;
                let limit = args.get("limit").and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
                let before_index = args.get("beforeIndex").and_then(Value::as_u64);
                commands::timeline_page(app.clone(), seed, limit, before_index).await
            }
            "session_bootstrap" => {
                let seed = required_string(&args, "seed")?;
                commands::session_bootstrap(app.clone(), seed).await
            }
            "service_rpc" => {
                let method = required_string(&args, "method")?;
                let params = args.get("params").cloned().unwrap_or_else(|| json!({}));
                commands::service_rpc(app.clone(), app.state::<HostState>(), method, params).await
            }
            "timeline_status" => {
                let seed = required_string(&args, "seed")?;
                commands::timeline_status(app.clone(), seed).await.map(|value| value.unwrap_or(Value::Null))
            }
            "streams_retry" => {
                let seed = args.get("seed").and_then(Value::as_str).map(str::to_owned);
                commands::streams_retry(app.clone(), app.state::<HostState>(), seed).await?;
                Ok(Value::Null)
            }
            "stop_stale_daemon" => commands::stop_stale_daemon().await.map(|status| json!(status)),
            "open_external" => {
                let url = required_string(&args, "url")?;
                commands::open_external(app.clone(), url)?;
                Ok(Value::Null)
            }
            _ => Err(format!("browser preview command not allowed: {command}")),
        }
    }.await;
    run.map(Json).map_err(|message| error_response(StatusCode::BAD_REQUEST, message))
}

async fn events(State(app): State<AppHandle>, headers: HeaderMap) -> impl IntoResponse {
    if !browser_origin_allowed(&headers) {
        return error_response(StatusCode::FORBIDDEN, "browser preview origin denied").into_response();
    }
    let receiver = app.state::<HostState>().preview_events.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(|message| async move {
        message.ok().map(|(name, payload)| {
            Ok::<Event, Infallible>(Event::default().event(name).data(payload.to_string()))
        })
    });
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

pub async fn serve(app: AppHandle) -> Result<(), String> {
    let router = Router::new()
        .route("/__qaqh_preview/invoke", post(invoke))
        .route("/__qaqh_preview/events", get(events))
        .with_state(app);
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], PREVIEW_PORT));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| format!("bind preview bridge {address}: {error}"))?;
    log::info!("[qaqh-webui-app] browser preview bridge listening at http://{address}");
    axum::serve(listener, router)
        .await
        .map_err(|error| format!("browser preview bridge: {error}"))
}
