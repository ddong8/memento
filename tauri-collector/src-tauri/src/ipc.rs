//! Tauri command handlers — every fn here is callable from the UI via
//! `invoke('cmd_name', { args })`.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::config::Config;
use crate::sidecar::{Sidecar, Status};

pub struct AppState {
    pub sidecar: Arc<Sidecar>,
}

#[derive(Debug, Serialize)]
pub struct CmdError {
    pub message: String,
}

impl<E: std::fmt::Display> From<E> for CmdError {
    fn from(e: E) -> Self {
        Self {
            message: e.to_string(),
        }
    }
}

type CmdResult<T> = Result<T, CmdError>;

#[tauri::command]
pub fn load_config() -> CmdResult<Config> {
    Ok(Config::load()?)
}

#[tauri::command]
pub fn save_config(cfg: Config) -> CmdResult<()> {
    cfg.save()?;
    Ok(())
}

#[tauri::command]
pub fn sidecar_status(state: State<'_, AppState>) -> Status {
    state.sidecar.status()
}

#[tauri::command]
pub fn sidecar_available(app: AppHandle) -> bool {
    crate::sidecar::sidecar_available(&app)
}

#[tauri::command]
pub fn sidecar_log_snapshot(state: State<'_, AppState>) -> Vec<String> {
    state.sidecar.log_snapshot()
}

#[tauri::command]
pub fn sidecar_start(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    state.sidecar.start(app)?;
    Ok(())
}

#[tauri::command]
pub fn sidecar_stop(state: State<'_, AppState>) -> CmdResult<()> {
    state.sidecar.stop()?;
    Ok(())
}

#[tauri::command]
pub fn detect_legacy_install() -> bool {
    // Refuse to coexist with the old pip + service-manager install. If
    // any of the platform service hooks exist we surface a warning in
    // the UI ("uninstall the legacy collector first").
    #[cfg(target_os = "macos")]
    {
        let plist = dirs::home_dir()
            .map(|h| h.join("Library/LaunchAgents/com.memento.collector.plist"))
            .map(|p| p.exists())
            .unwrap_or(false);
        return plist;
    }
    #[cfg(target_os = "linux")]
    {
        let unit = dirs::home_dir()
            .map(|h| h.join(".config/systemd/user/memento-collector.service"))
            .map(|p| p.exists())
            .unwrap_or(false);
        return unit;
    }
    #[cfg(target_os = "windows")]
    {
        // schtasks /Query exits 0 if the task exists.
        let out = std::process::Command::new("schtasks")
            .args(["/Query", "/TN", "MementoCollector"])
            .output();
        return matches!(out, Ok(o) if o.status.success());
    }
    #[allow(unreachable_code)]
    false
}
