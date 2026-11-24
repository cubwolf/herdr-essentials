# Smoke test for the helper on Windows (the counterpart of smoke.sh). It opens one small always-on-top
# window on the desktop for about 15 seconds: no mouse or keyboard input is sent, nothing is brought to the front.
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\k-float\tests\smoke.ps1 [-Bin <k-float.exe>] [-Shot <file.png>]
# Run it in the interactive desktop session (a terminal there, or `hc exec --on <machine>`); not over ssh.
param(
  [string]$Bin = (Join-Path $PSScriptRoot "..\target\release\k-float.exe"),
  [string]$Shot = ""
)
$ErrorActionPreference = "Stop"
$D = Join-Path $env:TEMP ("k-float-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path "$D\windows" -Force | Out-Null
$script:fail = 0
function ok($m) { Write-Output "ok   $m" }
function bad($m) { Write-Output "FAIL $m"; $script:fail = 1 }
function check($name, $cond) { if ($cond) { ok $name } else { bad $name } }
function events { if (Test-Path "$D\events\demo.jsonl") { @(Get-Content "$D\events\demo.jsonl" -Encoding UTF8) } else { @() } }
function has($name, $text) { check $name ([bool](events | Where-Object { $_.Contains($text) })) }
function spec($o, [switch]$Bom) {
  [IO.File]::WriteAllText("$D\windows\demo.json", ($o | ConvertTo-Json -Compress -Depth 5), (New-Object Text.UTF8Encoding($Bom.IsPresent)))
}

Add-Type @"
using System; using System.Runtime.InteropServices;
public class KFloatWin {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public struct RECT { public int L, T, R, B; }
}
"@
function win { [KFloatWin]::FindWindow([NullString]::Value, "k-float-smoke") }   # $null would arrive as "", which matches no window class
function exstyle { [KFloatWin]::GetWindowLong((win), -20) }

$html = "<body style='font:16px sans-serif;background:#fff7c2;margin:14px'><b>k-float smoke test</b><h3 id=h>hello</h3><p style='font-size:12px'>closes itself</p><script>float.onData(d=>{h.textContent='count '+d.count;float.send({got:d.count})})</script></body>"
$s = @{ title = "k-float-smoke"; x = 160; y = 160; width = 300; height = 170; html = $html; data = @{ count = 1 } }
spec $s

$front = [KFloatWin]::GetForegroundWindow()
$r = & $Bin start $D
check "start ($r)" ($r -like "started*")
Start-Sleep -Seconds 5
check "second start is a no-op" ((& $Bin start $D) -eq "running")
has "ready event" '"type":"ready"'
has "page got the first data and answered" '"data":{"got":1}'
check "window exists and is visible" ((win) -ne [IntPtr]::Zero -and [KFloatWin]::IsWindowVisible((win)))
check "always on top (WS_EX_TOPMOST)" (((exstyle) -band 0x8) -ne 0)
check "did not take the foreground" ([KFloatWin]::GetForegroundWindow() -eq $front)
$rect = New-Object KFloatWin+RECT
[void][KFloatWin]::GetWindowRect((win), [ref]$rect)
Write-Output ("     window rect: {0},{1} {2}x{3}" -f $rect.L, $rect.T, ($rect.R - $rect.L), ($rect.B - $rect.T))

# A spec written the way Windows PowerShell 5 writes UTF-8 (with a byte order mark) must still be read.
$s.data = @{ count = 7 }; spec $s -Bom
Start-Sleep -Milliseconds 1500
has "data update (file with a BOM) reached the page" '"data":{"got":7}'
check "no reload on data update" (@(events | Where-Object { $_.Contains('"type":"ready"') }).Count -eq 1)

if ($Shot) {
  # The window and a margin around it: enough to show it sits on top of what is open there,
  # without photographing the whole screen (it is someone's desktop).
  Add-Type -AssemblyName System.Drawing
  $m = 140
  $w = ($rect.R - $rect.L) + 2 * $m; $h = ($rect.B - $rect.T) + 2 * $m
  $from = New-Object Drawing.Point(($rect.L - $m), ($rect.T - $m))
  $bmp = New-Object Drawing.Bitmap($w, $h)
  $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($from, [Drawing.Point]::Empty, (New-Object Drawing.Size($w, $h)))
  $bmp.Save($Shot, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
  Write-Output "     shot: $Shot"
}

$s.clickThrough = $true; spec $s
Start-Sleep -Milliseconds 1200
check "click-through (WS_EX_TRANSPARENT)" (((exstyle) -band 0x20) -ne 0)
check "no warning about click-through" (-not (events | Where-Object { $_.Contains('"type":"warning"') }))

Remove-Item "$D\windows\demo.json"
Start-Sleep -Milliseconds 1200
has "closed by spec" '"by":"spec"'
check "window gone" ((win) -eq [IntPtr]::Zero)

& $Bin stop $D | Out-Null
Start-Sleep -Milliseconds 800
check "stop ends the helper" (-not (Get-CimInstance Win32_Process -Filter "Name='k-float.exe'" | Where-Object { $_.CommandLine -like "*$D*" }))

if ($script:fail) { Write-Output "--- events"; events; Write-Output "--- log"; if (Test-Path "$D\helper.log") { Get-Content "$D\helper.log" } }
Remove-Item -Recurse -Force $D -ErrorAction SilentlyContinue
exit $script:fail
