# TuneDeck build (PowerShell only - no Node.js needed)
# 1) download the official Electron runtime for Windows
# 2) put the TuneDeck app files inside it
# 3) rename electron.exe -> TuneDeck.exe and set the icon

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ElectronVersion = '33.4.11'
$Root  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cache = Join-Path $Root '.cache'
$Out   = Join-Path $Root 'dist\TuneDeck-win32-x64'
$Exe   = Join-Path $Out 'TuneDeck.exe'

function Step($text) { Write-Host ''; Write-Host $text -ForegroundColor Cyan }
function Fail($text) {
  Write-Host ''
  Write-Host "[!] $text" -ForegroundColor Red
  exit 1
}

function Copy-AppFiles {
  $App = Join-Path $Out 'resources\app'
  if (Test-Path $App) { Remove-Item -Recurse -Force $App }
  New-Item -ItemType Directory -Force -Path $App | Out-Null
  foreach ($f in 'bootstrap.js', 'main.js', 'preload.js', 'updater.js', 'package.json', 'version.json') {
    Copy-Item (Join-Path $Root $f) $App
  }
  Copy-Item -Recurse (Join-Path $Root 'renderer') $App
  Copy-Item -Recurse (Join-Path $Root 'assets') $App
}

try {
  New-Item -ItemType Directory -Force -Path $Cache | Out-Null

  # ---------- Close TuneDeck if it is running (its files would be locked) ----------
  $running = Get-Process -Name 'TuneDeck' -ErrorAction SilentlyContinue
  if ($running) {
    Step 'Closing the running TuneDeck...'
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
  }

  # ---------- Quick update: Electron already in place -> only refresh app files ----------
  $Stamp = Join-Path $Out 'electron-version.txt'
  if ((Test-Path $Exe) -and (Test-Path $Stamp) -and ((Get-Content $Stamp -Raw).Trim() -eq $ElectronVersion)) {
    Step 'Updating TuneDeck (quick update)...'
    Copy-AppFiles
    Write-Host ''
    Write-Host '==============================================' -ForegroundColor Green
    Write-Host '  UPDATED! Starting TuneDeck...' -ForegroundColor Green
    Write-Host '==============================================' -ForegroundColor Green
    Start-Process $Exe
    exit 0
  }

  # ---------- 1. Electron runtime ----------
  $zipName = "electron-v$ElectronVersion-win32-x64.zip"
  $zip = Join-Path $Cache $zipName
  if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 50MB) {
    Step "[1/4] Downloading Electron $ElectronVersion (~110MB, first time only)..."
    $url = "https://github.com/electron/electron/releases/download/v$ElectronVersion/$zipName"
    $part = "$zip.part"
    Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing
    if ((Get-Item $part).Length -lt 50MB) { Fail 'Download looks incomplete. Check your internet connection and run build.bat again.' }
    Move-Item -Force $part $zip
  } else {
    Step '[1/4] Electron already downloaded.'
  }

  # ---------- 2. Unpack ----------
  Step '[2/4] Unpacking...'
  if (Test-Path $Out) {
    try { Remove-Item -Recurse -Force $Out }
    catch { Fail 'Could not replace the old build. Quit TuneDeck (tray icon > right-click > quit) and run build.bat again.' }
  }
  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $Out)

  Rename-Item (Join-Path $Out 'electron.exe') 'TuneDeck.exe'
  $defaultApp = Join-Path $Out 'resources\default_app.asar'
  if (Test-Path $defaultApp) { Remove-Item -Force $defaultApp }

  # ---------- 3. App files ----------
  Step '[3/4] Copying TuneDeck files...'
  Copy-AppFiles

  # ---------- 4. Icon (optional) ----------
  Step '[4/4] Setting the app icon...'
  try {
    $rcedit = Join-Path $Cache 'rcedit-x64.exe'
    if (-not (Test-Path $rcedit)) {
      Invoke-WebRequest -Uri 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe' -OutFile $rcedit -UseBasicParsing
    }
    & $rcedit $Exe `
      --set-icon (Join-Path $Root 'assets\icon.ico') `
      --set-version-string 'ProductName' 'TuneDeck' `
      --set-version-string 'FileDescription' 'TuneDeck' `
      --set-version-string 'OriginalFilename' 'TuneDeck.exe' `
      --set-version-string 'CompanyName' 'TuneDeck'
    if ($LASTEXITCODE -ne 0) { throw "rcedit exit code $LASTEXITCODE" }
  } catch {
    Write-Host '    (Icon could not be set - the app still works, it just shows the default icon.)' -ForegroundColor Yellow
  }

  # ---------- Check (antivirus may delete a brand-new unsigned exe) ----------
  Start-Sleep -Seconds 4
  if (-not (Test-Path $Exe)) {
    Fail ("TuneDeck.exe was created and then deleted - probably by Windows Defender.`n" +
          "    Open Windows Security > Virus & threat protection > Protection history and restore it,`n" +
          "    or add this folder as an exclusion and run build.bat again:`n    $Root")
  }

  # Remember the Electron version so the next build.bat can do a quick update
  Set-Content -Path $Stamp -Value $ElectronVersion

  # ---------- Desktop shortcut ----------
  try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $sc = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop 'TuneDeck.lnk'))
    $sc.TargetPath = $Exe
    $sc.WorkingDirectory = $Out
    $sc.IconLocation = "$Exe,0"
    $sc.Save()
    $shortcutMsg = 'Desktop shortcut created: TuneDeck'
  } catch {
    $shortcutMsg = '(Could not create a desktop shortcut.)'
  }

  Write-Host ''
  Write-Host '==============================================' -ForegroundColor Green
  Write-Host '  DONE!' -ForegroundColor Green
  Write-Host "  $Exe" -ForegroundColor Green
  Write-Host '==============================================' -ForegroundColor Green
  Write-Host $shortcutMsg
  Write-Host 'Next time: extract a new zip over this same folder and run build.bat - it updates in seconds.'
  Start-Process $Exe
  exit 0
}
catch {
  Write-Host ''
  Write-Host '[!] Build failed:' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host 'Please copy this window and send it.' -ForegroundColor Red
  exit 1
}
