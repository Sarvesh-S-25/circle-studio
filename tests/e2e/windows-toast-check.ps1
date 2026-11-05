$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
$matches = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory($appId) | Where-Object { $_.Content.GetXml().Contains('Circle Studio: codex notification test') })
[pscustomobject]@{ notifierSetting = [string]$notifier.Setting; matchingCircleTestNotifications = $matches.Count; note = 'Checks only Circle test entries. Notification Center presence does not establish that a banner was seen.' } | ConvertTo-Json
