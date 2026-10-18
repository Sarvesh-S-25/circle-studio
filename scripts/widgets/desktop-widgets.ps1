# Circle Studio desktop widgets: each tile of the widget board as a borderless, rounded window that lives on the
# desktop (owned by the desktop window, so it stays put and survives Win+D, with no taskbar button). Drag a tile to move
# it (the place is remembered), click it to open Circle Studio there, right-click for options.
# Everything it shows comes from http://127.0.0.1:<Port>/api/widgets/feed, which also carries the colours of tokens.css.
# Started by Circle Studio (Settings, Desktop, or the widget board); one per Windows user.
param([int]$Port = 4380, [string]$DataDir = '')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\CircleStudioDesktopWidgets', [ref]$created)
if (-not $created) { exit 0 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CsDesk {
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetLongPtr(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongW")] static extern int SetLong(IntPtr h, int i, int v);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetLong(IntPtr h, int i);
  static void Set(IntPtr h, int i, IntPtr v) { if (IntPtr.Size == 8) SetLongPtr(h, i, v); else SetLong(h, i, v.ToInt32()); }
  // Owned by the desktop (Progman): stays on the desktop layer and is not hidden by Win+D.
  public static void OnDesktop(IntPtr h) { Set(h, -8, FindWindow("Progman", null)); }
  public static void Free(IntPtr h) { Set(h, -8, IntPtr.Zero); }
  // A tool window: no Alt+Tab entry.
  public static void Tool(IntPtr h) { SetLong(h, -20, GetLong(h, -20) | 0x80); }
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  // Under every other window again (no move, no resize, no focus taken).
  public static void Bottom(IntPtr h) { SetWindowPos(h, new IntPtr(1), 0, 0, 0, 0, 0x13); }
}
'@

# One hotkey for the whole desktop (Ctrl+Alt+C, C for Circle): the overlay (overlay.ps1, like the Xbox Game Bar) dims
# the screen, brings every tile in front of it and opens a command box; the same keys put everything back. Registered with Windows, so it works from any app. When another app
# already holds it, the next free one of Ctrl+Alt+W and Win+Alt+C is taken; the one in use is written to
# desktop-widgets.hotkey (the Widgets page shows it), and the right-click menu always has "Bring to front".
Add-Type -ReferencedAssemblies PresentationCore, WindowsBase -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Interop;
public class CsHotKey {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  const int ID = 0xC17;
  HwndSource src;
  public event EventHandler Pressed;
  public bool Register(uint mods, uint vk) {
    var p = new HwndSourceParameters("CircleStudioHotKey") { Width = 0, Height = 0, WindowStyle = 0 };
    src = new HwndSource(p);
    src.AddHook(Hook);
    return RegisterHotKey(src.Handle, ID, mods | 0x4000, vk); // 0x4000: no repeats while held
  }
  public void Unregister() { if (src != null) { UnregisterHotKey(src.Handle, ID); src.Dispose(); src = null; } }
  IntPtr Hook(IntPtr h, int msg, IntPtr w, IntPtr l, ref bool handled) {
    if (msg == 0x0312 && w.ToInt32() == ID) { handled = true; if (Pressed != null) Pressed(this, EventArgs.Empty); }
    return IntPtr.Zero;
  }
}
'@

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $DataDir -or $DataDir -eq 'undefined' -or -not [IO.Path]::IsPathRooted($DataDir)) { $DataDir = Join-Path $appRoot 'data' }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Set-Content -Path (Join-Path $DataDir 'desktop-widgets.pid') -Value $PID -Encoding ASCII
$stateFile = Join-Path $DataDir 'desktop-widgets.json'
$base = "http://127.0.0.1:$Port"

# ---- saved places and options ----------------------------------------------------------------------------------
$saved = @{ positions = @{}; onTop = $false; overlay = @{} }
if (Test-Path $stateFile) {
  try {
    $j = Get-Content -Raw -Path $stateFile | ConvertFrom-Json
    if ($j.positions) { foreach ($p in $j.positions.PSObject.Properties) { $saved.positions[$p.Name] = @{ x = [double]$p.Value.x; y = [double]$p.Value.y } } }
    $saved.onTop = [bool]$j.onTop
    if ($j.overlay) { foreach ($p in $j.overlay.PSObject.Properties) { $saved.overlay[$p.Name] = @{ x = [double]$p.Value.x; y = [double]$p.Value.y } } }
  } catch { }
}
function Save-State { ($saved | ConvertTo-Json -Depth 5) | Set-Content -Path $stateFile -Encoding UTF8 }

# ---- drawing helpers --------------------------------------------------------------------------------------------
$conv = New-Object System.Windows.Media.BrushConverter
$script:pal = $null
function Brush([string]$hex, [string]$alpha = '') { if (-not $hex) { $hex = '#808080' }; return $conv.ConvertFromString(('#' + $alpha + $hex.TrimStart('#'))) }
function StateHex([string]$s) { switch ($s) { 'working' { $script:pal.ok } 'waiting' { $script:pal.warn } 'done' { $script:pal.info } 'danger' { $script:pal.danger } default { $script:pal.lineStrong } } }
$uiFont = New-Object System.Windows.Media.FontFamily('Segoe UI Variable Text, Segoe UI')
$bigFont = New-Object System.Windows.Media.FontFamily('Segoe UI Variable Display, Segoe UI')

function Text([string]$t, [double]$size = 12, [string]$hex = '', [string]$weight = 'Normal', [switch]$Big) {
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Text = $t
  $tb.FontSize = $size
  $tb.FontFamily = $(if ($Big) { $bigFont } else { $uiFont })
  $tb.FontWeight = [System.Windows.FontWeights]::$weight
  $tb.Foreground = Brush $(if ($hex) { $hex } else { $script:pal.text })
  $tb.TextTrimming = 'CharacterEllipsis'
  return $tb
}

function Ring([string]$state, [double]$pct, [string]$label, [double]$d = 46) {
  $g = New-Object System.Windows.Controls.Grid
  $g.Width = $d; $g.Height = $d
  $t = 5.0
  $track = New-Object System.Windows.Shapes.Ellipse
  $track.Stroke = Brush $script:pal.sunken; $track.StrokeThickness = $t
  $arc = New-Object System.Windows.Shapes.Ellipse
  $arc.Stroke = Brush (StateHex $state); $arc.StrokeThickness = $t
  $arc.StrokeDashCap = 'Round'; $arc.StrokeStartLineCap = 'Round'; $arc.StrokeEndLineCap = 'Round'
  $circ = [Math]::PI * ($d - $t) / $t
  $dash = [Math]::Max(0.01, $circ * [Math]::Min(100, [Math]::Max(0, $pct)) / 100)
  $dc = New-Object System.Windows.Media.DoubleCollection
  $dc.Add($dash); $dc.Add(1000)
  $arc.StrokeDashArray = $dc
  $arc.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.5)
  $arc.RenderTransform = New-Object System.Windows.Media.RotateTransform(-90)
  if ($pct -le 0) { $arc.Visibility = 'Collapsed' } # nothing done draws no arc (a round end would still draw a dot)
  $lab = Text $label 11 '' 'SemiBold'
  $lab.HorizontalAlignment = 'Center'; $lab.VerticalAlignment = 'Center'
  [void]$g.Children.Add($track); [void]$g.Children.Add($arc); [void]$g.Children.Add($lab)
  return $g
}

function Dot([string]$state) { $e = New-Object System.Windows.Shapes.Ellipse; $e.Width = 8; $e.Height = 8; $e.Fill = Brush (StateHex $state); $e.VerticalAlignment = 'Center'; $e.Margin = '0,0,8,0'; return $e }

function Row($left, $right) {
  $dp = New-Object System.Windows.Controls.DockPanel
  $dp.LastChildFill = $true
  if ($right) { [System.Windows.Controls.DockPanel]::SetDock($right, 'Right'); [void]$dp.Children.Add($right) }
  [void]$dp.Children.Add($left)
  return $dp
}

# ---- buttons, rings that move, and the bar of stages ----------------------------------------------------------------
# A real Button (Tab, Enter and Space work) drawn flat and rounded: the look comes from one template, the colours from
# tokens.css through the feed.
$btnTemplate = [System.Windows.Markup.XamlReader]::Parse(@'
<ControlTemplate xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" TargetType="Button">
  <Border x:Name="b" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" CornerRadius="9" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}" Padding="{TemplateBinding Padding}">
    <ContentPresenter HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}" VerticalAlignment="Center"/>
  </Border>
  <ControlTemplate.Triggers>
    <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.85"/></Trigger>
    <Trigger Property="IsKeyboardFocused" Value="True"><Setter TargetName="b" Property="BorderThickness" Value="2"/></Trigger>
    <Trigger Property="IsPressed" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.7"/></Trigger>
  </ControlTemplate.Triggers>
</ControlTemplate>
'@)

function Btn([string]$label, [string]$kind = 'plain') {
  $b = New-Object System.Windows.Controls.Button
  $b.Template = $btnTemplate
  $b.Padding = '12,6,12,6'; $b.Margin = '6,0,0,0'; $b.Cursor = 'Hand'; $b.MinHeight = 30
  $b.HorizontalContentAlignment = 'Center'
  $fg = $script:pal.text
  switch ($kind) {
    'primary' { $b.Background = Brush $script:pal.accent; $b.BorderBrush = Brush $script:pal.text; $b.BorderThickness = 0; $fg = $script:pal.onAccent }
    'quiet' { $b.Background = [System.Windows.Media.Brushes]::Transparent; $b.BorderBrush = Brush $script:pal.accent; $b.BorderThickness = 0; $fg = $script:pal.soft }
    default { $b.Background = Brush $script:pal.sunken; $b.BorderBrush = Brush $script:pal.line; $b.BorderThickness = 1 }
  }
  $tb = Text $label 12 $fg 'SemiBold'; $tb.TextWrapping = 'Wrap'; $tb.TextTrimming = 'None'
  $b.Content = $tb
  return $b
}

# Windows' own "Show animations" setting: off means nothing turns or pulses (the words still say the state).
function Motion-On { try { return [bool][System.Windows.SystemParameters]::ClientAreaAnimation } catch { return $true } }

# A ring that says what a project is doing: turning while it works, pulsing amber while it waits for you, a full
# blue ring with a tick when it has just finished, a grey track when quiet.
function Live-Ring([string]$state, [string]$label, [double]$d = 64) {
  $g = New-Object System.Windows.Controls.Grid
  $g.Width = $d; $g.Height = $d
  $t = [Math]::Max(4.0, [Math]::Round($d / 11))
  $track = New-Object System.Windows.Shapes.Ellipse
  $track.Stroke = Brush $script:pal.sunken; $track.StrokeThickness = $t
  [void]$g.Children.Add($track)
  $arc = New-Object System.Windows.Shapes.Ellipse
  $arc.Stroke = Brush (StateHex $state); $arc.StrokeThickness = $t
  $arc.StrokeStartLineCap = 'Round'; $arc.StrokeEndLineCap = 'Round'; $arc.StrokeDashCap = 'Round'
  $circ = [Math]::PI * ($d - $t) / $t
  $share = $(switch ($state) { 'working' { 0.3 } 'idle' { 0 } default { 1 } })
  if ($share -gt 0) {
    $dc = New-Object System.Windows.Media.DoubleCollection
    if ($share -lt 1) { $dc.Add($circ * $share); $dc.Add(1000) } else { $dc.Add(1000); $dc.Add(0) }
    $arc.StrokeDashArray = $dc
    $arc.RenderTransformOrigin = New-Object System.Windows.Point(0.5, 0.5)
    $rot = New-Object System.Windows.Media.RotateTransform(-90)
    $arc.RenderTransform = $rot
    [void]$g.Children.Add($arc)
    if (Motion-On) {
      if ($state -eq 'working') {
        $an = New-Object System.Windows.Media.Animation.DoubleAnimation(-90, 270, (New-Object System.Windows.Duration([TimeSpan]::FromSeconds(1.6))))
        $an.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
        $rot.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $an)
      } elseif ($state -eq 'waiting') {
        $an = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.35, (New-Object System.Windows.Duration([TimeSpan]::FromSeconds(1.1))))
        $an.AutoReverse = $true; $an.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
        $arc.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $an)
      }
    }
  }
  $in = $(if ($state -eq 'done') { [string][char]0x2713 } else { $label })
  $lab = Text $in ([Math]::Max(11, [Math]::Round($d / 4.6))) '' 'SemiBold'
  $lab.HorizontalAlignment = 'Center'; $lab.VerticalAlignment = 'Center'
  [void]$g.Children.Add($lab)
  return $g
}

# One segment per stage, coloured by its state, with "3 of 8 done" beside it: progress you can count.
function Stage-Bar($t) {
  $g = New-Object System.Windows.Controls.Grid; $g.Margin = '0,2,0,10'
  $c1 = New-Object System.Windows.Controls.ColumnDefinition; $c1.Width = New-Object System.Windows.GridLength(1, 'Star')
  $c2 = New-Object System.Windows.Controls.ColumnDefinition; $c2.Width = [System.Windows.GridLength]::Auto
  $g.ColumnDefinitions.Add($c1); $g.ColumnDefinitions.Add($c2)
  $u = New-Object System.Windows.Controls.Primitives.UniformGrid; $u.Rows = 1; $u.VerticalAlignment = 'Center'
  $states = @()
  if ($t.stages) { $states = @($t.stages | ForEach-Object { $_.state }) }
  else { for ($k = 0; $k -lt [int]$t.progress.total; $k++) { $states += $(if ($k -lt [int]$t.progress.done) { 'done' } elseif ($k -eq [int]$t.progress.done -and $t.now.state -ne 'idle') { $t.now.state } else { 'idle' }) } }
  foreach ($s in $states) {
    $seg = New-Object System.Windows.Controls.Border; $seg.Height = 6; $seg.CornerRadius = 3; $seg.Margin = '0,0,3,0'
    $seg.Background = $(if ($s -eq 'idle') { Brush $script:pal.sunken } else { Brush (StateHex $s) })
    [void]$u.Children.Add($seg)
  }
  [System.Windows.Controls.Grid]::SetColumn($u, 0); [void]$g.Children.Add($u)
  $n = Text "$($t.progress.done) of $($t.progress.total) done" 11 $script:pal.soft; $n.Margin = '8,0,0,0'
  [System.Windows.Controls.Grid]::SetColumn($n, 1); [void]$g.Children.Add($n)
  return $g
}

# ---- asking on the desktop -------------------------------------------------------------------------------------------
# An agent's approval or question appears as a card at the bottom right of the screen, above other windows, with its
# own buttons: Allow / Deny, or the answers to pick. Answered here or anywhere else, it goes away. Nothing on it is a
# secret: the server has already masked them.
$script:asks = @{}
$script:asksOn = $true
$ASK_W = 360

function Post-Json([string]$path, $obj, [scriptblock]$done) {
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('X-Circle', '1'); $wc.Headers.Add('Content-Type', 'application/json'); $wc.Encoding = [System.Text.Encoding]::UTF8
  $wc.Add_UploadStringCompleted({ param($s, $e) $s.Dispose(); Safe-Asks })
  $wc.UploadStringAsync([Uri]"$base$path", 'POST', ($obj | ConvertTo-Json -Compress -Depth 5))
}

function Answer-Ask([string]$id, $body) {
  if ($script:asks.ContainsKey($id)) { $script:asks[$id].Content.IsEnabled = $false; $script:asks[$id].Content.Opacity = 0.6 }
  Post-Json "/api/requests/$([Uri]::EscapeDataString($id))/respond" $body {}
}

function Project-Name([string]$id) { $p = $script:projects | Where-Object { $_.id -eq $id } | Select-Object -First 1; if ($p) { return $p.name } else { return $id } }

function New-AskCard($r) {
  $w = New-Object System.Windows.Window
  $w.WindowStyle = 'None'; $w.AllowsTransparency = $true; $w.Background = [System.Windows.Media.Brushes]::Transparent
  $w.ShowInTaskbar = $false; $w.ResizeMode = 'NoResize'; $w.ShowActivated = $false; $w.Topmost = $true
  $w.Width = $ASK_W + 24; $w.SizeToContent = 'Height'
  $w.Title = "Circle Studio asks - $($r.title)"
  $card = New-Object System.Windows.Controls.Border
  $card.Margin = '12'; $card.CornerRadius = 16; $card.Padding = '16,14,16,14'; $card.BorderThickness = 1
  $card.Background = Brush $script:pal.raised; $card.BorderBrush = Brush $script:pal.warn
  $fx = New-Object System.Windows.Media.Effects.DropShadowEffect; $fx.BlurRadius = 22; $fx.ShadowDepth = 4; $fx.Opacity = 0.4; $card.Effect = $fx
  $sp = New-Object System.Windows.Controls.StackPanel
  $who = $(if ($r.nodeId) { "$($r.nodeId)" } else { 'The agent' })
  $isQ = $r.kind -eq 'question'
  $head = New-Object System.Windows.Controls.StackPanel; $head.Orientation = 'Horizontal'; $head.Margin = '0,0,0,6'
  [void]$head.Children.Add((Dot 'waiting'))
  [void]$head.Children.Add((Text "$(Project-Name $r.projectId)  $([char]0x00B7)  $who $(if ($isQ) { 'asks' } else { 'wants to go ahead' })" 11 $script:pal.soft 'SemiBold'))
  [void]$sp.Children.Add($head)
  $q = $null
  if ($isQ) { $q = @($r.questions)[0] }
  $title = Text $(if ($q) { $q.question } else { $r.title }) 14 '' 'SemiBold'; $title.TextWrapping = 'Wrap'; $title.TextTrimming = 'None'; $title.Margin = '0,0,0,8'
  [void]$sp.Children.Add($title)
  if (-not $isQ -and $r.detail) {
    $box = New-Object System.Windows.Controls.Border; $box.Background = Brush $script:pal.sunken; $box.CornerRadius = 8; $box.Padding = '10,6,10,6'; $box.Margin = '0,0,0,8'
    $cmd = Text ([string]$r.detail) 12 '' 'Normal'; $cmd.FontFamily = New-Object System.Windows.Media.FontFamily('Cascadia Mono, Consolas'); $cmd.TextWrapping = 'Wrap'; $cmd.TextTrimming = 'CharacterEllipsis'; $cmd.MaxHeight = 64
    $cmd.ToolTip = [string]$r.detail
    $box.Child = $cmd; [void]$sp.Children.Add($box)
  }
  if ($r.risk -eq 'outside-project') { $x = Text 'This reaches outside the project folder.' 12 $script:pal.warn 'SemiBold'; $x.Margin = '0,0,0,8'; $x.TextWrapping = 'Wrap'; [void]$sp.Children.Add($x) }
  $row = New-Object System.Windows.Controls.WrapPanel; $row.HorizontalAlignment = 'Right'
  $open = Btn 'Open' 'quiet'; $open.ToolTip = 'See it in Circle Studio'; $open.Tag = $r.id
  $open.Add_Click({ Open-App '#/inbox' })
  $simple = $isQ -and @($r.questions).Count -eq 1 -and -not $q.multiSelect -and @($q.options).Count -ge 1 -and @($q.options).Count -le 4
  if (-not $isQ) {
    $deny = Btn 'Deny'; $deny.Tag = $r.id; $deny.Add_Click({ param($s, $e) Answer-Ask $s.Tag @{ decision = 'deny' } })
    $allow = Btn 'Allow' 'primary'; $allow.Tag = $r.id; $allow.Add_Click({ param($s, $e) Answer-Ask $s.Tag @{ decision = 'allow' } })
    [void]$row.Children.Add($open); [void]$row.Children.Add($deny); [void]$row.Children.Add($allow)
  } elseif ($simple) {
    # the answers to pick, one button each, then a line for something else
    foreach ($o in @($q.options)) {
      $b = Btn ([string]$o.label); $b.Margin = '0,0,0,6'; $b.HorizontalAlignment = 'Stretch'; $b.HorizontalContentAlignment = 'Left'
      if ($o.description) { $b.ToolTip = [string]$o.description }
      $b.Tag = @{ id = $r.id; q = [string]$q.question; a = [string]$o.label }
      $b.Add_Click({ param($s, $e) Answer-Ask $s.Tag.id @{ decision = 'answer'; answers = @{ $s.Tag.q = $s.Tag.a } } })
      [void]$sp.Children.Add($b)
    }
    $other = New-Object System.Windows.Controls.TextBox; $other.Margin = '0,2,0,8'; $other.Padding = '6,4,6,4'; $other.FontSize = 12
    $other.Background = Brush $script:pal.sunken; $other.Foreground = Brush $script:pal.text; $other.BorderBrush = Brush $script:pal.line; $other.CaretBrush = Brush $script:pal.text
    $other.ToolTip = 'Something else: type it and press Enter'
    $other.Tag = @{ id = $r.id; q = [string]$q.question }
    $other.Add_KeyDown({ param($s, $e) if ($e.Key -eq 'Return' -and $s.Text.Trim()) { Answer-Ask $s.Tag.id @{ decision = 'answer'; answers = @{ $s.Tag.q = $s.Text.Trim() } } } })
    $hint = Text 'Or type something else and press Enter:' 11 $script:pal.soft; $hint.Margin = '0,4,0,2'
    [void]$sp.Children.Add($hint); [void]$sp.Children.Add($other)
    [void]$row.Children.Add($open)
  } else {
    $go = Btn 'Answer in Circle Studio' 'primary'; $go.Add_Click({ Open-App '#/inbox' })
    [void]$row.Children.Add($go)
  }
  [void]$sp.Children.Add($row)
  $card.Child = $sp
  $w.Content = $card
  $w.Add_SourceInitialized({ param($sender, $e) [CsDesk]::Tool((New-Object System.Windows.Interop.WindowInteropHelper($sender)).Handle) })
  return $w
}

# The cards stack up from the bottom right corner, newest at the bottom; at most three, then "and N more".
function Place-Asks {
  $area = [System.Windows.SystemParameters]::WorkArea
  $y = $area.Bottom - 8
  foreach ($w in @($script:asks.Values | Sort-Object { $_.Tag.at } -Descending)) {
    $w.UpdateLayout()
    $h = $(if ($w.ActualHeight -gt 0) { $w.ActualHeight } else { 220 })
    $y -= $h
    $w.Left = $area.Right - $w.Width - 8; $w.Top = [Math]::Max($area.Top, $y)
  }
}

function Refresh-Asks {
  if (-not $script:asksOn -or -not $script:pal) { foreach ($k in @($script:asks.Keys)) { $script:asks[$k].Close(); $script:asks.Remove($k) }; return }
  $list = @((Invoke-RestMethod -Uri "$base/api/requests?status=pending" -TimeoutSec 4).requests | Where-Object { $_ })
  $list = @($list | Sort-Object at | Select-Object -Last 3)
  $ids = @($list | ForEach-Object { $_.id })
  foreach ($k in @($script:asks.Keys)) { if ($ids -notcontains $k) { $script:asks[$k].Close(); $script:asks.Remove($k) } }
  $added = $false
  foreach ($r in $list) {
    if ($script:asks.ContainsKey($r.id)) { continue }
    $w = New-AskCard $r
    $w.Tag = @{ at = [string]$r.at }
    $script:asks[$r.id] = $w
    if (-not $script:ovUp) { $w.Show() } # while the overlay is open, what waits is in its own panel
    $added = $true
  }
  if ($added -or $script:asks.Count) { Place-Asks }
  if ($added) { [System.Media.SystemSounds]::Asterisk.Play() }
}
function Safe-Asks { try { Refresh-Asks } catch { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' asks: ' + $_.Exception.Message) } }

# ---- switching what a tile shows (its project, or the Chat tile's chat) ----------------------------------------
# Saved through Circle Studio (POST /api/widgets/pick), asynchronously, then the tiles are drawn again.
function Pick-Widget([int]$index, $patch) {
  $body = (@{ index = $index } + $patch) | ConvertTo-Json -Compress
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('X-Circle', '1'); $wc.Headers.Add('Content-Type', 'application/json')
  $wc.Add_UploadStringCompleted({ param($s, $e) $s.Dispose(); Safe-Refresh })
  $wc.UploadStringAsync([Uri]"$base/api/widgets/pick", 'POST', $body)
}

# Lock or unlock every tile in place (kept by Circle Studio, so the Widgets page shows the same).
$script:locked = $false
function Set-Locked([bool]$on) {
  $script:locked = $on
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('X-Circle', '1'); $wc.Headers.Add('Content-Type', 'application/json')
  $wc.Add_UploadStringCompleted({ param($s, $e) $s.Dispose(); Safe-Refresh })
  $wc.UploadStringAsync([Uri]"$base/api/settings", 'PUT', (@{ widgetsLocked = $on } | ConvertTo-Json -Compress))
}

# The projects to choose from, as menu items (the one shown is ticked).
function Add-ProjectItems($menu, $t) {
  foreach ($p in $script:projects) {
    $mi = New-Object System.Windows.Controls.MenuItem
    $mi.Header = $p.name; $mi.IsCheckable = $true; $mi.IsChecked = ($p.id -eq $t.projectId)
    $mi.Tag = @{ index = [int]$t.index; projectId = [string]$p.id }
    $mi.Add_Click({ param($s, $e) Pick-Widget $s.Tag.index @{ projectId = $s.Tag.projectId } })
    [void]$menu.Items.Add($mi)
  }
}

# ---- one tile's content -----------------------------------------------------------------------------------------
function Build-Tile($t) {
  $sp = New-Object System.Windows.Controls.StackPanel
  $title = Text $t.title 12 $script:pal.soft 'SemiBold'
  if ($t.canPick) {
    # the project name is a switch: click it to show another project here
    $title.Text = "$($t.title)  " + [string][char]0x25BE
    $title.Cursor = 'Hand'; $title.ToolTip = 'Show another project'
    $title.Tag = $t
    $title.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; $cm = New-Object System.Windows.Controls.ContextMenu; Add-ProjectItems $cm $s.Tag; $cm.PlacementTarget = $s; $cm.IsOpen = $true })
  }
  $title.Margin = '0,0,0,8'
  if ($t.big -and $t.kind -eq 'spend' -and $t.size -ne 's') { [void]$sp.Children.Add((Row $title (Text $t.big 15 '' 'SemiBold'))) } else { [void]$sp.Children.Add($title) }
  if ($t.chat -and $t.chat.threads -and $t.chat.threads.Count) {
    # the chats to switch between: the main chat first, then the agents'
    $wp = New-Object System.Windows.Controls.WrapPanel; $wp.Margin = '0,0,0,6'; $wp.MaxHeight = 52
    foreach ($th in $t.chat.threads) {
      $chip = New-Object System.Windows.Controls.Border
      $chip.CornerRadius = 10; $chip.Padding = '8,2,8,2'; $chip.Margin = '0,0,4,4'; $chip.BorderThickness = 1; $chip.Cursor = 'Hand'
      $chip.BorderBrush = Brush $(if ($th.on) { $script:pal.accent } else { $script:pal.line })
      $chip.Background = $(if ($th.on) { Brush $script:pal.accent } else { [System.Windows.Media.Brushes]::Transparent })
      $chip.Child = Text $th.label 10 $(if ($th.on) { $script:pal.onAccent } else { $script:pal.soft }) 'SemiBold'
      $chip.ToolTip = $(if ($th.id -eq 'main') { 'The main chat' } else { "$($th.label)'s chat" })
      $chip.Tag = @{ index = [int]$t.index; nodeId = [string]$th.id; on = [bool]$th.on }
      $chip.Add_MouseLeftButtonDown({ param($s, $e) $e.Handled = $true; if (-not $s.Tag.on) { Pick-Widget $s.Tag.index @{ nodeId = $s.Tag.nodeId } } })
      [void]$wp.Children.Add($chip)
    }
    [void]$sp.Children.Add($wp)
    # medium: the last two, one line each (they fit whole); large: the last few, wrapped
    $shown = $(if ($t.size -eq 'l') { @($t.chat.messages | Select-Object -Last 4) } else { @($t.chat.messages | Select-Object -Last 2) })
    $lastWho = ''
    foreach ($m in $shown) {
      $b = New-Object System.Windows.Controls.Border
      $b.CornerRadius = 10; $b.Padding = '8,4,8,4'; $b.Margin = '0,0,0,4'; $b.MaxWidth = 280
      $b.HorizontalAlignment = $(if ($m.mine) { 'Right' } else { 'Left' })
      $b.Background = $(if ($m.mine) { Brush $script:pal.accent '33' } else { Brush $script:pal.sunken })
      $col = New-Object System.Windows.Controls.StackPanel
      if ($m.who -ne $lastWho) { [void]$col.Children.Add((Text $m.who 11 $script:pal.soft 'SemiBold')) }
      $lastWho = $m.who
      $said = Text $m.text 12
      if ($t.size -eq 'l') { $said.TextWrapping = 'Wrap'; $said.MaxHeight = 46 } else { $said.TextWrapping = 'NoWrap'; $said.ToolTip = $m.text }
      [void]$col.Children.Add($said)
      $b.Child = $col
      [void]$sp.Children.Add($b)
    }
    # which engine answers, and that a click opens the chat window to reply from the desktop
    if ($t.engine) {
      $eng = (Get-Culture).TextInfo.ToTitleCase([string]$t.engine)
      $f = Text $(if ($t.size -eq 'l') { "$eng answers  " + [string][char]0x00B7 + "  click to reply" } else { $eng }) 10 $script:pal.accent 'SemiBold'
      $f.Margin = '0,2,0,0'
      [void]$sp.Children.Add($f)
    }
  }
  if ($t.chatWindow) { $sp.ToolTip = 'Click to open the chat: read it, pick the engine and reply' }
  if ($t.empty) { $e = Text $t.empty 13 $script:pal.soft; $e.Margin = '0,24,0,0'; $e.TextWrapping = 'Wrap'; [void]$sp.Children.Add($e) }

  if ($t.rings) {
    if ($t.size -eq 's') {
      $u = New-Object System.Windows.Controls.Primitives.UniformGrid; $u.Columns = 2; $u.Rows = 2
      foreach ($r in $t.rings) { $c = Ring $r.state $r.pct $r.label 48; $c.Margin = '4'; $c.ToolTip = "$($r.name): $($r.word)"; [void]$u.Children.Add($c) }
      [void]$sp.Children.Add($u)
    } else {
      $u = New-Object System.Windows.Controls.Primitives.UniformGrid; $u.Columns = 4
      foreach ($r in $t.rings) {
        $cell = New-Object System.Windows.Controls.StackPanel; $cell.Margin = '2,0,2,8'; $cell.ToolTip = $(if ($r.detail) { $r.detail } else { $r.word })
        $ring = Ring $r.state $r.pct $r.label 50; $ring.HorizontalAlignment = 'Center'
        $n = Text $r.name 11 '' 'Medium'; $n.HorizontalAlignment = 'Center'; $n.Margin = '0,4,0,0'
        $w = Text $r.word 10 (StateHex $r.state); $w.HorizontalAlignment = 'Center'
        [void]$cell.Children.Add($ring); [void]$cell.Children.Add($n); [void]$cell.Children.Add($w)
        [void]$u.Children.Add($cell)
      }
      [void]$sp.Children.Add($u)
    }
  }

  if ($t.big -and -not ($t.kind -eq 'spend' -and $t.size -ne 's')) {
    $hex = $(if ($t.bigState -eq 'waiting') { $script:pal.warn } else { $script:pal.text })
    [void]$sp.Children.Add((Text $t.big 34 $hex 'SemiBold' -Big))
  }

  if ($t.rows) {
    foreach ($r in $t.rows) {
      $hex = $script:pal.($r.color)
      $g = New-Object System.Windows.Controls.Grid; $g.Margin = '0,3,0,3'
      foreach ($w in @(62, 1, 70)) { $cd = New-Object System.Windows.Controls.ColumnDefinition; $cd.Width = $(if ($w -eq 1) { New-Object System.Windows.GridLength(1, 'Star') } else { New-Object System.Windows.GridLength($w) }); $g.ColumnDefinitions.Add($cd) }
      $l = Text $r.label 11 $hex 'SemiBold'; [System.Windows.Controls.Grid]::SetColumn($l, 0)
      $track = New-Object System.Windows.Controls.Border; $track.Height = 7; $track.CornerRadius = 4; $track.Background = Brush $script:pal.sunken; $track.VerticalAlignment = 'Center'
      $fill = New-Object System.Windows.Controls.Border; $fill.Height = 7; $fill.CornerRadius = 4; $fill.Background = Brush $hex; $fill.HorizontalAlignment = 'Left'
      $fill.Width = [Math]::Max(3, 190 * [double]$r.pct / 100 * $(if ($t.size -eq 'l') { 1 } else { 1 }))
      $track.Child = $fill; [System.Windows.Controls.Grid]::SetColumn($track, 1)
      $v = Text $r.value 11; $v.HorizontalAlignment = 'Right'; [System.Windows.Controls.Grid]::SetColumn($v, 2)
      [void]$g.Children.Add($l); [void]$g.Children.Add($track); [void]$g.Children.Add($v)
      [void]$sp.Children.Add($g)
    }
  }

  if ($t.bars -and $t.bars.Count) {
    $bp = New-Object System.Windows.Controls.StackPanel; $bp.Orientation = 'Horizontal'; $bp.Height = 64; $bp.Margin = '0,10,0,6'
    $w = [Math]::Floor(300 / $t.bars.Count) - 2
    foreach ($b in $t.bars) { $x = New-Object System.Windows.Controls.Border; $x.Width = [Math]::Max(2, $w); $x.Height = [Math]::Max(2, 64 * [double]$b / 100); $x.VerticalAlignment = 'Bottom'; $x.Margin = '0,0,2,0'; $x.CornerRadius = 2; $x.Background = Brush $script:pal.gate; [void]$bp.Children.Add($x) }
    [void]$sp.Children.Add($bp)
  }

  if ($t.progress -and $t.size -eq 's') {
    $r = Ring $t.progress.state ([double]$t.progress.pct) "$($t.progress.done)/$($t.progress.total)" 76
    $r.HorizontalAlignment = 'Left'; $r.Margin = '0,0,0,4'; $r.ToolTip = "$($t.progress.done) of $($t.progress.total) stages done"
    [void]$sp.Children.Add($r)
  } elseif ($t.progress) {
    [void]$sp.Children.Add((Stage-Bar $t))
    if ($t.now -and -not $t.stages) {
      $row = New-Object System.Windows.Controls.StackPanel; $row.Orientation = 'Horizontal'
      [void]$row.Children.Add((Dot $t.now.state))
      $nt = Text $t.now.title 15 '' 'SemiBold'; $nt.MaxWidth = 210; [void]$row.Children.Add($nt)
      if ($t.now.word) { $nw = Text "  $($t.now.word)" 12 (StateHex $t.now.state) 'SemiBold'; $nw.VerticalAlignment = 'Center'; [void]$row.Children.Add($nw) }
      [void]$sp.Children.Add($row)
    }
    if ($t.stages) {
      foreach ($st in $t.stages) {
        $g = New-Object System.Windows.Controls.DockPanel; $g.Margin = '0,3,0,3'
        $c = New-Object System.Windows.Controls.Border; $c.Width = 22; $c.Height = 22; $c.CornerRadius = 11; $c.BorderThickness = 2; $c.Margin = '0,0,10,0'
        $c.BorderBrush = Brush (StateHex $st.state); $c.Background = $(if ($st.state -eq 'done') { Brush $script:pal.info } else { [System.Windows.Media.Brushes]::Transparent })
        $num = Text $(if ($st.state -eq 'done') { [string][char]0x2713 } else { [string]$st.n }) 11 $(if ($st.state -eq 'done') { $script:pal.onAccent } else { $script:pal.text }) 'SemiBold'
        $num.HorizontalAlignment = 'Center'; $num.VerticalAlignment = 'Center'; $c.Child = $num
        [System.Windows.Controls.DockPanel]::SetDock($c, 'Left'); [void]$g.Children.Add($c)
        $word = Text $(switch ($st.state) { 'working' { 'Working' } 'waiting' { 'Needs you' } 'done' { 'Done' } default { '' } }) 11 (StateHex $st.state) 'SemiBold'
        $word.VerticalAlignment = 'Center'; [System.Windows.Controls.DockPanel]::SetDock($word, 'Right'); [void]$g.Children.Add($word)
        $col = New-Object System.Windows.Controls.StackPanel
        [void]$col.Children.Add((Text $st.title 12 '' $(if ($st.state -eq 'working' -or $st.state -eq 'waiting') { 'SemiBold' } else { 'Normal' })))
        if ($st.state -ne 'idle' -and $st.who) { [void]$col.Children.Add((Text $st.who 11 $script:pal.soft)) }
        [void]$g.Children.Add($col)
        [void]$sp.Children.Add($g)
      }
    }
  }
  if ($t.next) { $nx = Text $t.next 11 $script:pal.soft; $nx.Margin = '0,6,0,0'; [void]$sp.Children.Add($nx) }

  if ($t.activity) {
    # the activity ring: one per project that is doing something, with its words beside or under it
    $list = @($t.activity)
    if ($list.Count -eq 1 -and $t.size -ne 's') {
      $a = $list[0]
      $row = New-Object System.Windows.Controls.DockPanel; $row.Margin = '0,4,0,0'
      $ring = Live-Ring $a.state $a.label 84; $ring.Margin = '0,0,16,0'
      [System.Windows.Controls.DockPanel]::SetDock($ring, 'Left'); [void]$row.Children.Add($ring)
      $col = New-Object System.Windows.Controls.StackPanel; $col.VerticalAlignment = 'Center'
      [void]$col.Children.Add((Text $a.name 16 '' 'SemiBold'))
      [void]$col.Children.Add((Text $a.word 13 (StateHex $a.state) 'SemiBold'))
      if ($a.what) { [void]$col.Children.Add((Text $a.what 11 $script:pal.soft)) }
      [void]$row.Children.Add($col)
      [void]$sp.Children.Add($row)
    } else {
      $u = New-Object System.Windows.Controls.Primitives.UniformGrid
      $u.Columns = $(if ($list.Count -eq 1) { 1 } else { 3 })
      foreach ($a in $list) {
        $cell = New-Object System.Windows.Controls.StackPanel; $cell.Margin = '2,0,2,6'
        $cell.ToolTip = "$($a.name): $($a.word)$(if ($a.what) { ' (' + $a.what + ')' })"
        $ring = Live-Ring $a.state $a.label $(if ($list.Count -eq 1) { 62 } elseif ($t.size -eq 'l') { 74 } else { 52 }); $ring.HorizontalAlignment = 'Center'
        $n = Text $a.name 11 '' 'SemiBold'; $n.HorizontalAlignment = 'Center'; $n.Margin = '0,4,0,0'
        $w2 = Text $a.word 11 (StateHex $a.state); $w2.HorizontalAlignment = 'Center'
        [void]$cell.Children.Add($ring); [void]$cell.Children.Add($n); [void]$cell.Children.Add($w2)
        [void]$u.Children.Add($cell)
      }
      [void]$sp.Children.Add($u)
    }
  }

  if ($t.stats) {
    $u = New-Object System.Windows.Controls.Primitives.UniformGrid; $u.Rows = 1; $u.Margin = '0,4,0,6'
    foreach ($s in $t.stats) { $c = New-Object System.Windows.Controls.StackPanel; [void]$c.Children.Add((Text ([string]$s.n) 24 (StateHex $s.state) 'SemiBold' -Big)); [void]$c.Children.Add((Text $s.label 11 $script:pal.soft)); [void]$u.Children.Add($c) }
    [void]$sp.Children.Add($u)
  }
  if ($t.lines) { foreach ($l in $t.lines) { $x = Text $l 11 $script:pal.soft; $x.Margin = '0,2,0,0'; [void]$sp.Children.Add($x) } }

  if ($t.items) {
    foreach ($it in $t.items) {
      $row = New-Object System.Windows.Controls.StackPanel; $row.Orientation = 'Horizontal'; $row.Margin = '0,4,0,2'
      [void]$row.Children.Add((Dot $it.state))
      $col = New-Object System.Windows.Controls.StackPanel
      $tt = Text $it.title 12 '' 'Medium'; $tt.MaxWidth = 290; [void]$col.Children.Add($tt)
      if ($it.sub) { $s2 = Text $it.sub 10 $script:pal.soft; $s2.MaxWidth = 290; [void]$col.Children.Add($s2) }
      [void]$row.Children.Add($col)
      [void]$sp.Children.Add($row)
    }
  }
  if ($t.sub) { $s = Text $t.sub 11 $script:pal.soft; $s.Margin = '0,6,0,0'; $s.TextWrapping = 'Wrap'; $s.MaxHeight = 32; [void]$sp.Children.Add($s) }
  if ($t.note) { $s = Text $t.note 10 $script:pal.soft; $s.Margin = '0,4,0,0'; [void]$sp.Children.Add($s) }
  return $sp
}

# ---- windows ----------------------------------------------------------------------------------------------------
$CELL = 168; $GAP = 12; $PAD = 14
$windows = @{}

function Open-App([string]$hash) {
  # Circle Studio brings its open window forward (on that page) instead of opening a second one
  # (asynchronous, so the tiles never freeze while it does; it opens the window itself only when the server cannot)
  # chat:<project id> opens that project's chat window: a small window to read, pick the engine and reply
  $body = $(if ($hash -eq 'widget.html') { @{ kind = 'widget' } } elseif ($hash -like 'chat:*') { @{ kind = 'tile'; tile = @{ kind = 'chat'; size = 'l' }; projectId = $hash.Substring(5) } } else { @{ kind = 'app'; hash = $hash } }) | ConvertTo-Json -Compress
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('X-Circle', '1'); $wc.Headers.Add('Content-Type', 'application/json')
  $wc.Add_UploadStringCompleted({ param($s, $e) if ($e.Error) { Open-Directly ([string]$e.UserState) }; $s.Dispose() })
  $wc.UploadStringAsync([Uri]"$base/api/desktop/open", 'POST', $body, $hash)
}

function Open-Directly([string]$hash) {
  $url = $(if ($hash -like 'chat:*') { "$base/widget.html?w=chat&size=l&p=$([Uri]::EscapeDataString($hash.Substring(5)))" } else { "$base/$hash" })
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($edge) { Start-Process -FilePath $edge -ArgumentList "--app=$url" } else { Start-Process $url }
}

function Size-Of([string]$s) {
  $w = $(if ($s -eq 's') { $CELL } else { $CELL * 2 + $GAP })
  $h = $(if ($s -eq 'l') { $CELL * 2 + $GAP } else { $CELL })
  return @($w, $h)
}

# Tiles without a saved place are packed like the board: a grid four cells wide at the top right of the screen,
# filled row by row, each tile in the first free spot it fits (small 1x1, medium 2x1, large 2x2).
$script:taken = @{}
function Default-Place([int]$i, [string]$size) {
  $area = [System.Windows.SystemParameters]::WorkArea
  $cols = 4
  $w = $(if ($size -eq 's') { 1 } else { 2 })
  $h = $(if ($size -eq 'l') { 2 } else { 1 })
  for ($r = 0; $r -lt 40; $r++) {
    for ($c = 0; $c -le $cols - $w; $c++) {
      $free = $true
      for ($y = $r; $y -lt $r + $h; $y++) { for ($x = $c; $x -lt $c + $w; $x++) { if ($script:taken["$x,$y"]) { $free = $false } } }
      if ($free) {
        for ($y = $r; $y -lt $r + $h; $y++) { for ($x = $c; $x -lt $c + $w; $x++) { $script:taken["$x,$y"] = $true } }
        $left = $area.Right - 24 - $cols * ($CELL + $GAP) + $c * ($CELL + $GAP) - 12
        $top = $area.Top + 24 + $r * ($CELL + $GAP) - 12
        return @($left, $top)
      }
    }
  }
  return @($area.Left + 40, $area.Top + 40)
}

function New-Menu($t) {
  $m = New-Object System.Windows.Controls.ContextMenu
  $add = { param($label, $action) $mi = New-Object System.Windows.Controls.MenuItem; $mi.Header = $label; $mi.Add_Click($action); [void]$m.Items.Add($mi); return $mi }
  if ($t -and $t.canPick) {
    # the project this tile shows (also from its title)
    $pm = New-Object System.Windows.Controls.MenuItem; $pm.Header = 'Show project'
    Add-ProjectItems $pm $t
    [void]$m.Items.Add($pm)
    [void]$m.Items.Add((New-Object System.Windows.Controls.Separator))
  }
  [void](& $add 'Open Circle Studio' { Open-App '#/' })
  [void](& $add 'Edit widgets...' { Open-App '#/widgets' })
  [void](& $add 'Refresh now' { Refresh })
  $lock = & $add 'Lock in place' { Set-Locked (-not $script:locked) }
  $lock.IsCheckable = $true; $lock.IsChecked = [bool]$script:locked
  $lock.ToolTip = 'Tiles cannot be dragged while locked; a click still opens Circle Studio'
  [void](& $add "Open the overlay  ($script:HOTKEY_WORDS)" { Show-Overlay })
  $front = & $add 'Bring to front' { Toggle-Front }
  $front.IsCheckable = $true; $front.IsChecked = [bool]$script:front
  $front.ToolTip = 'Every tile in front of your windows for now; the same keys put them back'
  $top = & $add 'Keep on top of windows' { $saved.onTop = -not $saved.onTop; Save-State; Apply-Layer }
  $top.IsCheckable = $true; $top.IsChecked = $saved.onTop
  [void]$m.Items.Add((New-Object System.Windows.Controls.Separator))
  [void](& $add 'Close desktop widgets' { $app.Shutdown() })
  return $m
}

$script:HOTKEY_WORDS = 'Ctrl+Alt+C'
$script:front = $false
function Is-Up { return ($saved.onTop -or $script:front -or $script:ovUp) }

function Apply-Layer {
  foreach ($w in $windows.Values) {
    $h = (New-Object System.Windows.Interop.WindowInteropHelper($w)).Handle
    if (Is-Up) { [CsDesk]::Free($h); $w.Topmost = $true } else { $w.Topmost = $false; [CsDesk]::OnDesktop($h); [CsDesk]::Bottom($h) }
  }
}

# The hotkey: everything to the front, or back to the desktop.
function Toggle-Front {
  $script:front = -not $script:front
  Apply-Layer
  if ($script:front) { foreach ($w in $windows.Values) { $w.Opacity = 0.4; $an = New-Object System.Windows.Media.Animation.DoubleAnimation(0.4, 1.0, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(180)))); $w.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $an) } }
  Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' front: ' + $script:front)
}

function New-TileWindow($t, [int]$i) {
  $wh = Size-Of $t.size
  $w = New-Object System.Windows.Window
  $w.WindowStyle = 'None'; $w.AllowsTransparency = $true; $w.Background = [System.Windows.Media.Brushes]::Transparent
  $w.ShowInTaskbar = $false; $w.ResizeMode = 'NoResize'; $w.ShowActivated = $false
  $w.Width = $wh[0] + 24; $w.Height = $wh[1] + 24
  $w.Title = "Circle Studio - $($t.title)"
  $pos = $saved.positions[$t.key]
  # a place saved before keys stopped naming the project: keep it
  if (-not $pos -and $t.oldKey -and $saved.positions[$t.oldKey]) { $pos = $saved.positions[$t.oldKey]; $saved.positions[$t.key] = $pos; Save-State }
  if ($pos) { $w.Left = $pos.x; $w.Top = $pos.y } else { $p = Default-Place $i $t.size; $w.Left = $p[0]; $w.Top = $p[1] }
  $card = New-Object System.Windows.Controls.Border
  $card.Margin = '12'; $card.CornerRadius = 20; $card.Padding = $PAD; $card.BorderThickness = 1
  $fx = New-Object System.Windows.Media.Effects.DropShadowEffect; $fx.BlurRadius = 18; $fx.ShadowDepth = 3; $fx.Opacity = 0.35; $card.Effect = $fx
  $card.Cursor = 'Hand'
  $w.Content = $card
  $w.Tag = @{ key = $t.key; url = $t.url }
  $w.Add_MouseLeftButtonDown({
    param($sender, $e)
    $x = $sender.Left; $y = $sender.Top
    # locked in place: a press is only a click
    if (-not $script:locked) { try { $sender.DragMove() } catch { } }
    if ([Math]::Abs($sender.Left - $x) -lt 3 -and [Math]::Abs($sender.Top - $y) -lt 3) {
      if ($sender.Tag.key -eq 'offline') { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $appRoot 'scripts\launch.vbs') + '" --background') }
      else { if ($script:ovUp) { Hide-Overlay }; Open-App $sender.Tag.url }
    }
    else { $saved.positions[$sender.Tag.key] = @{ x = $sender.Left; y = $sender.Top }; Save-State }
  })
  $w.Add_SourceInitialized({ param($sender, $e) $h = (New-Object System.Windows.Interop.WindowInteropHelper($sender)).Handle; [CsDesk]::Tool($h); if (Is-Up) { $sender.Topmost = $true } else { [CsDesk]::OnDesktop($h) } })
  return $w
}

function Paint($w, $t) {
  $sig = ($t | ConvertTo-Json -Depth 8 -Compress) + $script:pal.raised
  if ($w.Tag -and $w.Tag.sig -eq $sig) { return }
  $card = $w.Content
  $card.Background = Brush $script:pal.raised
  $card.BorderBrush = Brush $script:pal.line
  $card.ClipToBounds = $true
  $card.Child = Build-Tile $t
  $w.Tag = @{ key = $t.key; url = $(if ($t.chatWindow) { 'chat:' + $t.chatWindow } elseif ($t.url) { $t.url } else { '#/' }); sig = $sig }
  $w.ContextMenu = New-Menu $t # the project list changes, so the menu is built again each time
}

function Theme { try { $v = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme; if ($v -eq 1) { 'light' } else { 'dark' } } catch { 'dark' } }

$script:offline = $null
function Refresh {
  try {
    $feed = Invoke-RestMethod -Uri "$base/api/widgets/feed?theme=$(Theme)&asks=1" -TimeoutSec 20
  } catch {
    if (-not $script:pal) { $script:pal = @{ raised = '#202828'; line = '#2d3535'; text = '#e0e8e8'; soft = '#afbaba'; sunken = '#0b1111'; lineStrong = '#6a7b7c'; ok = '#6fd087'; warn = '#f9aa60'; info = '#8fb9f7'; danger = '#ff847f'; gate = '#dbbb56'; accent = '#29a0a6'; onAccent = '#020e0e' } }
    $feed = @{ tiles = @(@{ key = 'offline'; kind = 'inbox'; size = 's'; title = 'Circle Studio'; empty = 'Not running. Click to start it.'; url = '#/' }) }
    $script:offline = $true
  }
  if ($feed.palette) { $script:pal = @{}; foreach ($p in $feed.palette.PSObject.Properties) { $script:pal[$p.Name] = $p.Value }; $script:offline = $false }
  $script:projects = @($feed.projects | Where-Object { $_ })
  if ($null -ne $feed.locked) { $script:locked = [bool]$feed.locked }
  if ($null -ne $feed.asks) { $script:asksOn = [bool]$feed.asks }
  $keys = @()
  $i = 0
  foreach ($t in $feed.tiles) {
    $keys += $t.key
    if (-not $windows.ContainsKey($t.key)) { $windows[$t.key] = New-TileWindow $t $i; Paint $windows[$t.key] $t; $windows[$t.key].Show() } else { Paint $windows[$t.key] $t }
    $i++
  }
  foreach ($k in @($windows.Keys)) { if ($keys -notcontains $k) { $windows[$k].Close(); $windows.Remove($k) } }
  if ($script:offline -and $windows.ContainsKey('offline')) {
    $windows['offline'].Tag = @{ key = 'offline'; url = '#/' }
  }
}

. (Join-Path $PSScriptRoot 'overlay.ps1')

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnExplicitShutdown'
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(15)
$logFile = Join-Path $DataDir 'desktop-widgets.log'
function Safe-Refresh { try { Refresh } catch { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' ' + $_.Exception.Message + ' ' + $_.InvocationInfo.PositionMessage) } }
$timer.Add_Tick({ Safe-Refresh })
# what an agent asks is looked for every 3 seconds (one small local request): it should not wait for the tiles
$askTimer = New-Object System.Windows.Threading.DispatcherTimer
$askTimer.Interval = [TimeSpan]::FromSeconds(3)
$askTimer.Add_Tick({ Safe-Asks })
$hotkey = New-Object CsHotKey
$hotkey.Add_Pressed({ try { Toggle-Overlay } catch { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' hotkey: ' + $_.Exception.Message + ' ' + $_.InvocationInfo.PositionMessage) } })
$app.Add_Startup({
  Safe-Refresh; $timer.Start(); Safe-Asks; $askTimer.Start()
  # Ctrl = 2, Alt = 1, Win = 8; C = 0x43, W = 0x57
  $got = ''
  foreach ($k in @(@('Ctrl+Alt+C', 3, 0x43), @('Ctrl+Alt+W', 3, 0x57), @('Win+Alt+C', 9, 0x43))) {
    if ($hotkey.Register([uint32]$k[1], [uint32]$k[2])) { $got = $k[0]; break }
    $hotkey.Unregister()
  }
  $script:HOTKEY_WORDS = $(if ($got) { $got } else { 'no hotkey' })
  Set-Content -Path (Join-Path $DataDir 'desktop-widgets.hotkey') -Value $script:HOTKEY_WORDS -Encoding ASCII
  if (-not $got) { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' hotkey: Ctrl+Alt+C, Ctrl+Alt+W and Win+Alt+C are all taken by other apps') }
})
$app.Add_Exit({ try { $hotkey.Unregister() } catch { }; try { Remove-Item -Path (Join-Path $DataDir 'desktop-widgets.pid') -ErrorAction SilentlyContinue } catch { }; $mutex.ReleaseMutex() })
[void]$app.Run()
