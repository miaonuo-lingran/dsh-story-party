# 阶段 1 验收脚本：建房 → 加入 → 发言 → AI 回复 → 拉历史 → 推进 → SSE
# 运行（Windows PowerShell 5.1 也可以，脚本内部已处理 UTF-8）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\acceptance.ps1
# 需要先起服务：$env:GALGAME_ROOM_PORT='7302'; node src/standalone.js

$ErrorActionPreference = 'Stop'

# PS 5.1 在中文系统上默认用 GBK 解码子进程输出；
# 本脚本所有 JSON 都走「curl -o 文件 → Get-Content -Encoding UTF8」，
# 不依赖控制台代码页。这里再顺手把控制台输出也切成 UTF-8。
$utf8 = [Text.UTF8Encoding]::new($false)
try { [Console]::OutputEncoding = $utf8 } catch { }
$OutputEncoding = $utf8

$base = if ($env:GALGAME_ROOM_BASE) { $env:GALGAME_ROOM_BASE } else { 'http://127.0.0.1:7302' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) 'galgame-room-acceptance'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Save-Body([hashtable]$obj) {
  $file = Join-Path $tmp ('body-' + [guid]::NewGuid().ToString('N') + '.json')
  [IO.File]::WriteAllText($file, ($obj | ConvertTo-Json -Compress -Depth 5), $utf8)
  return $file
}

# 调 API：响应先落到文件，再按 UTF-8 读回来解析。
# 这样不管控制台是 GBK 还是 UTF-8，拿到的都是原始 JSON。
function Curl-Json {
  param([string]$Method, [string]$ApiPath, [string]$Token, $Body)
  $resp = Join-Path $tmp ('resp-' + [guid]::NewGuid().ToString('N') + '.json')
  $curlArgs = @('-s', '-X', $Method, ($base + $ApiPath), '-o', $resp)
  if ($Token) { $curlArgs += @('-H', "authorization: Bearer $Token") }
  if ($null -ne $Body) {
    $curlArgs += @('-H', 'content-type: application/json', '--data-binary', "@$(Save-Body $Body)")
  }
  curl.exe @curlArgs | Out-Null
  $raw = Get-Content -Raw -Encoding UTF8 $resp
  if ([string]::IsNullOrWhiteSpace($raw)) { throw "空响应：$Method $ApiPath" }
  return $raw
}

function Show-Messages($messages) {
  foreach ($m in $messages) {
    $who = if ($m.kind -eq 'ai') { '【AI】' } else { $m.name + '(' + $m.role + ')' }
    Write-Host (('{0,3}  ' -f $m.seq) + $who.PadRight(14) + $m.text)
  }
}

Write-Host '== 0. 健康检查 =='
try {
  $health = Curl-Json 'GET' '/api/health' $null $null | ConvertFrom-Json
} catch {
  Write-Host "连不上 $base —— 先起服务：`$env:GALGAME_ROOM_PORT='7302'; node src/standalone.js"
  exit 1
}
Write-Host ("ok = {0}，现有房间 {1} 个" -f $health.ok, $health.rooms)
Write-Host ''

Write-Host '== 1. 建房（房主 = GM） =='
$create = Curl-Json 'POST' '/api/rooms' $null @{ title = '天台上的黄昏'; gmName = '澪' } | ConvertFrom-Json
$roomId = $create.room.id
$invite = $create.inviteToken
$gmToken = $create.gm.token
Write-Host ('房号: ' + $roomId + '  邀请令牌: ' + $invite.Substring(0, 8) + '...  GM令牌: ' + $gmToken.Substring(0, 8) + '...')
Write-Host ('开场设定: ' + (($create.room.scenario -split "`n")[0]))
Write-Host ''

Write-Host '== 2. 玩家「小满」加入 =='
$join = Curl-Json 'POST' "/api/rooms/$roomId/join" $null @{ name = '小满'; inviteToken = $invite } | ConvertFrom-Json
$playerToken = $join.token
Write-Host ('加入成功: ' + $join.member.name + ' / ' + $join.member.role)
Write-Host ''

Write-Host '== 3. 观众「阿透」加入（只读旁听） =='
$spec = Curl-Json 'POST' "/api/rooms/$roomId/join" $null @{ name = '阿透'; role = 'spectator'; inviteToken = $invite } | ConvertFrom-Json
$specToken = $spec.token
Write-Host ('加入成功: ' + $spec.member.name + ' / ' + $spec.member.role)
Write-Host ''

Write-Host '== 4. 玩家发言（带问句 → AI 应该接话） =='
$null = Curl-Json 'POST' "/api/rooms/$roomId/messages" $playerToken @{ text = '门后面好像有脚步声……我们要不要进去看看？' }
Write-Host '已发送，等 AI 判断…'
Start-Sleep -Milliseconds 2200

Write-Host '== 5. 观众发言（不进 AI 上下文，也不触发模型） =='
$null = Curl-Json 'POST' "/api/rooms/$roomId/messages" $specToken @{ text = '我就看看不说话，你们继续。' }
Start-Sleep -Milliseconds 800
Write-Host '已发送'
Write-Host ''

Write-Host '== 6. 玩家闲聊（AI 应选择性沉默） =='
$null = Curl-Json 'POST' "/api/rooms/$roomId/messages" $playerToken @{ text = '今天风好舒服啊。' }
Write-Host '已发送'
Start-Sleep -Milliseconds 2200

Write-Host '== 7. 拉历史（since=0，等价新客户端进房） =='
$hist = Curl-Json 'GET' "/api/rooms/$roomId/messages?since=0&t=$invite" $null $null | ConvertFrom-Json
Show-Messages $hist.messages
Write-Host ('ai.status = ' + $hist.ai.status + '，seq = ' + $hist.seq + '（第 6 步的闲聊没有新 AI 消息 = 沉默生效）')
Write-Host ''

Write-Host '== 8. GM 推进剧情（强制 AI 开口） =='
$null = Curl-Json 'POST' "/api/rooms/$roomId/advance" $gmToken $null
Start-Sleep -Milliseconds 1500

Write-Host '== 9. 增量拉取（since=4，只看新消息） =='
$inc = Curl-Json 'GET' "/api/rooms/$roomId/messages?since=4&t=$invite" $null $null | ConvertFrom-Json
Show-Messages $inc.messages
Write-Host ''

Write-Host '== 10. 成员列表 =='
$members = Curl-Json 'GET' "/api/rooms/$roomId/members?t=$invite" $null $null | ConvertFrom-Json
$members.members | Format-Table id, name, role, online -AutoSize

Write-Host '== 11. SSE 实时广播（第二个客户端，边发边看） =='
$sseFile = Join-Path $tmp 'sse.log'
if (Test-Path $sseFile) { Remove-Item $sseFile -Force }
$proc = Start-Process -FilePath 'curl.exe' -ArgumentList @('-sN', '--max-time', '5', "$base/api/rooms/$roomId/events?t=$invite", '-o', $sseFile) -NoNewWindow -PassThru
Start-Sleep -Milliseconds 800
$null = Curl-Json 'POST' "/api/rooms/$roomId/messages" $playerToken @{ text = '等等……门后是谁在呼吸？' }
Start-Sleep -Milliseconds 2200
Stop-Process -Id $proc.Id -ErrorAction SilentlyContinue
foreach ($line in (Get-Content $sseFile -Encoding UTF8)) {
  if ($line.StartsWith('event: ')) { Write-Host ('  <-- ' + $line) }
  elseif ($line.StartsWith('data: ') -and $line.Contains('"kind":"ai"')) {
    Write-Host ('  AI 广播: ' + $line.Substring(0, [Math]::Min(150, $line.Length)) + '…')
  }
}
Write-Host ''
Write-Host '验收结束。房号与服务端日志见上方输出。'
