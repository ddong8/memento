# One-click installer launcher (Windows).
# Delegates to scripts/install.mts — this file only locates a runtime that runs TypeScript directly:
# Node.js 22.18+, or the Node inside the Memento app.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

# Whether this runtime strips TypeScript types by default (Node 22.18+ / 23.6+)
function Test-Runtime {
    param([string]$exe)
    if (-not $exe) { return $false }
    try {
        & $exe -e "process.exit(process.features.typescript ? 0 : 1)" 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

$runtime = $null
$asNode = $false
foreach ($c in @($env:MEMENTO_INSTALL_NODE, "node") | Where-Object { $_ }) {
    $cmd = Get-Command $c -ErrorAction SilentlyContinue
    if ($cmd -and (Test-Runtime $cmd.Source)) {
        $runtime = $cmd.Source
        break
    }
}

# No suitable Node.js: the Memento app's own runtime, run as plain Node
if (-not $runtime) {
    $app = Join-Path $env:LOCALAPPDATA "Programs\Memento\Memento.exe"
    if (Test-Path $app) {
        $env:ELECTRON_RUN_AS_NODE = "1"
        if (Test-Runtime $app) {
            $runtime = $app
            $asNode = $true
        } else {
            Remove-Item Env:ELECTRON_RUN_AS_NODE
        }
    }
}

if (-not $runtime) {
    Write-Host "Error: Node.js 22.18 or newer is required but was not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install options:"
    Write-Host "  winget install OpenJS.NodeJS.LTS"
    Write-Host "  or download from https://nodejs.org/en/download"
    Write-Host ""
    Write-Host "Or set MEMENTO_INSTALL_NODE to the path of your Node.js 22.18+ binary."
    Write-Host "(The native GPU embedding install, .\install.ps1 embedding --native, also needs Python 3.11+.)"
    exit 1
}

& $runtime "scripts/install.mts" @args
$code = $LASTEXITCODE
if ($asNode) { Remove-Item Env:ELECTRON_RUN_AS_NODE }
exit $code
