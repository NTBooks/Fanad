<#
Builds installer\dist\FanadSetup-<version>.exe: stages a production payload (app source +
prod-only node_modules + built web UI), embeds a checksum-verified private Node runtime, and
compiles installer\fanad.iss with Inno Setup 6 (winget install JRSoftware.InnoSetup).

Usage:  powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1 [-SkipNpm]
  -SkipNpm   skip the repo npm ci + web build (reuse the existing web\dist; faster iteration)
#>
param(
    # The private runtime shipped inside the installer. Bump deliberately and retest; must
    # satisfy package.json engines (>=24). The zip is cached in installer\staging\cache.
    [string]$NodeVersion = '24.18.0',
    [switch]$SkipNpm
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$staging = Join-Path $PSScriptRoot 'staging'
$app = Join-Path $staging 'app'
$cache = Join-Path $staging 'cache'

$version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "== Building Fanad $version installer (Node $NodeVersion) =="

# ---- 1. Fresh production build in the repo (web\dist ships in the payload) ----
if (-not $SkipNpm) {
    Push-Location $repo
    try {
        npm ci; if ($LASTEXITCODE) { throw 'npm ci failed' }
        npm run build; if ($LASTEXITCODE) { throw 'npm run build failed' }
    } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $repo 'web\dist\index.html'))) {
    throw 'web\dist\index.html missing - run "npm run build" (or drop -SkipNpm)'
}

# ---- 2. Stage the payload: explicit include list so nothing (data\, .env, .git) leaks in ----
if (Test-Path $app) { Remove-Item $app -Recurse -Force }
New-Item -ItemType Directory -Force $app | Out-Null
foreach ($dir in 'server', 'shared', 'site', 'bin') {
    robocopy (Join-Path $repo $dir) (Join-Path $app $dir) /e /np /njh /njs /ndl /nfl | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy $dir failed ($LASTEXITCODE)" }
}
robocopy (Join-Path $repo 'web\dist') (Join-Path $app 'web\dist') /e /np /njh /njs /ndl /nfl | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy web\dist failed ($LASTEXITCODE)" }
# web\package.json keeps the root "workspaces" entry resolvable for the npm ci below.
Copy-Item (Join-Path $repo 'web\package.json') (Join-Path $app 'web\package.json')
foreach ($f in 'package.json', 'package-lock.json', 'README.md', '.env.example') {
    Copy-Item (Join-Path $repo $f) (Join-Path $app $f)
}
# Test files ride along inside the copied dirs - not needed at runtime.
Get-ChildItem $app -Recurse -Filter '*.test.js' | Remove-Item -Force

# ---- 3. Production dependencies only, resolved against the committed lockfile ----
Push-Location $app
try { npm ci --omit=dev; if ($LASTEXITCODE) { throw 'npm ci --omit=dev failed' } }
finally { Pop-Location }

# ---- 4. Private Node runtime: official zip, SHA-256 verified, npm stripped (never used) ----
New-Item -ItemType Directory -Force $cache | Out-Null
$zipName = "node-v$NodeVersion-win-x64.zip"
$zip = Join-Path $cache $zipName
if (-not (Test-Path $zip)) {
    Write-Host "Downloading $zipName..."
    Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$zipName" -OutFile $zip -UseBasicParsing
}
$sums = (Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
$expected = $null
foreach ($line in $sums -split "`n") {
    if ($line -match "^([0-9a-f]{64})\s+$([regex]::Escape($zipName))\s*$") { $expected = $Matches[1]; break }
}
if (-not $expected) { throw "no SHASUMS256.txt entry for $zipName" }
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected) { Remove-Item $zip; throw "SHA-256 mismatch for $zipName (got $actual, expected $expected) - cached zip deleted, rerun" }

$unpacked = Join-Path $staging "node-v$NodeVersion-win-x64"
if (Test-Path $unpacked) { Remove-Item $unpacked -Recurse -Force }
Expand-Archive $zip -DestinationPath $staging -Force
Move-Item $unpacked (Join-Path $app 'runtime')
foreach ($x in 'node_modules', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd', 'install_tools.bat', 'nodevars.bat') {
    $p = Join-Path $app "runtime\$x"
    if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}

# ---- 5. Launchers + icon ----
New-Item -ItemType Directory -Force (Join-Path $app 'bin') | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'launchers\*.cmd') (Join-Path $app 'bin')
Copy-Item (Join-Path $PSScriptRoot 'assets\fanad.ico') (Join-Path $app 'fanad.ico')

# ---- 6. Compile with Inno Setup 6 ----
$iscc = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
    $cmd = Get-Command iscc -ErrorAction SilentlyContinue
    if ($cmd) { $iscc = $cmd.Source }
}
if (-not $iscc) { throw 'Inno Setup 6 not found - install it with: winget install JRSoftware.InnoSetup' }

& $iscc "/DAppVersion=$version" "/DStagingDir=$app" (Join-Path $PSScriptRoot 'fanad.iss')
if ($LASTEXITCODE) { throw "ISCC failed ($LASTEXITCODE)" }
Write-Host "`nDone: installer\dist\FanadSetup-$version.exe"
