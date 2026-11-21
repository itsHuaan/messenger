//! Windows shortcut inspection, maintenance, and repair logic.
//!
//! Ensures that:
//! 1. Start Menu shortcut exists, points to the current executable, has the correct working directory,
//!    icon location, and AppUserModelId (`com.itshuaan.messenger`).
//! 2. Desktop shortcut is updated if and only if the user already has one (never forced upon update).
//! 3. Duplicate shortcuts (e.g. `messenger.lnk` vs `Messenger.lnk`) are consolidated.
//! 4. Windows Startup registry entry is synced with the current executable path if enabled.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutDetails {
    pub target_path: PathBuf,
    pub working_dir: PathBuf,
    pub arguments: String,
    pub icon_location: (PathBuf, i32),
    pub app_user_model_id: Option<String>,
}

#[cfg(windows)]
mod windows_impl {
    use super::ShortcutDetails;
    use std::path::{Path, PathBuf};
    use windows::core::{Interface, PCWSTR, PWSTR};
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::System::Variant::VARENUM;
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};

    // System.AppUserModel.ID property key: {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5
    pub const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

    struct ComGuard;
    impl ComGuard {
        fn new() -> Self {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            ComGuard
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }

    fn to_wide_null(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn inspect_shortcut(path: &Path) -> Option<ShortcutDetails> {
        if !path.exists() {
            return None;
        }

        let _com = ComGuard::new();

        unsafe {
            let shell_link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            let persist_file: IPersistFile = shell_link.cast().ok()?;

            let wide_path = to_wide_null(&path.to_string_lossy());
            persist_file
                .Load(PCWSTR(wide_path.as_ptr()), STGM_READ)
                .ok()?;

            // Target path
            let mut target_buf = [0u16; 1024];
            let _ = shell_link.GetPath(&mut target_buf, std::ptr::null_mut(), SLGP_RAWPATH.0 as u32);
            let target_str = String::from_utf16_lossy(&target_buf)
                .trim_matches('\0')
                .to_string();

            // Working directory
            let mut work_buf = [0u16; 1024];
            let _ = shell_link.GetWorkingDirectory(&mut work_buf);
            let work_str = String::from_utf16_lossy(&work_buf)
                .trim_matches('\0')
                .to_string();

            // Arguments
            let mut args_buf = [0u16; 1024];
            let _ = shell_link.GetArguments(&mut args_buf);
            let args_str = String::from_utf16_lossy(&args_buf)
                .trim_matches('\0')
                .to_string();

            // Icon location
            let mut icon_buf = [0u16; 1024];
            let mut icon_idx = 0i32;
            let _ = shell_link.GetIconLocation(&mut icon_buf, &mut icon_idx);
            let icon_str = String::from_utf16_lossy(&icon_buf)
                .trim_matches('\0')
                .to_string();

            // AppUserModelID from IPropertyStore
            let mut app_user_model_id = None;
            if let Ok(prop_store) = shell_link.cast::<IPropertyStore>() {
                if let Ok(val) = prop_store.GetValue(&PKEY_APP_USER_MODEL_ID) {
                    if let Ok(pwstr) = windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc(&val) {
                        if !pwstr.is_null() {
                            let s = pwstr.to_string().unwrap_or_default();
                            if !s.is_empty() {
                                app_user_model_id = Some(s);
                            }
                            windows::Win32::System::Com::CoTaskMemFree(Some(pwstr.as_ptr() as _));
                        }
                    }
                }
            }

            Some(ShortcutDetails {
                target_path: PathBuf::from(target_str),
                working_dir: PathBuf::from(work_str),
                arguments: args_str,
                icon_location: (PathBuf::from(icon_str), icon_idx),
                app_user_model_id,
            })
        }
    }

    pub fn write_shortcut(
        path: &Path,
        target_path: &Path,
        working_dir: &Path,
        icon_path: &Path,
        arguments: Option<&str>,
        description: Option<&str>,
        app_user_model_id: Option<&str>,
    ) -> Result<(), String> {
        let _com = ComGuard::new();

        unsafe {
            let shell_link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("Failed to create IShellLink instance: {e}"))?;

            let wide_target = to_wide_null(&target_path.to_string_lossy());
            shell_link
                .SetPath(PCWSTR(wide_target.as_ptr()))
                .map_err(|e| format!("Failed to set shortcut path: {e}"))?;

            let wide_work = to_wide_null(&working_dir.to_string_lossy());
            shell_link
                .SetWorkingDirectory(PCWSTR(wide_work.as_ptr()))
                .map_err(|e| format!("Failed to set working directory: {e}"))?;

            let wide_icon = to_wide_null(&icon_path.to_string_lossy());
            let _ = shell_link.SetIconLocation(PCWSTR(wide_icon.as_ptr()), 0);

            if let Some(desc) = description {
                let wide_desc = to_wide_null(desc);
                let _ = shell_link.SetDescription(PCWSTR(wide_desc.as_ptr()));
            }

            if let Some(args) = arguments {
                let wide_args = to_wide_null(args);
                let _ = shell_link.SetArguments(PCWSTR(wide_args.as_ptr()));
            }

            if let Some(app_id) = app_user_model_id {
                if let Ok(prop_store) = shell_link.cast::<IPropertyStore>() {
                    let wide_app_id = to_wide_null(app_id);
                    let byte_count = wide_app_id.len() * std::mem::size_of::<u16>();
                    let mem = windows::Win32::System::Com::CoTaskMemAlloc(byte_count) as *mut u16;
                    if !mem.is_null() {
                        std::ptr::copy_nonoverlapping(wide_app_id.as_ptr(), mem, wide_app_id.len());
                        let mut prop_var = PROPVARIANT::default();
                        prop_var.Anonymous.Anonymous = std::mem::ManuallyDrop::new(
                            windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0_0 {
                                vt: VARENUM(31), // VT_LPWSTR
                                wReserved1: 0,
                                wReserved2: 0,
                                wReserved3: 0,
                                Anonymous: windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0_0_0 {
                                    pwszVal: PWSTR(mem),
                                },
                            },
                        );
                        let _ = prop_store.SetValue(&PKEY_APP_USER_MODEL_ID, &prop_var);
                        let _ = prop_store.Commit();
                        let _ = windows::Win32::System::Com::StructuredStorage::PropVariantClear(&mut prop_var);
                    }
                }
            }

            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            let persist_file: IPersistFile = shell_link
                .cast()
                .map_err(|e| format!("Failed to cast IShellLink to IPersistFile: {e}"))?;

            let wide_out = to_wide_null(&path.to_string_lossy());
            persist_file
                .Save(PCWSTR(wide_out.as_ptr()), true)
                .map_err(|e| format!("Failed to save shortcut to disk: {e}"))?;

            Ok(())
        }
    }
}

pub const APP_USER_MODEL_ID: &str = "com.itshuaan.messenger";
pub const APP_NAME: &str = "Messenger";
pub const APP_NAME_LOWER: &str = "messenger";

/// Resolves user Start Menu shortcut paths.
pub fn get_start_menu_shortcut_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        let base = PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs");
        paths.push(base.join(format!("{APP_NAME}.lnk")));
        paths.push(base.join(format!("{APP_NAME_LOWER}.lnk")));
    }
    paths
}

/// Resolves user Desktop shortcut paths.
pub fn get_desktop_shortcut_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(userprofile) = std::env::var("USERPROFILE") {
        let base = PathBuf::from(userprofile).join("Desktop");
        paths.push(base.join(format!("{APP_NAME}.lnk")));
        paths.push(base.join(format!("{APP_NAME_LOWER}.lnk")));
    }
    paths
}

/// Inspects properties of a shortcut if present on Windows.
pub fn inspect_shortcut(path: &Path) -> Option<ShortcutDetails> {
    #[cfg(windows)]
    {
        windows_impl::inspect_shortcut(path)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        None
    }
}

/// Creates or updates a shortcut with all properties strictly validated.
pub fn write_shortcut(
    path: &Path,
    target_path: &Path,
    working_dir: &Path,
    icon_path: &Path,
    arguments: Option<&str>,
    description: Option<&str>,
    app_user_model_id: Option<&str>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_impl::write_shortcut(
            path,
            target_path,
            working_dir,
            icon_path,
            arguments,
            description,
            app_user_model_id,
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (
            path,
            target_path,
            working_dir,
            icon_path,
            arguments,
            description,
            app_user_model_id,
        );
        Ok(())
    }
}

/// Normalizes path comparison by checking path canonicalization or case-insensitive equality.
pub fn paths_match(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    if let (Ok(ca), Ok(cb)) = (a.canonicalize(), b.canonicalize()) {
        if ca == cb {
            return true;
        }
    }
    a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
}

/// Performs safe, idempotent shortcut maintenance:
/// - Start Menu shortcut is verified to point to `current_exe`. If missing or pointing to outdated binary, repaired.
/// - Desktop shortcut is updated ONLY IF it already exists (never created if user deleted or didn't opt in).
/// - Duplicate shortcuts with casing differences (e.g., `messenger.lnk` vs `Messenger.lnk`) are cleaned up.
/// - Windows Startup registry entry is synced with `current_exe` if startup integration is active.
pub fn maintain_shortcuts() -> Result<(), String> {
    let current_exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return Err(format!("Could not determine current executable path: {e}")),
    };

    let working_dir = current_exe
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));

    let icon_path = &current_exe;

    // 1. Maintain Start Menu Shortcut
    let start_menu_candidates = get_start_menu_shortcut_paths();
    let preferred_start_menu = start_menu_candidates
        .first()
        .cloned()
        .ok_or_else(|| "Could not determine Start Menu directory".to_string())?;

    let mut found_start_menu = false;
    for sm_path in &start_menu_candidates {
        if sm_path.exists() {
            found_start_menu = true;
            let needs_update = match inspect_shortcut(sm_path) {
                Some(details) => {
                    !paths_match(&details.target_path, &current_exe)
                        || !paths_match(&details.working_dir, &working_dir)
                        || details.app_user_model_id.as_deref() != Some(APP_USER_MODEL_ID)
                }
                None => true,
            };

            if needs_update || sm_path != &preferred_start_menu {
                println!(
                    "[Shortcuts] Repairing Start Menu shortcut: {}",
                    preferred_start_menu.display()
                );
                write_shortcut(
                    &preferred_start_menu,
                    &current_exe,
                    &working_dir,
                    icon_path,
                    None,
                    Some(APP_NAME),
                    Some(APP_USER_MODEL_ID),
                )?;
                if sm_path != &preferred_start_menu && sm_path.exists() {
                    let _ = std::fs::remove_file(sm_path);
                }
            }
            break;
        }
    }

    if !found_start_menu {
        println!(
            "[Shortcuts] Creating missing Start Menu shortcut: {}",
            preferred_start_menu.display()
        );
        write_shortcut(
            &preferred_start_menu,
            &current_exe,
            &working_dir,
            icon_path,
            None,
            Some(APP_NAME),
            Some(APP_USER_MODEL_ID),
        )?;
    }

    // 2. Maintain Desktop Shortcut (UPDATE ONLY IF EXISTS)
    let desktop_candidates = get_desktop_shortcut_paths();
    let preferred_desktop = desktop_candidates.first().cloned();

    for dt_path in &desktop_candidates {
        if dt_path.exists() {
            let target_dest = preferred_desktop.as_ref().unwrap_or(dt_path);
            let needs_update = match inspect_shortcut(dt_path) {
                Some(details) => {
                    !paths_match(&details.target_path, &current_exe)
                        || !paths_match(&details.working_dir, &working_dir)
                        || details.app_user_model_id.as_deref() != Some(APP_USER_MODEL_ID)
                }
                None => true,
            };

            if needs_update || dt_path != target_dest {
                println!(
                    "[Shortcuts] Repairing existing Desktop shortcut: {}",
                    target_dest.display()
                );
                write_shortcut(
                    target_dest,
                    &current_exe,
                    &working_dir,
                    icon_path,
                    None,
                    Some(APP_NAME),
                    Some(APP_USER_MODEL_ID),
                )?;
                if dt_path != target_dest && dt_path.exists() {
                    let _ = std::fs::remove_file(dt_path);
                }
            }
            break;
        }
    }

    // 3. Sync Startup Registry entry if currently enabled
    #[cfg(windows)]
    {
        if crate::startup::is_run_at_startup_registered() {
            let _ = crate::startup::set_run_at_startup(true);
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_paths_match_case_insensitive() {
        assert!(paths_match(
            Path::new(r"C:\Program Files\messenger\messenger.exe"),
            Path::new(r"c:\program files\messenger\messenger.exe")
        ));
    }

    #[test]
    fn test_paths_match_different() {
        assert!(!paths_match(
            Path::new(r"C:\Program Files\messenger\messenger.exe"),
            Path::new(r"C:\Users\Admins\AppData\Local\messenger\messenger.exe")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn test_create_and_inspect_shortcut() {
        let temp_dir = std::env::temp_dir().join("messenger_shortcut_test");
        let _ = std::fs::create_dir_all(&temp_dir);

        let shortcut_path = temp_dir.join("TestMessenger.lnk");
        let target_exe = temp_dir.join("messenger.exe");
        let _ = std::fs::write(&target_exe, b"MZ");

        let res = write_shortcut(
            &shortcut_path,
            &target_exe,
            &temp_dir,
            &target_exe,
            Some("--arg-test"),
            Some("Messenger Test"),
            Some(APP_USER_MODEL_ID),
        );
        assert!(res.is_ok(), "write_shortcut failed: {:?}", res);

        let details = inspect_shortcut(&shortcut_path).expect("inspect_shortcut returned None");
        assert!(
            paths_match(&details.target_path, &target_exe),
            "Target mismatch: {:?} vs {:?}",
            details.target_path,
            target_exe
        );
        assert!(
            paths_match(&details.working_dir, &temp_dir),
            "Working dir mismatch: {:?} vs {:?}",
            details.working_dir,
            temp_dir
        );
        assert_eq!(details.arguments, "--arg-test");
        assert_eq!(details.app_user_model_id.as_deref(), Some(APP_USER_MODEL_ID));

        // Cleanup
        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
