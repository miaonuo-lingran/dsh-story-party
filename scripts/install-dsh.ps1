# 把 dsh-galgame-room 装进 DSH profile（复制 + 登记 bundles）。
# 会先备份 profile/package.json，再改两处：dependencies 与 dsh.profile.bundles。
# 运行：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-dsh.ps1
# 装完需要重启 DeepSeek Harness 才会加载。

$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profile = Join-Path $dshHome 'profiles\desktop'
$target = Join-Path $profile 'node_modules\dsh-galgame-room'
$pkgPath = Join-Path $profile 'package.json'

if (-not (Test-Path (Join-Path $src 'src\index.js'))) {
  throw "找不到插件源码：$src（脚本应位于插件目录的 scripts\ 下）"
}
if (-not (Test-Path $pkgPath)) {
  throw "找不到 profile 的 package.json：$pkgPath"
}

Write-Host "源目录:   $src"
Write-Host "目标目录: $target"
Write-Host "profile:  $profile"
Write-Host ''

# 1. 备份 profile/package.json
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgPath "$pkgPath.bak-$stamp"
Write-Host "[1/4] 已备份 package.json → package.json.bak-$stamp"

# 2. 复制插件本体（旧的先挪走，避免残留文件）
if (Test-Path $target) {
  $old = "$target.old-$stamp"
  Move-Item $target $old
  Write-Host "[2/4] 旧版本已挪到 $old"
}
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($dir in @('src', 'public', 'scripts')) {
  Copy-Item (Join-Path $src $dir) $target -Recurse -Force
}
foreach ($file in @('package.json', 'cordis.patch.yml', 'README.md')) {
  Copy-Item (Join-Path $src $file) (Join-Path $target $file) -Force
}
Write-Host "[2/4] 已复制到 node_modules\dsh-galgame-room"

# 3. 在 package.json 里登记依赖与 bundle（文本插入，保留原文件其余部分）
$utf8 = [Text.UTF8Encoding]::new($false)
$raw = [IO.File]::ReadAllText($pkgPath, $utf8)
$fileDep = 'file:' + ($src -replace '\\', '/')

if ($raw -notmatch '"dsh-galgame-room"') {
  $raw = $raw -replace '("dependencies"\s*:\s*\{)', ('${1}' + "`r`n    " + '"dsh-galgame-room": "' + $fileDep + '",')
}
if ($raw -notmatch '"bundles"\s*:\s*\[[^\]]*"dsh-galgame-room"') {
  $raw = $raw -replace '("bundles"\s*:\s*\[)', ('${1}' + "`r`n        " + '"dsh-galgame-room",')
}

# 写盘前先验证 JSON 没被改坏
$null = $raw | ConvertFrom-Json
[IO.File]::WriteAllText($pkgPath, $raw, $utf8)
Write-Host "[3/4] 已登记 dependencies 与 dsh.profile.bundles"

Write-Host "[4/4] 完成。重启 DeepSeek Harness 后生效。"
Write-Host ''
Write-Host '重启后检查：'
Write-Host '  - 日志出现：[galgame-room] 房间服务已监听 0.0.0.0:7302'
Write-Host '  - 本机验证：curl.exe -s http://127.0.0.1:7302/api/health'
Write-Host '  - 首次监听若弹 Windows 防火墙，勾选「专用网络」允许'
Write-Host ''
Write-Host '卸载：删掉 node_modules\dsh-galgame-room，并从 package.json 的'
Write-Host 'dependencies 与 dsh.profile.bundles 里删掉 dsh-galgame-room 一行。'
