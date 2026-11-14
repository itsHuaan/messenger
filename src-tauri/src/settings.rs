use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn default_badge_color() -> String {
    "#F52D2D".to_string()
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
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            notifications_enabled: true,
            badge_enabled: true,
            hide_message_content: false,
            badge_color: default_badge_color(),
            last_update_check: None,
        }
    }
}

pub fn get_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get app config dir: {e}"))?;

    if !config_dir.exists() {
        fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config dir: {e}"))?;
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
    }

    #[test]
    fn test_settings_serde_roundtrip() {
        let original = AppSettings {
            notifications_enabled: false,
            badge_enabled: true,
            hide_message_content: true,
            badge_color: "#00AAFF".to_string(),
            last_update_check: Some("2026-11-14 13:00:00 UTC".to_string()),
        };
        let serialized = serde_json::to_string(&original).expect("Serialization failed");
        let deserialized: AppSettings =
            serde_json::from_str(&serialized).expect("Deserialization failed");

        assert_eq!(original.notifications_enabled, deserialized.notifications_enabled);
        assert_eq!(original.badge_enabled, deserialized.badge_enabled);
        assert_eq!(original.hide_message_content, deserialized.hide_message_content);
        assert_eq!(original.badge_color, deserialized.badge_color);
        assert_eq!(original.last_update_check, deserialized.last_update_check);
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
    }
}
