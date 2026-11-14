fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "notify_message",
            "update_unread_badge",
            "get_settings",
            "set_notifications_enabled",
            "set_badge_enabled",
            "set_hide_message_content",
            "set_badge_color",
            "set_run_at_startup",
            "check_for_updates",
            "download_update",
            "install_and_restart",
            "get_update_status",
        ]),
    ))
    .expect("failed to run tauri-build");
}
