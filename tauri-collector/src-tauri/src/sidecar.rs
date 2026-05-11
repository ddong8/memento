//! Lifecycle for the collector sidecar.
//!
//! The sidecar is a PyInstaller-frozen `memento-collector` binary shipped
//! inside the Tauri bundle as an `externalBin` (see `tauri.conf.json`).
//! Tauri's shell plugin resolves the right per-triple binary at runtime,
//! so we never have to figure out paths ourselves — we just ask for it
//! by name and get an async event stream back.

use std::collections::VecDeque;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const SIDECAR_BIN: &str = "memento-collector-sidecar";
const MAX_LOG_LINES: usize = 500;

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub running: bool,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub last_error: Option<String>,
}

impl Default for Status {
    fn default() -> Self {
        Self {
            running: false,
            pid: None,
            started_at: None,
            exit_code: None,
            last_error: None,
        }
    }
}

pub struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    status: Mutex<Status>,
    /// Ring buffer of the most recent stdout/stderr lines.
    log_tail: Mutex<VecDeque<String>>,
}

impl Sidecar {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            child: Mutex::new(None),
            status: Mutex::new(Status::default()),
            log_tail: Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES)),
        })
    }

    pub fn status(&self) -> Status {
        self.status.lock().clone()
    }

    pub fn log_snapshot(&self) -> Vec<String> {
        self.log_tail.lock().iter().cloned().collect()
    }

    /// Start the collector. No-op if already running.
    pub fn start(self: &Arc<Self>, app: AppHandle) -> Result<()> {
        {
            let g = self.child.lock();
            if g.is_some() {
                return Ok(());
            }
        }

        // Tauri's shell plugin picks the bundled per-triple binary that
        // matches the running host. We pass `run` because our PyInstaller
        // entry point gates on that subcommand (see sidecar/entry.py).
        let sidecar_cmd = app
            .shell()
            .sidecar(SIDECAR_BIN)
            .map_err(|e| anyhow!("sidecar({}) failed to resolve: {e}", SIDECAR_BIN))?
            .args(["run"]);

        let (mut rx, child) = sidecar_cmd
            .spawn()
            .map_err(|e| anyhow!("spawn {SIDECAR_BIN}: {e}"))?;

        let pid = child.pid();
        {
            let mut g = self.child.lock();
            *g = Some(child);
        }
        *self.status.lock() = Status {
            running: true,
            pid: Some(pid),
            started_at: Some(now_unix()),
            exit_code: None,
            last_error: None,
        };
        let _ = app.emit("sidecar:status", self.status());

        // Drain the event stream until the child terminates. tokio task
        // because rx.recv() is async — same runtime Tauri itself uses.
        let me = Arc::clone(self);
        let app_for_task = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                        let line = String::from_utf8_lossy(&bytes).trim_end().to_owned();
                        if !line.is_empty() {
                            me.push_log(&line, &app_for_task);
                        }
                    }
                    CommandEvent::Terminated(payload) => {
                        let code = payload.code;
                        let mut st = me.status.lock();
                        st.running = false;
                        st.pid = None;
                        st.exit_code = code;
                        if code.unwrap_or(0) != 0 {
                            st.last_error =
                                Some(format!("sidecar exited with code {:?}", code));
                        }
                        let snapshot = st.clone();
                        drop(st);
                        *me.child.lock() = None;
                        let _ = app_for_task.emit("sidecar:status", snapshot);
                    }
                    CommandEvent::Error(msg) => {
                        let mut st = me.status.lock();
                        st.last_error = Some(msg.clone());
                        let snapshot = st.clone();
                        drop(st);
                        let _ = app_for_task.emit("sidecar:status", snapshot);
                    }
                    _ => {}
                }
            }
        });

        Ok(())
    }

    pub fn stop(&self) -> Result<()> {
        let child = {
            let mut g = self.child.lock();
            g.take()
        };
        if let Some(child) = child {
            // Plugin-shell's CommandChild::kill is synchronous and uses
            // TerminateProcess on Windows / SIGKILL on POSIX. Our SQLite
            // queue is WAL-journalled so an abrupt kill won't corrupt
            // pending writes — they replay on next start.
            child.kill().ok();
        }
        let mut st = self.status.lock();
        st.running = false;
        st.pid = None;
        Ok(())
    }

    fn push_log(&self, line: &str, app: &AppHandle) {
        let mut buf = self.log_tail.lock();
        if buf.len() == MAX_LOG_LINES {
            buf.pop_front();
        }
        buf.push_back(line.to_owned());
        let _ = app.emit("sidecar:log", line.to_owned());
    }
}

fn now_unix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Surfaces whether the bundled sidecar binary is reachable. Used by the
/// UI to fail fast with a clear message if someone runs `cargo tauri
/// dev` before building the PyInstaller binary.
pub fn sidecar_available(app: &AppHandle) -> bool {
    app.shell().sidecar(SIDECAR_BIN).is_ok()
}
