@echo off
rem ============================================================
rem  hoax-fade.bat - window transparency slider (single file)
rem
rem  HOW TO USE: just double-click this file.
rem  No install needed - it uses the PowerShell built into Windows.
rem
rem  HOW IT WORKS: the PowerShell source is stored at the bottom of
rem  this same file, after the ::PS + BEGIN marker line. This header
rem  extracts that tail into %TEMP% and runs it. One file to carry.
rem ============================================================

setlocal
set "PSFILE=%TEMP%\hoax-fade.ps1"

rem Tell the PowerShell part where the real .bat lives. It is extracted into
rem %TEMP%, so it cannot know its own original path - and it needs that path
rem to register itself as a startup program.
set "HOAXFADE_SRC=%~f0"

rem Extract the tail. The marker is written as 'PS'+'BEGIN' so that this
rem line itself does not match the search - otherwise we would cut here.
powershell -NoProfile -WindowStyle Hidden -Command "$l = Get-Content -LiteralPath '%~f0' -Encoding UTF8; $m = $l | Select-String -Pattern ('PS'+'BEGIN') | Select-Object -First 1; if ($m) { $l[$m.LineNumber..($l.Count-1)] | Set-Content -LiteralPath ($env:TEMP + '\hoax-fade.ps1') -Encoding UTF8 }"

if not exist "%PSFILE%" (
  echo [!] Failed to unpack. PowerShell may be blocked on this PC.
  pause
  exit /b 1
)

start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%PSFILE%"
exit /b

::PSBEGIN
# ============================================================
#  창 투명도 슬라이더 (설치 불필요)
#
#  이 아래는 hoax-fade.bat 안에 들어 있는 PowerShell 본문이다.
#  bat 을 더블클릭하면 이 부분만 %TEMP% 로 뽑혀 나가 실행된다.
# ============================================================
#
#  왜 이게 필요한가:
#    브라우저 안(웹 페이지)에서는 "뒤가 비치는 진짜 투명"이 불가능하다.
#    페이지는 자기 창 안쪽만 그릴 수 있어서 CSS opacity 를 내려봐야 흰 배경만 나온다.
#    창 자체를 반투명하게 만드는 건 윈도우가 해주는 일(WS_EX_LAYERED)이고, 그게 이 스크립트다.
#
#  쓰는 법:
#    화면 우상단에 작은 알약 모양 바가 뜬다. 슬라이더를 내리면 게임 창이 반투명해진다.
#      ↻      게임 창 다시 찾기
#      ✕      닫기 (닫으면 게임 창은 자동으로 원래대로)
#      우클릭  시작프로그램 등록 / 닫기
#    바 자체를 잡아끌면 위치를 옮길 수 있다.
#
#  대상 창을 "제목으로" 찾는 이유:
#    창 목록을 띄워 고르게 하면 콤보박스가 필요하고, 그러면 바가 커진다.
#    게임 사이트를 띄운 브라우저 창은 제목에 'Hoax Minigames' 가 들어가므로 그걸로 찾는다.
#    한 번 찾으면 핸들을 기억하니, 그 뒤에 다른 탭으로 옮겨가도 계속 물고 있다.
#
#  디자인 메모:
#    기본 WinForms 컨트롤(TrackBar/Button/ComboBox)은 크고 투박해서 전부 직접 그린다.
#    바는 평소 흐릿하게 떠 있다가 마우스를 올리면 선명해진다 — 늘 떠 있어야 하니까
#    시야에 걸리적거리면 안 된다.
# ============================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public class HoaxWin {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    // GWL_EXSTYLE 은 32비트 값이라 x86/x64 양쪽에서 SetWindowLongW 로 충분하다.
    // (SetWindowLongPtrW 는 x86 user32 가 export 하지 않아 오히려 깨질 수 있다)
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll")]
    public static extern bool SetLayeredWindowAttributes(IntPtr hWnd, uint crKey, byte bAlpha, uint dwFlags);

    [DllImport("user32.dll")]
    public static extern bool RedrawWindow(IntPtr hWnd, IntPtr lprc, IntPtr hrgn, uint flags);

    // 테두리 없는 창을 잡아끌기 위한 것 — 제목 표시줄을 누른 것처럼 속인다
    [DllImport("user32.dll")]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    // 둥근 모서리
    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int w, int h);
}
"@

$GWL_EXSTYLE   = -20
$WS_EX_LAYERED = 0x80000
$LWA_ALPHA     = 0x2
# RDW_ERASE | RDW_INVALIDATE | RDW_FRAME | RDW_ALLCHILDREN
$RDW_ALL       = 0x4 -bor 0x1 -bor 0x400 -bor 0x80

# 게임 사이트를 띄운 브라우저 창 제목에 항상 들어가는 문자열 (index.html 의 <title>)
$GAME_TITLE = 'Hoax Minigames'

# 시작프로그램 등록 위치. 관리자 권한이 필요 없는 현재 사용자 영역.
$RUN_KEY  = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$RUN_NAME = 'HoaxFade'

# ------------------------------------------------------------
# 치수 / 색
# ------------------------------------------------------------
$W = 196          # 전체 폭. 늘 떠 있는 물건이라 최대한 작게.
$H = 26

$X_DOT    = 11                     # 대상 상태 점
$X_TRACK0 = 24                     # 슬라이더 시작
$X_TRACK1 = 112                    # 슬라이더 끝
$X_PCT    = 120                    # 퍼센트 글자
$X_CYCLE  = 161                    # ↻
$X_CLOSE  = 180                    # ✕

$C_BG     = [System.Drawing.Color]::FromArgb(28, 32, 36)
$C_TRACK  = [System.Drawing.Color]::FromArgb(70, 78, 84)
$C_ACCENT = [System.Drawing.Color]::FromArgb(62, 190, 170)   # 사이트 청록 계열
$C_THUMB  = [System.Drawing.Color]::FromArgb(245, 250, 249)
$C_TEXT   = [System.Drawing.Color]::FromArgb(205, 214, 218)
$C_DIM    = [System.Drawing.Color]::FromArgb(130, 140, 146)
$C_OK     = [System.Drawing.Color]::FromArgb(110, 217, 179)
$C_LOST   = [System.Drawing.Color]::FromArgb(230, 120, 110)

$MIN = 20         # 더 내리면 창을 눈으로 못 찾아서 되돌리기 어려워진다
$MAX = 100

# ------------------------------------------------------------
# 게임 창 찾기 / 투명도
# ------------------------------------------------------------
function Find-GameWindow {
    param([IntPtr]$Exclude)

    $hit = [IntPtr]::Zero
    $hitTitle = ''
    $cb = [HoaxWin+EnumProc] {
        param($hWnd, $lParam)
        if ($hit -ne [IntPtr]::Zero) { return $false }
        if (-not [HoaxWin]::IsWindowVisible($hWnd)) { return $true }
        if ($hWnd -eq $Exclude) { return $true }
        $len = [HoaxWin]::GetWindowTextLength($hWnd)
        if ($len -le 0) { return $true }
        $sb = New-Object System.Text.StringBuilder ($len + 1)
        [void][HoaxWin]::GetWindowText($hWnd, $sb, $sb.Capacity)
        $t = $sb.ToString()
        if ($t -like "*$GAME_TITLE*") {
            $script:foundHandle = $hWnd
            $script:foundTitle  = $t
            return $false
        }
        return $true
    }
    $script:foundHandle = [IntPtr]::Zero
    $script:foundTitle  = ''
    [void][HoaxWin]::EnumWindows($cb, [IntPtr]::Zero)
    return $script:foundHandle
}

function Set-WindowAlpha {
    param([IntPtr]$Handle, [int]$Percent)
    if ($Handle -eq [IntPtr]::Zero -or -not [HoaxWin]::IsWindow($Handle)) { return }
    $ex = [HoaxWin]::GetWindowLong($Handle, $GWL_EXSTYLE)
    [void][HoaxWin]::SetWindowLong($Handle, $GWL_EXSTYLE, ($ex -bor $WS_EX_LAYERED))
    [void][HoaxWin]::SetLayeredWindowAttributes($Handle, 0, [byte][math]::Round($Percent * 255 / 100), $LWA_ALPHA)
}

function Reset-WindowAlpha {
    param([IntPtr]$Handle)
    if ($Handle -eq [IntPtr]::Zero -or -not [HoaxWin]::IsWindow($Handle)) { return }
    # 255 로 한 번 올린 뒤 LAYERED 를 떼야 잔상이 남지 않는다
    [void][HoaxWin]::SetLayeredWindowAttributes($Handle, 0, 255, $LWA_ALPHA)
    $ex = [HoaxWin]::GetWindowLong($Handle, $GWL_EXSTYLE)
    [void][HoaxWin]::SetWindowLong($Handle, $GWL_EXSTYLE, ($ex -band (-bnot $WS_EX_LAYERED)))
    [void][HoaxWin]::RedrawWindow($Handle, [IntPtr]::Zero, [IntPtr]::Zero, $RDW_ALL)
}

# ------------------------------------------------------------
# 시작프로그램 등록
# ------------------------------------------------------------
# hoax-fade.bat 이 자기 경로를 HOAXFADE_SRC 환경변수로 넘겨준다.
# (이 스크립트 자신은 %TEMP% 로 복사된 사본이라 자기 경로를 등록해봐야 소용없다)
function Test-AutoStart {
    $v = (Get-ItemProperty -Path $RUN_KEY -Name $RUN_NAME -ErrorAction SilentlyContinue).$RUN_NAME
    return -not [string]::IsNullOrEmpty($v)
}

function Enable-AutoStart {
    $src = $env:HOAXFADE_SRC
    if ([string]::IsNullOrEmpty($src) -or -not (Test-Path -LiteralPath $src)) {
        [System.Windows.Forms.MessageBox]::Show(
            "원본 hoax-fade.bat 의 위치를 알 수 없어 등록할 수 없습니다.`n`nbat 파일을 직접 더블클릭해서 실행한 경우에만 등록됩니다.",
            'hoax fade') | Out-Null
        return $false
    }
    Set-ItemProperty -Path $RUN_KEY -Name $RUN_NAME -Value ('"' + $src + '"')
    [System.Windows.Forms.MessageBox]::Show(
        "등록했습니다. 다음 부팅부터 자동으로 실행됩니다.`n`n$src`n`n※ 이 bat 파일을 옮기거나 지우면 자동 실행도 깨집니다.",
        'hoax fade') | Out-Null
    return $true
}

function Disable-AutoStart {
    Remove-ItemProperty -Path $RUN_KEY -Name $RUN_NAME -ErrorAction SilentlyContinue
    return $false
}

# ------------------------------------------------------------
# 상태
# ------------------------------------------------------------
$script:value    = 100
$script:target   = [IntPtr]::Zero
$script:dragging = $false
$script:hotCycle = $false
$script:hotClose = $false

# ------------------------------------------------------------
# 창
# ------------------------------------------------------------
$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.BackColor       = $C_BG
$form.TopMost         = $true
$form.ShowInTaskbar   = $false
$form.StartPosition   = 'Manual'
$form.ClientSize      = New-Object System.Drawing.Size($W, $H)
# 윈도우는 창 높이에 기본 하한(SM_CYMINTRACK, 보통 39px)을 걸어서 26px 로 안 줄어든다.
# MinimumSize 를 직접 지정하면 WinForms 가 그 하한을 자기 값으로 바꿔준다.
$form.MinimumSize     = New-Object System.Drawing.Size($W, $H)
$form.MaximumSize     = New-Object System.Drawing.Size($W, $H)
$form.Opacity         = 0.42        # 평소엔 흐릿 — 늘 떠 있으니 시야를 막으면 안 된다

# DoubleBuffered 는 Control 의 protected 속성이라 PowerShell 에서 직접 대입이 안 된다.
# 리플렉션으로 넣어야 슬라이더를 끌 때 깜빡이지 않는다.
[System.Windows.Forms.Control].GetProperty(
    'DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic'
).SetValue($form, $true, $null)

$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($wa.Right - $W - 18), ($wa.Top + 16))

# FromHrgn 이 이미 Region 을 돌려주므로 New-Object 로 또 감싸면 안 된다
$form.Region = [System.Drawing.Region]::FromHrgn(
    [HoaxWin]::CreateRoundRectRgn(0, 0, $W + 1, $H + 1, $H, $H))

$tip = New-Object System.Windows.Forms.ToolTip
$tip.InitialDelay = 260

function Acquire-Target {
    $h = Find-GameWindow -Exclude $form.Handle
    $script:target = $h
    if ($h -ne [IntPtr]::Zero) {
        $tip.SetToolTip($form, "대상: $($script:foundTitle)")
    } else {
        $tip.SetToolTip($form, "게임 창을 못 찾음`n게임 사이트를 연 뒤 ↻ 를 누르세요")
    }
}

# 값 ↔ x 좌표
function ValueToX { param([int]$v) return $X_TRACK0 + ($X_TRACK1 - $X_TRACK0) * ($v - $MIN) / ($MAX - $MIN) }
function XToValue {
    param([int]$x)
    $r = ($x - $X_TRACK0) / [double]($X_TRACK1 - $X_TRACK0)
    $v = [int][math]::Round($MIN + $r * ($MAX - $MIN))
    if ($v -lt $MIN) { $v = $MIN }
    if ($v -gt $MAX) { $v = $MAX }
    return $v
}

# ------------------------------------------------------------
# 우클릭 메뉴 — 폭을 안 먹으면서 설정을 넣을 수 있는 유일한 자리
# ------------------------------------------------------------
$menu     = New-Object System.Windows.Forms.ContextMenuStrip
$miAuto   = $menu.Items.Add('Windows 시작 시 자동 실행')
$null     = $menu.Items.Add('-')
$miClose  = $menu.Items.Add('닫기')
$miAuto.Checked = Test-AutoStart

$miAuto.Add_Click({
    if ($miAuto.Checked) { $miAuto.Checked = Disable-AutoStart }
    else                 { $miAuto.Checked = Enable-AutoStart }
})
$miClose.Add_Click({ $form.Close() })
$form.ContextMenuStrip = $menu

# ------------------------------------------------------------
# 그리기 — 기본 컨트롤을 안 쓰고 전부 직접
# ------------------------------------------------------------
$form.Add_Paint({
    $g = $_.Graphics
    $g.SmoothingMode     = 'AntiAlias'
    $g.TextRenderingHint = 'ClearTypeGridFit'

    $cy = [int]($H / 2)

    # 대상 상태 점 — 게임 창을 잡고 있으면 민트, 못 잡았으면 빨강
    $alive = ($script:target -ne [IntPtr]::Zero) -and [HoaxWin]::IsWindow($script:target)
    $dot = New-Object System.Drawing.SolidBrush ($(if ($alive) { $C_OK } else { $C_LOST }))
    $g.FillEllipse($dot, $X_DOT - 3, $cy - 3, 6, 6)
    $dot.Dispose()

    # 트랙
    $penBg = New-Object System.Drawing.Pen ($C_TRACK, 3)
    $penBg.StartCap = 'Round'; $penBg.EndCap = 'Round'
    $g.DrawLine($penBg, $X_TRACK0, $cy, $X_TRACK1, $cy)
    $penBg.Dispose()

    # 채워진 구간 + 손잡이
    $tx = [int](ValueToX $script:value)
    $penFg = New-Object System.Drawing.Pen ($(if ($alive) { $C_ACCENT } else { $C_DIM }), 3)
    $penFg.StartCap = 'Round'; $penFg.EndCap = 'Round'
    $g.DrawLine($penFg, $X_TRACK0, $cy, $tx, $cy)
    $penFg.Dispose()

    $th = New-Object System.Drawing.SolidBrush $C_THUMB
    $g.FillEllipse($th, $tx - 5, $cy - 5, 10, 10)
    $th.Dispose()

    # 퍼센트
    $f = New-Object System.Drawing.Font ('Segoe UI', 8, [System.Drawing.FontStyle]::Bold)
    $b = New-Object System.Drawing.SolidBrush $C_TEXT
    $g.DrawString("$($script:value)%", $f, $b, $X_PCT, $cy - 8)
    $f.Dispose(); $b.Dispose()

    # ↻ / ✕ — 마우스가 올라간 쪽만 밝게
    $fi = New-Object System.Drawing.Font ('Segoe UI Symbol', 9)
    $bc = New-Object System.Drawing.SolidBrush ($(if ($script:hotCycle) { $C_TEXT } else { $C_DIM }))
    $g.DrawString([char]0x21BB, $fi, $bc, $X_CYCLE - 7, $cy - 9)
    $bc.Dispose()
    $bx = New-Object System.Drawing.SolidBrush ($(if ($script:hotClose) { $C_TEXT } else { $C_DIM }))
    $g.DrawString([char]0x2715, $fi, $bx, $X_CLOSE - 7, $cy - 9)
    $bx.Dispose()
    $fi.Dispose()
})

# ------------------------------------------------------------
# 마우스
# ------------------------------------------------------------
function InCycle { param($x) return ($x -ge $X_CYCLE - 9 -and $x -le $X_CYCLE + 9) }
function InClose { param($x) return ($x -ge $X_CLOSE - 9 -and $x -le $X_CLOSE + 9) }
function InTrack { param($x) return ($x -ge $X_TRACK0 - 7 -and $x -le $X_TRACK1 + 7) }

$form.Add_MouseEnter({ $form.Opacity = 0.96 })
$form.Add_MouseLeave({
    $form.Opacity = 0.42
    $script:hotCycle = $false; $script:hotClose = $false
    $form.Invalidate()
})

$form.Add_MouseDown({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Right) { return }  # 우클릭은 메뉴가 처리

    $x = $_.X
    if (InClose $x) { $form.Close(); return }
    if (InCycle $x) {
        # 다시 찾기 전에 지금 대상은 원래대로 — 반투명한 창이 남지 않게
        Reset-WindowAlpha -Handle $script:target
        Acquire-Target
        Set-WindowAlpha -Handle $script:target -Percent $script:value
        $form.Invalidate()
        return
    }
    if (InTrack $x) {
        $script:dragging = $true
        $script:value = XToValue $x
        Set-WindowAlpha -Handle $script:target -Percent $script:value
        $form.Invalidate()
        return
    }
    # 빈 곳을 누르면 창 끌기 (WM_NCLBUTTONDOWN / HTCAPTION)
    [void][HoaxWin]::ReleaseCapture()
    [void][HoaxWin]::SendMessage($form.Handle, 0xA1, 2, 0)
})

$form.Add_MouseMove({
    $x = $_.X
    if ($script:dragging) {
        $v = XToValue $x
        if ($v -ne $script:value) {
            $script:value = $v
            Set-WindowAlpha -Handle $script:target -Percent $v
            $form.Invalidate()
        }
        return
    }
    $hc = InCycle $x
    $hx = InClose $x
    if ($hc -ne $script:hotCycle -or $hx -ne $script:hotClose) {
        $script:hotCycle = $hc; $script:hotClose = $hx
        $form.Invalidate()
    }
})

$form.Add_MouseUp({ $script:dragging = $false })

# 게임 창이 닫히면 점을 빨갛게 — 1.5초마다만 확인하면 충분하다
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick({ $form.Invalidate() })
$timer.Start()

# 닫을 때 반드시 원복 — 안 그러면 반투명한 창이 그대로 남는다
$form.Add_FormClosing({
    $timer.Stop()
    Reset-WindowAlpha -Handle $script:target
})

Acquire-Target
[void]$form.ShowDialog()
