// Hide the console window on Windows release builds. Without this a
// black cmd.exe pops up behind the GUI every launch.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod ipc;
mod sidecar;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::MacosLauncher;

use crate::ipc::AppState;
use crate::sidecar::Sidecar;

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(app, "open", "Open Memento", true, None::<&str>)?;
    let pause_item = MenuItem::with_id(app, "pause", "Pause collector", true, None::<&str>)?;
    let resume_item = MenuItem::with_id(app, "resume", "Resume collector", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &pause_item, &resume_item, &quit_item])?;

    let _tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Memento")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "pause" => {
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = state.sidecar.stop();
                }
            }
            "resume" => {
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = state.sidecar.start(app.clone());
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = state.sidecar.stop();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left-click on tray brings the window forward — standard
            // pattern on Windows / Linux. macOS tray clicks open menu
            // by convention, so leave that alone.
            if let TrayIconEvent::Click { .. } = event {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sidecar = Sidecar::new();
    let app_state = AppState {
        sidecar: Arc::clone(&sidecar),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch → focus existing window instead of opening a
            // duplicate. Without this on Windows the user double-clicking
            // the tray icon spawns a second collector process.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--silent"]),
        ))
        .manage(app_state)
        .setup(move |app| {
            build_tray(app.handle())?;

            // Auto-start the daemon if the user enabled it in settings.
            let cfg = crate::config::Config::load().unwrap_or_default();
            if cfg.auto_start_daemon
                && !cfg.server_url.is_empty()
                && !cfg.server_token.is_empty()
            {
                let app_handle = app.handle().clone();
                let sidecar = Arc::clone(&sidecar);
                std::thread::spawn(move || {
                    // Small delay so the window is up before the
                    // sidecar's logs start streaming into a not-yet-
                    // existing webview.
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    let _ = sidecar.start(app_handle);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::load_config,
            ipc::save_config,
            ipc::sidecar_status,
            ipc::sidecar_available,
            ipc::sidecar_log_snapshot,
            ipc::sidecar_start,
            ipc::sidecar_stop,
            ipc::detect_legacy_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
