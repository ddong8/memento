// Memento desktop — vanilla JS, no framework.
// Uses Tauri 2.x's window.__TAURI__ globals to call Rust commands.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open: openDialog } = window.__TAURI__.dialog;

// Same set the Python collector knows about. Keep names in sync with
// collector/collector/tools/*.py — these are the values used to index
// the disabled_tools list in config.
const TOOLS = [
  { id: "claude_code",  name: "Claude Code",   desc: "~/.claude.json + ~/.claude/projects/*.jsonl" },
  { id: "codex",        name: "Codex",         desc: "~/.codex/sessions/*.jsonl" },
  { id: "cursor",       name: "Cursor",        desc: "~/Library/Application Support/Cursor (or AppData)" },
  { id: "openclaw",     name: "OpenClaw",      desc: "~/.openclaw/workspace/conversations" },
  { id: "antigravity",  name: "Antigravity",   desc: "~/Library/Application Support/antigravity" },
  { id: "obsidian",     name: "Obsidian",      desc: "vault path set on Server tab" },
  { id: "hermes",       name: "Hermes Agent",  desc: "~/.hermes" },
];

const $ = (sel) => document.querySelector(sel);

let state = {
  config: null,
  status: { running: false },
};

// ─── Tabs ──────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    const target = document.querySelector(`.panel[data-panel="${tab.dataset.tab}"]`);
    if (target) target.classList.add("active");
  });
});

// ─── Initial load ─────────────────────────────────────────────────
async function boot() {
  try {
    state.config = await invoke("load_config");
  } catch (e) {
    flash("err", "Failed to load config: " + e.message);
    state.config = {};
  }
  fillForm(state.config);
  renderToolList();

  try {
    const legacy = await invoke("detect_legacy_install");
    if (legacy) {
      $("#legacyWarning").classList.remove("hidden");
    }
  } catch { /* non-fatal */ }

  try {
    const ok = await invoke("sidecar_available");
    if (!ok) {
      $("#sidecarMissing").classList.remove("hidden");
    }
  } catch { /* non-fatal */ }

  try {
    state.status = await invoke("sidecar_status");
    renderStatus();
  } catch { /* sidecar may not have started yet */ }

  // Hydrate log view with whatever the Rust side has buffered.
  try {
    const lines = await invoke("sidecar_log_snapshot");
    if (lines.length) $("#logView").textContent = lines.join("\n") + "\n";
  } catch { /* fine */ }

  // Live updates from the sidecar process.
  await listen("sidecar:status", (e) => {
    state.status = e.payload;
    renderStatus();
  });
  await listen("sidecar:log", (e) => {
    appendLog(e.payload);
  });
}

function fillForm(cfg) {
  $("#serverUrl").value = cfg.server_url || "";
  $("#serverToken").value = cfg.server_token || "";
  $("#obsidianPath").value = cfg.obsidian_vault_path || "";
  $("#autoStartDaemon").checked = cfg.auto_start_daemon ?? true;
  $("#autostart").checked = !!cfg.autostart;
}

function readForm() {
  return {
    server_url: $("#serverUrl").value.trim().replace(/\/$/, ""),
    server_token: $("#serverToken").value.trim(),
    obsidian_vault_path: $("#obsidianPath").value.trim(),
    auto_start_daemon: $("#autoStartDaemon").checked,
    autostart: $("#autostart").checked,
    disabled_tools: state.config?.disabled_tools || [],
  };
}

// ─── Server tab actions ───────────────────────────────────────────
$("#saveBtn").addEventListener("click", async () => {
  const cfg = readForm();
  try {
    await invoke("save_config", { cfg });
    state.config = cfg;
    flash("ok", "Saved.");
  } catch (e) {
    flash("err", e.message);
  }
});

$("#startBtn").addEventListener("click", async () => {
  // Save first so the daemon picks up the latest values.
  try {
    const cfg = readForm();
    await invoke("save_config", { cfg });
    state.config = cfg;
  } catch (e) {
    return flash("err", e.message);
  }
  try {
    await invoke("sidecar_start");
    flash("ok", "Collector starting…");
  } catch (e) {
    flash("err", e.message);
  }
});

$("#stopBtn").addEventListener("click", async () => {
  try {
    await invoke("sidecar_stop");
    flash("ok", "Stopped.");
  } catch (e) {
    flash("err", e.message);
  }
});

$("#pickObsidian").addEventListener("click", async () => {
  try {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") $("#obsidianPath").value = picked;
  } catch (e) {
    flash("err", e.message);
  }
});

// ─── Tools tab ────────────────────────────────────────────────────
function renderToolList() {
  const ul = $("#toolList");
  ul.innerHTML = "";
  const disabled = new Set(state.config?.disabled_tools || []);
  for (const t of TOOLS) {
    const li = document.createElement("li");
    li.innerHTML = `
      <label class="toggle inline">
        <input type="checkbox" data-tool="${t.id}" ${disabled.has(t.id) ? "" : "checked"} />
        <span></span>
      </label>
      <div>
        <div class="tool-name">${t.name}</div>
        <div class="tool-desc">${t.desc}</div>
      </div>
    `;
    ul.appendChild(li);
  }
}

$("#saveToolsBtn").addEventListener("click", async () => {
  const disabled = [...document.querySelectorAll('.tool-list input[type="checkbox"]')]
    .filter((cb) => !cb.checked)
    .map((cb) => cb.dataset.tool);
  state.config = { ...(state.config || {}), ...readForm(), disabled_tools: disabled };
  try {
    await invoke("save_config", { cfg: state.config });
    flash("ok", "Tools updated. Restart collector to apply.");
  } catch (e) {
    flash("err", e.message);
  }
});

// ─── Status pill ──────────────────────────────────────────────────
function renderStatus() {
  const pill = $("#statusPill");
  const text = $("#statusText");
  pill.classList.remove("running", "error", "idle");
  if (state.status?.running) {
    pill.classList.add("running");
    text.textContent = "running";
  } else if (state.status?.last_error) {
    pill.classList.add("error");
    text.textContent = "error";
  } else {
    pill.classList.add("idle");
    text.textContent = "idle";
  }
  $("#daemonInfo").textContent = state.status?.running
    ? `running · PID ${state.status.pid}`
    : "stopped";
}

// ─── Logs tab ─────────────────────────────────────────────────────
function appendLog(line) {
  const view = $("#logView");
  view.textContent += line + "\n";
  // Cap to ~2000 lines to keep DOM cheap.
  const lines = view.textContent.split("\n");
  if (lines.length > 2000) {
    view.textContent = lines.slice(-2000).join("\n");
  }
  if ($("#autoscroll").checked) view.scrollTop = view.scrollHeight;
}

$("#clearLogBtn").addEventListener("click", () => {
  $("#logView").textContent = "";
});

// ─── Notice helper ────────────────────────────────────────────────
function flash(tone, msg) {
  const n = $("#serverNotice");
  n.classList.remove("ok", "err");
  n.classList.add(tone);
  n.textContent = msg;
  setTimeout(() => {
    n.textContent = "";
    n.classList.remove("ok", "err");
  }, 3000);
}

boot();
