# deploy.ps1 - copy every source file into the packaged app and restart.
# Use this instead of copying files by hand: forgetting main.js or preload.js
# produces silent no-ops in the UI (an IPC call that simply is not registered).

$ErrorActionPreference = 'Stop'

$src  = $PSScriptRoot
$prog = Join-Path $env:LOCALAPPDATA 'Programs\shrimp-term'
$app  = Join-Path $prog 'resources\app'

if (-not (Test-Path (Join-Path $prog 'ShrimpTerm.exe'))) {
  throw "packaged app not found at $prog - build it first"
}

Write-Host '==> stopping running instance' -ForegroundColor Cyan
Get-Process ShrimpTerm -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host '==> syncing sources' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $app 'renderer\assets'), (Join-Path $app 'assets') | Out-Null

foreach ($f in 'package.json', 'main.js', 'preload.js') {
  Copy-Item (Join-Path $src $f) $app -Force
  Write-Host "    $f"
}

# hosts.json 是本地运行数据（不入库）：源码里有就覆盖，没有就保留目标端已有的，
# 两边都没有才用 hosts.example.json 兜底，避免新克隆仓库首次部署直接报错。
$hSrc = Join-Path $src 'hosts.json'
$hDst = Join-Path $app 'hosts.json'
if (Test-Path $hSrc) {
  Copy-Item $hSrc $hDst -Force
  Write-Host '    hosts.json'
} elseif (-not (Test-Path $hDst)) {
  Copy-Item (Join-Path $src 'hosts.example.json') $hDst -Force
  Write-Host '    hosts.json (来自 hosts.example.json，请改成你自己的主机)' -ForegroundColor Yellow
} else {
  Write-Host '    hosts.json (保留已存在的配置)'
}
foreach ($f in 'index.html', 'app.js') {
  Copy-Item (Join-Path $src "renderer\$f") (Join-Path $app 'renderer') -Force
  Write-Host "    renderer\$f"
}
Copy-Item (Join-Path $src 'renderer\vendor\*') (Join-Path $app 'renderer\vendor') -Force
Write-Host '    renderer\vendor\*'
Copy-Item (Join-Path $src 'assets\*') (Join-Path $app 'assets') -Force
Copy-Item (Join-Path $src 'assets\shrimp-256.png') (Join-Path $app 'renderer\assets') -Force
Write-Host '    assets\*'

# runtime dependencies (ssh2, iconv-lite and their transitive deps). Skipping this
# is what produced "Cannot find module 'iconv-lite'" on a previous deploy.
if (Test-Path (Join-Path $src 'node_modules')) {
  Write-Host '==> syncing node_modules' -ForegroundColor Cyan
  $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
  & $robocopy (Join-Path $src 'node_modules') (Join-Path $app 'node_modules') /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
  $pkgCount = (Get-ChildItem (Join-Path $app 'node_modules') -Directory -ErrorAction SilentlyContinue).Count
  Write-Host "    $pkgCount packages"
}

# --- sanity: every preload channel must have a main handler
$pre  = (Select-String -Path (Join-Path $app 'preload.js') -Pattern "invoke\('([a-z:]+)'" -AllMatches).Matches |
          ForEach-Object { $_.Groups[1].Value }
$main = (Select-String -Path (Join-Path $app 'main.js') -Pattern "ipcMain\.handle\('([a-z:]+)'" -AllMatches).Matches |
          ForEach-Object { $_.Groups[1].Value }
$missing = $pre | Where-Object { $main -notcontains $_ }
if ($missing) {
  Write-Host "==> WARNING: preload channels without a main handler: $($missing -join ', ')" -ForegroundColor Yellow
} else {
  Write-Host "==> ipc ok ($($pre.Count) channels)" -ForegroundColor Green
}

Write-Host '==> launching' -ForegroundColor Cyan
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$p = Start-Process -FilePath (Join-Path $prog 'ShrimpTerm.exe') -PassThru
Start-Sleep -Seconds 12
$proc = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
if ($proc) {
  Write-Host "    running (pid $($p.Id))" -ForegroundColor Green
} else {
  Write-Host '    process exited - check the app logs' -ForegroundColor Red
}
