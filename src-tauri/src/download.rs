use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::core::{HSTRING, Interface, PWSTR};
use webview2_com::take_pwstr;
use webview2_com::{
    BytesReceivedChangedEventHandler, DownloadStartingEventHandler, StateChangedEventHandler,
};
use webview2_com::Microsoft::Web::WebView2::Win32::*;

#[derive(Clone)]
pub struct SendCom<T>(pub T);
unsafe impl<T> Send for SendCom<T> {}
unsafe impl<T> Sync for SendCom<T> {}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DownloadStartedPayload {
    pub id: u64,
    pub filename: String,
    pub path: String,
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DownloadProgressPayload {
    pub id: u64,
    pub filename: String,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DownloadCompletedPayload {
    pub id: u64,
    pub filename: String,
    pub path: String,
    pub total_bytes: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DownloadErrorPayload {
    pub id: u64,
    pub filename: String,
    pub error: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct DownloadCancelledPayload {
    pub filename: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ActiveDownloadInfo {
    pub id: u64,
    pub filename: String,
    pub path: String,
}

pub struct ActiveDownload {
    pub id: u64,
    pub filename: String,
    pub path: PathBuf,
    pub operation: SendCom<ICoreWebView2DownloadOperation>,
}

pub struct DownloadManager {
    next_id: Mutex<u64>,
    active_downloads: Mutex<HashMap<u64, ActiveDownload>>,
    recent_triggers: Mutex<HashMap<String, Instant>>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            next_id: Mutex::new(1),
            active_downloads: Mutex::new(HashMap::new()),
            recent_triggers: Mutex::new(HashMap::new()),
        }
    }

    pub fn next_download_id(&self) -> u64 {
        let mut id = self.next_id.lock().unwrap();
        let current = *id;
        *id = current.wrapping_add(1);
        current
    }

    /// Deduplicates download triggers within 2 seconds
    pub fn should_process_download(&self, uri: &str) -> bool {
        let mut triggers = self.recent_triggers.lock().unwrap();
        let now = Instant::now();

        // Clean up entries older than 5 seconds
        triggers.retain(|_, time| now.duration_since(*time) < Duration::from_secs(5));

        if let Some(last_time) = triggers.get(uri) {
            if now.duration_since(*last_time) < Duration::from_millis(2000) {
                return false;
            }
        }

        triggers.insert(uri.to_string(), now);
        true
    }

    pub fn register_active_download(
        &self,
        id: u64,
        filename: &str,
        path: &Path,
        operation: ICoreWebView2DownloadOperation,
    ) {
        let mut active = self.active_downloads.lock().unwrap();
        active.insert(
            id,
            ActiveDownload {
                id,
                filename: filename.to_string(),
                path: path.to_path_buf(),
                operation: SendCom(operation),
            },
        );
    }

    pub fn remove_active_download(&self, id: u64) {
        let mut active = self.active_downloads.lock().unwrap();
        active.remove(&id);
    }

    pub fn cancel_active_download(&self, id: u64) -> Result<(), String> {
        let active = self.active_downloads.lock().unwrap();
        if let Some(download) = active.get(&id) {
            unsafe {
                download.operation.0.Cancel().map_err(|e| e.to_string())?;
            }
            Ok(())
        } else {
            Err(format!("Download with id {id} not found."))
        }
    }

    pub fn get_active_list(&self) -> Vec<ActiveDownloadInfo> {
        let active = self.active_downloads.lock().unwrap();
        active
            .values()
            .map(|d| ActiveDownloadInfo {
                id: d.id,
                filename: d.filename.clone(),
                path: d.path.to_string_lossy().to_string(),
            })
            .collect()
    }
}

pub fn sanitize_filename(name: &str) -> String {
    // If name is a full URL, parse path to extract filename
    let raw_name = if name.starts_with("http://") || name.starts_with("https://") {
        if let Ok(u) = tauri::Url::parse(name) {
            u.path().split('/').last().unwrap_or("download").to_string()
        } else {
            name.to_string()
        }
    } else {
        name.to_string()
    };

    // Extract filename portion only to prevent path traversal
    let path = Path::new(&raw_name);
    let base = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");

    // Replace invalid Windows characters: < > : " / \ | ? * and control characters
    let mut sanitized: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();

    // Windows disallows filenames ending in a period or space
    sanitized = sanitized.trim().trim_end_matches('.').trim().to_string();

    // Avoid reserved Windows filenames (CON, PRN, AUX, NUL, COM1..9, LPT1..9)
    let uppercase = sanitized.to_uppercase();
    let stem = uppercase.split('.').next().unwrap_or("");
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.contains(&stem) {
        sanitized = format!("_{sanitized}");
    }

    if sanitized.is_empty() {
        "download".to_string()
    } else {
        sanitized
    }
}

pub fn is_download_url(url: &tauri::Url) -> bool {
    let host = url.host_str().unwrap_or("");
    let path = url.path().to_lowercase();

    // 1. Messenger / Facebook attachment CDNs
    if host == "cdn.fbsbx.com" || host.ends_with(".fbsbx.com") || host == "lookaside.fbsbx.com" {
        return true;
    }
    if host.ends_with(".fbcdn.net")
        && (path.contains("/v/")
            || url
                .query()
                .map_or(false, |q| q.contains("dl=1") || q.contains("attachment")))
    {
        return true;
    }

    // 2. Direct downloadable file extensions
    let extensions = [
        ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
        ".txt", ".csv", ".rtf", ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".mp3",
        ".wav", ".ogg", ".flac", ".aac", ".m4a", ".mp4", ".mkv", ".avi", ".mov", ".wmv",
        ".webm", ".m4v", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico",
        ".exe", ".msi", ".apk", ".dmg", ".iso",
    ];
    for ext in extensions {
        if path.ends_with(ext) {
            return true;
        }
    }

    // 3. Query parameters explicitly specifying download
    if let Some(query) = url.query() {
        if query.contains("dl=1")
            || query.contains("download=1")
            || query.contains("download=true")
            || query.contains("action=download")
        {
            return true;
        }
    }

    false
}

fn format_interrupt_reason(reason: COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON) -> String {
    match reason {
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_FAILED => "File operation failed.".to_string(),
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_ACCESS_DENIED => {
            "Access to destination folder was denied.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_NO_SPACE => "Disk is full.".to_string(),
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_NAME_TOO_LONG => {
            "Filename is too long.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_TOO_LARGE => {
            "File exceeds maximum size limit.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_MALICIOUS => {
            "Download blocked by security policy.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_BLOCKED_BY_POLICY => {
            "Download blocked by policy.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_SECURITY_CHECK_FAILED => {
            "Security scan failed.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_FILE_TOO_SHORT => {
            "File was unexpectedly truncated.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_FAILED => {
            "Network connection failed.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_TIMEOUT => {
            "Download timed out.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_DISCONNECTED => {
            "Network connection lost.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NETWORK_SERVER_DOWN => {
            "Server is unreachable.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_FAILED => {
            "Server returned an error.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_NO_RANGE => {
            "Server does not support range requests.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_BAD_CONTENT => {
            "Server sent corrupted content.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_UNAUTHORIZED => {
            "Download requires authorization.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_CERTIFICATE_PROBLEM => {
            "SSL/TLS certificate error.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_FORBIDDEN => {
            "Server denied access (403 Forbidden).".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_SERVER_UNEXPECTED_RESPONSE => {
            "Server returned an unexpected response.".to_string()
        }
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED => "Download was cancelled.".to_string(),
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_SHUTDOWN => {
            "Download stopped because the application closed.".to_string()
        }
        _ => "Download interrupted.".to_string(),
    }
}

pub fn get_unique_path(dir: &Path, filename: &str) -> PathBuf {
    let dest = dir.join(filename);
    if !dest.exists() {
        return dest;
    }

    let p = Path::new(filename);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(filename);
    let ext = p.extension().and_then(|s| s.to_str());

    for i in 1..10000 {
        let new_name = match ext {
            Some(extension) if !extension.is_empty() => format!("{stem} ({i}).{extension}"),
            _ => format!("{stem} ({i})"),
        };
        let candidate = dir.join(&new_name);
        if !candidate.exists() {
            return candidate;
        }
    }

    dir.join(format!(
        "{stem}_{}.{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        ext.unwrap_or("")
    ))
}

pub fn setup_webview_downloads(window: &WebviewWindow, app_handle: AppHandle) -> Result<(), String> {
    window
        .with_webview(move |platform_webview| {
            #[cfg(windows)]
            unsafe {
                let controller = platform_webview.controller();
                let core_webview = match controller.CoreWebView2() {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("[Messenger Desktop] Failed to get CoreWebView2 for download handler: {e}");
                        return;
                    }
                };

                let webview4: Result<ICoreWebView2_4, _> = core_webview.cast();
                let Ok(webview4) = webview4 else {
                    eprintln!("[Messenger Desktop] ICoreWebView2_4 is not supported on this Windows version");
                    return;
                };

                let app_handle_clone = app_handle.clone();
                let mut token: i64 = 0;
                let handler = DownloadStartingEventHandler::create(Box::new(move |_sender, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    handle_download_starting(&args, &app_handle_clone)
                }));

                if let Err(e) = webview4.add_DownloadStarting(&handler, &mut token) {
                    eprintln!("[Messenger Desktop] Failed to add DownloadStarting handler: {e}");
                } else {
                    println!("[Messenger Desktop] Native download interception successfully registered on WebView2");
                }
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn handle_download_starting(
    args: &ICoreWebView2DownloadStartingEventArgs,
    app_handle: &AppHandle,
) -> windows::core::Result<()> {
    unsafe {
        let download_operation = args.DownloadOperation()?;

        // 1. Get URI
        let mut uri_pwstr = PWSTR::null();
        download_operation.Uri(&mut uri_pwstr)?;
        let uri = take_pwstr(uri_pwstr);

        // 2. Check deduplication
        let state = app_handle.state::<DownloadManager>();
        if !state.should_process_download(&uri) {
            println!("[Messenger Desktop] Ignoring duplicate download trigger for URI: {uri}");
            args.SetCancel(true)?;
            return Ok(());
        }

        // 3. Get suggested path / filename from WebView2
        let mut result_path_pwstr = PWSTR::null();
        args.ResultFilePath(&mut result_path_pwstr)?;
        let default_result_path_str = take_pwstr(result_path_pwstr);
        let default_result_path = PathBuf::from(&default_result_path_str);

        let suggested_filename = default_result_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("download");

        let sanitized_filename = sanitize_filename(suggested_filename);

        println!(
            "[Messenger Desktop] Download starting: suggested='{sanitized_filename}', uri={uri}"
        );

        // 4. Resolve download directory and settings
        let app_state = app_handle.state::<crate::AppState>();
        let (download_dir, ask_save_location) = {
            if let Ok(settings) = app_state.settings.lock() {
                (
                    crate::settings::get_effective_download_dir(app_handle, &settings),
                    settings.ask_download_location,
                )
            } else {
                (
                    crate::settings::get_default_download_dir(app_handle),
                    false,
                )
            }
        };

        let user_selection: Option<PathBuf> = if ask_save_location {
            // Open native Windows Save File dialog starting in configured download directory
            let mut dialog = rfd::FileDialog::new()
                .set_title("Save File")
                .set_file_name(&sanitized_filename);

            if let Some(ext) = Path::new(&sanitized_filename).extension().and_then(|s| s.to_str()) {
                if !ext.is_empty() {
                    dialog = dialog.add_filter(ext, &[ext]);
                }
            }
            dialog = dialog.add_filter("All Files (*.*)", &["*"]);

            if download_dir.exists() {
                dialog = dialog.set_directory(&download_dir);
            }

            dialog.save_file()
        } else {
            // Auto-save to download_dir without prompting dialog
            if !download_dir.exists() {
                let _ = std::fs::create_dir_all(&download_dir);
            }
            Some(get_unique_path(&download_dir, &sanitized_filename))
        };

        match user_selection {
            Some(dest_path) => {
                // Validate destination path
                if !dest_path.is_absolute() {
                    eprintln!(
                        "[Messenger Desktop] Destination path is not absolute: {:?}",
                        dest_path
                    );
                    args.SetCancel(true)?;
                    return Ok(());
                }

                println!(
                    "[Messenger Desktop] Download destination path: {:?}",
                    dest_path
                );

                // Set destination path in WebView2
                let hstring_path = HSTRING::from(dest_path.as_os_str());
                args.SetResultFilePath(&hstring_path)?;
                args.SetHandled(true)?;

                let download_id = state.next_download_id();
                state.register_active_download(
                    download_id,
                    &sanitized_filename,
                    &dest_path,
                    download_operation.clone(),
                );

                // Initial total bytes
                let mut total_bytes: i64 = 0;
                let _ = download_operation.TotalBytesToReceive(&mut total_bytes);
                let total_opt = if total_bytes > 0 {
                    Some(total_bytes as u64)
                } else {
                    None
                };

                let _ = app_handle.emit(
                    "download-started",
                    DownloadStartedPayload {
                        id: download_id,
                        filename: sanitized_filename.clone(),
                        path: dest_path.to_string_lossy().to_string(),
                        total_bytes: total_opt,
                    },
                );

                // Attach BytesReceivedChanged event
                let app_handle_progress = app_handle.clone();
                let op_clone = download_operation.clone();
                let filename_progress = sanitized_filename.clone();
                let mut progress_token: i64 = 0;

                let progress_handler =
                    BytesReceivedChangedEventHandler::create(Box::new(move |_sender, _args| {
                        let mut received: i64 = 0;
                        let mut total: i64 = 0;
                        let _ = op_clone.BytesReceived(&mut received);
                        let _ = op_clone.TotalBytesToReceive(&mut total);

                        let percent = if total > 0 {
                            Some(
                                ((received as f64 / total as f64) * 100.0).clamp(0.0, 100.0)
                                    as u32,
                            )
                        } else {
                            None
                        };

                        let _ = app_handle_progress.emit(
                            "download-progress",
                            DownloadProgressPayload {
                                id: download_id,
                                filename: filename_progress.clone(),
                                received_bytes: received as u64,
                                total_bytes: if total > 0 { Some(total as u64) } else { None },
                                percent,
                            },
                        );
                        Ok(())
                    }));

                let _ = download_operation
                    .add_BytesReceivedChanged(&progress_handler, &mut progress_token);

                // Attach StateChanged event
                let app_handle_state = app_handle.clone();
                let op_state_clone = download_operation.clone();
                let filename_state = sanitized_filename.clone();
                let dest_path_state = dest_path.clone();
                let mut state_token: i64 = 0;

                let state_handler =
                    StateChangedEventHandler::create(Box::new(move |_sender, _args| {
                        let mut state_val = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
                        let _ = op_state_clone.State(&mut state_val);

                        if state_val == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                            let mut received: i64 = 0;
                            let _ = op_state_clone.BytesReceived(&mut received);

                            let state = app_handle_state.state::<DownloadManager>();
                            state.remove_active_download(download_id);

                            println!(
                                "[Messenger Desktop] Download completed successfully: {:?}",
                                dest_path_state
                            );

                            let _ = app_handle_state.emit(
                                "download-completed",
                                DownloadCompletedPayload {
                                    id: download_id,
                                    filename: filename_state.clone(),
                                    path: dest_path_state.to_string_lossy().to_string(),
                                    total_bytes: received as u64,
                                },
                            );
                        } else if state_val == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                            let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE;
                            let _ = op_state_clone.InterruptReason(&mut reason);

                            let state = app_handle_state.state::<DownloadManager>();
                            state.remove_active_download(download_id);

                            let reason_str = format_interrupt_reason(reason);
                            eprintln!(
                                "[Messenger Desktop] Download interrupted: {reason_str}"
                            );

                            let _ = app_handle_state.emit(
                                "download-error",
                                DownloadErrorPayload {
                                    id: download_id,
                                    filename: filename_state.clone(),
                                    error: reason_str,
                                },
                            );
                        }
                        Ok(())
                    }));

                let _ = download_operation.add_StateChanged(&state_handler, &mut state_token);
            }
            None => {
                println!(
                    "[Messenger Desktop] User cancelled Save File dialog. Cancelling download cleanly."
                );
                args.SetCancel(true)?;

                let _ = app_handle.emit(
                    "download-cancelled",
                    DownloadCancelledPayload {
                        filename: sanitized_filename,
                    },
                );
            }
        }

        Ok(())
    }
}

// ==========================================
// Tauri Commands
// ==========================================

#[tauri::command]
pub fn cancel_download(app: AppHandle, id: u64) -> Result<(), String> {
    let state = app.state::<DownloadManager>();
    state.cancel_active_download(id)
}

#[tauri::command]
pub fn get_active_downloads(app: AppHandle) -> Result<Vec<ActiveDownloadInfo>, String> {
    let state = app.state::<DownloadManager>();
    Ok(state.get_active_list())
}

#[tauri::command]
pub fn open_downloaded_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !p.exists() {
        return Err("File path does not exist or is invalid.".to_string());
    }

    tauri_plugin_opener::open_path(&p, None::<&str>)
        .map_err(|e| format!("Failed to open file: {e}"))
}

#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !p.exists() {
        return Err("File path does not exist or is invalid.".to_string());
    }

    // Try revealing via tauri_plugin_opener (SHOpenFolderAndSelectItems on Windows),
    // and fall back to explorer.exe /select,"path" if needed.
    if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&p) {
        eprintln!("[Messenger Desktop] reveal_item_in_dir error: {e}, falling back to explorer.exe");
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|spawn_err| format!("Failed to reveal file in Windows Explorer: {spawn_err}"))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_filename_normal() {
        assert_eq!(sanitize_filename("report.pdf"), "report.pdf");
        assert_eq!(sanitize_filename("holiday_photo.png"), "holiday_photo.png");
        assert_eq!(sanitize_filename("music_track.mp3"), "music_track.mp3");
    }

    #[test]
    fn test_sanitize_filename_path_traversal() {
        assert_eq!(sanitize_filename("../../evil.exe"), "evil.exe");
        assert_eq!(sanitize_filename("..\\..\\Windows\\System32\\cmd.exe"), "cmd.exe");
        assert_eq!(sanitize_filename("/etc/passwd"), "passwd");
    }

    #[test]
    fn test_sanitize_filename_special_and_invalid_chars() {
        assert_eq!(
            sanitize_filename("file:name*with?invalid\"chars<and>pipes|.txt"),
            "file_name_with_invalid_chars_and_pipes_.txt"
        );
    }

    #[test]
    fn test_sanitize_filename_unicode() {
        assert_eq!(
            sanitize_filename("Tài liệu dự án 2026 🚀.pdf"),
            "Tài liệu dự án 2026 🚀.pdf"
        );
        assert_eq!(
            sanitize_filename("日本語ファイル_写真.docx"),
            "日本語ファイル_写真.docx"
        );
    }

    #[test]
    fn test_sanitize_filename_reserved_windows_names() {
        assert_eq!(sanitize_filename("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_filename("prn.pdf"), "_prn.pdf");
        assert_eq!(sanitize_filename("AUX"), "_AUX");
        assert_eq!(sanitize_filename("NUL.zip"), "_NUL.zip");
        assert_eq!(sanitize_filename("com1.png"), "_com1.png");
    }

    #[test]
    fn test_sanitize_filename_trailing_periods_and_spaces() {
        assert_eq!(sanitize_filename("document.pdf...   "), "document.pdf");
        assert_eq!(sanitize_filename("   spaced_file.zip   "), "spaced_file.zip");
    }

    #[test]
    fn test_sanitize_filename_query_params() {
        assert_eq!(
            sanitize_filename("https://example.com/image.jpg?width=100&height=200&token=abc"),
            "image.jpg"
        );
    }

    #[test]
    fn test_sanitize_filename_empty() {
        assert_eq!(sanitize_filename(""), "download");
        assert_eq!(sanitize_filename("..."), "download");
    }

    #[test]
    fn test_is_download_url_messenger_cdns() {
        let u1 = tauri::Url::parse("https://cdn.fbsbx.com/v/t59.2708-21/123456_file.pdf?_nc_cat=100").unwrap();
        assert!(is_download_url(&u1));

        let u2 = tauri::Url::parse("https://lookaside.fbsbx.com/attachment/123456").unwrap();
        assert!(is_download_url(&u2));

        let u3 = tauri::Url::parse("https://video.xx.fbcdn.net/v/t42.17977-2/1234.mp4").unwrap();
        assert!(is_download_url(&u3));
    }

    #[test]
    fn test_is_download_url_file_extensions() {
        assert!(is_download_url(&tauri::Url::parse("https://example.com/archive.zip").unwrap()));
        assert!(is_download_url(&tauri::Url::parse("https://example.com/document.docx").unwrap()));
        assert!(is_download_url(&tauri::Url::parse("https://example.com/movie.mp4").unwrap()));
        assert!(is_download_url(&tauri::Url::parse("https://example.com/spreadsheet.xlsx").unwrap()));
    }

    #[test]
    fn test_is_download_url_query_flags() {
        assert!(is_download_url(&tauri::Url::parse("https://example.com/get_file?id=123&dl=1").unwrap()));
        assert!(is_download_url(&tauri::Url::parse("https://example.com/resource?download=1").unwrap()));
    }

    #[test]
    fn test_is_download_url_normal_navigation() {
        assert!(!is_download_url(&tauri::Url::parse("https://www.messenger.com/t/123456789").unwrap()));
        assert!(!is_download_url(&tauri::Url::parse("https://www.messenger.com/e2ee/t/987654321").unwrap()));
        assert!(!is_download_url(&tauri::Url::parse("https://google.com").unwrap()));
        assert!(!is_download_url(&tauri::Url::parse("https://github.com/tauri-apps/tauri").unwrap()));
    }

    #[test]
    fn test_download_deduplication() {
        let manager = DownloadManager::new();
        let uri = "https://cdn.fbsbx.com/v/file.pdf";

        assert!(manager.should_process_download(uri));
        // Immediate repeat within 2s should be rejected
        assert!(!manager.should_process_download(uri));

        // Different URI should be accepted
        assert!(manager.should_process_download("https://cdn.fbsbx.com/v/other.pdf"));
    }

    #[test]
    fn test_download_id_increment() {
        let manager = DownloadManager::new();
        let id1 = manager.next_download_id();
        let id2 = manager.next_download_id();
        assert_eq!(id1, 1);
        assert_eq!(id2, 2);
    }

    #[test]
    fn test_get_unique_path() {
        let temp_dir = std::env::temp_dir().join("messenger_test_unique_path");
        let _ = std::fs::remove_dir_all(&temp_dir);
        std::fs::create_dir_all(&temp_dir).unwrap();

        let path1 = get_unique_path(&temp_dir, "test.txt");
        assert_eq!(path1, temp_dir.join("test.txt"));
        std::fs::write(&path1, b"hello").unwrap();

        let path2 = get_unique_path(&temp_dir, "test.txt");
        assert_eq!(path2, temp_dir.join("test (1).txt"));
        std::fs::write(&path2, b"hello 2").unwrap();

        let path3 = get_unique_path(&temp_dir, "test.txt");
        assert_eq!(path3, temp_dir.join("test (2).txt"));

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}

