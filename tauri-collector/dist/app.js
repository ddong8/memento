// Memento desktop — vanilla JS, no framework.
// Uses Tauri 2.x's window.__TAURI__ globals to call Rust commands.
// `withGlobalTauri: true` in tauri.conf.json enables this; without it
// every line below would throw at module load and silently break every
// button on the page (no event listeners ever get registered).

if (!window.__TAURI__) {
  document.body.innerHTML =
    '<div style="padding:40px;font:14px/1.5 system-ui">' +
    '<h2>Tauri runtime not detected.</h2>' +
    '<p>Open this app via the Memento installer, not by opening dist/index.html ' +
    'directly. If you built from source, ensure tauri.conf.json has ' +
    '<code>app.withGlobalTauri = true</code>.</p></div>';
  throw new Error("window.__TAURI__ undefined — was the page opened outside Tauri?");
}

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { open: openDialog } = window.__TAURI__.dialog;
const tauriShell = window.__TAURI__.shell;  // tauri-plugin-shell .open(url)

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
    if (tab.dataset.tab === "dashboard") openDashboard();
  });
});

// ─── Dashboard tab (embedded webview) ─────────────────────────────
// The user only configures ONE URL on the Server tab — the API base, since
// that's what gets paired with the collector token. The Dashboard tab needs
// the WEB UI URL though, which may or may not be the same depending on the
// deployment topology. Heuristics, in order:
//
//   1. API on :8001  → web on :3001         (docker-compose default ports)
//   2. API ends /api → web at the parent    (nginx subpath proxy)
//   3. otherwise     → same base            (nginx unified domain, e.g.
//                                            mem.ihasy.com serves both /app
//                                            and /api/* from one origin)
//
// Two-URL config would let the user override this, but for the common cases
// the derivation gets it right and keeps the Server tab to just one field.
function deriveWebUrl(apiUrl) {
  const base = apiUrl.trim().replace(/\/$/, "");
  if (/:8001(\/|$)/.test(base)) return base.replace(/:8001/, ":3001");
  if (/\/api(\/|$)/.test(base)) return base.replace(/\/api\/?$/, "");
  return base;
}

function openDashboard() {
  const apiUrl = (state.config?.server_url || "").trim();
  const empty = document.getElementById("dashboardEmpty");
  const frame = document.getElementById("dashboardFrame");
  const iframe = document.getElementById("dashboardIframe");
  const urlEl = document.getElementById("dashboardUrl");
  if (!apiUrl) {
    empty.style.display = "block";
    frame.classList.add("hidden");
    return;
  }
  empty.style.display = "none";
  frame.classList.remove("hidden");
  const target = `${deriveWebUrl(apiUrl)}/app`;
  if (iframe.src !== target) {
    iframe.src = target;
  }
  urlEl.textContent = target;
}

document.getElementById("dashboardReload")?.addEventListener("click", () => {
  const iframe = document.getElementById("dashboardIframe");
  // Re-assigning src forces a fresh load even if it's the same URL.
  const current = iframe.src;
  iframe.src = "about:blank";
  setTimeout(() => { iframe.src = current; }, 50);
});

document.getElementById("dashboardOpenExternal")?.addEventListener("click", async () => {
  const url = document.getElementById("dashboardUrl").textContent;
  if (!url) return;
  try {
    // tauri-plugin-shell's `open` opens with the OS default browser.
    if (tauriShell?.open) {
      await tauriShell.open(url);
    } else {
      window.open(url, "_blank");
    }
  } catch (e) {
    console.warn("openExternal failed", e);
  }
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

// User-friendly: they probably paste the Memento URL they use in the
// browser (port 3001), but the Python collector needs the API base
// (port 8001). Normalize on save so the daemon always gets the API URL.
// Reverses deriveWebUrl()'s direction.
function normalizeApiUrl(input) {
  const base = (input || "").trim().replace(/\/$/, "");
  if (/:3001(\/|$)/.test(base)) return base.replace(/:3001/, ":8001");
  return base;
}

function readForm() {
  const normalized = normalizeApiUrl($("#serverUrl").value);
  // Reflect the normalized URL back into the input so users see what's
  // actually stored. Avoids confusion next time they open Settings.
  if (normalized && normalized !== $("#serverUrl").value.trim()) {
    $("#serverUrl").value = normalized;
  }
  return {
    server_url: normalized,
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
