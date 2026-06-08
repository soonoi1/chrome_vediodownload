$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$manifest = Get-Content (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$dist = Join-Path $root "dist"
$zip = Join-Path $dist ("media-catcher-chrome-" + $manifest.version + ".zip")

if (-not (Test-Path $dist)) {
  New-Item -ItemType Directory -Path $dist | Out-Null
}

if (Test-Path $zip) {
  Remove-Item -LiteralPath $zip
}

$include = @(
  "manifest.json",
  "README.md",
  "src",
  "native-helper"
)

$paths = $include | ForEach-Object { Join-Path $root $_ }
Compress-Archive -Path $paths -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Created $zip"
