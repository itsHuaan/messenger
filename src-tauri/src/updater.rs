use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Generates a clean UTC ISO-style timestamp using only standard library
pub fn current_timestamp() -> String {
    let now = std::time::SystemTime::now();
    let duration = now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = duration.as_secs();

    let days = secs / 86400;
    let day_secs = secs % 86400;
    let hours = day_secs / 3600;
    let minutes = (day_secs % 3600) / 60;
    let seconds = day_secs % 60;

    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1029 + doe / 1461 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!("{y:04}-{m:02}-{d:02} {hours:02}:{minutes:02}:{seconds:02} UTC")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub body: Option<String>,
    pub date: Option<String>,
    pub last_check: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgressEvent {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: Option<u32>,
}

pub struct DownloadedPayload {
    pub update: tauri_plugin_updater::Update,
    pub bytes: Vec<u8>,
}

pub struct UpdateManager {
    pub pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    pub downloaded_update: Mutex<Option<DownloadedPayload>>,
    pub is_checking: AtomicBool,
    pub is_downloading: AtomicBool,
}

impl UpdateManager {
    pub fn new() -> Self {
        Self {
            pending_update: Mutex::new(None),
            downloaded_update: Mutex::new(None),
            is_checking: AtomicBool::new(false),
            is_downloading: AtomicBool::new(false),
        }
    }
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdateInfo, String> {
    let state = app.state::<Arc<UpdateManager>>();

    // Prevent duplicate concurrent requests
    if state
        .is_checking
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("An update check is already in progress.".to_string());
    }

    struct CheckGuard<'a>(&'a AtomicBool);
    impl<'a> Drop for CheckGuard<'a> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = CheckGuard(&state.is_checking);

    let current_version = app.package_info().version.to_string();

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[Updater] Failed to initialize updater plugin: {e}");
            return Err(format!("Updater initialization failed: {e}"));
        }
    };

    println!("[Updater] Checking for updates (current version: {current_version})...");

    let check_res = updater.check().await;

    // Record check timestamp in settings
    let now_str = current_timestamp();
    let app_state = app.state::<crate::AppState>();
    if let Ok(mut settings) = app_state.settings.lock() {
        settings.last_update_check = Some(now_str.clone());
        let _ = crate::settings::save_settings(&app, &settings);
    }

    match check_res {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let body = update.body.clone();
            let date = update.date.as_ref().map(|d| d.to_string());

            println!("[Updater] Update available: {version} (current: {current_version})");

            let mut pending = state.pending_update.lock().map_err(|e| e.to_string())?;
            *pending = Some(update);

            Ok(UpdateInfo {
                available: true,
                current_version,
                version: Some(version),
                body,
                date,
                last_check: Some(now_str),
            })
        }
        Ok(None) => {
            println!("[Updater] Application is up to date: {current_version}");
            let mut pending = state.pending_update.lock().map_err(|e| e.to_string())?;
            *pending = None;

            Ok(UpdateInfo {
                available: false,
                current_version,
                version: None,
                body: None,
                date: None,
                last_check: Some(now_str),
            })
        }
        Err(e) => {
            eprintln!("[Updater] Error while checking for update: {e}");
            let err_msg = e.to_string();
            let friendly = if err_msg.contains("dns")
                || err_msg.contains("resolve")
                || err_msg.contains("network")
                || err_msg.contains("connection")
                || err_msg.contains("timed out")
            {
                "Unable to connect to the update server. Please check your internet connection and try again."
            } else if err_msg.contains("signature") || err_msg.contains("minisign") {
                "Update signature verification failed. The update cannot be verified securely."
            } else if err_msg.contains("404") || err_msg.contains("status code: 404") {
                "No release manifest found at the updater endpoint."
            } else {
                &err_msg
            };
            Err(friendly.to_string())
        }
    }
}

#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<String, String> {
    let state = app.state::<Arc<UpdateManager>>();

    if state
        .is_downloading
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("A download is already in progress.".to_string());
    }

    struct DownloadGuard<'a>(&'a AtomicBool);
    impl<'a> Drop for DownloadGuard<'a> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = DownloadGuard(&state.is_downloading);

    let update = {
        let pending = state.pending_update.lock().map_err(|e| e.to_string())?;
        match pending.as_ref() {
            Some(u) => u.clone(),
            None => {
                return Err(
                    "No pending update available to download. Please check for updates first."
                        .to_string(),
                )
            }
        }
    };

    let target_version = update.version.clone();
    println!("[Updater] Starting background download for version {target_version}...");

    let app_clone = app.clone();
    let mut downloaded_bytes: u64 = 0;

    let download_result = update
        .download(
            move |chunk_length, content_length| {
                downloaded_bytes += chunk_length as u64;
                let percent = content_length.map(|tot| {
                    if tot > 0 {
                        ((downloaded_bytes as f64 / tot as f64) * 100.0).round() as u32
                    } else {
                        0
                    }
                });

                if let Some(window) = app_clone.get_webview_window("main") {
                    let _ = window.emit(
                        "update-download-progress",
                        DownloadProgressEvent {
                            downloaded: downloaded_bytes,
                            total: content_length,
                            percent,
                        },
                    );
                }
            },
            || {
                println!("[Updater] Download finished. Verifying signature and payload...");
            },
        )
        .await;

    match download_result {
        Ok(bytes) => {
            println!(
                "[Updater] Successfully downloaded and verified {} bytes for version {target_version}",
                bytes.len()
            );

            // Store downloaded payload for user-initiated install
            let mut downloaded = state.downloaded_update.lock().map_err(|e| e.to_string())?;
            *downloaded = Some(DownloadedPayload { update, bytes });

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.emit(
                    "update-download-complete",
                    serde_json::json!({
                        "version": target_version
                    }),
                );
            }

            Ok(target_version)
        }
        Err(e) => {
            eprintln!("[Updater] Download failed: {e}");
            let err_msg = e.to_string();
            let friendly = if err_msg.contains("signature") || err_msg.contains("minisign") {
                "Downloaded update failed cryptographic signature verification. Installation aborted for security."
            } else if err_msg.contains("connection")
                || err_msg.contains("network")
                || err_msg.contains("timed out")
            {
                "Download interrupted. Please check your internet connection and retry."
            } else {
                &err_msg
            };
            Err(friendly.to_string())
        }
    }
}

#[tauri::command]
pub async fn install_and_restart(app: AppHandle) -> Result<(), String> {
    let state = app.state::<Arc<UpdateManager>>();

    let payload = {
        let mut downloaded = state.downloaded_update.lock().map_err(|e| e.to_string())?;
        downloaded.take()
    };

    let payload = match payload {
        Some(p) => p,
        None => return Err("No downloaded update ready to install.".to_string()),
    };

    println!("[Updater] User confirmed install and restart. Launching installer...");

    // Install the update
    if let Err(e) = payload.update.install(&payload.bytes) {
        eprintln!("[Updater] Installation execution error: {e}");
        return Err(format!("Failed to execute installer: {e}"));
    }

    println!("[Updater] Installer launched. Exiting application to allow update replacement.");
    app.exit(0);

    Ok(())
}

#[tauri::command]
pub fn get_update_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let current_version = app.package_info().version.to_string();
    let state = app.state::<crate::AppState>();
    let settings = state.settings.lock().map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "current_version": current_version,
        "last_check": settings.last_update_check,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_current_timestamp_format() {
        let ts = current_timestamp();
        assert!(ts.contains("UTC"));
        assert_eq!(ts.len(), 23); // "YYYY-MM-DD HH:MM:SS UTC"
    }

    #[test]
    fn test_update_manager_initial_state() {
        let mgr = UpdateManager::new();
        assert!(!mgr.is_checking.load(Ordering::SeqCst));
        assert!(!mgr.is_downloading.load(Ordering::SeqCst));
    }
}
