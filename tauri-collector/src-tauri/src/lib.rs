// Tauri 2.x splits the app entry: `run()` lives in lib.rs so mobile
// platforms (Android / iOS) can call it as a library entry point, while
// `main.rs` stays a thin wrapper for desktop. We don't target mobile
// today but Cargo.toml declares `[lib]` to match this convention, so
// `cargo metadata` rejects the crate without lib.rs.

mod auth;
mod config;
mod ipc;
mod mcp_configs;
mod sidecar;

use std::sync::Arc;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::ipc::AppState;
use crate::sidecar::Sidecar;

/// Pick zh / en for the tray menu by reading the OS user locale.
/// sys_locale::get_locale returns BCP-47 like "zh-CN" or "en-US".
/// Anything starting with "zh" → Chinese; everything else falls back to English.
fn tray_strings(version: &str) -> [String; 4] {
    let is_zh = sys_locale::get_locale()
        .map(|l| l.to_lowercase().starts_with("zh"))
        .unwrap_or(false);
    if is_zh {
        [
            "打开 Memento".into(),
            "检查更新".into(),
            format!("关于 (v{version})"),
            "退出".into(),
        ]
    } else {
        [
            "Open Memento".into(),
            "Check for updates".into(),
            format!("About (v{version})"),
            "Quit".into(),
        ]
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    // Inline the bundle version into the About menu entry so users see
    // what they're running without having to open the app first. Pulled
    // from Cargo.toml at compile time via `env!`, same source as the
    // app's window title and the auto-updater's "current version" check.
    let version = env!("CARGO_PKG_VERSION");
    let [s_open, s_check, s_about, s_quit] = tray_strings(version);
    let open_item = MenuItem::with_id(app, "open", &s_open, true, None::<&str>)?;
    let check_item = MenuItem::with_id(app, "check_update", &s_check, true, None::<&str>)?;
    // "About" is informational only — version is in the label. Disabled
    // so clicks don't do anything (no menu item handler for it). Tauri
    // renders disabled items as grayed-out, signalling they're labels.
    let about_item = MenuItem::with_id(app, "about", &s_about, false, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", &s_quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open_item, &check_item, &about_item, &quit_item],
    )?;

    // Reuse the bundled app icon (declared in tauri.conf.json bundle.icon[])
    // for the tray. Without an explicit .icon() call here, Tauri creates a
    // blank tray icon — which used to coexist alongside the one auto-built
    // from `app.trayIcon` config, giving us two tray entries on Windows.
    // The conf.json `trayIcon` block is gone now too, leaving this builder
    // as the single source of truth.
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".into()))?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        // Tell macOS to render the icon as-is rather than treating it as a
        // monochrome template image. Our Aurora-gradient icon has a fully
        // opaque alpha channel, so template rendering blanks it into a
        // solid white square in the menu bar. Setting this false keeps the
        // full color; Windows/Linux ignore the flag anyway.
        .icon_as_template(false)
        .menu(&menu)
        .tooltip("Memento")
        // Default Tauri behavior shows the menu on left-click too, which
        // conflicts with the Windows / Linux convention (left = open app,
        // right = menu). Turn it off so right-click is the *only* path to
        // the menu — our on_tray_icon_event below handles left-click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "check_update" => {
                // Bring the window forward so the user sees the prompt /
                // banner, then ping JS to clear the per-session dismissal
                // and re-run the updater check.
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = app.emit("menu:check-update", ());
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
            // Only respond to LEFT-click release. The menu shows on
            // right-click via Tauri's default handler (since we set
            // show_menu_on_left_click(false), left-click no longer
            // conflicts). Matching on Up so a click-and-drag doesn't
            // trigger window-show repeatedly.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(w) = tray.app_handle().get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                    let _ = w.unminimize();
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Second launch → focus existing window instead of opening a
            // duplicate. Without this on Windows the user double-clicking
            // the tray icon spawns a second collector process. Auto-update
            // also relies on this: when the new version starts, the old
            // process (if still alive) hits this callback and brings the
            // already-shown window forward.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
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
            // Reconcile OS launch-at-login with the saved/default setting
            // (defaults ON for fresh installs).
            crate::ipc::apply_autostart(app.handle(), cfg.autostart);
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
            ipc::configure_mcp,
            ipc::sidecar_status,
            ipc::sidecar_available,
            ipc::sidecar_log_snapshot,
            ipc::sidecar_start,
            ipc::sidecar_stop,
            ipc::detect_legacy_install,
            auth::auth_request,
            auth::mint_web_token,
        ])
        .on_window_event(|window, event| {
            // Intercept "close window" (X button / Cmd-W / Alt-F4) — hide
            // the window instead of exiting the app. The collector keeps
            // running in the background so syncs don't pause every time
            // the user clicks X. The tray menu's "Quit" item is the only
            // real exit path; everything else just hides the window.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
