#!/usr/bin/env python3
"""Release Metadata Verifier (AGENTS.md Compliance Checker).

Validates:
1. data/updates/version.json follows the strict "三位一体" rules in AGENTS.md:
   - Windows: MUST use .zip format (no setup.exe/msi allowed in auto-update)
   - macOS: MUST use .zip format
   - Linux: .tar.gz, .zip or .deb
2. Byte size and SHA-256 match local binary files if present in data/updates/
3. Optional verification against GitHub Release assets via --github-tag <tag>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path


def verify_sha256_format(hex_str: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{64}", hex_str.strip()))


def verify_metadata(version_file: Path, github_tag: str | None = None) -> bool:
    print(f"[*] Checking release metadata file: {version_file}")
    if not version_file.exists():
        print(f"[!] ERROR: {version_file} does not exist.")
        return False

    try:
        with open(version_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        print(f"[!] ERROR: Invalid JSON in {version_file}: {e}")
        return False

    version = data.get("version")
    if not version:
        print("[!] ERROR: Missing 'version' field in version.json.")
        return False

    platforms = data.get("platforms", {})
    if not isinstance(platforms, dict) or not platforms:
        print("[!] ERROR: 'platforms' dictionary is missing or empty in version.json.")
        return False

    errors: list[str] = []
    updates_dir = version_file.parent

    for plat_name, pinfo in platforms.items():
        if not isinstance(pinfo, dict):
            errors.append(f"Platform '{plat_name}' config must be an object.")
            continue

        asset_name = pinfo.get("asset_name", "")
        size = pinfo.get("size")
        sha256_val = pinfo.get("sha256", "")

        # 1. Format rules (AGENTS.md)
        if "win" in plat_name:
            if not asset_name.endswith(".zip"):
                errors.append(
                    f"Windows auto-update package MUST be a .zip file (found: '{asset_name}'). "
                    "Rule: AGENTS.md forbids setup.exe in auto-update interface to prevent upgrade loops."
                )
        elif "mac" in plat_name:
            if not asset_name.endswith(".zip"):
                errors.append(
                    f"macOS auto-update package MUST be a .zip file (found: '{asset_name}')."
                )
        elif "linux" in plat_name:
            valid_linux = (".tar.gz", ".zip", ".deb")
            if not any(asset_name.endswith(ext) for ext in valid_linux):
                errors.append(
                    f"Linux auto-update package must end with one of {valid_linux} (found: '{asset_name}')."
                )

        # 2. Size and hash validity
        if not isinstance(size, int) or size <= 0:
            errors.append(f"Platform '{plat_name}': size must be a positive integer (found: {size}).")

        if not sha256_val or not verify_sha256_format(sha256_val):
            errors.append(f"Platform '{plat_name}': invalid or missing 64-char sha256 hash (found: '{sha256_val}').")

        # 3. Check local physical file if present
        local_asset = updates_dir / asset_name
        if local_asset.exists():
            real_size = local_asset.stat().st_size
            if real_size != size:
                errors.append(
                    f"Platform '{plat_name}': size mismatch for local file {asset_name}! "
                    f"version.json declares {size} bytes, local file is {real_size} bytes."
                )

            hasher = hashlib.sha256()
            with open(local_asset, "rb") as af:
                while chunk := af.read(65536):
                    hasher.update(chunk)
            real_sha256 = hasher.hexdigest().lower()

            if real_sha256 != sha256_val.lower():
                errors.append(
                    f"Platform '{plat_name}': sha256 mismatch for local file {asset_name}! "
                    f"version.json declares {sha256_val}, local file is {real_sha256}."
                )
            else:
                print(f"[+] Verified local file {asset_name}: {real_size} bytes, sha256 OK")

    # 4. Check GitHub release assets if requested
    if github_tag:
        try:
            import urllib.request
            repo = os.environ.get("MEMENTO_GITHUB_REPO", "ddong8/memento")
            url = f"https://api.github.com/repos/{repo}/releases/tags/{github_tag}"
            print(f"[*] Checking GitHub Release assets at: {url}")
            req = urllib.request.Request(url, headers={"User-Agent": "Memento-Release-Verifier"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                gh_release = json.loads(resp.read().decode("utf-8"))
            gh_assets = {a["name"]: a["size"] for a in gh_release.get("assets", [])}

            for plat_name, pinfo in platforms.items():
                aname = pinfo.get("asset_name")
                asize = pinfo.get("size")
                if aname not in gh_assets:
                    errors.append(f"GitHub Release {github_tag} missing asset '{aname}' declared in version.json.")
                elif gh_assets[aname] != asize:
                    errors.append(
                        f"Asset '{aname}' size mismatch with GitHub Release! "
                        f"version.json={asize}, GitHub Release={gh_assets[aname]}"
                    )
                else:
                    print(f"[+] Verified GitHub Release asset {aname}: {asize} bytes match.")
        except Exception as e:
            print(f"[-] Warning: Failed to fetch GitHub release {github_tag}: {e}")

    if errors:
        print("\n[!] VERIFICATION FAILED with errors:")
        for err in errors:
            print(f"    - {err}")
        return False

    print("\n[✓] All release metadata passed AGENTS.md compliance checks successfully!")
    return True


def main():
    parser = argparse.ArgumentParser(description="Verify Memento release metadata compliance.")
    parser.add_argument(
        "--file",
        default="data/updates/version.json",
        help="Path to version.json (default: data/updates/version.json)",
    )
    parser.add_argument(
        "--github-tag",
        default=None,
        help="Optional GitHub Release tag to compare against (e.g. v1.0.68)",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    version_path = repo_root / args.file if not Path(args.file).is_absolute() else Path(args.file)

    success = verify_metadata(version_path, args.github_tag)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
