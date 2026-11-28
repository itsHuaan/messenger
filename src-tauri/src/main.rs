// Prevents the console window from appearing in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod badge;
mod download;
mod install_scope;
mod notification;
mod settings;
mod shortcut;
mod startup;
mod tray;
mod updater;

use settings::{AppSettings, AppState};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[tauri::command]
fn close_call_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    label: Option<String>,
) -> Result<(), String> {
    let target_label = label.unwrap_or_else(|| window.label().to_string());
    println!("[Messenger Desktop] close_call_window command received for target '{target_label}'");

    if target_label.starts_with("call-") {
        if let Some(call_win) = app.get_webview_window(&target_label) {
            call_win
                .close()
                .map_err(|e| format!("Failed to close call window '{target_label}': {e}"))?;
            println!("[Messenger Desktop] Successfully closed call window '{target_label}' via command");
        } else {
            eprintln!("[Messenger Desktop] Call window '{target_label}' not found");
        }
    } else {
        eprintln!("[Messenger Desktop] Refusing to close non-call window '{target_label}'");
    }

    Ok(())
}

#[cfg(windows)]
fn setup_call_window_close_handlers(window: &tauri::WebviewWindow) -> Result<(), String> {
    let label = window.label().to_string();
    let win_close = window.clone();
    let win_msg = window.clone();

    window
        .with_webview(move |platform_webview| {
            unsafe {
                use webview2_com::{
                    take_pwstr, WebMessageReceivedEventHandler, WindowCloseRequestedEventHandler,
                };
                use windows::core::PWSTR;

                let controller = platform_webview.controller();
                let core_webview = match controller.CoreWebView2() {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!(
                            "[Messenger Desktop] Failed to get CoreWebView2 for call window '{label}': {e}"
                        );
                        return;
                    }
                };

                // 1. Intercept native WebView2 WindowCloseRequested (fired on window.close())
                let close_target = win_close.clone();
                let label_close = label.clone();
                let close_handler = WindowCloseRequestedEventHandler::create(Box::new(
                    move |_sender, _args| {
                        println!(
                            "[Messenger Desktop] Native WindowCloseRequested received for call window '{label_close}'"
                        );
                        if let Err(e) = close_target.close() {
                            eprintln!(
                                "[Messenger Desktop] Failed to close call window '{label_close}' on WindowCloseRequested: {e}"
                            );
                        } else {
                            println!(
                                "[Messenger Desktop] Successfully requested close for call window '{label_close}'"
                            );
                        }
                        Ok(())
                    },
                ));
                let mut close_token: i64 = 0;
                if let Err(e) = core_webview.add_WindowCloseRequested(&close_handler, &mut close_token) {
                    eprintln!(
                        "[Messenger Desktop] Failed to register WindowCloseRequested on '{label}': {e}"
                    );
                } else {
                    println!(
                        "[Messenger Desktop] Registered WindowCloseRequested handler on call window '{label}'"
                    );
                }

                // 2. Intercept WebView2 WebMessageReceived (postMessage bridge)
                let msg_target = win_msg.clone();
                let label_msg = label.clone();
                let msg_handler = WebMessageReceivedEventHandler::create(Box::new(
                    move |_sender, args| {
                        let Some(args) = args else {
                            return Ok(());
                        };
                        let mut msg_pwstr = PWSTR::null();
                        if args.TryGetWebMessageAsString(&mut msg_pwstr).is_ok() {
                            let msg = take_pwstr(msg_pwstr);
                            if msg.contains("close_call_window") {
                                println!(
                                    "[Messenger Desktop] WebMessageReceived close request for call window '{label_msg}' (msg: {msg})"
                                );
                                if let Err(e) = msg_target.close() {
                                    eprintln!(
                                        "[Messenger Desktop] Failed to close call window '{label_msg}' on WebMessage: {e}"
                                    );
                                } else {
                                    println!(
                                        "[Messenger Desktop] Successfully closed call window '{label_msg}' via WebMessage"
                                    );
                                }
                            }
                        }
                        Ok(())
                    },
                ));
                let mut msg_token: i64 = 0;
                if let Err(e) = core_webview.add_WebMessageReceived(&msg_handler, &mut msg_token) {
                    eprintln!(
                        "[Messenger Desktop] Failed to register WebMessageReceived on '{label}': {e}"
                    );
                } else {
                    println!(
                        "[Messenger Desktop] Registered WebMessageReceived handler on call window '{label}'"
                    );
                }
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn open_in_browser(url: &str) {
    if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
        eprintln!("Failed to open default browser: {e}");
    }
}

fn is_internal_url(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or("");

    let is_messenger = host == "messenger.com" || host.ends_with(".messenger.com");

    let is_facebook_host = host == "facebook.com" || host.ends_with(".facebook.com");

    let is_facebook_internal = is_facebook_host
        && (url.path().starts_with("/messages")
            || url.path().starts_with("/login")
            || url.path().starts_with("/checkpoint")
            || url.path().starts_with("/auth")
            || url.path().starts_with("/dialog")
            || url.path().starts_with("/two_factor")
            || url.path().starts_with("/recover")
            || url.path().starts_with("/privacy")
            || url.path().starts_with("/videocall")
            || url.path().starts_with("/groupcall")
            || url.path().starts_with("/call")
            || url.path().starts_with("/rooms"));

    let is_facebook_redirect = host == "l.facebook.com" && url.path().starts_with("/l.php");

    (is_messenger || is_facebook_internal) && !is_facebook_redirect
}

fn is_popup_request(url: &tauri::Url) -> bool {
    url.as_str() == "about:blank" || url.scheme() == "about" || is_internal_url(url)
}

static CALL_POPUP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[tauri::command]
fn get_install_scope() -> install_scope::InstallScopeInfo {
    let info = install_scope::detect_install_scope();
    println!(
        "[Messenger Desktop] Install scope: {} (msi={}, detail={})",
        info.scope, info.is_msi, info.detail
    );
    info
}

#[tauri::command]
fn notify_message(
    app: tauri::AppHandle,
    title: String,
    body: String,
    conversation_id: Option<String>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().map_err(|e| e.to_string())?;

    if !settings.notifications_enabled {
        return Ok(());
    }

    let display_body = if settings.hide_message_content {
        "New message".to_string()
    } else {
        body
    };

    if let Some(ref cid) = conversation_id {
        println!("[Messenger Desktop] Toast notification requested for thread {cid}");
    } else {
        println!("[Messenger Desktop] Toast notification requested");
    }

    notification::show_toast(&app, &title, &display_body, conversation_id.as_deref())?;

    Ok(())
}

#[tauri::command]
fn update_unread_badge(app: tauri::AppHandle, count: u32, has_unread: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().map_err(|e| e.to_string())?;

    if let Some(window) = app.get_webview_window("main") {
        if !settings.badge_enabled || (!has_unread && count == 0) {
            window.set_overlay_icon(None).map_err(|e| e.to_string())?;
        } else {
            let icon = badge::create_badge_icon(count, has_unread, &settings.badge_color);
            window.set_overlay_icon(icon).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn set_notifications_enabled(app: tauri::AppHandle, enabled: bool) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.notifications_enabled = enabled;
    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Notifications enabled set to: {enabled}");
    Ok(settings.clone())
}

#[tauri::command]
fn set_badge_enabled(app: tauri::AppHandle, enabled: bool) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.badge_enabled = enabled;
    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Badge enabled set to: {enabled}");

    if !enabled {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_overlay_icon(None);
        }
    }
    Ok(settings.clone())
}

#[tauri::command]
fn set_hide_message_content(app: tauri::AppHandle, enabled: bool) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.hide_message_content = enabled;
    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Hide message content set to: {enabled}");
    Ok(settings.clone())
}

#[tauri::command]
fn set_badge_color(app: tauri::AppHandle, color: String) -> Result<AppSettings, String> {
    // Basic validation: must be a valid 6-digit hex color
    let hex = color.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Invalid hex color: {color}"));
    }
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.badge_color = format!("#{}", hex.to_uppercase());
    settings::save_settings(&app, &settings)?;
    println!(
        "[Messenger Desktop] Badge color set to: {}",
        settings.badge_color
    );
    Ok(settings.clone())
}

#[tauri::command]
fn set_run_at_startup(app: tauri::AppHandle, enabled: bool) -> Result<AppSettings, String> {
    startup::set_run_at_startup(enabled)?;

    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.run_at_startup = enabled;
    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Run at startup set to: {enabled}");
    Ok(settings.clone())
}

#[tauri::command]
fn set_minimize_to_tray(app: tauri::AppHandle, enabled: bool) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let previous_enabled = {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        let prev = settings.minimize_to_tray;
        settings.minimize_to_tray = enabled;
        settings::save_settings(&app, &settings)?;
        println!("[Messenger Desktop] Minimize to tray set to: {enabled}");
        prev
    };

    // Dynamically manage system tray lifecycle:
    // When enabled, create/show tray icon (avoiding duplicates).
    // When disabled, immediately remove tray icon.
    match tray::determine_tray_action(previous_enabled, enabled) {
        tray::TrayAction::Create => {
            if let Err(e) = tray::setup_tray(&app) {
                eprintln!("[Messenger Desktop] Failed to re-initialize system tray: {e}");
            }
        }
        tray::TrayAction::Remove => {
            tray::remove_tray(&app);
        }
        tray::TrayAction::None => {}
    }

    let settings = state.settings.lock().map_err(|e| e.to_string())?;
    Ok(settings.clone())
}

#[tauri::command]
fn set_start_minimized_to_tray(app: tauri::AppHandle, enabled: bool) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.start_minimized_to_tray = enabled;
    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Start minimized to tray set to: {enabled}");
    Ok(settings.clone())
}

#[tauri::command]
fn get_default_download_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(settings::get_default_download_dir(&app).to_string_lossy().to_string())
}

#[tauri::command]
fn choose_download_dir(app: tauri::AppHandle) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let current_dir = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings::get_effective_download_dir(&app, &settings)
    };

    let mut dialog = rfd::FileDialog::new().set_title("Choose Download Location");
    if current_dir.exists() {
        dialog = dialog.set_directory(&current_dir);
    }

    if let Some(folder) = dialog.pick_folder() {
        if !folder.is_absolute() || !folder.exists() {
            return Err("Selected folder does not exist or is invalid.".to_string());
        }

        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        let dir_str = folder.to_string_lossy().to_string();
        settings.download_dir = Some(dir_str.clone());
        settings::save_settings(&app, &settings)?;
        println!("[Messenger Desktop] Download location set to: {dir_str}");
        Ok(settings.clone())
    } else {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        Ok(settings.clone())
    }
}

#[tauri::command]
fn set_download_dir(app: tauri::AppHandle, path: Option<String>) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;

    if let Some(ref p) = path {
        let pb = PathBuf::from(p);
        if !pb.is_absolute() || !pb.exists() || !pb.is_dir() {
            return Err("Provided path is not a valid directory.".to_string());
        }
        settings.download_dir = Some(p.clone());
    } else {
        settings.download_dir = None;
    }

    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Download location updated to: {:?}", settings.download_dir);
    Ok(settings.clone())
}

#[tauri::command]
fn set_ask_download_location(app: tauri::AppHandle, enabled: bool) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.ask_download_location = enabled;
    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Ask download location set to: {enabled}");
    Ok(settings.clone())
}

#[tauri::command]
fn open_download_dir(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let dir = {
        let settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings::get_effective_download_dir(&app, &settings)
    };

    if !dir.exists() {
        return Err("Download directory does not exist.".to_string());
    }

    tauri_plugin_opener::open_path(&dir, None::<&str>)
        .map_err(|e| format!("Failed to open folder: {e}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Secondary windows (e.g. call popups) close independently and naturally
                if window.label() != "main" {
                    return;
                }

                let app = window.app_handle();
                let state = app.state::<AppState>();
                if state.is_exiting.load(Ordering::SeqCst) {
                    return;
                }

                let minimize_to_tray = state
                    .settings
                    .lock()
                    .map(|s| s.minimize_to_tray)
                    .unwrap_or(true);

                match tray::determine_close_behavior(minimize_to_tray) {
                    tray::CloseBehavior::Hide => {
                        api.prevent_close();
                        let _ = window.hide();
                        println!("[Messenger Desktop] Window hidden to system tray on close request.");
                    }
                    tray::CloseBehavior::Exit => {
                        println!("[Messenger Desktop] Terminating application on window close (Minimize to Tray disabled).");
                        tray::exit_application(app);
                    }
                }
            }
        })
        .setup(|app| {
            // Register Windows AppUserModelID identity and shortcut
            notification::register_app_identity(app.handle());

            let initial_settings = settings::load_settings(app.handle());
            if initial_settings.run_at_startup && install_scope::is_installed_production_context() {
                if let Err(e) = startup::set_run_at_startup(true) {
                    eprintln!("[Messenger Desktop] Failed to sync startup registry key: {e}");
                }
            }
            app.manage(AppState {
                settings: Mutex::new(initial_settings.clone()),
                is_exiting: AtomicBool::new(false),
            });
            app.manage(Arc::new(updater::UpdateManager::new()));
            app.manage(download::DownloadManager::new());

            // Initialize Windows System Tray only if minimize_to_tray is enabled
            if initial_settings.minimize_to_tray {
                if let Err(e) = tray::setup_tray(app.handle()) {
                    eprintln!("[Messenger Desktop] Failed to setup system tray: {e}");
                }
            } else {
                println!("[Messenger Desktop] Minimize to tray is disabled; skipping system tray setup.");
            }

            let app_handle_nav = app.handle().clone();
            let app_handle_win = app.handle().clone();

            let should_start_minimized =
                initial_settings.minimize_to_tray && initial_settings.start_minimized_to_tray;
            if should_start_minimized {
                println!("[Messenger Desktop] Starting application hidden in system tray.");
            }

            let webview_window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(
                    tauri::Url::parse("https://www.messenger.com").unwrap(),
                ),
            )
            .title("Messenger")
            .visible(!should_start_minimized)
            .position(338.0, 118.0)
            .inner_size(1244.0, 797.0)
            .min_inner_size(605.0, 800.0)
            .disable_drag_drop_handler()
            .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-renderer-backgrounding --disable-background-timer-throttling")
            .initialization_script(include_str!("inject.js"))
            .on_permission_request(|_webview, kind| {
                match kind {
                    tauri::webview::PermissionKind::Microphone
                    | tauri::webview::PermissionKind::Camera
                    | tauri::webview::PermissionKind::DisplayCapture
                    | tauri::webview::PermissionKind::Autoplay => {
                        tauri::webview::PermissionResponse::Allow
                    }
                    _ => tauri::webview::PermissionResponse::Default,
                }
            })

            // Handle normal navigation
            .on_navigation(move |url| {
                if is_internal_url(url) {
                    true
                } else if download::is_download_url(url) {
                    if let Some(window) = app_handle_nav.get_webview_window("main") {
                        let script = format!(
                            "window.__MESSENGER_DESKTOP_TRIGGER_DOWNLOAD__ && window.__MESSENGER_DESKTOP_TRIGGER_DOWNLOAD__({});",
                            serde_json::to_string(url.as_str()).unwrap_or_default()
                        );
                        let _ = window.eval(&script);
                    }
                    false
                } else {
                    open_in_browser(url.as_str());
                    false
                }
            })

            // Handle target="_blank" and window.open()
            .on_new_window(move |url, features| {
                if download::is_download_url(&url) {
                    if let Some(window) = app_handle_win.get_webview_window("main") {
                        let script = format!(
                            "window.__MESSENGER_DESKTOP_TRIGGER_DOWNLOAD__ && window.__MESSENGER_DESKTOP_TRIGGER_DOWNLOAD__({});",
                            serde_json::to_string(url.as_str()).unwrap_or_default()
                        );
                        let _ = window.eval(&script);
                    }
                    tauri::webview::NewWindowResponse::Deny
                } else if is_popup_request(&url) {
                    let count = CALL_POPUP_COUNTER.fetch_add(1, Ordering::Relaxed);
                    let label = format!("call-{count}");
                    println!("[Messenger Desktop] Opening call popup window '{label}' for URL: {url}");

                    let initial_url = if url.as_str() == "about:blank" || url.scheme() == "about" {
                        tauri::WebviewUrl::External("about:blank".parse().unwrap())
                    } else {
                        tauri::WebviewUrl::External(url.clone())
                    };

                    let app_popup = app_handle_win.clone();
                    let label_popup = label.clone();

                    let builder = tauri::WebviewWindowBuilder::new(&app_handle_win, &label, initial_url)
                        .title("Messenger Call")
                        .inner_size(1000.0, 700.0)
                        .min_inner_size(480.0, 400.0)
                        .window_features(features)
                        .disable_drag_drop_handler()
                        .additional_browser_args(
                            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-renderer-backgrounding --disable-background-timer-throttling",
                        )
                        .initialization_script(include_str!("call_inject.js"))
                        .on_document_title_changed(|w, title| {
                            if !title.is_empty() {
                                let _ = w.set_title(&title);
                            }
                        })
                        .on_permission_request(|_webview, kind| {
                            match kind {
                                tauri::webview::PermissionKind::Microphone
                                | tauri::webview::PermissionKind::Camera
                                | tauri::webview::PermissionKind::DisplayCapture
                                | tauri::webview::PermissionKind::Autoplay => {
                                    tauri::webview::PermissionResponse::Allow
                                }
                                _ => tauri::webview::PermissionResponse::Default,
                            }
                        })
                        .on_navigation(move |nav_url| {
                            if is_internal_url(nav_url)
                                || nav_url.as_str() == "about:blank"
                                || nav_url.scheme() == "about"
                            {
                                true
                            } else if download::is_download_url(nav_url) {
                                if let Some(w) = app_popup.get_webview_window(&label_popup) {
                                    let script = format!(
                                        "window.__MESSENGER_DESKTOP_TRIGGER_DOWNLOAD__ && window.__MESSENGER_DESKTOP_TRIGGER_DOWNLOAD__({});",
                                        serde_json::to_string(nav_url.as_str()).unwrap_or_default()
                                    );
                                    let _ = w.eval(&script);
                                }
                                false
                            } else {
                                open_in_browser(nav_url.as_str());
                                false
                            }
                        })
                        .on_new_window(move |new_url, _| {
                            open_in_browser(new_url.as_str());
                            tauri::webview::NewWindowResponse::Deny
                        });

                    match builder.build() {
                        Ok(call_window) => {
                            #[cfg(windows)]
                            if let Err(e) = setup_call_window_close_handlers(&call_window) {
                                eprintln!(
                                    "[Messenger Desktop] Failed to setup close handlers on call popup '{label}': {e}"
                                );
                            }

                            if let Err(e) =
                                download::setup_webview_downloads(&call_window, app_handle_win.clone())
                            {
                                eprintln!(
                                    "[Messenger Desktop] Failed to setup downloads on call popup '{label}': {e}"
                                );
                            }
                            tauri::webview::NewWindowResponse::Create { window: call_window }
                        }
                        Err(e) => {
                            eprintln!(
                                "[Messenger Desktop] Failed to create call popup window '{label}': {e}"
                            );
                            tauri::webview::NewWindowResponse::Deny
                        }
                    }
                } else {
                    open_in_browser(url.as_str());
                    tauri::webview::NewWindowResponse::Deny
                }
            })

            .build()?;

            // Attach native Windows download handling to WebView2
            if let Err(e) = download::setup_webview_downloads(&webview_window, app.handle().clone()) {
                eprintln!("[Messenger Desktop] Failed to initialize WebView2 download handler: {e}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notify_message,
            close_call_window,
            update_unread_badge,
            get_settings,
            get_install_scope,
            set_notifications_enabled,
            set_badge_enabled,
            set_hide_message_content,
            set_badge_color,
            set_run_at_startup,
            set_minimize_to_tray,
            set_start_minimized_to_tray,
            updater::check_for_updates,
            updater::download_update,
            updater::install_and_restart,
            updater::get_update_status,
            download::cancel_download,
            download::get_active_downloads,
            download::open_downloaded_file,
            download::show_in_folder,
            get_default_download_dir,
            choose_download_dir,
            set_download_dir,
            set_ask_download_location,
            open_download_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
