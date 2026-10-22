# The overlay, like the Xbox Game Bar: Ctrl+Alt+C dims the screen and opens its own widgets over it: a bar at the top
# (the project switcher, the Widgets menu, Reset layout, Close), panels (what waits for you, what runs, the workflow
# drawn small, the chat, this PC, spending, git, notifications) and the command box. The desktop tiles stay where they
# are, under the dim: the panels already show what they show, and tiles in front used to cover the panels.
# Esc, the same keys or a click on the dimmed screen close it.
# Dot-sourced by desktop-widgets.ps1, so it uses that file's helpers (Text, Btn, Brush, Dot, Open-App, the palette).
# Everything it shows comes from GET /api/overlay; every line typed goes to POST /api/overlay/command, which answers in
# plain words (backend/routes.overlay.mjs). Every panel can be dragged on its own (the tile lock does not apply here);
# a dragged panel keeps its place, the others stay stacked in their column. The Widgets menu also adds more widgets
# (activity rings, agents, a project at a glance, all projects, mods), drawn like the desktop tiles for the project
# shown, in a middle row. Places, hidden panels and added widgets are kept in desktop-widgets.json (overlay.places,
# overlay.hidden, overlay.extra).

$script:ov = $null
$script:ovUp = $false
$script:ovProject = ''
$script:ovSig = @{}
$script:ovSlots = @{}
$script:ovHistory = New-Object System.Collections.ArrayList
$script:ovHi = 0
$script:ovFeed = $null
$script:drag = $null
$script:ovZ = 10
$script:ovDrop = $null
$ovTimer = New-Object System.Windows.Threading.DispatcherTimer
$ovTimer.Interval = [TimeSpan]::FromMilliseconds(1500)
$ovTimer.Add_Tick({ Fetch-Overlay })

# Every panel, in the order of its column; the command box sits at the bottom.
$script:PANELS = [ordered]@{ waiting = 'Waiting for you'; running = 'Running now'; workflow = 'Workflow'; limits = 'Plan limits'; pc = 'This PC'; usage = 'Spending'; git = 'Git'; notices = 'Notifications'; command = 'Chat' }
$script:COLUMN = @{ waiting = 'left'; running = 'left'; workflow = 'left'; limits = 'right'; pc = 'right'; usage = 'right'; git = 'right'; notices = 'right' }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CsFront {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
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
  # the heading, with a grip that says the panel can be dragged
  $head = New-Object System.Windows.Controls.DockPanel; $head.Margin = '0,0,0,8'; $head.Cursor = 'SizeAll'; $head.Background = [System.Windows.Media.Brushes]::Transparent
  $grip = Glyph 0x283F 12 $script:pal.lineStrong; $grip.ToolTip = 'Drag to move'
  [System.Windows.Controls.DockPanel]::SetDock($grip, 'Right'); [void]$head.Children.Add($grip)
  [void]$head.Children.Add((Text $title 12 $script:pal.soft 'SemiBold'))
  [void]$sp.Children.Add($head)
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
      foreach ($o in @($r.options)) { $k++; $b = CmdBtn ([string]$o) "/answer $($r.n) $k"; $b.Margin = '0,0,6,6'; [void]$row.Children.Add($b) }
      if (-not @($r.options).Count) { [void]$row.Children.Add((Wrap (Text "Type: answer $($r.n) <your answer>" 11 $script:pal.soft))) }
    } else {
      [void]$row.Children.Add((CmdBtn 'Allow' "/allow $($r.n)" 'primary'))
      [void]$row.Children.Add((CmdBtn 'Deny' "/deny $($r.n)"))
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
    [void]$p[1].Children.Add((Wrap (Text $(if ($project) { "$($project.name) has no workflow yet: /open workflow draws one." } else { 'No project yet.' }) 12 $script:pal.soft)))
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

# Your plan's limits: the 5 hours and the week, how much is used and when each starts again.
function Paint-Limits($l) {
  $p = New-Panel 'Plan limits' 280
  if (-not $l -or -not @($l.rows).Count) {
    [void]$p[1].Children.Add((Wrap (Text 'Shows after Claude answers once (here or in the chat), or turn on "From your terminal too" on the Widgets page.' 12 $script:pal.soft)))
    return $p[0]
  }
  foreach ($r in @($l.rows)) {
    $g = New-Object System.Windows.Controls.DockPanel; $g.Margin = '0,2,0,0'
    $lab = Text $r.label 12 '' 'SemiBold'; $lab.Width = 66; [System.Windows.Controls.DockPanel]::SetDock($lab, 'Left'); [void]$g.Children.Add($lab)
    $v = Text $r.value 15 $script:pal[[string]$r.color] 'SemiBold'; $v.Width = 52; $v.TextAlignment = 'Right'; [System.Windows.Controls.DockPanel]::SetDock($v, 'Right'); [void]$g.Children.Add($v)
    [void]$g.Children.Add((Meter ([double]$r.pct) 116))
    [void]$p[1].Children.Add($g)
    if ($r.resets) { $t = Text $r.resets 11 $script:pal.soft; $t.Margin = '66,1,0,6'; [void]$p[1].Children.Add($t) }
  }
  $n = Text "Read at $($l.read), from $($l.from)" 10 $script:pal.soft; $n.Margin = '0,2,0,0'; [void]$p[1].Children.Add($n)
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
  if ($text.Trim().StartsWith('/')) { Show-Reply @{ title = 'Working...'; lines = @($text); tone = 'info' } } else { Show-Reply $null }
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('X-Circle', '1'); $wc.Headers.Add('Content-Type', 'application/json'); $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Add_UploadStringCompleted({
    param($s, $e)
    $s.Dispose()
    try {
      if ($e.Error) { Show-Reply @{ title = 'Circle Studio did not answer.'; lines = @('Is it running? Click any tile to start it.'); tone = 'danger' }; return }
      $r = $e.Result | ConvertFrom-Json
      if ($r.projectId) { $script:ovProject = [string]$r.projectId }
      Show-Reply $r.say ($r.command -eq 'bar' -and ([string]$e.UserState) -match '^/(help|\?)')
      if ($r.open) { Open-App ([string]$r.open) }
      if ($r.chatWindow) { Open-App ('chat:' + [string]$r.chatWindow) }
      if ($r.hide) { Hide-Overlay } else { Fetch-Overlay }
    } catch { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' overlay command: ' + $_.Exception.Message) }
  })
  $wc.UploadStringAsync([Uri]"$base/api/overlay/command", 'POST', (@{ text = $text; projectId = $script:ovProject; from = 'bar' } | ConvertTo-Json -Compress), $text)
}

# ---- the chat at the bottom -----------------------------------------------------------------------------------------
# A real chat with the project shown at the top: its conversation, the answer streaming in, and what you type goes to
# it, every word. A line starting with / is a command (/usage, /status, /allow 1, /help...). The first button says who
# answers (a click switches to the next ready tool); a line under it says the folder it works in and what it is doing.
# Previous chats takes up an earlier one, New chat starts again, Folder opens another folder, Open in editor shows the
# project and the file being worked on.
function TalkBtn([string]$label, [string]$tip, [scriptblock]$act) {
  $b = Btn $label 'quiet'; $b.Margin = '0,0,2,0'; $b.Padding = '8,3,8,3'; $b.MinHeight = 24; $b.ToolTip = $tip
  $b.Content.FontSize = 11
  $b.Add_Click($act)
  return $b
}

function New-CommandBar([double]$w) {
  $p = New-Panel 'Chat' $w
  $p[0].BorderBrush = Brush $script:pal.accent; $p[0].Padding = '18,12,18,16'; $p[0].Margin = '0'
  $sp = $p[1]
  $script:ovTalkHead = $sp.Children[0].Children[1] # the heading's words: "Chat  .  <project>  .  <engine>"
  # what you can do with the chat
  $bar = New-Object System.Windows.Controls.WrapPanel; $bar.Margin = '0,0,0,6'
  $eng = Btn 'Claude' 'plain'; $eng.Margin = '0,0,8,0'; $eng.Padding = '10,3,10,3'; $eng.MinHeight = 24; $eng.Content.FontSize = 11
  $eng.ToolTip = 'Who answers here. A click switches to the next AI tool that is ready (or type /engine codex).'
  $eng.Add_Click({ Send-Command '/engine next' })
  $script:ovEngBtn = $eng
  [void]$bar.Children.Add($eng)
  $prev = TalkBtn ('Previous chats  ' + [string][char]0x25BE) 'Every conversation in this folder: from the terminal, an IDE or here' { Toggle-Drop 'previous' }
  $script:ovPrevBtn = $prev
  [void]$bar.Children.Add($prev)
  [void]$bar.Children.Add((TalkBtn 'New chat' 'Start a new chat; the earlier ones stay under Previous chats' { Send-Command '/new' }))
  [void]$bar.Children.Add((TalkBtn 'Folder...' 'Choose another folder to work in' { Send-Command '/folder' }))
  [void]$bar.Children.Add((TalkBtn 'Terminal' 'Show the terminal (or editor) this chat runs in; if none is open, a new terminal carries it on' { Send-Command '/terminal' }))
  $ed = TalkBtn 'Open in editor' 'Open this project in Antigravity IDE, at the file the agent last worked on' { Open-Editor }
  $script:ovEditBtn = $ed
  [void]$bar.Children.Add($ed)
  [void]$sp.Children.Add($bar)
  # where it works, and what it is doing right now
  $where = Mono '' 11 $script:pal.soft; $where.TextTrimming = 'CharacterEllipsis'; $where.Margin = '2,0,0,8'
  $script:ovWhere = $where
  [void]$sp.Children.Add($where)
  # the conversation
  $script:ovTalk = VStack
  $tv = New-Object System.Windows.Controls.ScrollViewer; $tv.MaxHeight = 300; $tv.VerticalScrollBarVisibility = 'Auto'; $tv.Content = $script:ovTalk; $tv.Margin = '0,0,0,8'
  $script:ovTalkScroll = $tv
  [void]$sp.Children.Add($tv)
  # what the last command said
  $script:ovReply = VStack; $script:ovReply.Margin = '2,0,2,8'; $script:ovReply.Visibility = 'Collapsed'
  $sv = New-Object System.Windows.Controls.ScrollViewer; $sv.MaxHeight = 160; $sv.VerticalScrollBarVisibility = 'Auto'; $sv.Content = $script:ovReply
  $script:ovReplyScroll = $sv
  [void]$sp.Children.Add($sv)
  # the box, with its hint under the text while it is empty
  $g = New-Object System.Windows.Controls.Grid
  $in = New-Object System.Windows.Controls.TextBox
  $in.FontSize = 16; $in.Padding = '12,9,12,9'; $in.BorderThickness = 2; $in.FontFamily = $uiFont
  $in.Background = Brush $script:pal.sunken; $in.Foreground = Brush $script:pal.text; $in.BorderBrush = Brush $script:pal.accent; $in.CaretBrush = Brush $script:pal.text
  $in.SelectionBrush = Brush $script:pal.accent
  [System.Windows.Automation.AutomationProperties]::SetName($in, 'Message or command')
  $hint = Text 'Message Claude  (/ for commands, like /usage)' 14 $script:pal.soft; $hint.Margin = '16,0,0,0'; $hint.VerticalAlignment = 'Center'; $hint.IsHitTestVisible = $false
  $in.Tag = $hint
  $in.Add_TextChanged({ param($s, $e) $s.Tag.Visibility = $(if ($s.Text) { 'Collapsed' } else { 'Visible' }) })
  $in.Add_PreviewKeyDown({
    param($s, $e)
    if ($e.Key -eq 'Return') { $t = $s.Text; $s.Text = ''; Send-Command $t; $e.Handled = $true }
    elseif ($e.Key -eq 'Up' -and $script:ovHistory.Count) { $script:ovHi = [Math]::Max(0, $script:ovHi - 1); $s.Text = $script:ovHistory[$script:ovHi]; $s.CaretIndex = $s.Text.Length; $e.Handled = $true }
    elseif ($e.Key -eq 'Down' -and $script:ovHistory.Count) { $script:ovHi = [Math]::Min($script:ovHistory.Count, $script:ovHi + 1); $s.Text = $(if ($script:ovHi -lt $script:ovHistory.Count) { $script:ovHistory[$script:ovHi] } else { '' }); $s.CaretIndex = $s.Text.Length; $e.Handled = $true }
  })
  [void]$g.Children.Add($in); [void]$g.Children.Add($hint)
  $script:ovInput = $in
  $script:ovHint = $hint
  # Enter sends, and so does this button
  $row = New-Object System.Windows.Controls.DockPanel
  $go = Btn 'Send' 'primary'; $go.Margin = '8,0,0,0'; $go.MinHeight = 44; $go.Padding = '16,6,16,6'
  [System.Windows.Automation.AutomationProperties]::SetName($go, 'Send')
  $go.Add_Click({ $t = $script:ovInput.Text; $script:ovInput.Text = ''; Send-Command $t; $script:ovInput.Focus() })
  [System.Windows.Controls.DockPanel]::SetDock($go, 'Right'); [void]$row.Children.Add($go); [void]$row.Children.Add($g)
  [void]$sp.Children.Add($row)
  # no list of command words under the box: / shows what there is (/help)
  $script:ovExamples = $null
  return $p[0]
}

# The conversation in the box: whole messages in plain words, newest at the bottom, and the answer as it comes.
function Paint-Talk($f) {
  $t = $f.talk
  $eng = $(if ($t -and $t.engine) { (Get-Culture).TextInfo.ToTitleCase([string]$t.engine) } else { '' })
  if ($script:ovTalkHead) { $script:ovTalkHead.Text = $(if ($f.project) { "Chat  $([char]0x00B7)  $($f.project.name)$(if ($eng) { "  $([char]0x00B7)  $eng" })" } else { 'Chat' }) }
  $b = $f.bar
  if ($b) {
    $who = [string]$b.engineLabel; if ($b.model -and $b.engine -eq 'claude') { $who += " $([char]0x00B7) $($b.model)" }
    if ($script:ovEngBtn) { $script:ovEngBtn.Content.Text = "$who  $([char]0x25BE)" }
    if ($script:ovHint) { $script:ovHint.Text = "Message $($b.engineLabel)$(if ($f.project) { " in $($f.project.name)" })  (/ for commands, like /usage)" }
    if ($script:ovWhere) {
      $bits = @()
      if ($b.where) { $bits += "Working in $($b.where)" }
      if ($b.waiting) { $bits += "waiting for you" } elseif ($b.now) { $bits += "now: $($b.now)" }
      if ($b.lined) { $bits += "$($b.lined) message$(if ($b.lined -gt 1) { 's' }) to send next" }
      if ($f.limits -and @($f.limits.rows).Count) { $bits += ((@($f.limits.rows) | ForEach-Object { "$($_.label.ToLower()) $($_.value)" }) -join ', ') + ' used' }
      $script:ovWhere.Text = ($bits -join "  $([char]0x00B7)  ")
      $script:ovWhere.ToolTip = $script:ovWhere.Text
    }
  }
  $box = $script:ovTalk; $box.Children.Clear()
  if ($t -and $t.continueId) { $n = Wrap (Text 'Your newest conversation in this folder: writing carries it on.' 11 $script:pal.soft); $n.Margin = '0,0,0,6'; [void]$box.Children.Add($n) }
  elseif ($t -and $t.title) { $n = Wrap (Text $t.title 11 $script:pal.soft); $n.Margin = '0,0,0,6'; [void]$box.Children.Add($n) }
  $msgs = @($(if ($t) { $t.messages } else { @() }) | Where-Object { $_ })
  $wide = [Math]::Max(290, $script:ovCmdW - 110)
  foreach ($m in $msgs) { $bb = Bubble $m.who $m.text ([bool]$m.mine) 400; $bb.MaxWidth = $wide; [void]$box.Children.Add($bb) }
  $live = $f.live
  if ($live -and -not $live.done) {
    [void]$box.Children.Add((Bubble 'You' $live.you $true 120))
    $txt = $(if ($live.text) { [string]$live.text } else { [string][char]0x2026 })
    if ($txt.Length -gt 1500) { $txt = [string][char]0x2026 + $txt.Substring($txt.Length - 1500) }
    $bb = Bubble $live.to $txt $false 400; $bb.MaxWidth = $wide; [void]$box.Children.Add($bb)
    if ($live.error) { [void]$box.Children.Add((Wrap (Text $live.error 11 $script:pal.danger 'SemiBold'))) }
    else {
      $row = HStack; $row.Margin = '0,2,0,0'
      [void]$row.Children.Add((Text $(if ($b -and $b.waiting) { 'Waiting for you: answer on the card or above' } else { 'Answering...' }) 11 $script:pal.ok 'SemiBold'))
      $stop = TalkBtn 'Stop' 'Stop this answer' { Send-Command '/stop' }; $stop.Margin = '10,-3,0,0'
      [void]$row.Children.Add($stop)
      [void]$box.Children.Add($row)
    }
  } elseif ($live -and $live.error) { [void]$box.Children.Add((Wrap (Text $live.error 11 $script:pal.danger 'SemiBold'))) }
  if (-not $box.Children.Count) { [void]$box.Children.Add((Wrap (Text $(if ($f.project) { 'Nothing said yet. Ask for what you need below.' } else { 'No project yet: Folder... adds one.' }) 12 $script:pal.soft))) }
  $script:ovTalkScroll.ScrollToBottom()
  if ($script:ovEditBtn) { $script:ovEditBtn.Visibility = $(if ($f.editor) { 'Visible' } else { 'Collapsed' }); if ($f.editor) { $script:ovEditBtn.Content.Text = "Open in $($f.editor)" } }
}

function Open-Editor {
  if (-not $script:ovProject) { return }
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('X-Circle', '1'); $wc.Headers.Add('Content-Type', 'application/json'); $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Add_UploadStringCompleted({
    param($s, $e)
    $s.Dispose()
    try {
      $r = $e.Result | ConvertFrom-Json
      if ($r.opened) { Show-Reply @{ title = "Opened in $($r.editor)."; lines = @($(if ($r.file) { $r.file } else { 'The project folder.' })); tone = 'ok' } }
      else { Show-Reply @{ title = 'Could not open the editor.'; lines = @($r.why); tone = 'warn' } }
    } catch { Show-Reply @{ title = 'Could not open the editor.'; lines = @(); tone = 'warn' } }
  })
  $wc.UploadStringAsync([Uri]"$base/api/desktop/editor", 'POST', (@{ projectId = $script:ovProject } | ConvertTo-Json -Compress))
}

# Previous chats: the conversations in this folder, newest first; a click carries one on (continue <n>).
function New-PreviousMenu {
  $b = Card 380
  $sp = VStack
  $h = Text 'Previous chats' 13 '' 'SemiBold'; $h.Margin = '2,0,0,8'; [void]$sp.Children.Add($h)
  $list = VStack
  [void]$list.Children.Add((Text 'Reading them...' 12 $script:pal.soft))
  $sv = New-Object System.Windows.Controls.ScrollViewer; $sv.MaxHeight = 340; $sv.VerticalScrollBarVisibility = 'Auto'; $sv.Content = $list
  [void]$sp.Children.Add($sv)
  $b.Child = $sp
  $wc = New-Object System.Net.WebClient; $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Add_DownloadStringCompleted({
    param($s, $e)
    $s.Dispose()
    $l = $script:ovPrevList; if (-not $l) { return }
    $l.Children.Clear()
    try {
      $convs = @(($e.Result | ConvertFrom-Json).conversations | Where-Object { $_ } | Select-Object -First 15)
      if (-not $convs.Count) { [void]$l.Children.Add((Text 'No conversations here yet.' 12 $script:pal.soft)); return }
      $k = 0
      foreach ($c in $convs) {
        $k++
        $row = Btn '' 'quiet'; $row.Margin = '0,0,0,2'; $row.Padding = '8,6,8,6'; $row.HorizontalContentAlignment = 'Stretch'
        $dp = New-Object System.Windows.Controls.DockPanel
        $when = Text $(try { ([datetime]$c.lastAt).ToLocalTime().ToString('d MMM HH:mm') } catch { '' }) 11 $script:pal.soft; [System.Windows.Controls.DockPanel]::SetDock($when, 'Right'); [void]$dp.Children.Add($when)
        $tt = Text ([string]$c.title) 13; $tt.Margin = '0,0,10,0'; [void]$dp.Children.Add($tt)
        $row.Content = $dp; $row.Tag = "/continue $k"; $row.ToolTip = 'Carry this conversation on here; the original stays as it was'
        $row.Add_Click({ param($x, $y) Close-Drop; Send-Command ([string]$x.Tag) })
        [void]$l.Children.Add($row)
      }
    } catch { [void]$l.Children.Add((Text 'Could not read them.' 12 $script:pal.soft)) }
  })
  $script:ovPrevList = $list
  if ($script:ovProject) { $wc.DownloadStringAsync([Uri]"$base/api/projects/$([Uri]::EscapeDataString($script:ovProject))/history") }
  return $b
}

function Paint-Examples($list) {
  $ex = $script:ovExamples; if (-not $ex) { return }; $ex.Children.Clear()
  foreach ($x in @($list)) {
    $c = New-Object System.Windows.Controls.Border; $c.CornerRadius = 10; $c.Padding = '9,3,9,3'; $c.Margin = '0,0,6,6'; $c.BorderThickness = 1; $c.Cursor = 'Hand'
    $c.BorderBrush = Brush $script:pal.line; $c.Child = Mono ([string]$x) 11 $script:pal.soft; $c.Tag = [string]$x; $c.ToolTip = 'Put it in the box'
    $c.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; $t = [string]$s.Tag; $script:ovInput.Text = $(if ($t -match '<') { $t.Substring(0, $t.IndexOf('<')) } else { $t }); $script:ovInput.CaretIndex = $script:ovInput.Text.Length; $script:ovInput.Focus() })
    [void]$ex.Children.Add($c)
  }
}

# ---- the top bar: the project switcher, the Widgets menu, Reset layout, Close --------------------------------------
$script:DOT = [string][char]0x00B7

function Card([double]$w) {
  $b = New-Object System.Windows.Controls.Border
  $b.CornerRadius = 16; $b.Padding = '14,12,14,12'; $b.BorderThickness = 1; $b.Width = $w
  $b.Background = Brush $script:pal.raised; $b.BorderBrush = Brush $script:pal.lineStrong
  $fx = New-Object System.Windows.Media.Effects.DropShadowEffect; $fx.BlurRadius = 30; $fx.ShadowDepth = 6; $fx.Opacity = 0.5; $b.Effect = $fx
  return $b
}

function Pill([string]$t, [string]$hex) {
  $p = New-Object System.Windows.Controls.Border; $p.CornerRadius = 9; $p.Padding = '7,1,7,2'; $p.VerticalAlignment = 'Center'; $p.Background = Brush $hex
  $p.Child = Text $t 11 $script:pal.onAccent 'SemiBold'
  return $p
}

function New-TopBar {
  $b = New-Object System.Windows.Controls.Border
  $b.CornerRadius = 18; $b.Padding = '12,7,8,7'; $b.BorderThickness = 1
  $b.Background = Brush $script:pal.raised; $b.BorderBrush = Brush $script:pal.line
  $fx = New-Object System.Windows.Media.Effects.DropShadowEffect; $fx.BlurRadius = 24; $fx.ShadowDepth = 4; $fx.Opacity = 0.45; $b.Effect = $fx
  $row = HStack
  $mark = New-Object System.Windows.Shapes.Ellipse; $mark.Width = 14; $mark.Height = 14; $mark.StrokeThickness = 3; $mark.Stroke = Brush $script:pal.accent; $mark.VerticalAlignment = 'Center'; $mark.Margin = '0,0,8,0'
  [void]$row.Children.Add($mark)
  $name = Text 'Circle Studio' 13 '' 'SemiBold'; $name.VerticalAlignment = 'Center'; $name.Margin = '0,0,14,0'
  [void]$row.Children.Add($name)
  # the project shown: a click (or Ctrl+P) opens the switcher; Ctrl+Tab goes to the next project
  $chip = Btn '' 'plain'; $chip.Margin = '0'; $chip.Padding = '12,5,12,5'; $chip.MinWidth = 230; $chip.HorizontalContentAlignment = 'Left'
  $chip.ToolTip = 'Switch project (Ctrl+P). Ctrl+Tab shows the next one.'
  [System.Windows.Automation.AutomationProperties]::SetName($chip, 'Switch project')
  $chip.Add_Click({ Toggle-Drop 'switcher' })
  $script:ovChip = $chip
  [void]$row.Children.Add($chip)
  $wb = Btn ('Widgets  ' + [string][char]0x25BE) 'quiet'; $wb.Margin = '10,0,0,0'; $wb.ToolTip = 'Show or hide panels'
  $wb.Add_Click({ Toggle-Drop 'widgets' })
  $script:ovWidgetsBtn = $wb
  [void]$row.Children.Add($wb)
  $rb = Btn 'Reset layout' 'quiet'; $rb.Margin = '2,0,0,0'; $rb.ToolTip = 'Every panel back in its column, and shown'
  $rb.Add_Click({ Reset-Layout })
  [void]$row.Children.Add($rb)
  $sep = New-Object System.Windows.Controls.Border; $sep.Width = 1; $sep.Margin = '6,4,6,4'; $sep.Background = Brush $script:pal.line
  [void]$row.Children.Add($sep)
  $cb = Btn ([string][char]0x2715) 'quiet'; $cb.Margin = '0'; $cb.Padding = '10,6,10,6'; $cb.ToolTip = "Close (Esc or $($script:HOTKEY_WORDS))"
  [System.Windows.Automation.AutomationProperties]::SetName($cb, 'Close')
  $cb.Add_Click({ Hide-Overlay })
  [void]$row.Children.Add($cb)
  $b.Child = $row
  # always centred at the top, whatever its width
  $b.Add_SizeChanged({ param($s, $e) [System.Windows.Controls.Canvas]::SetLeft($s, [Math]::Max(8, ($script:ovCanvas.Width - $s.ActualWidth) / 2)) })
  return $b
}

# The chip in the top bar: the project shown, what it is doing, and how many other projects need you.
function Paint-Chip($f) {
  $sp = HStack
  $list = @($f.projects | Where-Object { $_ })
  $cur = $list | Where-Object { $_.current } | Select-Object -First 1
  if ($f.project) {
    $d = Dot $(if ($cur) { [string]$cur.state } else { 'idle' }); $d.Width = 10; $d.Height = 10; $d.Margin = '0,0,10,0'
    [void]$sp.Children.Add($d)
    $col = VStack
    $n = Text $f.project.name 14 '' 'SemiBold'; $n.MaxWidth = 240; [void]$col.Children.Add($n)
    if ($cur) { [void]$col.Children.Add((Text $cur.word 11 $(if ($cur.state -eq 'waiting') { $script:pal.warn } else { $script:pal.soft }))) }
    [void]$sp.Children.Add($col)
  } else { [void]$sp.Children.Add((Text 'No project yet' 13 $script:pal.soft 'SemiBold')) }
  $others = @($list | Where-Object { -not $_.current -and $_.waiting -gt 0 }).Count
  if ($others) { $pill = Pill "$others more need$(if ($others -eq 1) { 's' }) you" $script:pal.warn; $pill.Margin = '12,0,0,0'; [void]$sp.Children.Add($pill) }
  $caret = Glyph 0x25BE 12 $script:pal.soft; $caret.Margin = '12,0,0,0'
  [void]$sp.Children.Add($caret)
  $script:ovChip.Content = $sp
}

# A drop-down card under the top bar (the switcher or the Widgets menu), drawn inside the overlay itself, so it never
# fights the overlay for the keyboard. A click anywhere else or Esc closes it.
function Drop-Anchor([string]$which) { switch ($which) { 'switcher' { return $script:ovChip } 'previous' { return $script:ovPrevBtn } default { return $script:ovWidgetsBtn } } }

function Close-Drop {
  if (-not $script:ovDrop) { return }
  $script:ovCanvas.Children.Remove($script:ovDrop.el)
  $script:ovDrop = $null
}

function Toggle-Drop([string]$which) {
  $was = $(if ($script:ovDrop) { $script:ovDrop.which } else { '' })
  Close-Drop
  if ($was -eq $which) { [void]$script:ovInput.Focus(); return }
  $el = $(switch ($which) { 'switcher' { New-Switcher } 'previous' { New-PreviousMenu } default { New-WidgetsMenu } })
  $anchor = Drop-Anchor $which
  $pt = $anchor.TranslatePoint((New-Object System.Windows.Point(0, ($anchor.ActualHeight + 12))), $script:ovCanvas)
  [System.Windows.Controls.Canvas]::SetLeft($el, (Clamp ($pt.X - 14) 8 ($script:ovCanvas.Width - $el.Width - 8)))
  if ($which -eq 'previous') {
    # above the chat box, which sits at the bottom
    $top = $anchor.TranslatePoint((New-Object System.Windows.Point(0, 0)), $script:ovCanvas)
    $el.Measure((New-Object System.Windows.Size([double]::PositiveInfinity, [double]::PositiveInfinity)))
    [System.Windows.Controls.Canvas]::SetTop($el, [Math]::Max(8, $top.Y - 8 - [Math]::Max(140, $el.DesiredSize.Height)))
  } else { [System.Windows.Controls.Canvas]::SetTop($el, $pt.Y) }
  [System.Windows.Controls.Panel]::SetZIndex($el, 100000)
  [void]$script:ovCanvas.Children.Add($el)
  $script:ovDrop = @{ which = $which; el = $el }
  if ($which -eq 'switcher') { [void]$script:swSearch.Focus(); [void][System.Windows.Input.Keyboard]::Focus($script:swSearch) }
}

function New-Switcher {
  $b = Card 452
  $b.BorderBrush = Brush $script:pal.accent
  $sp = VStack
  $head = New-Object System.Windows.Controls.DockPanel; $head.Margin = '2,0,2,10'
  $keys = Text "Ctrl+Tab next  $($script:DOT)  Ctrl+Shift+Tab back" 10 $script:pal.soft; $keys.VerticalAlignment = 'Center'
  [System.Windows.Controls.DockPanel]::SetDock($keys, 'Right'); [void]$head.Children.Add($keys)
  [void]$head.Children.Add((Text 'Switch project' 13 '' 'SemiBold'))
  [void]$sp.Children.Add($head)
  # find by name
  $g = New-Object System.Windows.Controls.Grid; $g.Margin = '0,0,0,12'
  $in = New-Object System.Windows.Controls.TextBox
  $in.FontSize = 14; $in.Padding = '10,7,10,7'; $in.BorderThickness = 1; $in.FontFamily = $uiFont
  $in.Background = Brush $script:pal.sunken; $in.Foreground = Brush $script:pal.text; $in.BorderBrush = Brush $script:pal.lineStrong; $in.CaretBrush = Brush $script:pal.text; $in.SelectionBrush = Brush $script:pal.accent
  [System.Windows.Automation.AutomationProperties]::SetName($in, 'Find a project')
  $hint = Text 'Find a project' 14 $script:pal.soft; $hint.Margin = '13,0,0,0'; $hint.VerticalAlignment = 'Center'; $hint.IsHitTestVisible = $false
  $in.Tag = $hint
  $in.Add_TextChanged({ param($s, $e) $s.Tag.Visibility = $(if ($s.Text) { 'Collapsed' } else { 'Visible' }); Fill-Switcher $s.Text })
  $in.Add_PreviewKeyDown({
    param($s, $e)
    if ($e.Key -eq 'Return') { if ($script:swFirst) { Pick-Project ([string]$script:swFirst.Tag) }; $e.Handled = $true }
    elseif ($e.Key -eq 'Down' -and $script:swFirst) { [void]$script:swFirst.Focus(); $e.Handled = $true }
  })
  [void]$g.Children.Add($in); [void]$g.Children.Add($hint)
  $script:swSearch = $in
  [void]$sp.Children.Add($g)
  # the projects, two to a row; the arrow keys move between them
  $wp = New-Object System.Windows.Controls.WrapPanel
  [System.Windows.Input.KeyboardNavigation]::SetDirectionalNavigation($wp, 'Cycle')
  $script:swGrid = $wp
  $sv = New-Object System.Windows.Controls.ScrollViewer; $sv.MaxHeight = 380; $sv.VerticalScrollBarVisibility = 'Auto'; $sv.Content = $wp
  [void]$sp.Children.Add($sv)
  $foot = Text "Enter shows the first match  $($script:DOT)  arrows move  $($script:DOT)  Esc closes" 10 $script:pal.soft; $foot.Margin = '2,4,0,0'
  [void]$sp.Children.Add($foot)
  $b.Child = $sp
  Fill-Switcher ''
  return $b
}

function Fill-Switcher([string]$q) {
  $wp = $script:swGrid; $wp.Children.Clear()
  $script:swFirst = $null
  $q = $q.Trim()
  $list = @($script:ovFeed.projects | Where-Object { $_ -and (-not $q -or ([string]$_.name).IndexOf($q, [StringComparison]::OrdinalIgnoreCase) -ge 0) })
  foreach ($x in $list) {
    $on = [bool]$x.current
    $card = Btn '' 'plain'; $card.Width = 204; $card.Margin = '0,0,8,8'; $card.Padding = '12,9,10,10'; $card.HorizontalContentAlignment = 'Stretch'
    $card.Background = $(if ($on) { Brush $script:pal.accent '2E' } else { Brush $script:pal.sunken })
    $card.BorderBrush = Brush $(if ($on) { $script:pal.accent } elseif ($x.state -eq 'waiting') { $script:pal.warn } else { $script:pal.line })
    $card.BorderThickness = $(if ($on) { 2 } else { 1 })
    $dp = New-Object System.Windows.Controls.DockPanel
    if ($x.waiting -gt 0) {
      $pill = Pill ([string]$x.waiting) $script:pal.warn; $pill.VerticalAlignment = 'Top'; $pill.ToolTip = 'Waiting for you'
      [System.Windows.Controls.DockPanel]::SetDock($pill, 'Right'); [void]$dp.Children.Add($pill)
    } elseif ($on) {
      $tick = Glyph 0x2713 13 $script:pal.accent; $tick.VerticalAlignment = 'Top'; $tick.ToolTip = 'Shown now'
      [System.Windows.Controls.DockPanel]::SetDock($tick, 'Right'); [void]$dp.Children.Add($tick)
    }
    $col = VStack
    $top = HStack
    $d = Dot ([string]$x.state); $d.Width = 9; $d.Height = 9
    [void]$top.Children.Add($d)
    $n = Text $x.name 13 '' 'SemiBold'; $n.MaxWidth = 140; [void]$top.Children.Add($n)
    [void]$col.Children.Add($top)
    $wd = Text $(if ($on) { "Shown now  $($script:DOT)  $($x.word)" } else { [string]$x.word }) 11 $(if ($x.state -eq 'waiting') { $script:pal.warn } elseif ($x.state -eq 'working') { $script:pal.ok } else { $script:pal.soft })
    $wd.Margin = '17,3,0,0'; $wd.MaxWidth = 160
    [void]$col.Children.Add($wd)
    [void]$dp.Children.Add($col)
    $card.Content = $dp
    $card.Tag = [string]$x.id
    [System.Windows.Automation.AutomationProperties]::SetName($card, "$($x.name), $($x.word)")
    $card.Add_Click({ param($s, $e) Pick-Project ([string]$s.Tag) })
    [void]$wp.Children.Add($card)
    if (-not $script:swFirst) { $script:swFirst = $card }
  }
  if (-not $list.Count) { $t = Text $(if ($q) { 'No project matches.' } else { 'No project yet. Add a folder on Home.' }) 12 $script:pal.soft; $t.Margin = '2,0,0,8'; [void]$wp.Children.Add($t) }
}

function Pick-Project([string]$id) {
  Close-Drop
  if ($id -and $id -ne $script:ovProject) {
    $script:ovProject = $id
    # the chip changes at once; the panels follow with the next answer
    foreach ($x in @($script:ovFeed.projects | Where-Object { $_ })) { $x.current = ($x.id -eq $id); if ($x.current) { $script:ovFeed.project = [pscustomobject]@{ id = $x.id; name = $x.name } } }
    Paint-Chip $script:ovFeed
    $script:ovSig = @{ examples = '1' }
    Fetch-Overlay
  }
  [void]$script:ovInput.Focus()
}

function Step-Project([int]$d) {
  $list = @($script:ovFeed.projects | Where-Object { $_ })
  if ($list.Count -lt 2) { return }
  $i = 0
  for ($k = 0; $k -lt $list.Count; $k++) { if ($list[$k].id -eq $script:ovProject) { $i = $k } }
  Pick-Project ([string]$list[($i + $d + $list.Count) % $list.Count].id)
}

function New-WidgetsMenu {
  $b = Card 272
  $sp = VStack
  $h = Text 'Show on the overlay' 13 '' 'SemiBold'; $h.Margin = '2,0,0,8'; [void]$sp.Children.Add($h)
  foreach ($name in @($script:PANELS.Keys)) {
    if ($name -eq 'command') { continue } # the box is always there
    $shown = @($saved.overlay.hidden) -notcontains $name
    $row = Btn '' 'quiet'; $row.Margin = '0,0,0,2'; $row.Padding = '8,6,8,6'; $row.HorizontalContentAlignment = 'Stretch'
    $dp = New-Object System.Windows.Controls.DockPanel
    $box = New-Object System.Windows.Controls.Border; $box.Width = 18; $box.Height = 18; $box.CornerRadius = 5; $box.BorderThickness = 2; $box.Margin = '0,0,10,0'
    $box.BorderBrush = Brush $(if ($shown) { $script:pal.accent } else { $script:pal.lineStrong })
    $box.Background = $(if ($shown) { Brush $script:pal.accent } else { [System.Windows.Media.Brushes]::Transparent })
    if ($shown) { $t = Glyph 0x2713 11 $script:pal.onAccent; $t.HorizontalAlignment = 'Center'; $box.Child = $t }
    [System.Windows.Controls.DockPanel]::SetDock($box, 'Left'); [void]$dp.Children.Add($box)
    [void]$dp.Children.Add((Text $script:PANELS[$name] 13 $(if ($shown) { $script:pal.text } else { $script:pal.soft })))
    $row.Content = $dp; $row.Tag = $name
    [System.Windows.Automation.AutomationProperties]::SetName($row, "$($script:PANELS[$name]), $(if ($shown) { 'shown' } else { 'hidden' })")
    $row.Add_Click({ param($s, $e) $n = [string]$s.Tag; Set-Hidden $n (@($saved.overlay.hidden) -notcontains $n); Close-Drop; Toggle-Drop 'widgets' }) # drawn again, still open
    [void]$sp.Children.Add($row)
  }
  # more widgets to add, as the server offers them; a tick when added
  $offered = @($script:ovFeed.extrasOffered | Where-Object { $_ })
  if ($offered.Count) {
    $h2 = Text 'Add more' 13 '' 'SemiBold'; $h2.Margin = '2,10,0,6'; [void]$sp.Children.Add($h2)
    foreach ($x in $offered) {
      $added = @($saved.overlay.extra) -contains [string]$x.kind
      $row = Btn '' 'quiet'; $row.Margin = '0,0,0,2'; $row.Padding = '8,6,8,6'; $row.HorizontalContentAlignment = 'Stretch'
      $dp = New-Object System.Windows.Controls.DockPanel
      $ic = Glyph $(if ($added) { 0x2713 } else { 0x002B }) 13 $(if ($added) { $script:pal.accent } else { $script:pal.soft }); $ic.Width = 18; $ic.Margin = '0,0,10,0'; $ic.TextAlignment = 'Center'
      [System.Windows.Controls.DockPanel]::SetDock($ic, 'Left'); [void]$dp.Children.Add($ic)
      $st = Text $(if ($added) { 'Remove' } else { 'Add' }) 11 $script:pal.soft; [System.Windows.Controls.DockPanel]::SetDock($st, 'Right'); [void]$dp.Children.Add($st)
      [void]$dp.Children.Add((Text $x.label 13 $(if ($added) { $script:pal.text } else { $script:pal.soft })))
      $row.Content = $dp; $row.Tag = [string]$x.kind
      [System.Windows.Automation.AutomationProperties]::SetName($row, "$($x.label), $(if ($added) { 'added, click to remove' } else { 'click to add' })")
      $row.Add_Click({ param($s, $e) Set-Extra ([string]$s.Tag) (@($saved.overlay.extra) -notcontains [string]$s.Tag); Close-Drop; Toggle-Drop 'widgets' })
      [void]$sp.Children.Add($row)
    }
  }
  $foot = Text 'Drag any panel by its heading to move it.' 10 $script:pal.soft; $foot.Margin = '2,8,0,0'; $foot.TextWrapping = 'Wrap'
  [void]$sp.Children.Add($foot)
  $b.Child = $sp
  return $b
}

function Set-Hidden([string]$name, [bool]$hide) {
  $rest = @(@($saved.overlay.hidden) | Where-Object { $_ -and $_ -ne $name })
  # kept as a list even with one in it (a $(...) would unroll it)
  if ($hide) { $saved.overlay.hidden = [object[]]@($rest + $name) } else { $saved.overlay.hidden = [object[]]$rest }
  Save-State
  if ($script:ovSlots[$name]) { $script:ovSlots[$name].Visibility = $(if ($hide) { 'Collapsed' } else { 'Visible' }) }
}

# Add or remove one of the extra widgets; it is drawn with the next answer from Circle Studio (asked for at once).
function Set-Extra([string]$kind, [bool]$add) {
  $rest = @(@($saved.overlay.extra) | Where-Object { $_ -and $_ -ne $kind })
  # kept as a list even with one in it (a $(...) would unroll it)
  if ($add) { $saved.overlay.extra = [object[]]@($rest + $kind) } else { $saved.overlay.extra = [object[]]$rest }
  if (-not $add) { Drop-Slot ('x:' + $kind) }
  Save-State
  Fetch-Overlay
}

function Drop-Slot([string]$name) {
  $s = $script:ovSlots[$name]
  if (-not $s) { return }
  if ($s.Parent) { [void]$s.Parent.Children.Remove($s) }
  $script:ovSlots.Remove($name); $script:ovSig.Remove($name)
  $saved.overlay.places.Remove($name)
}

# An extra widget: the desktop tile's content in a panel card (its project follows the overlay's switcher).
function New-ExtraPanel($t) {
  $b = New-Object System.Windows.Controls.Border
  $b.CornerRadius = 16; $b.Padding = '16,12,16,14'; $b.BorderThickness = 1; $b.Width = 348; $b.MaxHeight = 420
  $b.Background = Brush $script:pal.raised; $b.BorderBrush = Brush $script:pal.line
  $fx = New-Object System.Windows.Media.Effects.DropShadowEffect; $fx.BlurRadius = 24; $fx.ShadowDepth = 4; $fx.Opacity = 0.45; $b.Effect = $fx
  $b.ClipToBounds = $true
  $b.Child = Build-Tile $t $true
  return $b
}

function Reset-Layout {
  $saved.overlay = @{ places = @{}; hidden = @(); extra = @($saved.overlay.extra) } # added widgets stay, back in their row
  Save-State
  Close-Drop
  Lay-Out
  Show-Reply @{ title = 'Layout reset.'; lines = @('Every panel is back in its column.'); tone = 'ok' }
  [void]$script:ovInput.Focus()
}

# ---- placing and dragging the panels -------------------------------------------------------------------------------
# Each panel sits in its column until it is dragged; from then on it has a place of its own (kept). A press on a button,
# a box, a scroll bar or anything clickable is left to it: a drag starts only from the rest, after 5 pixels of movement,
# so clicks still work. While dragging, the overlay's canvas holds the mouse, so a fast move never drops the panel.
function Is-Control($src, $stop) {
  $n = $src
  while ($n -and $n -ne $stop) {
    if ($n -is [System.Windows.Controls.Primitives.ButtonBase] -or $n -is [System.Windows.Controls.Primitives.TextBoxBase] -or $n -is [System.Windows.Controls.Primitives.ScrollBar]) { return $true }
    if ($n -is [System.Windows.FrameworkElement] -and $n.Cursor -eq [System.Windows.Input.Cursors]::Hand) { return $true }
    $n = $(if ($n -is [System.Windows.Media.Visual]) { [System.Windows.Media.VisualTreeHelper]::GetParent($n) } else { [System.Windows.LogicalTreeHelper]::GetParent($n) })
  }
  return $false
}

function Is-Inside($src, $el) {
  $n = $src
  while ($n) {
    if ($n -eq $el) { return $true }
    $n = $(if ($n -is [System.Windows.Media.Visual]) { [System.Windows.Media.VisualTreeHelper]::GetParent($n) } else { [System.Windows.LogicalTreeHelper]::GetParent($n) })
  }
  return $false
}

function Clamp([double]$v, [double]$lo, [double]$hi) { return [Math]::Max($lo, [Math]::Min($v, [Math]::Max($lo, $hi))) }

function New-Slot([string]$name) {
  $c = New-Object System.Windows.Controls.ContentControl; $c.Focusable = $false; $c.Tag = $name; $c.Margin = '0,0,0,12'
  $script:ovSlots[$name] = $c
  $c.Add_PreviewMouseLeftButtonDown({
    param($s, $e)
    $script:drag = $null
    if (Is-Control $e.OriginalSource $s) { return }
    $script:drag = @{ el = $s; at = $e.GetPosition($script:ovCanvas); on = $false }
  })
  $c.Add_PreviewMouseMove({
    param($s, $e)
    $d = $script:drag
    if (-not $d -or $d.on -or $d.el -ne $s) { return }
    if ($e.LeftButton -ne 'Pressed') { $script:drag = $null; return }
    $p = $e.GetPosition($script:ovCanvas)
    if ([Math]::Abs($p.X - $d.at.X) + [Math]::Abs($p.Y - $d.at.Y) -lt 5) { return }
    Begin-Drag $s
  })
}

function Begin-Drag($s) {
  $c = $script:ovCanvas
  $tl = $s.TranslatePoint((New-Object System.Windows.Point(0, 0)), $c)
  if ($s.Parent -ne $c) { [void]$s.Parent.Children.Remove($s); [void]$c.Children.Add($s) }
  [System.Windows.Controls.Canvas]::SetBottom($s, [double]::NaN)
  [System.Windows.Controls.Canvas]::SetLeft($s, $tl.X); [System.Windows.Controls.Canvas]::SetTop($s, $tl.Y)
  $script:ovZ++; [System.Windows.Controls.Panel]::SetZIndex($s, $script:ovZ)
  $s.Opacity = 0.92
  $script:drag.on = $true; $script:drag.x = $tl.X; $script:drag.y = $tl.Y
  [void]$c.CaptureMouse()
}

function Move-Drag($p) {
  $d = $script:drag
  if (-not $d -or -not $d.on) { return }
  $c = $script:ovCanvas; $el = $d.el
  [System.Windows.Controls.Canvas]::SetLeft($el, (Clamp ($d.x + $p.X - $d.at.X) 0 ($c.Width - $el.ActualWidth)))
  [System.Windows.Controls.Canvas]::SetTop($el, (Clamp ($d.y + $p.Y - $d.at.Y) 0 ($c.Height - 48)))
}

function End-Drag {
  $d = $script:drag
  $script:drag = $null
  if (-not $d -or -not $d.on) { return }
  $d.el.Opacity = 1
  if ($script:ovCanvas.IsMouseCaptured) { $script:ovCanvas.ReleaseMouseCapture() }
  $saved.overlay.places[[string]$d.el.Tag] = @{ x = [Math]::Round([System.Windows.Controls.Canvas]::GetLeft($d.el), 1); y = [Math]::Round([System.Windows.Controls.Canvas]::GetTop($d.el), 1) }
  Save-State
}

# Every panel to its kept place, or back into its column (in the column's order); the command box at the bottom middle.
function Lay-Out { foreach ($name in @(@($script:PANELS.Keys) + @(@($saved.overlay.extra) | ForEach-Object { 'x:' + $_ }))) { Place-Slot $name } }

# One panel to its kept place, or back into its column (extra widgets: the middle row).
function Place-Slot([string]$name) {
  $c = $script:ovCanvas
  $s = $script:ovSlots[$name]
  if ($s) {
    if ($s.Parent) { [void]$s.Parent.Children.Remove($s) }
    [System.Windows.Controls.Canvas]::SetBottom($s, [double]::NaN); [System.Windows.Controls.Canvas]::SetTop($s, [double]::NaN)
    $pos = $saved.overlay.places[$name]
    if ($pos) {
      [void]$c.Children.Add($s)
      [System.Windows.Controls.Canvas]::SetLeft($s, (Clamp $pos.x 0 ($c.Width - 120))); [System.Windows.Controls.Canvas]::SetTop($s, (Clamp $pos.y 0 ($c.Height - 48)))
    } elseif ($name -eq 'command') {
      [void]$c.Children.Add($s)
      [System.Windows.Controls.Canvas]::SetLeft($s, ($c.Width - $script:ovCmdW) / 2); [System.Windows.Controls.Canvas]::SetBottom($s, 12)
    } elseif ($name -like 'x:*') { [void]$script:ovCols['extra'].Children.Add($s) }
    else { [void]$script:ovCols[$script:COLUMN[$name]].Children.Add($s) }
    $s.Visibility = $(if (@($saved.overlay.hidden) -contains $name) { 'Collapsed' } else { 'Visible' })
  }
}

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
  # a click on the dimmed screen itself (not on a panel) closes the open drop-down, or else the overlay
  $root.Add_MouseLeftButtonDown({ param($s, $e) if ($e.OriginalSource -eq $s -or $e.OriginalSource -eq $script:ovCanvas) { if ($script:ovDrop) { Close-Drop; [void]$script:ovInput.Focus() } else { Hide-Overlay } } })
  # a press on a panel outside the open drop-down (and its button) closes the drop-down too
  $root.Add_PreviewMouseLeftButtonDown({
    param($s, $e)
    $d = $script:ovDrop
    if (-not $d) { return }
    $anchor = Drop-Anchor $d.which
    if ($e.OriginalSource -ne $s -and $e.OriginalSource -ne $script:ovCanvas -and -not (Is-Inside $e.OriginalSource $d.el) -and -not (Is-Inside $e.OriginalSource $anchor)) { Close-Drop }
  })
  $c = New-Object System.Windows.Controls.Canvas
  $c.Background = [System.Windows.Media.Brushes]::Transparent
  $c.HorizontalAlignment = 'Left'; $c.VerticalAlignment = 'Top'
  $c.Margin = New-Object System.Windows.Thickness(($area.Left - $vs[0]), ($area.Top - $vs[1]), 0, 0)
  $c.Width = $area.Width; $c.Height = $area.Height
  $c.Add_MouseMove({ param($s, $e) Move-Drag ($e.GetPosition($s)) })
  $c.Add_MouseLeftButtonUp({ param($s, $e) End-Drag })
  $c.Add_LostMouseCapture({ param($s, $e) End-Drag })
  $script:ovCanvas = $c
  [void]$root.Children.Add($c)

  $script:ovSlots = @{}
  foreach ($name in @($script:PANELS.Keys)) { New-Slot $name }
  # the columns start below the top bar when the screen is too narrow for the three side by side
  $top = $(if ($area.Width -lt 1320) { 76 } else { 16 })
  $script:ovCols = @{}
  foreach ($col in @(@('left', 24, 340), @('right', ($area.Width - 24 - 280), 280))) {
    $st = VStack; $script:ovCols[$col[0]] = $st
    $sv = New-Object System.Windows.Controls.ScrollViewer; $sv.VerticalScrollBarVisibility = 'Auto'; $sv.MaxHeight = $area.Height - $top - 12; $sv.Content = $st; $sv.Focusable = $false
    [void]$c.Children.Add($sv); [System.Windows.Controls.Canvas]::SetLeft($sv, $col[1]); [System.Windows.Controls.Canvas]::SetTop($sv, $top)
  }
  # the middle row for added widgets: between the columns, under the top bar, above the command box
  $mid = New-Object System.Windows.Controls.WrapPanel; $mid.Width = [Math]::Max(372, $area.Width - 2 * 24 - 340 - 280 - 2 * 24)
  $script:ovCols['extra'] = $mid
  # (one across on a small screen, more on a wide one; it scrolls rather than run into the command box)
  $msv = New-Object System.Windows.Controls.ScrollViewer; $msv.VerticalScrollBarVisibility = 'Auto'; $msv.Focusable = $false; $msv.Content = $mid
  $msv.MaxHeight = [Math]::Max(200, $area.Height - 80 - 230)
  [void]$c.Children.Add($msv); [System.Windows.Controls.Canvas]::SetLeft($msv, 24 + 340 + 24); [System.Windows.Controls.Canvas]::SetTop($msv, 80)
  $script:ovCmdW = [Math]::Max(440, [Math]::Min(680, $area.Width - 2 * 392))
  $script:ovSlots['command'].Content = New-CommandBar $script:ovCmdW
  $script:ovSlots['command'].Margin = '0'
  $bar = New-TopBar
  [void]$c.Children.Add($bar); [System.Windows.Controls.Canvas]::SetTop($bar, 14); [System.Windows.Controls.Panel]::SetZIndex($bar, 50000)
  $script:ovDrop = $null
  Lay-Out

  $w.Content = $root
  $w.Add_PreviewKeyDown({
    param($s, $e)
    $mods = [int][System.Windows.Input.Keyboard]::Modifiers
    $ctrl = ($mods -band 2) -ne 0
    if ($e.Key -eq 'Escape') { if ($script:ovDrop) { Close-Drop; [void]$script:ovInput.Focus() } else { Hide-Overlay }; $e.Handled = $true }
    elseif ($ctrl -and $e.Key -eq 'Tab') { Step-Project $(if (($mods -band 4) -ne 0) { -1 } else { 1 }); $e.Handled = $true }
    elseif ($ctrl -and $e.Key -eq 'P') { Toggle-Drop 'switcher'; $e.Handled = $true }
  })
  $w.Add_SourceInitialized({ param($sender, $e) [CsDesk]::Tool((Hwnd $sender)) })
  $script:ovSig = @{}
  return $w
}

# Paint the slots whose content changed (the clock and the PC numbers change every time; the rest only when they do).
function Paint-Overlay($f) {
  $script:ovFeed = $f
  if ($f.palette) { $script:pal = @{}; foreach ($p in $f.palette.PSObject.Properties) { $script:pal[$p.Name] = $p.Value } }
  if ($f.project) { $script:ovProject = [string]$f.project.id }
  $chipSig = ConvertTo-Json -InputObject @{ v = @($f.projects, $f.project) } -Depth 6 -Compress
  if ($script:ovSig['chip'] -ne $chipSig) { $script:ovSig['chip'] = $chipSig; Paint-Chip $f }
  $parts = @{
    waiting = @{ v = $f.waiting; draw = { Paint-Waiting $f.waiting } }
    running = @{ v = $f.running; draw = { Paint-Running $f.running } }
    workflow = @{ v = @($f.workflow, $f.project); draw = { Paint-Workflow $f.workflow $f.project } }
    pc = @{ v = @($f.pc, (Get-Date).ToString('t')); draw = { Paint-PC $f.pc } }
    usage = @{ v = $f.usage; draw = { Paint-Usage $f.usage } }
    limits = @{ v = $f.limits; draw = { Paint-Limits $f.limits } }
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
  $talkSig = ConvertTo-Json -InputObject @{ v = @($f.talk, $f.live, $f.project, $f.editor, $f.bar, $f.limits) } -Depth 8 -Compress
  if ($script:ovSig['talk'] -ne $talkSig) { $script:ovSig['talk'] = $talkSig; try { Paint-Talk $f } catch { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' overlay talk: ' + $_.Exception.Message + ' ' + $_.InvocationInfo.PositionMessage) } }
  # the added widgets, in the order they were added
  $want = @($saved.overlay.extra)
  foreach ($t in @($f.extras | Where-Object { $_ -and $want -contains [string]$_.kind })) {
    $k = 'x:' + [string]$t.kind
    if (-not $script:ovSlots.ContainsKey($k)) { New-Slot $k; $script:ovSlots[$k].Margin = '0,0,16,16'; Place-Slot $k }
    $sig = ConvertTo-Json -InputObject @{ v = $t } -Depth 8 -Compress
    if ($script:ovSig[$k] -eq $sig) { continue }
    $script:ovSig[$k] = $sig
    try { $script:ovSlots[$k].Content = New-ExtraPanel $t } catch { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + " overlay $k`: " + $_.Exception.Message + ' ' + $_.InvocationInfo.PositionMessage) }
  }
  foreach ($k in @($script:ovSlots.Keys | Where-Object { $_ -like 'x:*' })) { if ($want -notcontains $k.Substring(2)) { Drop-Slot $k } }
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
  $q = "theme=$(Theme)$(if ($script:ovProject) { '&projectId=' + [Uri]::EscapeDataString($script:ovProject) })$(if (@($saved.overlay.extra).Count) { '&extra=' + [Uri]::EscapeDataString((@($saved.overlay.extra) -join ',')) })"
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
  # the desktop tiles stay where they are, under the dim. A card that asks (Allow, the answers) stays on top, to answer
  # right there; an answer's notification waits until the overlay closes (the bar shows the answer already).
  foreach ($k in @($script:asks.Keys)) { $w = $script:asks[$k]; if ($k -like 'r:*') { $w.Hide() } else { $w.Topmost = $false; $w.Topmost = $true } }
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
  $script:drag = $null; $script:ovDrop = $null
  if ($script:ov) { $script:ov.Close(); $script:ov = $null }
  foreach ($w in $script:asks.Values) { $w.Show() }
  if ($script:asks.Count) { Place-Asks }
}

function Toggle-Overlay { if ($script:ovUp) { Hide-Overlay } else { Show-Overlay } }
