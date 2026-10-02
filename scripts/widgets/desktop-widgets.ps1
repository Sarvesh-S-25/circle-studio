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
}
'@

$appRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $DataDir -or $DataDir -eq 'undefined' -or -not [IO.Path]::IsPathRooted($DataDir)) { $DataDir = Join-Path $appRoot 'data' }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Set-Content -Path (Join-Path $DataDir 'desktop-widgets.pid') -Value $PID -Encoding ASCII
$stateFile = Join-Path $DataDir 'desktop-widgets.json'
$base = "http://127.0.0.1:$Port"

# ---- saved places and options ----------------------------------------------------------------------------------
$saved = @{ positions = @{}; onTop = $false }
if (Test-Path $stateFile) {
  try {
    $j = Get-Content -Raw -Path $stateFile | ConvertFrom-Json
    if ($j.positions) { foreach ($p in $j.positions.PSObject.Properties) { $saved.positions[$p.Name] = @{ x = [double]$p.Value.x; y = [double]$p.Value.y } } }
    $saved.onTop = [bool]$j.onTop
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

# ---- one tile's content -----------------------------------------------------------------------------------------
function Build-Tile($t) {
  $sp = New-Object System.Windows.Controls.StackPanel
  $title = Text $t.title 12 $script:pal.soft 'SemiBold'
  $title.Margin = '0,0,0,8'
  if ($t.big -and $t.kind -eq 'spend' -and $t.size -ne 's') { [void]$sp.Children.Add((Row $title (Text $t.big 15 '' 'SemiBold'))) } else { [void]$sp.Children.Add($title) }
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

  if ($t.steps) {
    $u = New-Object System.Windows.Controls.Primitives.UniformGrid; $u.Rows = 1; $u.Margin = '0,6,0,6'
    foreach ($s in $t.steps) {
      $cell = New-Object System.Windows.Controls.StackPanel
      $circle = New-Object System.Windows.Controls.Border; $circle.Width = 26; $circle.Height = 26; $circle.CornerRadius = 13; $circle.BorderThickness = 2
      $circle.BorderBrush = Brush (StateHex $s.state)
      $circle.Background = $(if ($s.state -eq 'done') { Brush $script:pal.info } else { Brush $script:pal.raised })
      $num = Text $(if ($s.state -eq 'done') { [string][char]0x2713 } else { [string]$s.n }) 11 $(if ($s.state -eq 'done') { $script:pal.onAccent } else { $script:pal.text }) 'SemiBold'
      $num.HorizontalAlignment = 'Center'; $num.VerticalAlignment = 'Center'; $circle.Child = $num
      $lab = Text $s.label 10 (StateHex $s.state); $lab.HorizontalAlignment = 'Center'; $lab.Margin = '2,4,2,0'
      [void]$cell.Children.Add($circle); [void]$cell.Children.Add($lab)
      [void]$u.Children.Add($cell)
    }
    [void]$sp.Children.Add($u)
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
  $body = $(if ($hash -eq 'widget.html') { @{ kind = 'widget' } } else { @{ kind = 'app'; hash = $hash } }) | ConvertTo-Json -Compress
  $wc = New-Object System.Net.WebClient
  $wc.Headers.Add('X-Circle', '1'); $wc.Headers.Add('Content-Type', 'application/json')
  $wc.Add_UploadStringCompleted({ param($s, $e) if ($e.Error) { Open-Directly ([string]$e.UserState) }; $s.Dispose() })
  $wc.UploadStringAsync([Uri]"$base/api/desktop/open", 'POST', $body, $hash)
}

function Open-Directly([string]$hash) {
  $url = "$base/$hash"
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

$menuTemplate = $null
function New-Menu($win) {
  $m = New-Object System.Windows.Controls.ContextMenu
  $add = { param($label, $action) $mi = New-Object System.Windows.Controls.MenuItem; $mi.Header = $label; $mi.Add_Click($action); [void]$m.Items.Add($mi); return $mi }
  [void](& $add 'Open Circle Studio' { Open-App '#/' })
  [void](& $add 'Edit widgets...' { Open-App '#/widgets' })
  [void](& $add 'Refresh now' { Refresh })
  $top = & $add 'Keep on top of windows' { $saved.onTop = -not $saved.onTop; Save-State; Apply-Layer }
  $top.IsCheckable = $true; $top.IsChecked = $saved.onTop
  [void]$m.Items.Add((New-Object System.Windows.Controls.Separator))
  [void](& $add 'Close desktop widgets' { $app.Shutdown() })
  return $m
}

function Apply-Layer {
  foreach ($w in $windows.Values) {
    $h = (New-Object System.Windows.Interop.WindowInteropHelper($w)).Handle
    if ($saved.onTop) { [CsDesk]::Free($h); $w.Topmost = $true } else { $w.Topmost = $false; [CsDesk]::OnDesktop($h) }
  }
}

function New-TileWindow($t, [int]$i) {
  $wh = Size-Of $t.size
  $w = New-Object System.Windows.Window
  $w.WindowStyle = 'None'; $w.AllowsTransparency = $true; $w.Background = [System.Windows.Media.Brushes]::Transparent
  $w.ShowInTaskbar = $false; $w.ResizeMode = 'NoResize'; $w.ShowActivated = $false
  $w.Width = $wh[0] + 24; $w.Height = $wh[1] + 24
  $w.Title = "Circle Studio - $($t.title)"
  $pos = $saved.positions[$t.key]
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
    try { $sender.DragMove() } catch { }
    if ([Math]::Abs($sender.Left - $x) -lt 3 -and [Math]::Abs($sender.Top - $y) -lt 3) {
      if ($sender.Tag.key -eq 'offline') { Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $appRoot 'scripts\launch.vbs') + '" --background') }
      else { Open-App $sender.Tag.url }
    }
    else { $saved.positions[$sender.Tag.key] = @{ x = $sender.Left; y = $sender.Top }; Save-State }
  })
  $w.Add_SourceInitialized({ param($sender, $e) $h = (New-Object System.Windows.Interop.WindowInteropHelper($sender)).Handle; [CsDesk]::Tool($h); if ($saved.onTop) { $sender.Topmost = $true } else { [CsDesk]::OnDesktop($h) } })
  $w.ContextMenu = New-Menu $w
  return $w
}

function Paint($w, $t) {
  $card = $w.Content
  $card.Background = Brush $script:pal.raised
  $card.BorderBrush = Brush $script:pal.line
  $card.Child = Build-Tile $t
  $w.Tag = @{ key = $t.key; url = $(if ($t.url) { $t.url } else { '#/' }) }
}

function Theme { try { $v = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme; if ($v -eq 1) { 'light' } else { 'dark' } } catch { 'dark' } }

$script:offline = $null
function Refresh {
  try {
    $feed = Invoke-RestMethod -Uri "$base/api/widgets/feed?theme=$(Theme)" -TimeoutSec 20
  } catch {
    if (-not $script:pal) { $script:pal = @{ raised = '#202828'; line = '#2d3535'; text = '#e0e8e8'; soft = '#afbaba'; sunken = '#0b1111'; lineStrong = '#6a7b7c'; ok = '#6fd087'; warn = '#f9aa60'; info = '#8fb9f7'; danger = '#ff847f'; gate = '#dbbb56'; accent = '#29a0a6'; onAccent = '#020e0e' } }
    $feed = @{ tiles = @(@{ key = 'offline'; kind = 'inbox'; size = 's'; title = 'Circle Studio'; empty = 'Not running. Click to start it.'; url = '#/' }) }
    $script:offline = $true
  }
  if ($feed.palette) { $script:pal = @{}; foreach ($p in $feed.palette.PSObject.Properties) { $script:pal[$p.Name] = $p.Value }; $script:offline = $false }
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

$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnExplicitShutdown'
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(15)
$logFile = Join-Path $DataDir 'desktop-widgets.log'
function Safe-Refresh { try { Refresh } catch { Add-Content -Path $logFile -Value ((Get-Date).ToString('s') + ' ' + $_.Exception.Message + ' ' + $_.InvocationInfo.PositionMessage) } }
$timer.Add_Tick({ Safe-Refresh })
$app.Add_Startup({ Safe-Refresh; $timer.Start() })
$app.Add_Exit({ try { Remove-Item -Path (Join-Path $DataDir 'desktop-widgets.pid') -ErrorAction SilentlyContinue } catch { }; $mutex.ReleaseMutex() })
[void]$app.Run()
