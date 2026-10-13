param(
  [ValidateSet("start", "stop", "status", "restart")]
  [string]$Action = "start"
)

$ErrorActionPreference = "Stop"
$webRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = Join-Path $webRoot ".dev-runtime"
$statePath = Join-Path $stateDirectory "service.json"
$stdoutPath = $null
$stderrPath = $null
$healthError = $null

function Test-ServiceHealth {
  try {
    $webResponse = Invoke-WebRequest -Uri "http://127.0.0.1:5173/" -UseBasicParsing -TimeoutSec 3
    if ($webResponse.StatusCode -ne 200 -or $webResponse.Content -notmatch 'id="root"') {
      throw "Port 5173 did not return the project Web page."
    }
    $runtimeResponse = Invoke-WebRequest -Uri "http://127.0.0.1:5192/api/health" -UseBasicParsing -TimeoutSec 3
    $health = $runtimeResponse.Content | ConvertFrom-Json
    if ($runtimeResponse.StatusCode -ne 200 -or $health.status -ne "ok" -or $health.runtime -ne "pi") {
      throw "Pi Runtime health check failed."
    }
    $proxyResponse = Invoke-WebRequest -Uri "http://127.0.0.1:5173/api/health" -UseBasicParsing -TimeoutSec 3
    $proxyHealth = $proxyResponse.Content | ConvertFrom-Json
    if ($proxyHealth.status -ne "ok" -or $proxyHealth.runtime -ne "pi") {
      throw "Web-to-Runtime proxy health check failed."
    }
    $script:healthError = $null
    return $true
  } catch {
    $script:healthError = $_.Exception.Message
    return $false
  }
}

function Get-ManagedProcess {
  if (-not (Test-Path -LiteralPath $statePath)) { return $null }
  try {
    $recordJson = Get-Content -LiteralPath $statePath -Raw
    $record = $recordJson | ConvertFrom-Json
    $candidate = Get-Process -Id ([int]$record.processId) -ErrorAction SilentlyContinue
    if (-not $candidate) { return $null }
    $actualStart = $candidate.StartTime.ToUniversalTime()
    $startedAtMatch = [regex]::Match($recordJson, '"startedAt"\s*:\s*"(?<value>[^"]+)"')
    if (-not $startedAtMatch.Success) { return $null }
    $expectedStart = [DateTimeOffset]::ParseExact($startedAtMatch.Groups["value"].Value, "o", [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None).UtcDateTime
    if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 3) { return $null }
    $actualPath = [IO.Path]::GetFullPath([string]$candidate.Path)
    $expectedPath = [IO.Path]::GetFullPath([string]$record.nodePath)
    if (-not [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    return $candidate
  } catch {
    return $null
  }
}

function Show-RecentLogs {
  $paths = @()
  if ($stdoutPath -and (Test-Path -LiteralPath $stdoutPath)) { $paths += Get-Item -LiteralPath $stdoutPath }
  if ($stderrPath -and (Test-Path -LiteralPath $stderrPath)) { $paths += Get-Item -LiteralPath $stderrPath }
  if (-not $paths.Count -and (Test-Path -LiteralPath $stateDirectory)) {
    $paths = @(Get-ChildItem -LiteralPath $stateDirectory -Filter "*.log" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 2)
  }
  foreach ($file in $paths) {
    $path = $file.FullName
    if (Test-Path -LiteralPath $path) {
      Write-Host "--- $([IO.Path]::GetFileName($path)) ---"
      Get-Content -LiteralPath $path -Tail 40 -ErrorAction SilentlyContinue
    }
  }
}

function Stop-ManagedService {
  $managed = Get-ManagedProcess
  if ($managed) {
    Stop-Process -Id $managed.Id -Force
    try { Wait-Process -Id $managed.Id -Timeout 10 -ErrorAction SilentlyContinue } catch { }
    Write-Host "Stopped project service (PID $($managed.Id))."
  } else {
    Write-Host "No managed project service process was running."
  }
  Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
}

if ($Action -eq "status") {
  $process = Get-ManagedProcess
  if ($process -and (Test-ServiceHealth)) {
    Write-Host "Project Web app and Pi Runtime are running (PID $($process.Id))."
    Write-Host "Web:     http://127.0.0.1:5173/"
    Write-Host "Runtime: http://127.0.0.1:5192/api/health"
    Write-Host "Logs:    $stateDirectory"
    exit 0
  }
  Write-Host "Project Web app and Pi Runtime are not running."
  if ($process) { Write-Host "The process exists, but HTTP health checks failed: $healthError" }
  Show-RecentLogs
  exit 1
}

if ($Action -eq "stop") {
  Stop-ManagedService
  exit 0
}

if ($Action -eq "restart") {
  Stop-ManagedService
  $Action = "start"
}

if ($Action -eq "start") {
  $existing = Get-ManagedProcess
  if ($existing) {
    if (Test-ServiceHealth) {
      Write-Host "Project Web app and Pi Runtime are already running (PID $($existing.Id))."
      Write-Host "Web:     http://127.0.0.1:5173/"
      Write-Host "Runtime: http://127.0.0.1:5192/api/health"
      exit 0
    }
    Write-Host "Existing project process is unhealthy; restarting it: $healthError"
    Stop-ManagedService
  }

  New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
  $runId = Get-Date -Format "yyyyMMdd-HHmmssfff"
  $stdoutPath = Join-Path $stateDirectory "stdout-$runId.log"
  $stderrPath = Join-Path $stateDirectory "stderr-$runId.log"
  Set-Content -LiteralPath $stdoutPath -Value "" -Encoding utf8
  Set-Content -LiteralPath $stderrPath -Value "" -Encoding utf8
  $node = Get-Command node.exe -ErrorAction Stop
  $process = Start-Process -FilePath $node.Source -ArgumentList @("scripts/dev.mjs") -WorkingDirectory $webRoot -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
  @{ processId = $process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString("o"); nodePath = $node.Source; stdoutPath = $stdoutPath; stderrPath = $stderrPath } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  $ready = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) { break }
    $output = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
    $runtimeReady = $output -match "Model runtime API listening on http://127\.0\.0\.1:5192" -or $output -match "Reusing existing Pi Runtime on http://127\.0\.0\.1:5192"
    if ($runtimeReady -and $output -match "http://127\.0\.0\.1:5173/" -and (Test-ServiceHealth)) {
      $ready = $true
      break
    }
  }

  if (-not $ready) {
    $process.Refresh()
    Show-RecentLogs
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
    throw "Project startup failed HTTP health checks. $healthError Start the service on the host computer, outside an isolated command sandbox."
  }

  Write-Host "Project Web app and Pi Runtime started in the background."
  Write-Host "Web:     http://127.0.0.1:5173/"
  Write-Host "Runtime: http://127.0.0.1:5192/api/health"
  Write-Host "Logs:    $stateDirectory"
}
