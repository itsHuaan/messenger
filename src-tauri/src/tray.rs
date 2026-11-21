use std::sync::atomic::Ordering;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent, TrayIconId},
    AppHandle, Emitter, Manager, WebviewWindow,
};

pub const TRAY_ID: &str = "main-tray";

pub fn restore_and_focus(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn toggle_window_visibility(window: &WebviewWindow) {
    let is_visible = window.is_visible().unwrap_or(false);
    let is_minimized = window.is_minimized().unwrap_or(false);

    if is_visible && !is_minimized {
        let _ = window.hide();
    } else {
        restore_and_focus(window);
    }
}

pub fn trigger_manual_updater(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        restore_and_focus(&window);
        let _ = window.emit("trigger-check-updates", ());
        let _ = window.eval(
            "window.__MESSENGER_DESKTOP_CHECK_UPDATES__ && window.__MESSENGER_DESKTOP_CHECK_UPDATES__();",
        );
    }
}

pub fn exit_application(app: &AppHandle) {
    println!("[Messenger Desktop] Application exit requested from tray menu.");
    let state = app.state::<crate::AppState>();
    state.is_exiting.store(true, Ordering::SeqCst);

    // Clean up tray icon so no dangling tray icon remains on Windows taskbar
    let _ = app.remove_tray_by_id(&TrayIconId::new(TRAY_ID));

    app.exit(0);
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 1. Resolve application icon for the tray
    let icon = app.default_window_icon().cloned().or_else(|| {
        tauri::image::Image::from_bytes(include_bytes!("../icons/32x32.png")).ok()
    });

    // 2. Build native context menu
    let open_i = MenuItem::with_id(app, "open_messenger", "Open Messenger", true, None::<&str>)?;
    let toggle_i = MenuItem::with_id(app, "show_hide", "Show / Hide", true, None::<&str>)?;
    let updates_i = MenuItem::with_id(app, "check_updates", "Check for Updates", true, None::<&str>)?;
    let exit_i = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open_i, &toggle_i, &updates_i, &exit_i])?;

    // 3. Build TrayIcon with left-click, double-click, and context menu support
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Messenger")
        .menu(&menu)
        .show_menu_on_left_click(false);

    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }

    builder
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "open_messenger" => {
                    if let Some(window) = app.get_webview_window("main") {
                        restore_and_focus(&window);
                    }
                }
                "show_hide" => {
                    if let Some(window) = app.get_webview_window("main") {
                        toggle_window_visibility(&window);
                    }
                }
                "check_updates" => {
                    trigger_manual_updater(app);
                }
                "exit" => {
                    exit_application(app);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        toggle_window_visibility(&window);
                    }
                }
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        restore_and_focus(&window);
                    }
                }
                _ => {}
            }
        })
        .build(app)?;

    println!("[Messenger Desktop] System tray initialized successfully.");
    Ok(())
}
