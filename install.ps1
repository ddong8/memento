# One-click installer launcher (Windows).
# Delegates to scripts/install.py — this file only locates a suitable Python.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Test-Python {
    param([string]$exe)
    if (-not $exe) { return $false }
    try {
        $out = & $exe -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)" 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

$candidates = @(
    $env:MEMENTO_INSTALL_PYTHON,
    "py -3.13", "py -3.12", "py -3.11",
    "python3.13", "python3.12", "python3.11",
    "python3", "python"
) | Where-Object { $_ }

$pyCmd = $null
foreach ($c in $candidates) {
    $parts = $c -split ' ', 2
    $exe = $parts[0]
    $extraArgs = if ($parts.Count -gt 1) { $parts[1] } else { $null }
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }

    if ($extraArgs) {
        # py launcher style: e.g. "py -3.11"
        try {
            $out = & $exe $extraArgs -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)" 2>$null
            if ($LASTEXITCODE -eq 0) {
                $pyCmd = @($exe, $extraArgs)
                break
            }
        } catch { continue }
    } else {
        if (Test-Python $exe) {
            $pyCmd = @($exe)
            break
        }
    }
}

if (-not $pyCmd) {
    Write-Host "Error: Python 3.11 or newer is required but was not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install options:"
    Write-Host "  winget install Python.Python.3.11"
    Write-Host "  or download from https://www.python.org/downloads/"
    Write-Host ""
    Write-Host "Or set MEMENTO_INSTALL_PYTHON to the path of your Python 3.11+ interpreter."
    exit 1
}

& $pyCmd[0] @($pyCmd | Select-Object -Skip 1) "scripts/install.py" @args
exit $LASTEXITCODE
