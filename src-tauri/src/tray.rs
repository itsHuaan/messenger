use std::sync::atomic::Ordering;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent, TrayIconId},
    AppHandle, Emitter, Manager, WebviewWindow,
};

pub const TRAY_ID: &str = "main-tray";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseBehavior {
    Hide,
    Exit,
}

pub fn determine_close_behavior(minimize_to_tray: bool) -> CloseBehavior {
    if minimize_to_tray {
        CloseBehavior::Hide
    } else {
        CloseBehavior::Exit
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    Create,
    Remove,
    None,
}

pub fn determine_tray_action(current_enabled: bool, new_enabled: bool) -> TrayAction {
    match (current_enabled, new_enabled) {
        (false, true) => TrayAction::Create,
        (true, false) => TrayAction::Remove,
        _ => TrayAction::None,
    }
}

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

pub fn has_tray(app: &AppHandle) -> bool {
    let id = TrayIconId::new(TRAY_ID);
    app.tray_by_id(&id).is_some()
}

pub fn remove_tray(app: &AppHandle) {
    let id = TrayIconId::new(TRAY_ID);
    if let Some(_tray) = app.remove_tray_by_id(&id) {
        println!("[Messenger Desktop] System tray icon removed.");
    }
}

pub fn exit_application(app: &AppHandle) {
    println!("[Messenger Desktop] Application exit requested.");
    let state = app.state::<crate::AppState>();
    state.is_exiting.store(true, Ordering::SeqCst);

    // Clean up tray icon so no dangling tray icon remains on Windows taskbar
    remove_tray(app);

    app.exit(0);
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if has_tray(app) {
        println!("[Messenger Desktop] System tray icon '{TRAY_ID}' already exists, skipping duplicate creation.");
        return Ok(());
    }

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
            let state = app.state::<crate::AppState>();
            if state.is_exiting.load(Ordering::SeqCst) {
                return;
            }

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
            let app = tray.app_handle();
            let state = app.state::<crate::AppState>();
            if state.is_exiting.load(Ordering::SeqCst) {
                return;
            }

            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    if let Some(window) = app.get_webview_window("main") {
                        toggle_window_visibility(&window);
                    }
                }
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tray_id_constant() {
        assert_eq!(TRAY_ID, "main-tray");
    }

    #[test]
    fn test_close_behavior_decision() {
        // When minimize to tray is enabled -> hide window
        assert_eq!(determine_close_behavior(true), CloseBehavior::Hide);
        // When minimize to tray is disabled -> exit application
        assert_eq!(determine_close_behavior(false), CloseBehavior::Exit);
    }

    #[test]
    fn test_tray_lifecycle_action() {
        // Transition from false to true -> Create tray
        assert_eq!(determine_tray_action(false, true), TrayAction::Create);
        // Transition from true to false -> Remove tray
        assert_eq!(determine_tray_action(true, false), TrayAction::Remove);
        // Already enabled and staying enabled -> None
        assert_eq!(determine_tray_action(true, true), TrayAction::None);
        // Already disabled and staying disabled -> None
        assert_eq!(determine_tray_action(false, false), TrayAction::None);
    }
}
