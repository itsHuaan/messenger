use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub is_exiting: AtomicBool,
}

fn default_badge_color() -> String {
    "#F52D2D".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub notifications_enabled: bool,
    pub badge_enabled: bool,
    #[serde(default)]
    pub hide_message_content: bool,
    /// Badge fill color as a hex string, e.g. "#F52D2D"
    #[serde(default = "default_badge_color")]
    pub badge_color: String,
    #[serde(default)]
    pub last_update_check: Option<String>,
    #[serde(default)]
    pub run_at_startup: bool,
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    #[serde(default)]
    pub start_minimized_to_tray: bool,
    #[serde(default)]
    pub download_dir: Option<String>,
    #[serde(default)]
    pub ask_download_location: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            notifications_enabled: true,
            badge_enabled: true,
            hide_message_content: false,
            badge_color: default_badge_color(),
            last_update_check: None,
            run_at_startup: false,
            minimize_to_tray: true,
            start_minimized_to_tray: false,
            download_dir: None,
            ask_download_location: false,
        }
    }
}

pub fn get_default_download_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .download_dir()
        .ok()
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(|p| PathBuf::from(p).join("Downloads"))
        })
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn get_effective_download_dir(app: &AppHandle, settings: &AppSettings) -> PathBuf {
    if let Some(dir) = &settings.download_dir {
        let p = PathBuf::from(dir);
        if p.exists() && p.is_dir() {
            return p;
        }
    }
    get_default_download_dir(app)
}

pub fn get_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get app config dir: {e}"))?;

    if !config_dir.exists() {
        fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    }

    Ok(config_dir.join("settings.json"))
}

pub fn load_settings(app: &AppHandle) -> AppSettings {
    if let Ok(path) = get_settings_path(app) {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(settings) = serde_json::from_str::<AppSettings>(&content) {
                    return settings;
                }
            }
        }
    }
    AppSettings::default()
}

pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = get_settings_path(app)?;
    let content = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Failed to serialize settings: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("Failed to write settings to disk: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_settings() {
        let settings = AppSettings::default();
        assert!(settings.notifications_enabled);
        assert!(settings.badge_enabled);
        assert!(!settings.hide_message_content);
        assert_eq!(settings.badge_color, "#F52D2D");
        assert!(settings.last_update_check.is_none());
        assert!(!settings.run_at_startup, "Default run_at_startup must be false (off)");
        assert!(settings.minimize_to_tray, "Default minimize_to_tray must be true (on)");
        assert!(!settings.start_minimized_to_tray, "Default start_minimized_to_tray must be false (off)");
        assert!(settings.download_dir.is_none(), "Default download_dir must be None");
        assert!(!settings.ask_download_location, "Default ask_download_location must be false");
    }

    #[test]
    fn test_settings_serde_roundtrip() {
        let original = AppSettings {
            notifications_enabled: false,
            badge_enabled: true,
            hide_message_content: true,
            badge_color: "#00AAFF".to_string(),
            last_update_check: Some("2026-11-14 13:00:00 UTC".to_string()),
            run_at_startup: true,
            minimize_to_tray: false,
            start_minimized_to_tray: true,
            download_dir: Some("D:\\MessengerDownloads".to_string()),
            ask_download_location: true,
        };
        let serialized = serde_json::to_string(&original).expect("Serialization failed");
        let deserialized: AppSettings =
            serde_json::from_str(&serialized).expect("Deserialization failed");

        assert_eq!(
            original.notifications_enabled,
            deserialized.notifications_enabled
        );
        assert_eq!(original.badge_enabled, deserialized.badge_enabled);
        assert_eq!(
            original.hide_message_content,
            deserialized.hide_message_content
        );
        assert_eq!(original.badge_color, deserialized.badge_color);
        assert_eq!(original.last_update_check, deserialized.last_update_check);
        assert_eq!(original.run_at_startup, deserialized.run_at_startup);
        assert_eq!(original.minimize_to_tray, deserialized.minimize_to_tray);
        assert_eq!(original.start_minimized_to_tray, deserialized.start_minimized_to_tray);
        assert_eq!(original.download_dir, deserialized.download_dir);
        assert_eq!(original.ask_download_location, deserialized.ask_download_location);
    }

    #[test]
    fn test_backward_compatibility_missing_hide_content() {
        let json_data = r#"{"notifications_enabled":true,"badge_enabled":false}"#;
        let deserialized: AppSettings =
            serde_json::from_str(json_data).expect("Deserialization failed");
        assert!(deserialized.notifications_enabled);
        assert!(!deserialized.badge_enabled);
        assert!(!deserialized.hide_message_content);
        assert_eq!(deserialized.badge_color, "#F52D2D");
        assert!(!deserialized.run_at_startup, "Missing run_at_startup must default to false");
        assert!(deserialized.minimize_to_tray, "Missing minimize_to_tray must default to true");
        assert!(!deserialized.start_minimized_to_tray, "Missing start_minimized_to_tray must default to false");
        assert!(deserialized.download_dir.is_none());
        assert!(!deserialized.ask_download_location);
    }
}
