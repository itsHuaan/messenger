use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::TypedEventHandler;
use windows::UI::Notifications::{
    ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
};
use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
use windows::core::{HSTRING, Interface, w};
use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

pub const APP_ID: &str = "com.itshuaan.messenger";
pub const APP_NAME: &str = "Messenger";

pub fn xml_escape(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(c),
        }
    }
    escaped
}

/// Resolves the absolute path to the application icon (preferring .png).
pub fn get_icon_path(app: &AppHandle) -> Option<PathBuf> {
    // 1. Try beside the running executable (works in both dev & release)
    if let Ok(exe) = tauri::utils::platform::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let candidates = [
                exe_dir.join("icons").join("icon.png"),
                exe_dir.join("icons").join("icon.ico"),
                exe_dir.join("icon.png"),
                exe_dir.join("icon.ico"),
            ];
            for candidate in &candidates {
                if candidate.exists() {
                    return Some(candidate.clone());
                }
            }
        }
    }

    // 2. Try bundled resource directory
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidates = [
            resource_dir.join("icons").join("icon.png"),
            resource_dir.join("icons").join("icon.ico"),
        ];
        for candidate in &candidates {
            if candidate.exists() {
                return Some(candidate.clone());
            }
        }
    }

    // 3. Try working directory (dev mode)
    if let Ok(curr_dir) = std::env::current_dir() {
        let candidates = [
            curr_dir.join("icons").join("icon.png"),
            curr_dir.join("icons").join("icon.ico"),
            curr_dir.join("src-tauri").join("icons").join("icon.png"),
            curr_dir.join("src-tauri").join("icons").join("icon.ico"),
        ];
        for candidate in candidates {
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    None
}

/// Converts a filesystem path to a file:/// URI suitable for toast XML.
/// Replaces backslashes with forward slashes.
fn path_to_file_uri(path: &PathBuf) -> String {
    let s = path.to_string_lossy();
    // Windows: replace backslashes, ensure no double slashes
    let forward = s.replace('\\', "/");
    format!("file:///{}", forward.trim_start_matches('/'))
}

/// Registers the application identity with Windows so notifications show "Messenger" and its icon.
pub fn register_app_identity(app: &AppHandle) {
    // 1. Set explicit AppUserModelID on the running process
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(w!("com.itshuaan.messenger"));
    }

    // 2. Register AppUserModelID in HKCU registry
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let subkey_path = format!(r"SOFTWARE\Classes\AppUserModelId\{APP_ID}");
    if let Ok((key, _)) = hkcu.create_subkey(&subkey_path) {
        let _ = key.set_value("DisplayName", &APP_NAME);
        let _ = key.set_value("IconBackgroundColor", &"0");
        if let Some(icon_path) = get_icon_path(app) {
            let icon_str = icon_path.to_str().unwrap_or("");
            let _ = key.set_value("IconUri", &icon_str);
        }
    }

    // 3. Ensure Windows shortcuts (Start Menu and Desktop if exists) are maintained and valid
    if let Err(e) = crate::shortcut::maintain_shortcuts() {
        eprintln!("[Shortcuts] Error maintaining shortcuts: {e}");
    }
}

/// Parses a query string formatted argument like "action=reply&threadId=123"
fn parse_arguments(query: &str) -> (String, String) {
    let mut action = String::new();
    let mut thread_id = String::new();

    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            match k {
                "action" => action = v.to_string(),
                "threadId" => thread_id = v.to_string(),
                _ => {}
            }
        }
    }

    (action, thread_id)
}

fn handle_toast_activation(app: &AppHandle, arguments: &str) {
    let (action, thread_id) = parse_arguments(arguments);
    println!("[Messenger Desktop] Toast activated: action='{action}', threadId='{thread_id}'");

    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    // Bring application to the foreground
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();

    // Navigate to the conversation
    if !thread_id.is_empty() {
        let script = format!(
            "if (typeof window.__MESSENGER_DESKTOP_OPEN_THREAD__ === 'function') {{ \
                window.__MESSENGER_DESKTOP_OPEN_THREAD__({}); \
            }}",
            serde_json::to_string(&thread_id).unwrap_or_default()
        );
        let _ = window.eval(&script);
    }
}

/// Displays a native Windows toast notification (no inline reply, clean click-to-open).
pub fn show_toast(
    app: &AppHandle,
    title: &str,
    body: &str,
    conversation_id: Option<&str>,
) -> Result<(), String> {
    let thread_id = conversation_id.unwrap_or("");
    let escaped_title = xml_escape(title);
    let escaped_body = xml_escape(body);
    let escaped_thread_id = xml_escape(thread_id);

    // Build the app logo override element using the app icon
    let icon_element = if let Some(icon_path) = get_icon_path(app) {
        let icon_uri = xml_escape(&path_to_file_uri(&icon_path));
        format!(r#"<image placement="appLogoOverride" hint-crop="circle" src="{icon_uri}"/>"#)
    } else {
        String::new()
    };

    let xml_content = format!(
        r#"<toast launch="action=open&amp;threadId={escaped_thread_id}">
    <visual>
        <binding template="ToastGeneric">
            <text>{escaped_title}</text>
            <text>{escaped_body}</text>
            {icon_element}
        </binding>
    </visual>
</toast>"#
    );

    let xml_doc = XmlDocument::new().map_err(|e| format!("Failed to create XmlDocument: {e}"))?;
    xml_doc
        .LoadXml(&HSTRING::from(&xml_content))
        .map_err(|e| format!("Failed to load Toast XML: {e}"))?;

    let toast = ToastNotification::CreateToastNotification(&xml_doc)
        .map_err(|e| format!("Failed to create ToastNotification: {e}"))?;

    let app_handle = app.clone();
    let handler = TypedEventHandler::<ToastNotification, windows::core::IInspectable>::new(
        move |_sender, insp| {
            if let Some(ref insp_val) = *insp {
                if let Ok(toast_args) = insp_val.cast::<ToastActivatedEventArgs>() {
                    if let Ok(arguments) = toast_args.Arguments() {
                        let args_str = arguments.to_string();
                        handle_toast_activation(&app_handle, &args_str);
                    }
                }
            }
            Ok(())
        },
    );

    toast
        .Activated(&handler)
        .map_err(|e| format!("Failed to register Activated handler: {e}"))?;

    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(APP_ID))
        .map_err(|e| format!("Failed to create ToastNotifier for {APP_ID}: {e}"))?;

    notifier
        .Show(&toast)
        .map_err(|e| format!("Failed to display toast notification: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_xml_escape() {
        assert_eq!(
            xml_escape(r#"Alice & Bob <friends> "yes" 'no'"#),
            "Alice &amp; Bob &lt;friends&gt; &quot;yes&quot; &apos;no&apos;"
        );
    }

    #[test]
    fn test_parse_arguments() {
        let (action, thread_id) = parse_arguments("action=reply&threadId=12345678");
        assert_eq!(action, "reply");
        assert_eq!(thread_id, "12345678");

        let (action2, thread_id2) = parse_arguments("action=open&threadId=abcd");
        assert_eq!(action2, "open");
        assert_eq!(thread_id2, "abcd");
    }
}
