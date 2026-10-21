# 回滚：把 profile 恢复到安装前的样子（package.json + 移走插件目录）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\rollback-dsh.ps1
# 找不到备份时，退化为“从 package.json 里删掉插件两项 + 移走目录”。

param(
  [string]$Backup = 'F:\超分\dsh-galgame-room\.pre-install\package.json'
)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profile = Join-Path $dshHome 'profiles\desktop'
$pkgPath = Join-Path $profile 'package.json'
$target = Join-Path $profile 'node_modules\dsh-galgame-room'

if (Test-Path $Backup) {
  Copy-Item $Backup $pkgPath -Force
  Write-Host "已恢复 package.json ← $Backup"
} else {
  Write-Host "没找到备份（$Backup），改为从 package.json 里删掉插件条目。"
  $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($pkg.dependencies.PSObject.Properties.Name -contains 'dsh-galgame-room') {
    $pkg.dependencies.PSObject.Properties.Remove('dsh-galgame-room')
  }
  if ($pkg.dsh -and $pkg.dsh.profile) {
    $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-galgame-room' })
  }
  [IO.File]::WriteAllText($pkgPath, ($pkg | ConvertTo-Json -Depth 20), $utf8)
  Write-Host '已从 package.json 移除 dsh-galgame-room。'
}

if (Test-Path $target) {
  $moved = $target + '.removed-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Move-Item $target $moved
  Write-Host "插件目录已移走 → $moved"
} else {
  Write-Host '插件目录本来就不在，跳过。'
}

Write-Host ''
Write-Host '重启 DeepSeek Harness 即可回到安装前状态。'
