# IXG Wall telemetry agent (Windows).
# Prints one JSON line per interval: network throughput of the busiest adapter, and the
# browsers' load on the GPU's video and 3D engines. CPU and memory are read by Node itself.
# Counters stay open between samples, so a sample costs milliseconds, not a PDH query.
param([int]$IntervalMs = 2000)

$ErrorActionPreference = 'SilentlyContinue'

function New-CounterList([string]$Category, [string]$Counter, [string]$Match) {
  $list = New-Object System.Collections.Generic.List[object]
  try {
    $cat = New-Object System.Diagnostics.PerformanceCounterCategory($Category)
    foreach ($inst in $cat.GetInstanceNames()) {
      if ($inst -notmatch $Match) { continue }
      try {
        $pc = New-Object System.Diagnostics.PerformanceCounter($Category, $Counter, $inst, $true)
        [void]$pc.NextValue() # rate counters need a first read to prime
        $list.Add([pscustomobject]@{ Name = $inst; Counter = $pc })
      } catch {}
    }
  } catch {}
  return , $list
}

# GPU engine instances are per process; sum per physical engine, report the busiest engine.
function Get-EngineLoad($list) {
  $groups = @{}
  foreach ($c in $list) {
    $key = if ($c.Name -match 'luid_0x[0-9a-fA-F]+_0x[0-9a-fA-F]+_phys_\d+_eng_\d+') { $Matches[0] } else { $c.Name }
    try { $groups[$key] = [double]$groups[$key] + $c.Counter.NextValue() } catch {}
  }
  if ($groups.Count -eq 0) { return $null }
  return [math]::Min(100, ($groups.Values | Measure-Object -Maximum).Maximum)
}

# Only the browsers' engine instances: watching every process costs far more CPU than it
# reveals. AMD reports video decode on its combined codec engine (engtype VideoEncode),
# NVIDIA and Intel on VideoDecode, so every Video* engine counts.
function Update-GpuSets {
  $ids = Get-Process -Name chrome, msedge, brave -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }
  $pattern = if ($ids) { '^pid_(' + (($ids | Sort-Object -Unique) -join '|') + ')_' } else { '^$' }
  $all = New-CounterList 'GPU Engine' 'Utilization Percentage' $pattern
  $script:video = New-Object System.Collections.Generic.List[object]
  $script:gpu3d = New-Object System.Collections.Generic.List[object]
  foreach ($c in $all) {
    if ($c.Name -match 'engtype_Video') { $script:video.Add($c) }
    elseif ($c.Name -match 'engtype_3D$') { $script:gpu3d.Add($c) }
    else { $c.Counter.Dispose() }
  }
}

$rx = New-CounterList 'Network Interface' 'Bytes Received/sec' '.'
$tx = New-CounterList 'Network Interface' 'Bytes Sent/sec' '.'
Update-GpuSets
$rebuildAt = (Get-Date).AddSeconds(5)

while ($true) {
  Start-Sleep -Milliseconds $IntervalMs
  if ((Get-Date) -gt $rebuildAt) {
    # A (re)started browser gets new process ids, so its engine instances are re-found.
    foreach ($c in @($video) + @($gpu3d)) { $c.Counter.Dispose() }
    Update-GpuSets
    $rebuildAt = (Get-Date).AddSeconds($(if (($video.Count + $gpu3d.Count) -eq 0) { 5 } else { 30 }))
  }
  $busiest = $null; $busiestRx = -1; $txFor = 0
  for ($i = 0; $i -lt $rx.Count; $i++) {
    $v = 0; try { $v = $rx[$i].Counter.NextValue() } catch {}
    $t = 0; if ($i -lt $tx.Count) { try { $t = $tx[$i].Counter.NextValue() } catch {} }
    if ($v -gt $busiestRx) { $busiestRx = $v; $busiest = $rx[$i].Name; $txFor = $t }
  }
  $line = [ordered]@{
    t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    rxBps = if ($busiestRx -ge 0) { [math]::Round($busiestRx * 8) } else { $null }
    txBps = [math]::Round($txFor * 8)
    nic = $busiest
    video = Get-EngineLoad $video
    gpu3d = Get-EngineLoad $gpu3d
  }
  [Console]::Out.WriteLine(($line | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}
