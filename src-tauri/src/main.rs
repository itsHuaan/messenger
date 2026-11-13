// Prevents the console window from appearing in Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod badge;
mod notification;
mod settings;

use settings::AppSettings;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
}

fn open_in_browser(url: &str) {
    if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
        eprintln!("Failed to open default browser: {e}");
    }
}

fn is_internal_url(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or("");

    let is_facebook =
        host == "facebook.com" || host.ends_with(".facebook.com");

    let is_messenger =
        host == "messenger.com" || host.ends_with(".messenger.com");

    let is_facebook_redirect =
        host == "l.facebook.com" && url.path().starts_with("/l.php");

    (is_facebook || is_messenger) && !is_facebook_redirect
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

    notification::show_toast(
        &app,
        &title,
        &display_body,
        conversation_id.as_deref(),
    )?;

    Ok(())
}

#[tauri::command]
fn update_unread_badge(
    app: tauri::AppHandle,
    count: u32,
    has_unread: bool,
) -> Result<(), String> {
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
fn set_notifications_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.notifications_enabled = enabled;
    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Notifications enabled set to: {enabled}");
    Ok(settings.clone())
}

#[tauri::command]
fn set_badge_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<AppSettings, String> {
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
fn set_hide_message_content(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.hide_message_content = enabled;
    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Hide message content set to: {enabled}");
    Ok(settings.clone())
}

#[tauri::command]
fn set_badge_color(
    app: tauri::AppHandle,
    color: String,
) -> Result<AppSettings, String> {
    // Basic validation: must be a valid 6-digit hex color
    let hex = color.trim().trim_start_matches('#');
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("Invalid hex color: {color}"));
    }
    let state = app.state::<AppState>();
    let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
    settings.badge_color = format!("#{}", hex.to_uppercase());
    settings::save_settings(&app, &settings)?;
    println!("[Messenger Desktop] Badge color set to: {}", settings.badge_color);
    Ok(settings.clone())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Register Windows AppUserModelID identity and shortcut
            notification::register_app_identity(app.handle());

            let initial_settings = settings::load_settings(app.handle());
            app.manage(AppState {
                settings: Mutex::new(initial_settings),
            });

            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(
                    tauri::Url::parse("https://www.messenger.com").unwrap(),
                ),
            )
            .title("Messenger")
            .position(338.0, 118.0)
            .inner_size(1244.0, 797.0)
            .min_inner_size(605.0, 800.0)
            .initialization_script(include_str!("inject.js"))

            // Handle normal navigation
            .on_navigation(|url| {
                if is_internal_url(url) {
                    true
                } else {
                    open_in_browser(url.as_str());
                    false
                }
            })

            // Handle target="_blank" and window.open()
            .on_new_window(|url, _features| {
                open_in_browser(url.as_str());
                tauri::webview::NewWindowResponse::Deny
            })

            .build()?;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
