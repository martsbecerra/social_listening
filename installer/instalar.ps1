# ==========================================================================
# instalar.ps1 (viene adentro de SocialListening-replica.zip)
# --------------------------------------------------------------------------
# Instala o actualiza la copia de solo lectura en esta máquina:
#   - copia la app a %LOCALAPPDATA%\SocialListening (sin permisos de
#     administrador). En una actualización conserva el .env, los datos
#     (data\, replica-datos\) y los logs.
#   - la primera vez pide el token de lectura del repo de datos y lo guarda
#     SOLO en el .env de esta máquina.
#   - crea un acceso directo en el escritorio (abre la app en el navegador)
#     y otro en Inicio (la copia arranca sola al iniciar sesión).
#   - arranca la copia y abre el navegador.
#
# Uso: clic derecho > "Ejecutar con PowerShell", o en una consola:
#   powershell -ExecutionPolicy Bypass -File instalar.ps1
# -Destino, -SinAccesos y -NoIniciar sirven para probar la instalación en
# otra carpeta sin tocar el escritorio ni el inicio.
# ==========================================================================
param(
  [string]$Destino = (Join-Path $env:LOCALAPPDATA 'SocialListening'),
  [switch]$SinAccesos,
  [switch]$NoIniciar
)

$ErrorActionPreference = 'Stop'
$origen = $PSScriptRoot

if (-not (Test-Path (Join-Path $origen 'server.js'))) {
  throw 'Corré instalar.ps1 desde la carpeta descomprimida del zip.'
}

function Read-EnvValue([string]$file, [string]$name) {
  if (-not (Test-Path $file)) { return '' }
  $line = Get-Content $file | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if (-not $line) { return '' }
  return $line.Substring($name.Length + 1).Trim()
}

function Set-EnvValue([string]$file, [string]$name, [string]$value) {
  $lines = @(Get-Content $file | Where-Object { $_ -notmatch "^$name=" })
  $lines += "$name=$value"
  Set-Content -Path $file -Value $lines -Encoding UTF8
}

# Una copia que ya corre tiene node.exe tomado: hay que pararla (el bucle
# y su node) antes de copiar encima.
$destinoFull = [System.IO.Path]::GetFullPath($Destino)
Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -eq 'cmd.exe' -and $_.CommandLine -like "*$destinoFull*iniciar-replica.bat*") -or
    ($_.Name -eq 'node.exe' -and $_.ExecutablePath -like "$destinoFull\*")
  } |
  ForEach-Object {
    Write-Host "Parando la copia que estaba corriendo (proceso $($_.ProcessId))"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 1

Write-Host "Copiando la app a $destinoFull"
New-Item -ItemType Directory -Force -Path $destinoFull | Out-Null
robocopy $origen $destinoFull /MIR /NFL /NDL /NJH /NJS /NP `
  /XD (Join-Path $origen 'data') (Join-Path $destinoFull 'data') `
      (Join-Path $destinoFull 'replica-datos') (Join-Path $destinoFull 'logs') `
  /XF .env | Out-Null
if ($LASTEXITCODE -ge 8) { throw "No se pudo copiar la app (robocopy, código $LASTEXITCODE)." }

$envFile = Join-Path $destinoFull '.env'
$plantilla = Join-Path $destinoFull '.env.replica'
if (-not (Test-Path $envFile)) {
  Copy-Item $plantilla $envFile
} else {
  # Actualización: la URL del repo y el puerto los manda el instalador nuevo;
  # el token queda el que ya estaba.
  foreach ($name in 'APP_MODE', 'PORT', 'REPLICA_REPO_URL', 'REPLICA_POLL_MINUTES') {
    $nuevo = Read-EnvValue $plantilla $name
    if ($nuevo) { Set-EnvValue $envFile $name $nuevo }
  }
}

if (-not (Read-EnvValue $envFile 'DATA_REPO_TOKEN')) {
  Write-Host ''
  Write-Host 'Pegá el token de lectura del repo de datos (no se muestra al escribirlo).'
  Write-Host 'Si todavía no lo tenés, apretá Enter: la copia arranca sin datos y'
  Write-Host 'el token se puede cargar después volviendo a correr este instalador.'
  $seguro = Read-Host 'Token' -AsSecureString
  $token = [System.Net.NetworkCredential]::new('', $seguro).Password.Trim()
  if ($token) { Set-EnvValue $envFile 'DATA_REPO_TOKEN' $token }
}

$port = Read-EnvValue $envFile 'PORT'
if (-not $port) { $port = '3000' }
$url = "http://localhost:$port/dashboard.html"
$bat = Join-Path $destinoFull 'iniciar-replica.bat'

if (-not $SinAccesos) {
  $shell = New-Object -ComObject WScript.Shell
  $escritorio = [Environment]::GetFolderPath('Desktop')
  Set-Content -Path (Join-Path $escritorio 'Social Listening.url') -Encoding ASCII -Value @(
    '[InternetShortcut]', "URL=$url"
  )
  $inicio = [Environment]::GetFolderPath('Startup')
  $acceso = $shell.CreateShortcut((Join-Path $inicio 'Social Listening (copia).lnk'))
  $acceso.TargetPath = $bat
  $acceso.WorkingDirectory = $destinoFull
  $acceso.WindowStyle = 7
  $acceso.Description = 'Copia de solo lectura de Social Listening'
  $acceso.Save()
  Write-Host 'Accesos directos: "Social Listening" en el escritorio y arranque al iniciar sesión.'
}

if (-not $NoIniciar) {
  Start-Process -FilePath $bat -WorkingDirectory $destinoFull -WindowStyle Minimized
  Write-Host 'Arrancando la copia (la primera descarga de datos puede tardar unos minutos)...'
  $listo = $false
  for ($i = 0; $i -lt 120 -and -not $listo; $i++) {
    Start-Sleep -Seconds 2
    try {
      Invoke-WebRequest -Uri "http://localhost:$port/api/app/mode" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $listo = $true
    } catch { }
  }
  if ($listo) {
    Start-Process $url
    Write-Host "Listo: $url"
  } else {
    Write-Warning "La copia no respondió todavía. Mirá el log en $destinoFull\logs."
  }
}
