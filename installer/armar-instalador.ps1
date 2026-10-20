# ==========================================================================
# installer\armar-instalador.ps1
# --------------------------------------------------------------------------
# Arma dist\SocialListening-replica.zip: lo que se le pasa a cada persona de
# la red para instalar una réplica de solo lectura (ver
# openspec\changes\replicas-solo-lectura\).
#
# Adentro van Node portable (win-x64) y MinGit portable, bajados de sus
# descargas oficiales; la app tal como está en el commit actual (git
# archive: nada sin versionar, ni .env ni data\), sin test\, openspec\ ni
# design\; las dependencias de producción (npm ci --omit=dev);
# build-info.json con el commit; un .env de réplica SIN secretos (el token
# lo pide instalar.ps1 en cada máquina); instalar.ps1 e
# iniciar-replica.bat.
#
# Uso, desde la raíz del repo:
#   powershell -ExecutionPolicy Bypass -File installer\armar-instalador.ps1 `
#     -RepoUrl https://github.com/<dueño>/<repo-de-datos>.git
#
# Las descargas quedan en dist\descargas\ y se reusan en el próximo armado.
# ==========================================================================
param(
  [Parameter(Mandatory = $true)][string]$RepoUrl,
  [string]$NodeVersion = '24.14.0',
  [string]$MinGitVersion = '2.53.0',
  [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$dist = Join-Path $root 'dist'
$downloads = Join-Path $dist 'descargas'
$stage = Join-Path $dist 'SocialListening-replica'
$zip = Join-Path $dist 'SocialListening-replica.zip'

if ($RepoUrl -notmatch '^https://') { throw 'RepoUrl tiene que ser una URL https del repo de datos.' }

Push-Location $root
try {
  $dirty = git status --porcelain --untracked-files=no
  if ($dirty) { Write-Warning 'Hay cambios sin commitear: el instalador lleva el último commit, no lo que está en disco.' }
  $commit = (git rev-parse --short HEAD).Trim()
} finally { Pop-Location }

New-Item -ItemType Directory -Force -Path $downloads | Out-Null
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
if (Test-Path $zip) { Remove-Item -Force $zip }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Get-Download([string]$url, [string]$name) {
  $file = Join-Path $downloads $name
  if (-not (Test-Path $file)) {
    Write-Host "Bajando $url"
    Invoke-WebRequest -Uri $url -OutFile "$file.parcial" -UseBasicParsing
    Move-Item "$file.parcial" $file
  }
  return $file
}

# App: el commit actual, sin lo que no hace falta para servir.
Write-Host "App (commit $commit)"
$tar = Join-Path $dist 'app.tar'
git -C $root archive --format=tar -o $tar HEAD
tar -xf $tar -C $stage
Remove-Item $tar
foreach ($dir in 'test', 'openspec', 'design', 'installer', '.cursor', '.claude', '.pr-body.md') {
  $p = Join-Path $stage $dir
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $stage 'build-info.json'), (@{ commit = $commit } | ConvertTo-Json), $utf8)

# Node portable: queda en node\ y es el que usan npm ci y el lanzador.
$nodeName = "node-v$NodeVersion-win-x64"
$nodeZip = Get-Download "https://nodejs.org/dist/v$NodeVersion/$nodeName.zip" "$nodeName.zip"
Expand-Archive -Path $nodeZip -DestinationPath $stage
Rename-Item (Join-Path $stage $nodeName) 'node'

$minGitZip = Get-Download "https://github.com/git-for-windows/git/releases/download/v$MinGitVersion.windows.1/MinGit-$MinGitVersion-64-bit.zip" "MinGit-$MinGitVersion-64-bit.zip"
Expand-Archive -Path $minGitZip -DestinationPath (Join-Path $stage 'mingit')

Write-Host 'Dependencias de producción (npm ci --omit=dev)'
$nodeDir = Join-Path $stage 'node'
$oldPath = $env:Path
$env:Path = "$nodeDir;$oldPath"
Push-Location $stage
try {
  & (Join-Path $nodeDir 'npm.cmd') ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm ci terminó con código $LASTEXITCODE" }
  & (Join-Path $nodeDir 'node.exe') -e "require('sharp'); require('node:sqlite')"
  if ($LASTEXITCODE -ne 0) { throw 'sharp o node:sqlite no cargan con el Node portable.' }
} finally {
  Pop-Location
  $env:Path = $oldPath
}

# .env de réplica: sin secretos. DATA_REPO_TOKEN lo completa instalar.ps1.
[IO.File]::WriteAllLines((Join-Path $stage '.env.replica'), [string[]]@(
  '# Réplica de solo lectura (lo armó installer\armar-instalador.ps1).',
  'APP_MODE=replica',
  "PORT=$Port",
  "REPLICA_REPO_URL=$RepoUrl",
  'REPLICA_POLL_MINUTES=10',
  'DATA_REPO_TOKEN='
), $utf8)

Copy-Item (Join-Path $PSScriptRoot 'instalar.ps1') $stage
Copy-Item (Join-Path $PSScriptRoot 'iniciar-replica.bat') $stage
Copy-Item (Join-Path $PSScriptRoot 'LEEME.txt') $stage

Write-Host 'Comprimiendo'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Listo: $zip ($mb MB, commit $commit)"
