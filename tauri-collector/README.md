# Memento — desktop app (Tauri)

A native desktop wrapper around the Python `memento-collector` daemon. End
users install a single `.msi` / `.dmg` / `.AppImage`, configure their
server URL + token in the Settings window, and the collector runs in the
background — no Python, no terminal commands, no pyenv.

> Status: **Phase 1b ready** — window + tray + sidecar IPC + capabilities
> wired to Tauri's `externalBin` resolver. End users will never see a
> `pip install`; the frozen Python collector lives inside the bundle and
> is launched via the shell plugin's sidecar API. Build the PyInstaller
> binary first (see `sidecar/README.md`), then `cargo tauri build`.

## Architecture at a glance

```
┌────────────────────────────────────────────────────────────────┐
│  Tauri shell  (Rust + WebView)                                 │
│                                                                │
│  ┌───────────────────┐    spawn / signal    ┌───────────────┐  │
│  │ Settings UI       │ ────────────────────▶│  sidecar      │  │
│  │ dist/index.html   │◀───── logs / status ─│  collector    │  │
│  │ (vanilla HTML/CSS)│                      │  (frozen .exe) │ │
│  └───────────────────┘                      └───────────────┘  │
│         │                                          │           │
│         │ IPC (tauri::command)                     │ HTTPS     │
│         ▼                                          ▼           │
│  ┌───────────────────┐                      ┌───────────────┐  │
│  │ Tauri Rust core   │                      │ Memento API   │  │
│  │ - tray menu       │                      │ (server)      │  │
│  │ - autolaunch      │                      └───────────────┘  │
│  │ - config persist  │                                         │
│  └───────────────────┘                                         │
└────────────────────────────────────────────────────────────────┘
```

The collector is **the same Python code** shipped to PyPI as
`memento-brain-collector`. Tauri's only job is the GUI, lifecycle, and
packaging.

## Layout

```
tauri-collector/
├── README.md                  ← you are here
├── src-tauri/                 Rust + Tauri 2.x project
│   ├── Cargo.toml
│   ├── tauri.conf.json        bundle id / icons / installer config
│   ├── build.rs
│   ├── icons/                 .ico / .png / .icns (TODO: replace placeholders)
│   └── src/
│       ├── main.rs            entry · window · tray · plugins
│       ├── sidecar.rs         spawn / monitor / signal the collector child
│       ├── config.rs          read/write config shared with the Python side
│       └── ipc.rs             #[tauri::command] handlers called by the UI
├── dist/                      Vanilla HTML/CSS/JS frontend (NO bundler)
│   ├── index.html
│   ├── styles.css             Aurora palette (matches web/)
│   └── app.js                 ~150 LOC, no framework
└── sidecar/                   PyInstaller pipeline
    ├── README.md
    ├── collector.spec         PyInstaller spec
    └── build_sidecar.py       one-command freezer
```

## Development (macOS dev → Windows release)

Prerequisites:
- Rust 1.75+  (`curl https://sh.rustup.rs -sSf | sh`)
- Node 20+ (only for `cargo tauri` CLI; the dist/ frontend is plain HTML)
- `cargo install tauri-cli --version "^2.0"`
- For sidecar building: Python 3.11+ with `pip install pyinstaller` on the
  **target** platform (PyInstaller doesn't cross-compile)

Run in dev mode (live-reload):

```sh
cd tauri-collector
cargo tauri dev
```

Build a release artifact for the current platform:

```sh
cargo tauri build
```

On macOS this produces `.dmg` + `.app`. On Windows it produces `.msi`.

### Building the Windows installer

PyInstaller can't cross-compile, so the Windows sidecar must be built on
a Windows host. The pipeline is automated in
[`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml)
— **don't bother building Windows locally on Mac/Linux**, just push a
tag (or trigger manually) and grab the `.msi`/`.exe` from the workflow.

#### Trigger a release build (recommended)

```sh
# From your dev machine
git tag desktop-v0.1.0
git push origin desktop-v0.1.0
```

The workflow builds the PyInstaller sidecar, runs `cargo tauri build`,
and uploads `Memento_*.msi` + `Memento_*-setup.exe` as a new GitHub
Release tagged `desktop-v0.1.0`.

The `desktop-v*` tag namespace is **separate** from the `v*` PyPI
release tags (`release.yml`), so you can ship desktop installers
independently of collector/MCP server PyPI releases.

#### Trigger a build without releasing

Use **Actions → Desktop Release → Run workflow** in the GitHub UI. The
artifacts are attached to the workflow run (14-day retention) instead of
a tagged release. Useful for testing pipeline changes or building from
a feature branch.

#### Local Windows build (only if you want to debug the toolchain)

```powershell
cd tauri-collector\sidecar
pip install -e ..\..\collector pyinstaller
python build_sidecar.py

cd ..
cargo tauri icon ..\web\public\favicon.png
cargo tauri build
# → src-tauri\target\release\bundle\msi\Memento_*.msi
```

## Coexistence with the existing pip-installed collector

If a user already has `memento-collector` installed via pip (and
launchd / systemd / schtasks), the Tauri app will **detect and refuse to
start** until the legacy install is removed (`memento-collector
uninstall`). Running both produces double sync + duplicate documents.

## Roadmap

- ~~**Phase 1a**: Skeleton — window opens, tray appears, can spawn
  pip-installed `memento-collector` and stream its log~~ ✅
- ~~**Phase 1b**: PyInstaller sidecar — fully self-contained binary
  (Rust side wired; needs Windows machine to actually run
  `python build_sidecar.py` for the .msi)~~ ✅ (Rust)
- **Phase 2**: Settings UI polish (start/stop visual feedback, log
  viewer level filters, autostart wiring)
- **Phase 3**: Auto-update via Tauri's updater
- **Phase 4**: macOS + Linux packaging
- **Phase 5**: Code-signing + notarization for distribution
