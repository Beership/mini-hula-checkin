$ErrorActionPreference = 'Continue'
foreach ($name in @('WeChatMiniCheckin', 'WeChatMiniCatchup')) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Output ("removed task: " + $name)
  } else {
    Write-Output ("not found: " + $name)
  }
}
