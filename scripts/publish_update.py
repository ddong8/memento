#!/usr/bin/env python3
"""Publish client package to Memento server updates directory.

Usage:
    python scripts/publish_update.py [--version 1.0.1] [--platform windows] [--notes "Release notes"]

This script compresses the built client into a zip package and updates
data/updates/version.json, enabling instant one-click client updates across all devices.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import zipfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Publish Memento client update package.")
    parser.add_argument("--version", default="1.0.1", help="Version string (e.g. 1.0.1)")
    parser.add_argument("--platform", default="windows", choices=["windows", "macos", "linux"], help="Target platform")
    parser.add_argument("--src", default=None, help="Source build directory (auto-detected if omitted)")
    parser.add_argument("--notes", default="性能与稳定性优化，支持自动热替换升级。", help="Release notes")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    updates_dir = repo_root / "data" / "updates"
    updates_dir.mkdir(parents=True, exist_ok=True)

    # 1. Detect source directory
    src_dir = None
    if args.src:
        src_dir = Path(args.src)
    else:
        if args.platform == "windows":
            src_dir = repo_root / "mobile" / "build" / "windows" / "x64" / "runner" / "Release"
        elif args.platform == "macos":
            src_dir = repo_root / "mobile" / "build" / "macos" / "Build" / "Products" / "Release"
        elif args.platform == "linux":
            src_dir = repo_root / "mobile" / "build" / "linux" / "x64" / "release" / "bundle"

    if not src_dir or not src_dir.exists():
        print(f"Error: Build directory not found at {src_dir}")
        print("Please build the client first (e.g. 'flutter build windows --release') or specify --src.")
        sys.exit(1)

    # 2. Create update zip package
    zip_filename = f"memento-{args.platform}-v{args.version}.zip"
    target_zip = updates_dir / zip_filename
    print(f"Packaging {src_dir} -> {target_zip} ...")

    with zipfile.ZipFile(target_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(src_dir):
            for file in files:
                full_path = Path(root) / file
                rel_path = full_path.relative_to(src_dir)
                zf.write(full_path, arcname=str(rel_path))

    import hashlib

    hasher = hashlib.sha256()
    with open(target_zip, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    zip_sha256 = hasher.hexdigest()

    zip_size = target_zip.stat().st_size
    print(f"Created package: {zip_filename} ({zip_size / (1024 * 1024):.2f} MB, sha256: {zip_sha256})")

    # 3. Update version.json
    version_file = updates_dir / "version.json"
    meta = {}
    if version_file.exists():
        try:
            with open(version_file, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            meta = {}

    meta["version"] = args.version
    meta["title"] = f"Memento v{args.version}"
    meta["release_notes"] = args.notes
    if "platforms" not in meta:
        meta["platforms"] = {}

    meta["platforms"][args.platform] = {
        "asset_name": zip_filename,
        "size": zip_size,
        "sha256": zip_sha256,
    }

    with open(version_file, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

    print(f"Updated {version_file} successfully!")
    print(f"Ready for client auto-update! Endpoint: /api/system/update/check")


if __name__ == "__main__":
    main()
