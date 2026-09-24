// The PowerShell that watches Windows notifications. It runs as a child process of the app, is passed to
// powershell.exe as an encoded command (so it works from inside the packaged app.asar), and prints one JSON
// line per NEW notification that matches the filter. Everything else is dropped inside PowerShell and never
// reaches the app, is never stored and never logged.
//
// Environment: VRMP_FILTER = comma-separated words matched (case-insensitive, substring) against the
// notification's app name and app id; '*' matches every app. VRMP_PARENT = the app's process id, so this
// script exits by itself if the app dies.
module.exports = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [void][Windows.UI.Notifications.Management.UserNotificationListener,Windows.UI.Notifications,ContentType=WindowsRuntime]
  [void][Windows.UI.Notifications.NotificationKinds,Windows.UI.Notifications,ContentType=WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  $listT = $asTask.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
  $l = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $status = [string]$l.GetAccessStatus()
  if ($status -ne 'Allowed') {
    $accT = $asTask.MakeGenericMethod([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
    $t = $accT.Invoke($null, @($l.RequestAccessAsync())); [void]$t.Wait(30000); $status = [string]$t.Result
  }
  if ($status -ne 'Allowed') { Out-Json @{ error = "Windows did not allow notification access ($status). Turn it on in Windows Settings > Privacy > Notifications." }; exit 0 }
  $terms = @(($env:VRMP_FILTER -split ',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
  if (-not $terms.Count) { $terms = @('discord') }
  $parent = 0; [void][int]::TryParse($env:VRMP_PARENT, [ref]$parent)
  function Snap { $t = $listT.Invoke($null, @($l.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast))); [void]$t.Wait(8000); $t.Result }
  $seen = @{}
  foreach ($n in (Snap)) { $seen[$n.Id] = 1 }
  Out-Json @{ ready = $true }
  while ($true) {
    if ($parent -gt 0 -and -not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { break }
    foreach ($n in @(Snap)) {
      if ($seen.ContainsKey($n.Id)) { continue }
      $seen[$n.Id] = 1
      $name = [string]$n.AppInfo.DisplayInfo.DisplayName
      $aumid = [string]$n.AppInfo.AppUserModelId
      $hay = ($name + ' ' + $aumid).ToLower()
      $ok = $false
      foreach ($w in $terms) { if ($w -eq '*' -or $hay.Contains($w)) { $ok = $true; break } }
      if (-not $ok) { continue }
      $texts = @(); $b = $n.Notification.Visual.Bindings | Select-Object -First 1
      if ($b) { foreach ($el in $b.GetTextElements()) { $texts += [string]$el.Text } }
      Out-Json @{ app = $name; title = $(if ($texts.Count) { $texts[0] } else { '' }); body = ($texts | Select-Object -Skip 1) -join "\`n" }
    }
    if ($seen.Count -gt 3000) { $seen = @{}; foreach ($n in (Snap)) { $seen[$n.Id] = 1 } }
    Start-Sleep -Milliseconds 500
  }
} catch { Out-Json @{ error = $_.Exception.Message } }
`;
