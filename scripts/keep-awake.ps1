# ==========================================================================
# scripts\keep-awake.ps1
# --------------------------------------------------------------------------
# Le pide a Windows que no suspenda el sistema ni apague la pantalla
# mientras este proceso viva: SetThreadExecutionState(ES_CONTINUOUS |
# ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED), sin permisos de administrador.
# Una notebook con Modern Standby (S0) entra en reposo apenas se apaga la
# pantalla y frena la app (el cron no dispara); por eso también
# ES_DISPLAY_REQUIRED.
#
# Lo lanza el server al arrancar (src/keepAwake.js) con la entrada estándar
# conectada por pipe, y este proceso se queda bloqueado leyéndola: cuando
# el server termina (bien, mal o matado), el pipe se cierra, este proceso
# sale y Windows vuelve a su política de energía normal. También se puede
# correr a mano en una consola (Ctrl+C para cortar). Los mensajes van sin
# acentos a propósito: la consola y el pipe no comparten codificación.
# ==========================================================================
$ErrorActionPreference = 'Stop'
$sig = '[DllImport("kernel32.dll", SetLastError = true)] public static extern uint SetThreadExecutionState(uint esFlags);'
try {
  $k = Add-Type -MemberDefinition $sig -Name 'Power' -Namespace 'SocialListening' -PassThru
  # En PowerShell 5.1 el literal 0x80000000 se lee como Int32 negativo y no
  # se puede castear a UInt32: por eso los valores van en decimal.
  $ES_CONTINUOUS       = [uint32]2147483648  # 0x80000000
  $ES_SYSTEM_REQUIRED  = [uint32]1           # 0x00000001
  $ES_DISPLAY_REQUIRED = [uint32]2           # 0x00000002
  $flags = [uint32]($ES_CONTINUOUS + $ES_SYSTEM_REQUIRED + $ES_DISPLAY_REQUIRED)
  $previo = [uint32]$k::SetThreadExecutionState($flags)
} catch {
  Write-Output "keep-awake: fallo al pedir el estado ($($_.Exception.Message)); Windows puede suspender la maquina."
  exit 1
}
if ($previo -eq 0) {
  Write-Output 'keep-awake: SetThreadExecutionState devolvio 0 (fallo); Windows puede suspender la maquina.'
  exit 1
}
Write-Output 'keep-awake: activo. Windows no va a suspender el sistema ni apagar la pantalla mientras la app corra.'
# Bloquea hasta el fin de la entrada estandar (EOF): mientras el server viva, el pipe sigue abierto.
try {
  while ($null -ne [Console]::In.ReadLine()) { }
} catch { }
# Al terminar el proceso Windows descarta el pedido solo; esto es prolijidad.
[void]$k::SetThreadExecutionState($ES_CONTINUOUS)
