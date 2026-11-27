# Build pgvector for embedded Postgres 16 on Windows x64 (pgvector's own nmake build). Output: out\win32-x64\...
$ErrorActionPreference = "Stop"
$version = if ($env:PGVECTOR_VERSION) { $env:PGVECTOR_VERSION } else { "0.8.1" }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here "out\win32-x64"
Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$out\lib", "$out\extension" | Out-Null
$pgroot = $env:PGROOT
if (-not $pgroot -or -not (Test-Path "$pgroot\include\server")) { throw "PGROOT must point at a PostgreSQL 16 install with include\server" }
$work = Join-Path $env:RUNNER_TEMP "pgvector"
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null
Invoke-WebRequest "https://github.com/pgvector/pgvector/archive/refs/tags/v$version.zip" -OutFile "$work\src.zip"
Expand-Archive "$work\src.zip" $work
$src = Join-Path $work "pgvector-$version"
Push-Location $src
cmd /c "set PGROOT=$pgroot&& nmake /NOLOGO /F Makefile.win"
if ($LASTEXITCODE -ne 0) { throw "nmake failed" }
Pop-Location
Copy-Item "$src\vector.dll" "$out\lib\"
Copy-Item "$src\vector.control" "$out\extension\"
Copy-Item "$src\sql\vector--*.sql" "$out\extension\"
Get-ChildItem "$out\lib"
Write-Host "built pgvector $version for win32-x64"
