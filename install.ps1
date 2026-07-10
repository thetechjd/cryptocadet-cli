# CryptoCadet installer (Windows) — NODE-ENVIRONMENT build.
#
#   irm https://cryptocadet.app/install.ps1 | iex
#
# Mirrors install.sh: sets up a private, pinned Node (latest v24, SHA256-verified against
# nodejs.org), npm-installs @cryptocadet/cli (+ its native keychain @napi-rs/keyring, which is
# the ONLY working secret store on Windows), and writes cryptocadet/ccx launchers that run that
# Node against the CLI. Same JS artifact as npm and Homebrew — identical behavior across OSes.
#
# Override with env: CRYPTOCADET_INSTALL_DIR, CRYPTOCADET_BIN_DIR, CRYPTOCADET_NPM_SPEC,
# CRYPTOCADET_NODE_CHANNEL.
$ErrorActionPreference = 'Stop'

$InstallDir = if ($env:CRYPTOCADET_INSTALL_DIR) { $env:CRYPTOCADET_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'cryptocadet-cli' }
$BinDir     = if ($env:CRYPTOCADET_BIN_DIR)     { $env:CRYPTOCADET_BIN_DIR }     else { Join-Path $InstallDir 'bin' }
$NpmSpec    = if ($env:CRYPTOCADET_NPM_SPEC)    { $env:CRYPTOCADET_NPM_SPEC }    else { '@cryptocadet/cli' } # pre-publish: github:thetechjd/cryptocadet-cli
$Channel    = if ($env:CRYPTOCADET_NODE_CHANNEL){ $env:CRYPTOCADET_NODE_CHANNEL }else { 'latest-v24.x' }

function Info($m) { Write-Host $m }
function Fail($m) { Write-Error $m; exit 1 }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# ── Bootstrap a private Node (idempotent) ─────────────────────────────────────────────────────
$NodeExe = Join-Path $InstallDir 'node\node.exe'
if (-not (Test-Path $NodeExe)) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = "https://nodejs.org/dist/$Channel"
  Info "resolving latest Node ($Channel, win-$arch) ..."
  $shas = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
  $line = ($shas -split "`n" | Where-Object { $_ -match "node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1)
  if (-not $line) { Fail "no Node build for win-$arch in $base" }
  $parts = $line.Trim() -split '\s+'
  $want = $parts[0]; $file = $parts[1]
  $tmp = Join-Path $env:TEMP $file
  Info "downloading $file ..."
  Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $tmp
  $got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want.ToLower()) { Fail "Node checksum mismatch (want $want got $got)" }
  Info "extracting Node ..."
  $ex = Join-Path $env:TEMP ("cc-node-" + [guid]::NewGuid())
  Expand-Archive -Path $tmp -DestinationPath $ex -Force
  $inner = Get-ChildItem $ex -Directory | Select-Object -First 1
  if (Test-Path (Join-Path $InstallDir 'node')) { Remove-Item -Recurse -Force (Join-Path $InstallDir 'node') }
  Move-Item $inner.FullName (Join-Path $InstallDir 'node')
  Remove-Item -Recurse -Force $ex, $tmp -ErrorAction SilentlyContinue
} else {
  Info "using cached Node at $InstallDir\node"
}

$NodeDir = Join-Path $InstallDir 'node'
$Npm     = Join-Path $NodeDir 'npm.cmd'

# ── Install the CLI (+ native keychain) with that Node ────────────────────────────────────────
Info "installing $NpmSpec ..."
$AppDir = Join-Path $InstallDir 'app'
if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
$env:Path = "$NodeDir;$env:Path"
& $Npm install --prefix $AppDir --omit=dev --no-fund --no-audit $NpmSpec
if ($LASTEXITCODE -ne 0) { Fail "npm install of $NpmSpec failed" }

$Entry = Join-Path $AppDir 'node_modules\@cryptocadet\cli\dist\cli\bin.js'
if (-not (Test-Path $Entry)) { Fail "installed package is missing $Entry" }

# ── Launchers on PATH ─────────────────────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
foreach ($name in @('cryptocadet', 'ccx')) {
  $cmd = Join-Path $BinDir "$name.cmd"
  "@echo off`r`n`"$NodeExe`" `"$Entry`" %*" | Set-Content -Path $cmd -Encoding ASCII
}

# Add BinDir to the user PATH if missing.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $BinDir) {
  [Environment]::SetEnvironmentVariable('Path', "$BinDir;$userPath", 'User')
  Info "added $BinDir to your user PATH (open a new terminal to pick it up)"
}

Info ""
Info "CryptoCadet installed."
Info "  node: $(& $NodeExe -v)"
Info "  bin:  $BinDir\cryptocadet.cmd"
Info "Get started (new terminal):"
Info "  cryptocadet init"
