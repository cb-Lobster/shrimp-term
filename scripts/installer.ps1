# installer.ps1 - 生成可分发的 Windows 安装包（NSIS）
#   构建免安装目录 -> 写入图标与版本 -> 用该目录打安装包 -> 报告产物
#
#   npm run installer
#
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$pkg = Get-Content 'package.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $pkg.version
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

Write-Host ''
Write-Host "==> ShrimpTerm $ver 安装包" -ForegroundColor Cyan

# 文件被占用会导致打包失败
$running = Get-Process ShrimpTerm -ErrorAction SilentlyContinue
if ($running) {
  foreach ($p in $running) { Write-Host "    停止运行中的实例 pid $($p.Id)" }
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 1500
}

# --- 1. 免安装目录
Write-Host '==> 1/3 构建应用目录' -ForegroundColor Cyan
& npx electron-builder --win --dir
if ($LASTEXITCODE -ne 0) { throw "构建失败（exit $LASTEXITCODE）" }
$exe = 'dist\win-unpacked\ShrimpTerm.exe'
if (-not (Test-Path $exe)) { throw "产物缺失：$exe" }

# --- 2. 图标与版本（electron-builder 在无管理员权限的机器上写不了，用 rcedit 补）
Write-Host '==> 2/3 写入图标与版本' -ForegroundColor Cyan
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
  if ($LASTEXITCODE -ne 0) { throw "rcedit 失败（exit $LASTEXITCODE）" }
  Write-Host '    图标与版本已写入'
} else {
  Write-Host '    未找到 rcedit，安装包里的 exe 会是 Electron 默认图标' -ForegroundColor Yellow
}

# 写入构建信息，让界面能显示“跑的是哪一版”
$commit = (& git rev-parse --short HEAD 2>$null)
$info = @{ version = $ver; commit = "$commit"; builtAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') } | ConvertTo-Json -Compress
[IO.File]::WriteAllText((Join-Path $root 'dist\win-unpacked\resources\app\build-info.json'), $info, (New-Object Text.UTF8Encoding $false))

# --- 3. 用已打包目录生成 NSIS 安装包（避免重新打包把图标覆盖掉）
Write-Host '==> 3/3 生成 NSIS 安装包' -ForegroundColor Cyan
& npx electron-builder --win nsis --prepackaged dist\win-unpacked
if ($LASTEXITCODE -ne 0) { throw "安装包生成失败（exit $LASTEXITCODE）" }

# --- 报告
$setup = Get-ChildItem 'dist' -Filter '*Setup*.exe' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host ''
if ($setup) {
  Write-Host ('安装包：' + $setup.FullName) -ForegroundColor Green
  Write-Host ('大小：  ' + [math]::Round($setup.Length / 1MB, 1) + ' MB')
  Write-Host ''
  Write-Host '分发说明：' -ForegroundColor Cyan
  Write-Host '  · 默认按当前用户安装（%LOCALAPPDATA%\Programs\ShrimpTerm），不需要管理员权限'
  Write-Host '  · 安装时可改路径；装到 Program Files 需要管理员权限，但数据已放用户目录，不影响使用'
  Write-Host '  · 未做代码签名，首次运行可能被 SmartScreen 拦一下（更多信息 → 仍要运行）'
  Write-Host '  · 卸载：设置 → 应用 → ShrimpTerm；用户数据保留在 %APPDATA%\ShrimpTerm'
} else {
  Write-Host '未找到安装包产物，请检查 dist 目录' -ForegroundColor Red
  exit 1
}
