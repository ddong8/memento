//! Tauri command handlers — every fn here is callable from the UI via
//! `invoke('cmd_name', { args })`.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

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
pub fn save_config(app: AppHandle, cfg: Config) -> CmdResult<()> {
    cfg.save()?;
    apply_autostart(&app, cfg.autostart);
    Ok(())
}

/// Reconcile the OS "launch at login" registration with the config
/// checkbox. The autostart *plugin* is registered in lib.rs but nothing
/// ever toggled it — so the checkbox was cosmetic. Best-effort: a failure
/// here (e.g. sandboxed env) shouldn't block saving the rest of config.
pub fn apply_autostart(app: &AppHandle, want: bool) {
    let mgr = app.autolaunch();
    let is_on = mgr.is_enabled().unwrap_or(false);
    if want && !is_on {
        if let Err(e) = mgr.enable() {
            tracing::warn!("autostart enable failed: {e}");
        }
    } else if !want && is_on {
        if let Err(e) = mgr.disable() {
            tracing::warn!("autostart disable failed: {e}");
        }
    }
}

/// Write MCP server entries into AI tool config files (Claude Code,
/// Cursor, Codex, Windsurf, Antigravity). Best-effort: missing tool
/// configs are silently skipped. Returns which tools were configured
/// so the UI can show "configured for: claude_code, cursor".
#[tauri::command]
pub fn configure_mcp(server_url: String, server_token: String) -> CmdResult<crate::mcp_configs::McpWriteReport> {
    let report = crate::mcp_configs::write_all(&server_url, &server_token)?;
    Ok(report)
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
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW so the legacy-install probe doesn't flash
        // a console window every time the desktop app boots.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // schtasks /Query exits 0 if the task exists.
        let out = std::process::Command::new("schtasks")
            .args(["/Query", "/TN", "MementoCollector"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        return matches!(out, Ok(o) if o.status.success());
    }
    #[allow(unreachable_code)]
    false
}
