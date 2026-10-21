//! QAQ-Harness 桌面壳(Tauri 2 宿主)入口。
//!
//! 架构:webview( Solid 渲染层)↔ 类型化 IPC ↔ Rust 宿主 ↔ `qaqh-client` ↔
//! daemon(sidecar 或共享在跑实例)。daemon token 只存在于宿主进程内存。

// 只在 debug 构建里挂载:`browser_preview::serve` 的唯一调用点也在
// `#[cfg(debug_assertions)]` 下,release 保留整个模块只会报一堆 dead_code。
#[cfg(debug_assertions)]
mod browser_preview;
mod challenge;
mod commands;
mod daemon;
mod events;
mod lan;
mod pairing;
mod procgroup;
mod skills;
mod version;

use tauri::{
    Emitter, Manager, RunEvent, WindowEvent,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

#[tauri::command]
fn set_window_theme(window: tauri::WebviewWindow, dark: bool) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        // 返回值 = 本窗口是否真的拿到了材质。Win10 / 旧 22H2 上 apply_mica 会失败，
        // 渲染层据此退回实底，避免透明窗口露出桌面。
        window_vibrancy::apply_mica(&window, Some(dark))
            .map_err(|error| error.to_string())
            .map(|_| true)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = dark;
        window_vibrancy::apply_vibrancy(
            &window,
            window_vibrancy::NSVisualEffectMaterial::Sidebar,
            Some(window_vibrancy::NSVisualEffectState::Active),
            None,
        )
        .map_err(|error| error.to_string())
        .map(|_| true)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (window, dark);
        Ok(false)
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn install_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 QAQH", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 QAQH…", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;
    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("QAQ-Harness")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quit" => {
                show_main_window(app);
                let _ = app.emit("app://quit-requested", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            let open = matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                }
            );
            if open {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // 单实例(D1):多开窗口聚焦到既有实例,宿主状态不复制。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());
    // macOS 系统权限检测/申请(屏幕录制等)。插件只支持 macOS,其他平台不注册。
    // `#[cfg]` 不能挂链式调用的表达式上,所以 builder 分步构建。
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_permissions::init());
    builder
        .manage(daemon::HostState::new())
        .invoke_handler(tauri::generate_handler![
            set_window_theme,
            commands::session_list,
            commands::attach,
            // 用户级 skills(`~/.qaqh/skills`、`~/.agents/skills`)不走 daemon 的
            // `fs.*` 白名单——那两个根不在 allowed_roots 里,由宿主自己读。
            skills::skills_user_scan,
            commands::pending_approvals,
            commands::respond_approval,
            commands::send_message,
            commands::cancel_turn,
            commands::compact_context,
            commands::create_session,
            commands::pick_directory,
            commands::pick_attachments,
            // 应用内截图(macOS `screencapture`):回临时文件路径,渲染层再当附件用。
            commands::capture_screenshot,
            commands::upload_attachment,
            commands::timeline_page,
            commands::session_bootstrap,
            commands::service_rpc,
            commands::host_memory,
            commands::host_process_group,
            commands::open_external,
            commands::streams_retry,
            commands::stop_stale_daemon,
            commands::exit_app,
            commands::timeline_status,
            lan::daemon_lan_status,
            lan::daemon_lan_enable,
            lan::daemon_lan_disable,
            pairing::pairing_create,
            pairing::devices_list,
            pairing::device_revoke,
            version::app_version,
        ])
        .setup(|app| {
            install_tray(app)?;
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main")
                && let Err(error) = window_vibrancy::apply_mica(&window, None)
            {
                log::warn!("[qaqh-webui-app] Windows Mica unavailable: {error}");
            }
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main")
                && let Err(error) = window_vibrancy::apply_vibrancy(
                    &window,
                    window_vibrancy::NSVisualEffectMaterial::Sidebar,
                    Some(window_vibrancy::NSVisualEffectState::Active),
                    None,
                )
            {
                log::warn!("[qaqh-webui-app] macOS Vibrancy unavailable: {error}");
            }
            #[cfg(debug_assertions)]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = browser_preview::serve(handle).await {
                        log::warn!("[qaqh-webui-app] browser preview bridge unavailable: {error}");
                    }
                });
            }
            // 启动即校验/拉起 daemon(D1);不阻塞窗口显示,失败经事件上报。
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = daemon::ensure_connected(&handle).await {
                    log::warn!("[qaqh-webui-app] initial daemon connect: {error}");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build qaqh-webui-app")
        .run(|app, event| {
            match event {
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { api, .. },
                    ..
                } if label == "main" => {
                    // 标题栏 X 收到托盘；只有托盘菜单的显式退出才会结束宿主。
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
                RunEvent::Exit => {
                    // 窗口关闭 ≠ 取消 Turn/审批:进程退出时只 detach 宿主连接。
                    app.state::<daemon::HostState>().detach();
                }
                _ => {}
            }
        });
}
