# Çalışan Tilki Studio süreçlerinin işlemci ve bellek kullanımını örnekler.
param([int]$Seconds = 15)
function Snap {
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*tilki-studio*' -and $_.Name -ne 'node.exe' } | ForEach-Object {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($p) {
      $type = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'main' }
      if ($_.CommandLine -match 'utility-sub-type=([a-z_.]+)') { $type = $Matches[1].Split('.')[-1] }
      [pscustomobject]@{ Id = $p.Id; Type = $type; Cpu = $p.CPU; Mem = $p.WorkingSet64 / 1MB }
    }
  }
}
$a = Snap; Start-Sleep $Seconds; $b = Snap
$n = (Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
$total = 0
foreach ($x in $b) {
  $y = $a | Where-Object Id -eq $x.Id
  if ($y) {
    $pct = ($x.Cpu - $y.Cpu) / $Seconds * 100; $total += $pct
    '{0,-22} {1,6:N1}% of a core   {2,5:N0} MB' -f $x.Type, $pct, $x.Mem
  }
}
'TOTAL {0:N1}% of a core = {1:N1}% of whole CPU ({2} threads), RAM {3:N0} MB' -f $total, ($total / $n), $n, (($b | Measure-Object Mem -Sum).Sum)
