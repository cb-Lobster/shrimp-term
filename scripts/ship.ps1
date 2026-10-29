# ship.ps1 - 一条命令把源码变成"桌面上那个能用的版本"
#   构建 → 打图标/版本 → 覆盖安装 → 保留用户数据 → 校验 → 修快捷方式
#
#   npm run ship                 装到默认位置
#   npm run ship -- -Target D:\X 装到自定义位置
#
param(
  [string]$Target = "D:\Apps\ShrimpTerm"
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$pkg = Get-Content 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $pkg.version
$runtime = @('settings.json', 'hosts.json', 'history.json')

Write-Host ''
Write-Host "==> ShrimpTerm $ver  ->  $Target" -ForegroundColor Cyan

# --- 0. 提醒：带上未提交的改动发布
$dirty = & git status --porcelain 2>$null
if ($dirty) {
  Write-Host "    注意：工作区有未提交改动，本次发布内容包含这些改动" -ForegroundColor Yellow
}

# --- 1. 停掉运行中的实例（文件被占用会拷贝失败）
$running = Get-Process ShrimpTerm -ErrorAction SilentlyContinue
if ($running) {
  foreach ($p in $running) { Write-Host "    停止运行中的实例 pid $($p.Id)" }
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 1500
}

# --- 2. 备份用户运行时数据
$bak = Join-Path $env:TEMP ("shrimp-ship-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $bak | Out-Null
foreach ($f in $runtime) {
  $src = Join-Path $Target "resources\app\$f"
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $bak $f) -Force
    Write-Host "    备份 $f"
  }
}

# --- 3. 构建
Write-Host '==> 构建' -ForegroundColor Cyan
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
& npx electron-builder --win --dir
if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }

$exe = "dist\win-unpacked\ShrimpTerm.exe"
if (-not (Test-Path $exe)) { throw "构建产物缺失：$exe" }

# --- 4. 写入图标与版本信息（electron-builder 在无管理员权限的机器上写不了）
$rcedit = Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign" `
  -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($rcedit) {
  & $rcedit.FullName $exe `
    --set-icon 'assets\shrimp.ico' `
    --set-version-string 'ProductName' 'ShrimpTerm' `
    --set-version-string 'FileDescription' 'ShrimpTerm - 极简 SSH 终端 + 运维助手' `
    --set-version-string 'CompanyName' 'cb-Lobster' `
    --set-version-string 'LegalCopyright' 'MIT (c) cb-Lobster' `
    --set-file-version "$ver.0" `
    --set-product-version $ver
  if ($LASTEXITCODE -ne 0) { throw "写入图标/版本失败（rcedit exit $LASTEXITCODE）" }
  Write-Host "    图标与版本已写入"
} else {
  Write-Host "    未找到 rcedit，跳过图标/版本写入（exe 会是 Electron 默认图标）" -ForegroundColor Yellow
}

# --- 5. 覆盖安装
Write-Host '==> 安装' -ForegroundColor Cyan
if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item 'dist\win-unpacked\*' $Target -Recurse -Force

# --- 6. 还原用户数据
foreach ($f in $runtime) {
  $src = Join-Path $bak $f
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $Target "resources\app\$f") -Force
    Write-Host "    还原 $f"
  }
}
Remove-Item $bak -Recurse -Force -ErrorAction SilentlyContinue

# --- 7. 校验
Write-Host '==> 校验' -ForegroundColor Cyan
$ok = $true
$gotVer = (Get-Item (Join-Path $Target 'ShrimpTerm.exe')).VersionInfo.ProductVersion
if ($gotVer -eq $ver) { Write-Host "    版本 $gotVer" } else { Write-Host "    版本不符：期望 $ver，实际 $gotVer" -ForegroundColor Red; $ok = $false }

$checks = @{
  'renderer\index.html'          = '界面'
  'renderer\app.js'              = '界面逻辑'
  'main.js'                      = '主进程'
  'renderer\assets\shrimp-256.png' = '图标资源'
}
foreach ($k in $checks.Keys) {
  if (Test-Path (Join-Path $Target "resources\app\$k")) { Write-Host "    $($checks[$k]) 就位" }
  else { Write-Host "    缺少 $k" -ForegroundColor Red; $ok = $false }
}

$dataCount = 0
foreach ($f in $runtime) { if (Test-Path (Join-Path $Target "resources\app\$f")) { $dataCount++ } }
Write-Host "    用户数据 $dataCount/3 份保留"

# --- 8. 桌面快捷方式
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ShrimpTerm.lnk'
$sh = New-Object -ComObject WScript.Shell
$want = Join-Path $Target 'ShrimpTerm.exe'
$need = $true
if (Test-Path $lnk) {
  $cur = $sh.CreateShortcut($lnk)
  if ($cur.TargetPath -eq $want) { $need = $false; Write-Host '    桌面快捷方式已正确' }
}
if ($need) {
  $s = $sh.CreateShortcut($lnk)
  $s.TargetPath = $want
  $s.WorkingDirectory = $Target
  $s.IconLocation = "$want,0"
  $s.Description = 'ShrimpTerm · 极简 SSH 终端 + 运维助手'
  $s.Save()
  Write-Host '    桌面快捷方式已更新'
}

Write-Host ''
if ($ok) {
  Write-Host "完成：双击桌面 ShrimpTerm 即可，版本 $ver" -ForegroundColor Green
} else {
  Write-Host "完成但有校验项未通过，请看上面的红字" -ForegroundColor Yellow
  exit 1
}
