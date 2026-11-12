
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(
                    tauri::Url::parse("https://www.messenger.com").unwrap()
                )
            )
            .title("Messenger")
            .position(338.0, 118.0)
            .inner_size(1244.0, 797.0)

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
