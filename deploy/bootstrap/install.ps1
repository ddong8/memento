# Memento — remote bootstrap installer (Windows).
#
# Usage:
#   iwr https://mem.ihasy.com/install.ps1 -useb | iex
#
# Overrides via env vars:
#   MEMENTO_INSTALL_DIR   target dir (default: $env:USERPROFILE\memento)
#   MEMENTO_VERSION       git ref (default: main)
#   MEMENTO_REPO_URL      repo base (default: https://github.com/ddong8/memento)
#   MEMENTO_MIRROR_URL    fast mirror (default: https://mem.ihasy.com/install/latest.tar.gz)

$ErrorActionPreference = "Stop"

$Version    = if ($env:MEMENTO_VERSION)     { $env:MEMENTO_VERSION }     else { "main" }
$TargetDir  = if ($env:MEMENTO_INSTALL_DIR) { $env:MEMENTO_INSTALL_DIR } else { Join-Path $env:USERPROFILE "memento" }
$RepoUrl    = if ($env:MEMENTO_REPO_URL)    { $env:MEMENTO_REPO_URL }    else { "https://github.com/ddong8/memento" }
$MirrorUrl  = if ($env:MEMENTO_MIRROR_URL)  { $env:MEMENTO_MIRROR_URL }  else { "https://mem.ihasy.com/install/latest.tar.gz" }

function Say  { param([string]$m) Write-Host "· $m" -ForegroundColor Cyan }
function Ok   { param([string]$m) Write-Host "✓ $m" -ForegroundColor Green }
function Fail { param([string]$m) Write-Host "✗ $m" -ForegroundColor Red }

function Require-Command {
    param([string]$name, [string]$hint = "")
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Fail "missing: $name"
        if ($hint) { Write-Host "  → $hint" }
        return $false
    }
    return $true
}

function Check-Prereqs {
    $ok = $true
    if (-not (Require-Command curl "install via winget install cURL.cURL")) { $ok = $false }
    if (-not (Require-Command tar  "built-in on Windows 10/11; enable via Settings if missing")) { $ok = $false }
    if (-not (Require-Command docker "install Docker Desktop for Windows")) { $ok = $false }
    if (-not $ok) {
        Fail "Please install missing prerequisites, then re-run."
        exit 1
    }
    try {
        docker info > $null 2>&1
    } catch {
        Fail "Docker daemon is not running."
        Write-Host "  → Open Docker Desktop from the Start Menu."
        exit 1
    }
    Ok "prerequisites found (curl, tar, docker, daemon running)"
}

function Download-Repo {
    Say "Downloading repository to $TargetDir…"
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    $tmp = Join-Path $env:TEMP "memento-$(Get-Random).tar.gz"

    $fetched = $false
    try {
        # try mirror first (shorter latency for CN users)
        curl.exe -fsSL --max-time 15 $MirrorUrl -o $tmp
        if ((Get-Item $tmp).Length -gt 0) {
            Ok "fetched from mirror"
            $fetched = $true
        }
    } catch { }

    if (-not $fetched) {
        curl.exe -fsSL "$RepoUrl/archive/refs/heads/$Version.tar.gz" -o $tmp
        if ((Get-Item $tmp).Length -gt 0) {
            Ok "fetched from GitHub"
            $fetched = $true
        }
    }
    if (-not $fetched) {
        Fail "could not download repository from either mirror or GitHub"
        exit 1
    }

    tar.exe -xzf $tmp -C $TargetDir --strip-components=1
    Remove-Item $tmp -Force
    Ok "extracted"
}

Write-Host ""
Write-Host "Memento — one-click installer" -ForegroundColor White
Write-Host "target:  $TargetDir" -ForegroundColor DarkGray
Write-Host "version: $Version"  -ForegroundColor DarkGray
Write-Host ""

Check-Prereqs

# idempotent rerun
if ((Test-Path $TargetDir) -and (Test-Path (Join-Path $TargetDir "install.ps1")) -and (Test-Path (Join-Path $TargetDir "docker-compose.yml"))) {
    Say "Existing installation detected at $TargetDir — running update."
    Set-Location $TargetDir
    & .\install.ps1 update @args
    exit $LASTEXITCODE
}

Download-Repo

Say "Handing off to the local installer…"
Write-Host ""
Set-Location $TargetDir
& .\install.ps1 @args
exit $LASTEXITCODE
