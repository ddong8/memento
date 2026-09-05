# PyInstaller spec for the Memento collector sidecar.
#
# Don't invoke this directly — use build_sidecar.py, which handles
# Tauri's `<triple>` naming convention and drops the binary in
# ../src-tauri/binaries/.

from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None

# Pick up every collector submodule and the parsers (some are imported
# dynamically by tool definitions, so the static analyzer misses them).
hidden = (
    collect_submodules("collector")
    + collect_submodules("collector.tools")
    + collect_submodules("collector.parsers")
    # Conversation tools that go through dynamic dispatch:
    + ["collector.parsers.antigravity_pb_decoder",
       "collector.parsers.antigravity_vscdb",
       "collector.parsers.antigravity_export"]
    # `memento-brain-memory` is a dep of the collector but used at MCP
    # mount time, not by the daemon. Excluded to keep the binary small.
)

# Packages with mypyc / Cython / Rust compiled artifacts that PyInstaller's
# static analyzer can't enumerate. `tomli` 2.x ships hash-named mypyc .pyd
# files on Windows (e.g. 3c22db458360489351e4_mypyc.cp311-win_amd64.pyd);
# without collect_all the frozen import chain hits ModuleNotFoundError
# the moment `collector.parsers.toml_parser` is imported.
extra_datas = []
extra_binaries = []
for pkg in ("tomli", "pydantic", "pydantic_core", "watchdog", "cryptography",
            "httpx", "httpcore", "websockets"):
    try:
        d, b, h = collect_all(pkg)
        extra_datas.extend(d)
        extra_binaries.extend(b)
        hidden.extend(h)
    except Exception:
        pass  # Package not installed — skip

a = Analysis(
    ["entry.py"],
    pathex=[],
    binaries=extra_binaries,
    datas=extra_datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "tkinter",          # GUI toolkit, never loaded
        "pytest",
        "IPython",
        "memento_brain_memory",  # MCP server, separate concern
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="memento-collector-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,           # UPX trips multiple Windows AV vendors
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,       # No console window on Windows
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
