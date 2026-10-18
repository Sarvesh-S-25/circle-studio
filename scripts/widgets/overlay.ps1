# The overlay, like the Xbox Game Bar: Ctrl+Alt+C dims the screen, brings every desktop tile in front of it and opens
# a command box with panels around it (what waits for you, what runs, the workflow drawn small, the chat, this PC,
# spending, git, notifications). Esc, the same keys or a click on the dimmed screen put everything back.
# Dot-sourced by desktop-widgets.ps1, so it uses that file's helpers (Text, Btn, Brush, Dot, Open-App, the palette).
# Everything it shows comes from GET /api/overlay; every line typed goes to POST /api/overlay/command, which answers in
# plain words (backend/routes.overlay.mjs). The panels can be dragged; their places are kept in desktop-widgets.json.

$script:ov = $null
$script:ovUp = $false
$script:ovProject = ''
$script:ovSig = @{}
$script:ovSlots = @{}
$script:ovHistory = New-Object System.Collections.ArrayList
$script:ovHi = 0
$script:ovFeed = $null
$script:drag = $null
$ovTimer = New-Object System.Windows.Threading.DispatcherTimer
$ovTimer.Interval = [TimeSpan]::FromMilliseconds(1500)
$ovTimer.Add_Tick({ Fetch-Overlay })

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CsFront {
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  // Top of the always-on-top band, without taking the keyboard (no move, no resize, no activate).
  public static void Top(IntPtr h) { SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x13); }
  public static void Focus(IntPtr h) { SetForegroundWindow(h); }
}
'@

function Hwnd($w) { return (New-Object System.Windows.Interop.WindowInteropHelper($w)).Handle }
function Mono([string]$t, [double]$size = 12, [string]$hex = '') { $tb = Text $t $size $hex; $tb.FontFamily = New-Object System.Windows.Media.FontFamily('Cascadia Mono, Consolas'); return $tb }
function Wrap($tb, [double]$maxH = 0) { $tb.TextWrapping = 'Wrap'; $tb.TextTrimming = 'CharacterEllipsis'; if ($maxH -gt 0) { $tb.MaxHeight = $maxH }; return $tb }
function VStack { return (New-Object System.Windows.Controls.StackPanel) }
function HStack { $s = New-Object System.Windows.Controls.StackPanel; $s.Orientation = 'Horizontal'; return $s }
function Add($parent, $child) { if ($child) { [void]$parent.Children.Add($child) }; return $child }

# A bar that fills to pct (processor, memory), in the colour of how full it is.
function Meter([double]$pct, [double]$w = 150) {
  $hex = $(if ($pct -ge 90) { $script:pal.danger } elseif ($pct -ge 70) { $script:pal.warn } else { $script:pal.ok })
  $track = New-Object System.Windows.Controls.Border; $track.Height = 7; $track.CornerRadius = 4; $track.Width = $w; $track.Background = Brush $script:pal.sunken; $track.VerticalAlignment = 'Center'
  $fill = New-Object System.Windows.Controls.Border; $fill.Height = 7; $fill.CornerRadius = 4; $fill.HorizontalAlignment = 'Left'; $fill.Background = Brush $hex
  $fill.Width = [Math]::Max(3, $w * [Math]::Min(100, [Math]::Max(0, $pct)) / 100)
  $track.Child = $fill
  return $track
}

# One panel: a rounded card with a small heading; returns the stack to fill.
function New-Panel([string]$title, [double]$w) {
  $b = New-Object System.Windows.Controls.Border
  $b.CornerRadius = 16; $b.Padding = '16,12,16,14'; $b.Margin = '0,0,0,12'; $b.BorderThickness = 1; $b.Width = $w
  $b.Background = Brush $script:pal.raised; $b.BorderBrush = Brush $script:pal.line
  $fx = New-Object System.Windows.Media.Effects.DropShadowEffect; $fx.BlurRadius = 24; $fx.ShadowDepth = 4; $fx.Opacity = 0.45; $b.Effect = $fx
  $sp = VStack
  $h = Text $title 12 $script:pal.soft 'SemiBold'; $h.Margin = '0,0,0,8'
  [void]$sp.Children.Add($h)
  $b.Child = $sp
  return @($b, $sp)
}

# A button that runs a command, as if it were typed (the answer shows under the command box).
function CmdBtn([string]$label, [string]$command, [string]$kind = 'plain') {
  $b = Btn $label $kind; $b.Tag = $command; $b.Margin = '0,0,6,0'; $b.ToolTip = "Runs: $command"
  $b.Add_Click({ param($s, $e) Send-Command ([string]$s.Tag) })
  return $b
}

# ---- the panels ---------------------------------------------------------------------------------------------------
function Paint-Waiting($list) {
  $list = @($list | Where-Object { $_ })
  $p = New-Panel $(if ($list.Count) { "Waiting for you  $([char]0x00B7)  $($list.Count)" } else { 'Waiting for you' }) 340
  if (-not $list.Count) { [void]$p[1].Children.Add((Wrap (Text 'Nothing waits for you.' 13 $script:pal.soft))); return $p[0] }
  $p[0].BorderBrush = Brush $script:pal.warn
  foreach ($r in @($list | Select-Object -First 3)) {
    $head = HStack; $head.Margin = '0,4,0,2'
    [void]$head.Children.Add((Dot 'waiting'))
    [void]$head.Children.Add((Text "$($r.n)  $([char]0x00B7)  $($r.project)  $([char]0x00B7)  $($r.who)" 11 $script:pal.soft 'SemiBold'))
    [void]$p[1].Children.Add($head)
    [void]$p[1].Children.Add((Wrap (Text $r.title 13 '' 'SemiBold') 40))
    if ($r.detail) {
      $box = New-Object System.Windows.Controls.Border; $box.Background = Brush $script:pal.sunken; $box.CornerRadius = 8; $box.Padding = '8,4,8,4'; $box.Margin = '0,4,0,4'
      $box.Child = Wrap (Mono $r.detail 11) 34; [void]$p[1].Children.Add($box)
    }
    if ($r.outside) { [void]$p[1].Children.Add((Wrap (Text 'This reaches outside the project folder.' 11 $script:pal.warn 'SemiBold'))) }
    $row = New-Object System.Windows.Controls.WrapPanel; $row.Margin = '0,6,0,8'
    if ($r.kind -eq 'question') {
      $k = 0
      foreach ($o in @($r.options)) { $k++; $b = CmdBtn ([string]$o) "answer $($r.n) $k"; $b.Margin = '0,0,6,6'; [void]$row.Children.Add($b) }
      if (-not @($r.options).Count) { [void]$row.Children.Add((Wrap (Text "Type: answer $($r.n) <your answer>" 11 $script:pal.soft))) }
    } else {
      [void]$row.Children.Add((CmdBtn 'Allow' "allow $($r.n)" 'primary'))
      [void]$row.Children.Add((CmdBtn 'Deny' "deny $($r.n)"))
    }
    [void]$p[1].Children.Add($row)
  }
  if ($list.Count -gt 3) { [void]$p[1].Children.Add((Text "and $($list.Count - 3) more: type waiting" 11 $script:pal.soft)) }
  return $p[0]
}

function Paint-Running($list) {
  $list = @($list | Where-Object { $_ })
  $p = New-Panel $(if ($list.Count) { "Running now  $([char]0x00B7)  $($list.Count)" } else { 'Running now' }) 340
  if (-not $list.Count) { [void]$p[1].Children.Add((Wrap (Text 'Nothing is running.' 13 $script:pal.soft))); return $p[0] }
  foreach ($r in @($list | Select-Object -First 4)) {
    $row = HStack; $row.Margin = '0,2,0,4'
    [void]$row.Children.Add((Dot 'working'))
    $col = VStack
    $t = Text $r.title 12 '' 'Medium'; $t.MaxWidth = 280; [void]$col.Children.Add($t)
    if ($r.sub) { $s = Text $r.sub 11 $script:pal.soft; $s.MaxWidth = 280; [void]$col.Children.Add($s) }
    [void]$row.Children.Add($col)
    [void]$p[1].Children.Add($row)
  }
  return $p[0]
}

# The workflow drawn small: a circle per stage on one line (a tick when done, its number otherwise), its name under it
# and a dot per agent, coloured by state.
function Paint-Workflow($wf, $project) {
  if (-not $wf) {
    $p = New-Panel 'Workflow' 340
    [void]$p[1].Children.Add((Wrap (Text $(if ($project) { "$($project.name) has no workflow yet. Type: open workflow" } else { 'No project yet.' }) 12 $script:pal.soft)))
    return $p[0]
  }
  $p = New-Panel "Workflow  $([char]0x00B7)  $($wf.done) of $($wf.total) done" 340
  $wp = New-Object System.Windows.Controls.WrapPanel
  $first = $true
  foreach ($s in @($wf.stages)) {
    $cell = VStack; $cell.Width = 61; $cell.Margin = '0,0,0,8'
    $g = New-Object System.Windows.Controls.Grid; $g.Height = 26
    if (-not $first) {
      $ln = New-Object System.Windows.Controls.Border; $ln.Height = 2; $ln.Width = 34; $ln.HorizontalAlignment = 'Left'; $ln.Margin = '-17,0,0,0'
      $ln.Background = Brush $(if ($s.state -eq 'idle') { $script:pal.line } else { (StateHex $s.state) }); [void]$g.Children.Add($ln)
    }
    $first = $false
    $c = New-Object System.Windows.Controls.Border; $c.Width = 26; $c.Height = 26; $c.CornerRadius = 13; $c.BorderThickness = 2
    $c.BorderBrush = Brush (StateHex $s.state)
    $c.Background = $(if ($s.state -eq 'done') { Brush $script:pal.info } elseif ($s.state -eq 'idle') { Brush $script:pal.raised } else { Brush (StateHex $s.state) '33' })
    $num = Text $(if ($s.state -eq 'done') { [string][char]0x2713 } else { [string]$s.n }) 11 $(if ($s.state -eq 'done') { $script:pal.onAccent } else { $script:pal.text }) 'SemiBold'
    $num.HorizontalAlignment = 'Center'; $num.VerticalAlignment = 'Center'; $c.Child = $num
    $c.ToolTip = "$($s.n). $($s.title): $($s.word)$(if ($s.checkpoint) { ', you check it first' })"
    [void]$g.Children.Add($c)
    [void]$cell.Children.Add($g)
    $t = Wrap (Text $s.title 10 $(if ($s.state -eq 'idle') { $script:pal.soft } else { $script:pal.text }) $(if ($s.state -eq 'working' -or $s.state -eq 'waiting') { 'SemiBold' } else { 'Normal' })) 28
    $t.TextAlignment = 'Center'; $t.Margin = '2,4,2,2'; [void]$cell.Children.Add($t)
    $dots = HStack; $dots.HorizontalAlignment = 'Center'
    foreach ($a in @($s.agents)) { $d = Dot $a.state; $d.Width = 6; $d.Height = 6; $d.Margin = '1,0,1,0'; $d.ToolTip = "$($a.title)"; [void]$dots.Children.Add($d) }
    [void]$cell.Children.Add($dots)
    [void]$wp.Children.Add($cell)
  }
  [void]$p[1].Children.Add($wp)
  $now = Wrap (Text $wf.now 12 '' 'SemiBold'); [void]$p[1].Children.Add($now)
  if ($wf.more) { [void]$p[1].Children.Add((Text "and $($wf.more) more stages" 11 $script:pal.soft)) }
  return $p[0]
}

function Bubble([string]$who, [string]$said, [bool]$mine, [double]$maxH = 60) {
  $b = New-Object System.Windows.Controls.Border
  $b.CornerRadius = 10; $b.Padding = '8,4,8,6'; $b.Margin = '0,0,0,4'; $b.MaxWidth = 290
  $b.HorizontalAlignment = $(if ($mine) { 'Right' } else { 'Left' })
  $b.Background = $(if ($mine) { Brush $script:pal.accent '33' } else { Brush $script:pal.sunken })
  $col = VStack
  if ($who) { [void]$col.Children.Add((Text $who 11 $script:pal.soft 'SemiBold')) }
  [void]$col.Children.Add((Wrap (Text $said 12) $maxH))
  $b.Child = $col
  return $b
}

function Paint-Chat($chat, $live, $project) {
  $eng = $(if ($chat -and $chat.engine) { (Get-Culture).TextInfo.ToTitleCase([string]$chat.engine) } else { '' })
  $p = New-Panel $(if ($project) { "Chat  $([char]0x00B7)  $($project.name)$(if ($eng) { "  $([char]0x00B7)  $eng" })" } else { 'Chat' }) 340
  if ($live) {
    [void]$p[1].Children.Add((Bubble "You, to $($live.to)" $live.you $true 40))
    $txt = $(if ($live.text) { [string]$live.text } elseif ($live.done) { '(no words)' } else { [string][char]0x2026 })
    if ($txt.Length -gt 700) { $txt = [string][char]0x2026 + $txt.Substring($txt.Length - 700) }
    [void]$p[1].Children.Add((Bubble $live.to $txt $false 150))
    $st = $(if ($live.error) { Wrap (Text $live.error 11 $script:pal.danger 'SemiBold') } elseif ($live.done) { Text 'Done' 11 $script:pal.info 'SemiBold' } else { Text 'Answering...  type stop to stop it' 11 $script:pal.ok 'SemiBold' })
    [void]$p[1].Children.Add($st)
  } elseif ($chat -and @($chat.messages).Count) {
    foreach ($m in @($chat.messages | Select-Object -Last 2)) { [void]$p[1].Children.Add((Bubble $m.who $m.text ([bool]$m.mine) 46)) }
  } else { [void]$p[1].Children.Add((Wrap (Text 'Nothing said yet.' 12 $script:pal.soft))) }
  $hint = Text 'Type a sentence below to send it here.' 10 $script:pal.soft; $hint.Margin = '0,6,0,0'
  [void]$p[1].Children.Add($hint)
  return $p[0]
}

function Paint-PC($pc) {
  $p = New-Panel 'This PC' 280
  [void]$p[1].Children.Add((Text ((Get-Date).ToString('t')) 30 '' 'SemiBold' -Big))
  [void]$p[1].Children.Add((Text ((Get-Date).ToString('dddd d MMMM')) 11 $script:pal.soft))
  foreach ($row in @(@('Processor', $pc.cpu, $(if ($null -ne $pc.cpu) { "$($pc.cpu)%" } else { '-' })), @('Memory', $pc.memPct, "$($pc.memUsedGb) / $($pc.memTotalGb) GB"))) {
    $g = New-Object System.Windows.Controls.DockPanel; $g.Margin = '0,8,0,0'
    $l = Text $row[0] 11 $script:pal.soft 'SemiBold'; $l.Width = 66; [System.Windows.Controls.DockPanel]::SetDock($l, 'Left'); [void]$g.Children.Add($l)
    $v = Text $row[2] 11; $v.Width = 74; $v.TextAlignment = 'Right'; [System.Windows.Controls.DockPanel]::SetDock($v, 'Right'); [void]$g.Children.Add($v)
    [void]$g.Children.Add((Meter ([double]$(if ($null -ne $row[1]) { $row[1] } else { 0 })) 100))
    [void]$p[1].Children.Add($g)
  }
  $up = Text "On for $($pc.uptime)  $([char]0x00B7)  $($pc.cores) threads" 10 $script:pal.soft; $up.Margin = '0,8,0,0'; [void]$p[1].Children.Add($up)
  return $p[0]
}

function Paint-Usage($u) {
  $p = New-Panel "Spending  $([char]0x00B7)  30 days" 280
  if (-not $u) { [void]$p[1].Children.Add((Text 'Adding up your use...' 12 $script:pal.soft)); return $p[0] }
  $row = HStack
  [void]$row.Children.Add((Text $u.total 26 '' 'SemiBold' -Big))
  $td = Text "  $($u.today) today" 12 $script:pal.soft; $td.VerticalAlignment = 'Bottom'; $td.Margin = '0,0,0,5'; [void]$row.Children.Add($td)
  [void]$p[1].Children.Add($row)
  $bars = @($u.bars)
  if ($bars.Count) {
    $max = [Math]::Max(0.01, ($bars | Measure-Object -Maximum).Maximum)
    $bp = HStack; $bp.Height = 34; $bp.Margin = '0,6,0,6'
    foreach ($b in $bars) { $x = New-Object System.Windows.Controls.Border; $x.Width = 12; $x.Margin = '0,0,4,0'; $x.CornerRadius = 2; $x.VerticalAlignment = 'Bottom'; $x.Height = [Math]::Max(2, 34 * [double]$b / $max); $x.Background = Brush $script:pal.gate; [void]$bp.Children.Add($x) }
    $bp.ToolTip = 'Claude, the last 14 days'
    [void]$p[1].Children.Add($bp)
  }
  foreach ($r in @($u.rows | Select-Object -First 4)) { [void]$p[1].Children.Add((Row (Text $r.label 11 $script:pal.soft) (Text $r.value 11))) }
  $n = Text $u.note 10 $script:pal.soft; $n.Margin = '0,4,0,0'; [void]$p[1].Children.Add($n)
  return $p[0]
}

function Paint-Git($g, $project) {
  $p = New-Panel $(if ($project) { "Git  $([char]0x00B7)  $($project.name)" } else { 'Git' }) 280
  if (-not $g) { [void]$p[1].Children.Add((Text 'No project yet.' 12 $script:pal.soft)); return $p[0] }
  if ($g.isRepo) { [void]$p[1].Children.Add((Text $g.branch 15 '' 'SemiBold')) }
  [void]$p[1].Children.Add((Wrap (Text $g.line 12 $(if ($g.changed) { $script:pal.warn } else { $script:pal.soft }))))
  if ($g.last) { $l = Wrap (Text "Last: $($g.last)" 11 $script:pal.soft) 30; $l.Margin = '0,4,0,0'; [void]$p[1].Children.Add($l) }
  return $p[0]
}

function Paint-Notices($list) {
  $p = New-Panel 'Notifications' 280
  $list = @($list | Where-Object { $_ })
  if (-not $list.Count) { [void]$p[1].Children.Add((Wrap (Text 'Nothing yet.' 12 $script:pal.soft))); return $p[0] }
  foreach ($n in $list) {
    $row = HStack; $row.Margin = '0,2,0,2'
    [void]$row.Children.Add((Dot $(if ($n.read) { 'idle' } else { 'waiting' })))
    $t = Text "$($n.at)  $($n.title)" 11 $(if ($n.read) { $script:pal.soft } else { $script:pal.text }); $t.MaxWidth = 230; [void]$row.Children.Add($t)
    [void]$p[1].Children.Add($row)
  }
  return $p[0]
}

# ---- the command box ----------------------------------------------------------------------------------------------
function Show-Reply($say, [bool]$mono = $false) {
  $r = $script:ovReply
  $r.Children.Clear()
  if (-not $say) { $r.Visibility = 'Collapsed'; return }
  $r.Visibility = 'Visible'
  $hex = $(switch ($say.tone) { 'ok' { $script:pal.ok } 'warn' { $script:pal.warn } 'danger' { $script:pal.danger } default { $script:pal.text } })
  [void]$r.Children.Add((Wrap (Text $say.title 14 $hex 'SemiBold')))
  foreach ($l in @($say.lines | Where-Object { $_ })) {
    $t = $(if ($mono) { Mono ([string]$l) 11 $script:pal.soft } else { Text ([string]$l) 12 $script:pal.soft })
    $t.Margin = '0,3,0,0'; [void]$r.Children.Add((Wrap $t))
  }
  $script:ovReplyScroll.ScrollToTop()
}

function Send-Command([string]$text) {
  if (-not $text.Trim()) { return }
  if ($script:ovHistory.Count -eq 0 -or $script:ovHistory[$script:ovHistory.Count - 1] -ne $text) { [void]$script:ovHistory.Add($text) }
  $script:ovHi = $script:ovHistory.Count
  Show-Reply @{ title = 'Working...'; lines = @($text); tone = 'info' }
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('X-Circle', '1'); $wc.Headers.Add('Content-Type', 'application/json'); $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Add_UploadStringCompleted({
    param($s, $e)
    $s.Dispose()
    try {
      if ($e.Error) { Show-Reply @{ title = 'Circle Studio did not answer.'; lines = @('Is it running? Click any tile to start it.'); tone = 'danger' }; return }
      $r = $e.Result | ConvertFrom-Json
      if ($r.projectId) { $script:ovProject = [string]$r.projectId }
      Show-Reply $r.say ($r.command -eq 'help')
      if ($r.open) { Open-App ([string]$r.open) }
      if ($r.chatWindow) { Open-App ('chat:' + [string]$r.chatWindow) }
      if ($r.hide) { Hide-Overlay } else { Fetch-Overlay }
    } catch { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' overlay command: ' + $_.Exception.Message) }
  })
  $wc.UploadStringAsync([Uri]"$base/api/overlay/command", 'POST', (@{ text = $text; projectId = $script:ovProject } | ConvertTo-Json -Compress))
}

function New-CommandBar([double]$w) {
  $p = New-Panel '' $w
  $p[0].BorderBrush = Brush $script:pal.accent; $p[0].Padding = '18,12,18,16'
  $sp = $p[1]; $sp.Children.Clear()
  # top line: name, the project shown (a click switches it), and how to close
  $top = New-Object System.Windows.Controls.DockPanel; $top.Margin = '0,0,0,8'
  $close = Text "Esc or $($script:HOTKEY_WORDS) to close" 11 $script:pal.soft; $close.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($close, 'Right'); [void]$top.Children.Add($close)
  $name = Text 'Circle Studio' 13 $script:pal.accent 'SemiBold'; $name.VerticalAlignment = 'Center'; $name.Margin = '0,0,10,0'
  [System.Windows.Controls.DockPanel]::SetDock($name, 'Left'); [void]$top.Children.Add($name)
  $chip = Btn ('Project ' + [string][char]0x25BE) 'plain'; $chip.Margin = '0'; $chip.MinHeight = 26; $chip.Padding = '10,2,10,2'; $chip.HorizontalAlignment = 'Left'
  $chip.ToolTip = 'Show another project (or type: project <name>)'
  $chip.Add_Click({
    param($s, $e)
    $cm = New-Object System.Windows.Controls.ContextMenu
    foreach ($pr in @($script:ovFeed.projects)) {
      $mi = New-Object System.Windows.Controls.MenuItem; $mi.Header = $pr.name; $mi.IsCheckable = $true; $mi.IsChecked = ($pr.id -eq $script:ovProject); $mi.Tag = [string]$pr.id
      $mi.Add_Click({ param($a, $b) $script:ovProject = [string]$a.Tag; $script:ovSig = @{}; Fetch-Overlay; $script:ovInput.Focus() })
      [void]$cm.Items.Add($mi)
    }
    $cm.PlacementTarget = $s; $cm.IsOpen = $true
  })
  $script:ovChip = $chip
  [void]$top.Children.Add($chip)
  [void]$sp.Children.Add($top)
  # what the last command said
  $script:ovReply = VStack; $script:ovReply.Margin = '2,0,2,10'; $script:ovReply.Visibility = 'Collapsed'
  $sv = New-Object System.Windows.Controls.ScrollViewer; $sv.MaxHeight = 280; $sv.VerticalScrollBarVisibility = 'Auto'; $sv.Content = $script:ovReply
  $script:ovReplyScroll = $sv
  [void]$sp.Children.Add($sv)
  # the box, with its hint under the text while it is empty
  $g = New-Object System.Windows.Controls.Grid
  $in = New-Object System.Windows.Controls.TextBox
  $in.FontSize = 17; $in.Padding = '12,9,12,9'; $in.BorderThickness = 2; $in.FontFamily = $uiFont
  $in.Background = Brush $script:pal.sunken; $in.Foreground = Brush $script:pal.text; $in.BorderBrush = Brush $script:pal.accent; $in.CaretBrush = Brush $script:pal.text
  $in.SelectionBrush = Brush $script:pal.accent
  [System.Windows.Automation.AutomationProperties]::SetName($in, 'Command')
  $hint = Text 'Type a command or a message. help shows them all.' 15 $script:pal.soft; $hint.Margin = '16,0,0,0'; $hint.VerticalAlignment = 'Center'; $hint.IsHitTestVisible = $false
  $in.Tag = $hint
  $in.Add_TextChanged({ param($s, $e) $s.Tag.Visibility = $(if ($s.Text) { 'Collapsed' } else { 'Visible' }) })
  $in.Add_PreviewKeyDown({
    param($s, $e)
    if ($e.Key -eq 'Return') { $t = $s.Text; $s.Text = ''; Send-Command $t; $e.Handled = $true }
    elseif ($e.Key -eq 'Escape') { Hide-Overlay; $e.Handled = $true }
    elseif ($e.Key -eq 'Up' -and $script:ovHistory.Count) { $script:ovHi = [Math]::Max(0, $script:ovHi - 1); $s.Text = $script:ovHistory[$script:ovHi]; $s.CaretIndex = $s.Text.Length; $e.Handled = $true }
    elseif ($e.Key -eq 'Down' -and $script:ovHistory.Count) { $script:ovHi = [Math]::Min($script:ovHistory.Count, $script:ovHi + 1); $s.Text = $(if ($script:ovHi -lt $script:ovHistory.Count) { $script:ovHistory[$script:ovHi] } else { '' }); $s.CaretIndex = $s.Text.Length; $e.Handled = $true }
  })
  [void]$g.Children.Add($in); [void]$g.Children.Add($hint)
  $script:ovInput = $in
  [void]$sp.Children.Add($g)
  # a few to try: a click puts it in the box
  $ex = New-Object System.Windows.Controls.WrapPanel; $ex.Margin = '0,10,0,0'
  $script:ovExamples = $ex
  [void]$sp.Children.Add($ex)
  return $p[0]
}

function Paint-Examples($list) {
  $ex = $script:ovExamples; $ex.Children.Clear()
  foreach ($x in @($list)) {
    $c = New-Object System.Windows.Controls.Border; $c.CornerRadius = 10; $c.Padding = '9,3,9,3'; $c.Margin = '0,0,6,6'; $c.BorderThickness = 1; $c.Cursor = 'Hand'
    $c.BorderBrush = Brush $script:pal.line; $c.Child = Mono ([string]$x) 11 $script:pal.soft; $c.Tag = [string]$x; $c.ToolTip = 'Put it in the box'
    $c.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; $t = [string]$s.Tag; $script:ovInput.Text = $(if ($t -match '<') { $t.Substring(0, $t.IndexOf('<')) } else { $t }); $script:ovInput.CaretIndex = $script:ovInput.Text.Length; $script:ovInput.Focus() })
    [void]$ex.Children.Add($c)
  }
}

# ---- placing and dragging the groups --------------------------------------------------------------------------------
# Three groups, each dragged as one by any spot that is not a button or a box: the left column (waiting, running,
# workflow, chat), the PC column (this PC, spending, git, notifications) and the command box. A place is kept per group.
function Is-Control($src, $stop) {
  $n = $src
  while ($n -and $n -ne $stop) {
    if ($n -is [System.Windows.Controls.Primitives.ButtonBase] -or $n -is [System.Windows.Controls.Primitives.TextBoxBase] -or $n -is [System.Windows.Controls.Primitives.ScrollBar]) { return $true }
    $n = $(if ($n -is [System.Windows.Media.Visual]) { [System.Windows.Media.VisualTreeHelper]::GetParent($n) } else { [System.Windows.LogicalTreeHelper]::GetParent($n) })
  }
  return $false
}

function Place-Group($el, [string]$key, [double]$x, [double]$y, [bool]$fromBottom) {
  $pos = $null
  if ($saved.overlay -and $saved.overlay[$key]) { $pos = $saved.overlay[$key] }
  if ($pos) { $x = [double]$pos.x; $y = [double]$pos.y }
  [System.Windows.Controls.Canvas]::SetLeft($el, $x)
  if ($fromBottom) { [System.Windows.Controls.Canvas]::SetBottom($el, $y) } else { [System.Windows.Controls.Canvas]::SetTop($el, $y) }
  $el.Tag = @{ key = $key; bottom = $fromBottom }
  $el.Add_PreviewMouseLeftButtonDown({
    param($s, $e)
    if ($script:locked -or (Is-Control $e.OriginalSource $s)) { return }
    $c = $script:ovCanvas
    $script:drag = @{ el = $s; at = $e.GetPosition($c); x = [System.Windows.Controls.Canvas]::GetLeft($s); y = $(if ($s.Tag.bottom) { [System.Windows.Controls.Canvas]::GetBottom($s) } else { [System.Windows.Controls.Canvas]::GetTop($s) }) }
    [void]$s.CaptureMouse(); $e.Handled = $true
  })
  $el.Add_MouseMove({
    param($s, $e)
    $d = $script:drag
    if (-not $d -or $d.el -ne $s) { return }
    $p = $e.GetPosition($script:ovCanvas)
    [System.Windows.Controls.Canvas]::SetLeft($s, $d.x + $p.X - $d.at.X)
    if ($s.Tag.bottom) { [System.Windows.Controls.Canvas]::SetBottom($s, $d.y - ($p.Y - $d.at.Y)) } else { [System.Windows.Controls.Canvas]::SetTop($s, $d.y + $p.Y - $d.at.Y) }
  })
  $el.Add_MouseLeftButtonUp({
    param($s, $e)
    if (-not $script:drag -or $script:drag.el -ne $s) { return }
    $s.ReleaseMouseCapture(); $script:drag = $null
    if (-not $saved.overlay) { $saved.overlay = @{} }
    $saved.overlay[$s.Tag.key] = @{ x = [System.Windows.Controls.Canvas]::GetLeft($s); y = $(if ($s.Tag.bottom) { [System.Windows.Controls.Canvas]::GetBottom($s) } else { [System.Windows.Controls.Canvas]::GetTop($s) }) }
    Save-State
  })
}

function New-Slot($parent, [string]$name) { $c = New-Object System.Windows.Controls.ContentControl; $c.Focusable = $false; [void]$parent.Children.Add($c); $script:ovSlots[$name] = $c }

function New-Overlay {
  $vs = @([System.Windows.SystemParameters]::VirtualScreenLeft, [System.Windows.SystemParameters]::VirtualScreenTop, [System.Windows.SystemParameters]::VirtualScreenWidth, [System.Windows.SystemParameters]::VirtualScreenHeight)
  $area = [System.Windows.SystemParameters]::WorkArea
  $w = New-Object System.Windows.Window
  $w.WindowStyle = 'None'; $w.AllowsTransparency = $true; $w.Background = [System.Windows.Media.Brushes]::Transparent
  $w.ShowInTaskbar = $false; $w.ResizeMode = 'NoResize'; $w.Topmost = $true; $w.Title = 'Circle Studio overlay'
  $w.Left = $vs[0]; $w.Top = $vs[1]; $w.Width = $vs[2]; $w.Height = $vs[3]
  $root = New-Object System.Windows.Controls.Grid
  $scrim = $(if ($script:pal.scrim) { $script:pal.scrim } else { '#9e000000' })
  $root.Background = $conv.ConvertFromString($scrim)
  # a click on the dimmed screen itself (not on a panel) closes it
  $root.Add_MouseLeftButtonDown({ param($s, $e) if ($e.OriginalSource -eq $s -or $e.OriginalSource -eq $script:ovCanvas) { Hide-Overlay } })
  $c = New-Object System.Windows.Controls.Canvas
  $c.Background = [System.Windows.Media.Brushes]::Transparent
  $c.HorizontalAlignment = 'Left'; $c.VerticalAlignment = 'Top'
  $c.Margin = New-Object System.Windows.Thickness(($area.Left - $vs[0]), ($area.Top - $vs[1]), 0, 0)
  $c.Width = $area.Width; $c.Height = $area.Height
  $script:ovCanvas = $c
  [void]$root.Children.Add($c)

  $left = VStack; New-Slot $left 'waiting'; New-Slot $left 'running'; New-Slot $left 'workflow'; New-Slot $left 'chat'
  $sv = New-Object System.Windows.Controls.ScrollViewer; $sv.VerticalScrollBarVisibility = 'Auto'; $sv.MaxHeight = $area.Height - 36; $sv.Content = $left; $sv.Focusable = $false
  [void]$c.Children.Add($sv); Place-Group $sv 'left' 24 24 $false

  $right = VStack; New-Slot $right 'pc'; New-Slot $right 'usage'; New-Slot $right 'git'; New-Slot $right 'notices'
  [void]$c.Children.Add($right); Place-Group $right 'stats' ($area.Width - 24 - 280) 12 $true

  $bw = [Math]::Max(440, [Math]::Min(680, $area.Width - 2 * 392))
  $bar = New-CommandBar $bw
  [void]$c.Children.Add($bar); Place-Group $bar 'command' (($area.Width - $bw) / 2) 12 $true

  $w.Content = $root
  $w.Add_PreviewKeyDown({ param($s, $e) if ($e.Key -eq 'Escape') { Hide-Overlay; $e.Handled = $true } })
  $w.Add_SourceInitialized({ param($sender, $e) [CsDesk]::Tool((Hwnd $sender)) })
  $script:ovSig = @{}
  return $w
}

# Paint the slots whose content changed (the clock and the PC numbers change every time; the rest only when they do).
function Paint-Overlay($f) {
  $script:ovFeed = $f
  if ($f.palette) { $script:pal = @{}; foreach ($p in $f.palette.PSObject.Properties) { $script:pal[$p.Name] = $p.Value } }
  if ($f.project) { $script:ovProject = [string]$f.project.id; $script:ovChip.Content.Text = "$($f.project.name)  " + [string][char]0x25BE } else { $script:ovChip.Content.Text = 'No project yet' }
  $parts = @{
    waiting = @{ v = $f.waiting; draw = { Paint-Waiting $f.waiting } }
    running = @{ v = $f.running; draw = { Paint-Running $f.running } }
    workflow = @{ v = @($f.workflow, $f.project); draw = { Paint-Workflow $f.workflow $f.project } }
    chat = @{ v = @($f.chat, $f.live, $f.project); draw = { Paint-Chat $f.chat $f.live $f.project } }
    pc = @{ v = @($f.pc, (Get-Date).ToString('t')); draw = { Paint-PC $f.pc } }
    usage = @{ v = $f.usage; draw = { Paint-Usage $f.usage } }
    git = @{ v = @($f.git, $f.project); draw = { Paint-Git $f.git $f.project } }
    notices = @{ v = $f.notices; draw = { Paint-Notices $f.notices } }
  }
  foreach ($k in $parts.Keys) {
    # -InputObject: an empty list piped would give nothing, the same as "never painted", and the panel would stay empty
    $sig = ConvertTo-Json -InputObject @{ v = $parts[$k].v } -Depth 8 -Compress
    if ($script:ovSig.ContainsKey($k) -and $script:ovSig[$k] -eq $sig) { continue }
    $script:ovSig[$k] = $sig
    try { $script:ovSlots[$k].Content = & $parts[$k].draw } catch { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + " overlay $k`: " + $_.Exception.Message + ' ' + $_.InvocationInfo.PositionMessage) }
  }
  if (-not $script:ovSig['examples']) { Paint-Examples $f.examples; $script:ovSig['examples'] = '1' }
}

function Fetch-Overlay {
  if (-not $script:ovUp) { return }
  $wc = New-Object System.Net.WebClient
  $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Add_DownloadStringCompleted({
    param($s, $e)
    $s.Dispose()
    if (-not $script:ovUp) { return }
    try {
      if ($e.Error) { Show-Reply @{ title = 'Circle Studio is not running.'; lines = @('Click any tile to start it, then press the keys again.'); tone = 'danger' }; return }
      Paint-Overlay ($e.Result | ConvertFrom-Json)
    } catch { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' overlay: ' + $_.Exception.Message + ' ' + $_.InvocationInfo.PositionMessage) }
  })
  $q = "theme=$(Theme)$(if ($script:ovProject) { '&projectId=' + [Uri]::EscapeDataString($script:ovProject) })"
  $wc.DownloadStringAsync([Uri]"$base/api/overlay?$q")
}

function Show-Overlay {
  if ($script:ovUp) { return }
  $script:ovUp = $true
  $script:ov = New-Overlay          # built again each time: the screen, the theme or the palette may have changed
  $script:ov.Opacity = 0
  $script:ov.Show()
  $h = Hwnd $script:ov
  [CsFront]::Focus($h); $script:ov.Activate() | Out-Null
  # the tiles in front of the dimmed screen, without taking the keyboard from the command box
  foreach ($w in $windows.Values) { $th = Hwnd $w; [CsDesk]::Free($th); $w.Topmost = $true; [CsFront]::Top($th) }
  foreach ($w in $script:asks.Values) { $w.Hide() } # what waits is in the overlay's own panel
  if (Motion-On) { $an = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(140)))); $script:ov.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $an) } else { $script:ov.Opacity = 1 }
  if ($script:ovFeed) { try { Paint-Overlay $script:ovFeed } catch { } }
  $script:ovInput.Focus() | Out-Null
  [System.Windows.Input.Keyboard]::Focus($script:ovInput) | Out-Null
  Fetch-Overlay; $ovTimer.Start()
  Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' overlay: open')
}

function Hide-Overlay {
  if (-not $script:ovUp) { return }
  $script:ovUp = $false
  $ovTimer.Stop()
  if ($script:ov) { $script:ov.Close(); $script:ov = $null }
  Apply-Layer
  foreach ($w in $script:asks.Values) { $w.Show() }
  if ($script:asks.Count) { Place-Asks }
}

function Toggle-Overlay { if ($script:ovUp) { Hide-Overlay } else { Show-Overlay } }
