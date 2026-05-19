//! Persistent settings for the desktop app.
//!
//! Stored at:
//!   macOS    ~/Library/Application Support/com.memento.app/config.json
//!   Windows  %APPDATA%/com.memento.app/config.json
//!   Linux    ~/.config/com.memento.app/config.json
//!
//! Schema is intentionally a superset of the Python collector's own
//! ~/.memento/config.json — when the user updates settings here we ALSO
//! mirror the relevant keys into that file so the spawned collector
//! daemon reads consistent values regardless of which install path
//! created the file.

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const APP_DIR_NAME: &str = "com.memento.app";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Memento server base URL, e.g. "https://mem.example.com" or
    /// "http://localhost:8001". No trailing slash.
    #[serde(default)]
    pub server_url: String,

    /// Per-user collector token issued by the server (User.collector_token).
    #[serde(default)]
    pub server_token: String,

    /// Optional Obsidian vault path; empty disables the Obsidian tool.
    #[serde(default)]
    pub obsidian_vault_path: String,

    /// Tool ids the user has explicitly disabled. Anything not in this
    /// list runs normally.
    #[serde(default)]
    pub disabled_tools: Vec<String>,

    /// Launch the app on system login. Default on.
    #[serde(default = "default_true")]
    pub autostart: bool,

    /// Start the collector daemon automatically when the app launches.
    /// Default on.
    #[serde(default = "default_true")]
    pub auto_start_daemon: bool,
}

fn default_true() -> bool {
    true
}

// Hand-written so a brand-new install (no config file → Config::default())
// gets both toggles ON — `#[derive(Default)]` would force the bools false
// and the serde `default_true` only applies when *deserializing* an
// existing file with the key missing, not to Default::default().
impl Default for Config {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            server_token: String::new(),
            obsidian_vault_path: String::new(),
            disabled_tools: Vec::new(),
            autostart: true,
            auto_start_daemon: true,
        }
    }
}

impl Config {
    pub fn path() -> Result<PathBuf> {
        let base = dirs::config_dir()
            .context("could not determine OS config directory")?;
        Ok(base.join(APP_DIR_NAME).join("config.json"))
    }

    pub fn load() -> Result<Self> {
        let path = Self::path()?;
        if !path.exists() {
            return Ok(Self::default());
        }
        let bytes = fs::read(&path)
            .with_context(|| format!("read config: {}", path.display()))?;
        let cfg: Self = serde_json::from_slice(&bytes)
            .with_context(|| format!("parse config: {}", path.display()))?;
        Ok(cfg)
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("mkdir -p {}", parent.display())
            })?;
        }
        let bytes = serde_json::to_vec_pretty(self)?;
        // Atomic write: write to temp then rename — avoids a partial-file
        // read by the collector if we crash mid-write.
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &path)?;
        self.mirror_to_collector_config()?;
        Ok(())
    }

    /// The Python collector reads `~/.memento/config.json` (see
    /// `collector/collector/main.py::_load_saved_config`). Mirror the
    /// keys it understands so the daemon picks up new values on next
    /// restart, regardless of which path wrote the file.
    fn mirror_to_collector_config(&self) -> Result<()> {
        let collector_path = dirs::home_dir()
            .context("no home dir")?
            .join(".memento")
            .join("config.json");
        if let Some(parent) = collector_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut existing: serde_json::Value = if collector_path.exists() {
            serde_json::from_slice(&fs::read(&collector_path)?)
                .unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };
        if let serde_json::Value::Object(ref mut map) = existing {
            map.insert("server_url".into(), self.server_url.clone().into());
            map.insert("server_token".into(), self.server_token.clone().into());
            if !self.obsidian_vault_path.is_empty() {
                map.insert(
                    "obsidian_vault_path".into(),
                    self.obsidian_vault_path.clone().into(),
                );
            }
        }
        let tmp = collector_path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&existing)?)?;
        fs::rename(&tmp, &collector_path)?;
        Ok(())
    }
}
