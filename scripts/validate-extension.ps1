$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$manifest = Join-Path $root "manifest.json"
$required = @(
  "manifest.json",
  "src/background.js",
  "src/content-script.js",
  "src/popup.html",
  "src/popup.css",
  "src/popup.js",
  "src/downloader.html",
  "src/downloader.css",
  "src/downloader.js",
  "test-page/index.html"
)

foreach ($relative in $required) {
  $path = Join-Path $root $relative
  if (-not (Test-Path $path)) {
    throw "Missing required file: $relative"
  }
}

Get-Content $manifest -Raw | ConvertFrom-Json | Out-Null

$jsFiles = @(
  "src/background.js",
  "src/content-script.js",
  "src/popup.js",
  "src/downloader.js",
  "scripts/test-server.js"
)

foreach ($relative in $jsFiles) {
  node --check (Join-Path $root $relative)
}

Write-Host "Media Catcher extension validation passed."
