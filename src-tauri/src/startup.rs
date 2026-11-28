#[cfg(windows)]
use winreg::RegKey;
#[cfg(windows)]
use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE};

pub const REG_RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const REG_VALUE_NAME: &str = "Messenger";

/// Formats an executable path for the Windows Run registry key.
/// Strips the `\\?\` prefix if present and wraps in double quotes.
pub fn format_startup_command(raw_path: &str) -> String {
    let clean = raw_path.strip_prefix(r"\\?\").unwrap_or(raw_path);
    format!("\"{clean}\"")
}

/// Sets or removes the Windows HKCU Run registry value for Messenger.
pub fn set_run_at_startup(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if !crate::install_scope::is_installed_production_context() {
            println!("[Messenger Desktop] Skipping startup registry update: not running in an installed production context.");
            return Ok(());
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (run_key, _) = hkcu
            .create_subkey(REG_RUN_KEY)
            .map_err(|e| format!("Failed to access Windows Run registry key: {e}"))?;

        if enabled {
            let current_exe = tauri::utils::platform::current_exe()
                .map_err(|e| format!("Failed to determine current executable path: {e}"))?;
            let formatted = format_startup_command(&current_exe.display().to_string());
            run_key
                .set_value(REG_VALUE_NAME, &formatted)
                .map_err(|e| format!("Failed to set Run registry value: {e}"))?;
            println!("[Messenger Desktop] Run at startup enabled: {formatted}");
        } else {
            match run_key.delete_value(REG_VALUE_NAME) {
                Ok(_) => {
                    println!("[Messenger Desktop] Run at startup disabled (registry value deleted)");
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Value was already absent, treat as success
                }
                Err(e) => return Err(format!("Failed to delete Run registry value: {e}")),
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Ok(())
    }
}

/// Checks whether the Windows HKCU Run registry value exists for Messenger.
#[allow(dead_code)]
pub fn is_run_at_startup_registered() -> bool {
    #[cfg(windows)]
    {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(run_key) = hkcu.open_subkey_with_flags(REG_RUN_KEY, KEY_QUERY_VALUE) {
            return run_key.get_value::<String, _>(REG_VALUE_NAME).is_ok();
        }
        false
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_startup_command_plain() {
        assert_eq!(
            format_startup_command(r"C:\Program Files\Messenger\Messenger.exe"),
            r#""C:\Program Files\Messenger\Messenger.exe""#
        );
    }

    #[test]
    fn test_format_startup_command_verbatim_prefix() {
        assert_eq!(
            format_startup_command(r"\\?\C:\Users\Admins\AppData\Local\Programs\Messenger\Messenger.exe"),
            r#""C:\Users\Admins\AppData\Local\Programs\Messenger\Messenger.exe""#
        );
    }
}
