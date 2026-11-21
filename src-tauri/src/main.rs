// Prevents the console window from appearing in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod badge;
mod download;
mod notification;
mod settings;
mod startup;
mod tray;
mod updater;

use settings::AppSettings;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub is_exiting: AtomicBool,
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
            || url.path().starts_with("/privacy"));

    let is_facebook_redirect = host == "l.facebook.com" && url.path().starts_with("/l.php");

    (is_messenger || is_facebook_internal) && !is_facebook_redirect
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
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.minimize_to_tray = enabled;
    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Minimize to tray set to: {enabled}");
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

                if minimize_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                    println!("[Messenger Desktop] Window hidden to system tray on close request.");
                } else {
                    println!("[Messenger Desktop] Terminating application on window close (Minimize to Tray disabled).");
                    tray::exit_application(app);
                }
            }
        })
        .setup(|app| {
            // Register Windows AppUserModelID identity and shortcut
            notification::register_app_identity(app.handle());

            let initial_settings = settings::load_settings(app.handle());
            if initial_settings.run_at_startup {
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

            // Initialize Windows System Tray
            if let Err(e) = tray::setup_tray(app.handle()) {
                eprintln!("[Messenger Desktop] Failed to setup system tray: {e}");
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
            .on_new_window(move |url, _features| {
                if download::is_download_url(&url) {
                    if let Some(window) = app_handle_win.get_webview_window("main") {
                        let script = format!(
                            "window.__MESSENGER_DESKTOP_TRIGGER_DOWNLOAD__ && window.__MESSENGER_DESKTOP_TRIGGER_DOWNLOAD__({});",
                            serde_json::to_string(url.as_str()).unwrap_or_default()
                        );
                        let _ = window.eval(&script);
                    }
                    tauri::webview::NewWindowResponse::Deny
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
            update_unread_badge,
            get_settings,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
