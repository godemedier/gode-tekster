param([string]$Out)
# Skærmbillede af Gode Tekster-vinduet til PNG. GetWindowRect tager Windows' usynlige
# vindueskant med (8 px i siderne og bunden, sort på billedet), så billedet skæres til vinduets
# synlige grænser fra DWM (DWMWA_EXTENDED_FRAME_BOUNDS) (7/10).
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Snap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$p = Get-Process gode-tekster | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { "intet vindue"; exit 1 }
$r = New-Object Snap+RECT
[Snap]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.R - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[Snap]::PrintWindow($p.MainWindowHandle, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$g.Dispose()
# Den synlige del af vinduet. Fejler DWM, gemmes hele rektanglet som før.
$v = New-Object Snap+RECT
if ([Snap]::DwmGetWindowAttribute($p.MainWindowHandle, 9, [ref]$v, 16) -eq 0) {
  $crop = New-Object System.Drawing.Rectangle ($v.L - $r.L), ($v.T - $r.T), ($v.R - $v.L), ($v.B - $v.T)
  $visible = $bmp.Clone($crop, $bmp.PixelFormat)
  $bmp.Dispose()
  $bmp = $visible
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"$($bmp.Width) x $($bmp.Height) gemt"
