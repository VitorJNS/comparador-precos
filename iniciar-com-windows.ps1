# Cria (ou remove, com -Remover) um atalho na pasta Inicializar do Windows
# para o Radar de Precos abrir minimizado sempre que voce ligar o PC.
# Uso:  powershell -ExecutionPolicy Bypass -File .\iniciar-com-windows.ps1
param([switch]$Remover)

$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'Radar de Precos.lnk'

if ($Remover) {
  if (Test-Path $link) { Remove-Item $link -Confirm:$false; 'Atalho removido.' } else { 'Nenhum atalho encontrado.' }
  return
}

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = 'cmd.exe'
$s.Arguments = '/c npm start'
$s.WorkingDirectory = $PSScriptRoot
$s.WindowStyle = 7  # minimizado
$s.Description = 'Radar de Precos (coleta automatica)'
$s.Save()
"Pronto! O app vai iniciar minimizado junto com o Windows. Atalho: $link"
