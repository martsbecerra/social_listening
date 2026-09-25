# ==========================================================================
# scripts\quickedit-off.ps1
# --------------------------------------------------------------------------
# Apaga el modo QuickEdit de la consola ACTUAL (la ventana en la que corre
# scripts\iniciar-con-reinicio.bat). Con QuickEdit activo, un clic adentro de
# la ventana selecciona texto y congela cualquier proceso que escriba en esa
# consola hasta que alguien aprieta una tecla. Solo toca esta consola
# (SetConsoleMode sobre el buffer de entrada, que comparten todos los
# procesos de la ventana); no cambia ninguna configuración de Windows.
# Nunca falla: si no hay consola o no se puede, avisa y sigue.
# ==========================================================================
$sig = @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int nStdHandle);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out uint lpMode);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, uint dwMode);
'@
try {
  $k = Add-Type -MemberDefinition $sig -Name 'ConsoleMode' -Namespace 'SocialListening' -PassThru
  $STD_INPUT_HANDLE = -10
  $ENABLE_QUICK_EDIT_MODE = [uint32]0x0040
  $ENABLE_EXTENDED_FLAGS = [uint32]0x0080
  $h = $k::GetStdHandle($STD_INPUT_HANDLE)
  $mode = [uint32]0
  if ($k::GetConsoleMode($h, [ref]$mode)) {
    $mask = [uint32]([uint32]::MaxValue - $ENABLE_QUICK_EDIT_MODE)
    $nuevo = [uint32](($mode -band $mask) -bor $ENABLE_EXTENDED_FLAGS)
    if ($k::SetConsoleMode($h, $nuevo)) {
      Write-Host 'QuickEdit desactivado en esta consola.'
    } else {
      Write-Host 'No se pudo desactivar QuickEdit en esta consola (se sigue igual).'
    }
  } else {
    Write-Host 'No se pudo leer el modo de la consola (se sigue igual).'
  }
} catch {
  Write-Host "No se pudo desactivar QuickEdit: $($_.Exception.Message) (se sigue igual)."
}
