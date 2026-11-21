//! Windows installation scope detection.
//!
//! Determines whether the running application was installed in user scope
//! (HKCU) or machine scope (HKLM) by inspecting the registry metadata
//! written by the Tauri NSIS installer.
//!
//! Registry keys checked (product name: `messenger`, manufacturer: `itshuaan`):
//!   - Uninstall key: `Software\Microsoft\Windows\CurrentVersion\Uninstall\messenger`
//!   - Manufacturer product key: `Software\itshuaan\messenger`

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

/// NSIS-generated registry key names (must match the generated installer.nsi defines).
const PRODUCT_NAME: &str = "messenger";
const MANUFACTURER: &str = "itshuaan";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\messenger";
#[allow(dead_code)]
const MANU_PRODUCT_KEY: &str = r"Software\itshuaan\messenger";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum InstallScope {
    #[serde(rename = "USER_SCOPE")]
    UserScope,
    #[serde(rename = "MACHINE_SCOPE")]
    MachineScope,
    #[serde(rename = "UNKNOWN")]
    Unknown,
}

impl std::fmt::Display for InstallScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InstallScope::UserScope => write!(f, "USER_SCOPE"),
            InstallScope::MachineScope => write!(f, "MACHINE_SCOPE"),
            InstallScope::Unknown => write!(f, "UNKNOWN"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallScopeInfo {
    pub scope: InstallScope,
    pub install_location: Option<String>,
    pub display_version: Option<String>,
    pub is_msi: bool,
    pub detail: String,
}

/// Internal struct for data read from one registry hive.
struct RegistryScopeData {
    install_location: Option<String>,
    display_version: Option<String>,
    uninstall_string: Option<String>,
}

/// Read NSIS installation metadata from the given registry hive.
fn read_scope_data(hive: winreg::HKEY) -> Option<RegistryScopeData> {
    let root = RegKey::predef(hive);
    let subkey = root.open_subkey_with_flags(UNINSTALL_KEY, KEY_READ).ok()?;

    // Validate DisplayName matches our product
    let display_name: String = subkey.get_value("DisplayName").ok()?;
    if !display_name.eq_ignore_ascii_case(PRODUCT_NAME) {
        return None;
    }

    Some(RegistryScopeData {
        install_location: subkey.get_value("InstallLocation").ok(),
        display_version: subkey.get_value("DisplayVersion").ok(),
        uninstall_string: subkey.get_value("UninstallString").ok(),
    })
}

/// Strip surrounding double-quotes that the NSIS installer adds to some registry values.
fn clean_quoted_path(s: &str) -> String {
    s.trim().trim_matches('"').to_string()
}

/// Returns true when the uninstall string looks like an MSI invocation.
fn is_msi_uninstall(uninstall_string: &Option<String>) -> bool {
    match uninstall_string {
        Some(s) => {
            let lower = s.to_lowercase();
            lower.contains("msiexec") || lower.ends_with(".msi")
        }
        None => false,
    }
}

/// Scan HKLM for a WiX (MSI) installation matching our product name and manufacturer.
fn has_wix_install_in_hklm() -> bool {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let uninstall_root = match hklm.open_subkey_with_flags(
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        KEY_READ,
    ) {
        Ok(key) => key,
        Err(_) => return false,
    };

    for name in uninstall_root.enum_keys().filter_map(|r| r.ok()) {
        if let Ok(subkey) = uninstall_root.open_subkey_with_flags(&name, KEY_READ) {
            let dn: String = match subkey.get_value("DisplayName") {
                Ok(v) => v,
                Err(_) => continue,
            };
            let pub_: String = match subkey.get_value("Publisher") {
                Ok(v) => v,
                Err(_) => continue,
            };
            if dn.eq_ignore_ascii_case(PRODUCT_NAME) && pub_.eq_ignore_ascii_case(MANUFACTURER) {
                let us: Option<String> = subkey.get_value("UninstallString").ok();
                if is_msi_uninstall(&us) {
                    return true;
                }
            }
        }
    }
    false
}

/// Check whether the registered install location matches the directory of the running executable.
fn validate_install_location(registered_location: &Option<String>, current_exe: &PathBuf) -> bool {
    let loc = match registered_location {
        Some(s) => clean_quoted_path(s),
        None => return false,
    };
    if loc.is_empty() {
        return false;
    }
    let registered_dir = PathBuf::from(&loc);
    match current_exe.parent() {
        Some(exe_dir) => crate::shortcut::paths_match(exe_dir, &registered_dir),
        None => false,
    }
}

/// Detect the installation scope of the currently running application.
///
/// Returns [`InstallScopeInfo`] with the detected scope, install location,
/// version, MSI flag, and a human-readable detail string.
pub fn detect_install_scope() -> InstallScopeInfo {
    let current_exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            return InstallScopeInfo {
                scope: InstallScope::Unknown,
                install_location: None,
                display_version: None,
                is_msi: false,
                detail: format!("Could not determine current executable path: {e}"),
            };
        }
    };

    let has_msi = has_wix_install_in_hklm();

    let hkcu_data = read_scope_data(HKEY_CURRENT_USER);
    let hklm_data = read_scope_data(HKEY_LOCAL_MACHINE);

    let hkcu_valid = hkcu_data
        .as_ref()
        .is_some_and(|d| validate_install_location(&d.install_location, &current_exe));
    let hklm_valid = hklm_data
        .as_ref()
        .is_some_and(|d| validate_install_location(&d.install_location, &current_exe));

    let hkcu_is_msi = hkcu_data
        .as_ref()
        .is_some_and(|d| is_msi_uninstall(&d.uninstall_string));
    let hklm_is_msi = hklm_data
        .as_ref()
        .is_some_and(|d| is_msi_uninstall(&d.uninstall_string));

    match (hkcu_valid, hklm_valid) {
        (true, false) => {
            let d = hkcu_data.unwrap();
            InstallScopeInfo {
                scope: InstallScope::UserScope,
                install_location: d.install_location.map(|s| clean_quoted_path(&s)),
                display_version: d.display_version,
                is_msi: hkcu_is_msi,
                detail: "Installation detected in HKCU (current-user scope).".to_string(),
            }
        }
        (false, true) => {
            let d = hklm_data.unwrap();
            InstallScopeInfo {
                scope: InstallScope::MachineScope,
                install_location: d.install_location.map(|s| clean_quoted_path(&s)),
                display_version: d.display_version,
                is_msi: hklm_is_msi || has_msi,
                detail: "Installation detected in HKLM (per-machine scope).".to_string(),
            }
        }
        (true, true) => {
            let d = hkcu_data.unwrap();
            InstallScopeInfo {
                scope: InstallScope::Unknown,
                install_location: d.install_location.map(|s| clean_quoted_path(&s)),
                display_version: d.display_version,
                is_msi: has_msi || hkcu_is_msi || hklm_is_msi,
                detail: "Installation metadata found in both HKCU and HKLM. Scope is ambiguous."
                    .to_string(),
            }
        }
        (false, false) => {
            let detail = if hkcu_data.is_some() || hklm_data.is_some() {
                "Registry entries found but install location does not match the running executable."
                    .to_string()
            } else {
                "No installation registry entries found for this application.".to_string()
            };
            InstallScopeInfo {
                scope: InstallScope::Unknown,
                install_location: None,
                display_version: None,
                is_msi: has_msi,
                detail,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_quoted_path() {
        assert_eq!(
            clean_quoted_path(r#""C:\Users\Test\AppData\Local\messenger""#),
            r"C:\Users\Test\AppData\Local\messenger"
        );
        assert_eq!(clean_quoted_path(r"C:\plain\path"), r"C:\plain\path");
        assert_eq!(clean_quoted_path(""), "");
    }

    #[test]
    fn test_is_msi_uninstall() {
        assert!(is_msi_uninstall(&Some(
            r"MsiExec.exe /I{GUID}".to_string()
        )));
        assert!(is_msi_uninstall(&Some(r"msiexec /x{GUID}".to_string())));
        assert!(!is_msi_uninstall(&Some(
            r"C:\path\uninstall.exe".to_string()
        )));
        assert!(!is_msi_uninstall(&None));
    }

    #[test]
    fn test_install_scope_display() {
        assert_eq!(InstallScope::UserScope.to_string(), "USER_SCOPE");
        assert_eq!(InstallScope::MachineScope.to_string(), "MACHINE_SCOPE");
        assert_eq!(InstallScope::Unknown.to_string(), "UNKNOWN");
    }

    #[test]
    fn test_install_scope_serde() {
        let info = InstallScopeInfo {
            scope: InstallScope::UserScope,
            install_location: Some(r"C:\Users\Test\AppData\Local\messenger".to_string()),
            display_version: Some("0.0.11".to_string()),
            is_msi: false,
            detail: "test".to_string(),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains("\"USER_SCOPE\""));
        let deserialized: InstallScopeInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.scope, InstallScope::UserScope);
    }
}
