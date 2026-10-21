/**
 * 房间页契约冒烟测试（无浏览器）：
 * 模拟页面会发的请求顺序与 SSE 事件，验证前端依赖的字段都在。
 *
 *   node scripts/smoke-events.mjs
 *   $env:GALGAME_ROOM_BASE='http://127.0.0.1:7303'; node scripts/smoke-events.mjs
 */
import assert from 'node:assert/strict'

const base = process.env.GALGAME_ROOM_BASE || 'http://127.0.0.1:7303'

async function api(path, options = {}) {
  const { method = 'GET', token, body } = options
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${data.error ?? ''}`)
  return data
}

function parseEvent(chunk) {
  const event = { event: 'message', data: '' }
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) event.event = line.slice(7).trim()
    else if (line.startsWith('data: ')) event.data += line.slice(6)
  }
  return event
}

async function waitFor(events, predicate, timeoutMs = 4000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hit = events.find(predicate)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error('等待事件超时：' + events.map((e) => e.event).join(','))
}

// 1. 页面与静态资源
const home = await fetch(`${base}/`)
assert.equal(home.status, 200)
const homeHtml = await home.text()
assert.match(homeHtml, /id="create-form"/)
assert.match(homeHtml, /id="join-form"/)
assert.match(homeHtml, /class="mode-switch"/)
assert.match(homeHtml, /\/room-assets\/host\.js/)
assert.match(homeHtml, /\/room-assets\/dialog\.js/)
const dialogAsset = await fetch(`${base}/room-assets/dialog.js`)
assert.equal(dialogAsset.status, 200)

const network = await (await fetch(`${base}/api/network`)).json()
assert.ok(Array.isArray(network.addresses))
assert.ok(Number.isInteger(network.port))
assert.equal(typeof network.publicUrl, 'string')

const version = await (await fetch(`${base}/api/version`)).json()
assert.ok(typeof version.version === 'string' && version.version.length > 0)
assert.equal(version.protocol, 1)

// 公网地址可在运行时改（樱花隧道重建后地址会变，不用重载插件）
const setPublic = await api('/api/public-url', { method: 'POST', body: { url: 'example.test:7302' } })
assert.equal(setPublic.publicUrl, 'http://example.test:7302')
const withPublic = await (await fetch(`${base}/api/network`)).json()
assert.equal(withPublic.publicUrl, 'http://example.test:7302')
await api('/api/public-url', { method: 'POST', body: { url: '' } })

// 房主侧调试开关（默认关）
const settings = await (await fetch(`${base}/api/settings`)).json()
assert.equal(settings.saveReasoning, false)

// cosplay 人设卡列表（standalone 没有宿主，返回空数组也算通）
const cards = await (await fetch(`${base}/api/cards`)).json()
assert.ok(Array.isArray(cards.cards))

// 剧情包列表 + 制作页
const packs = await (await fetch(`${base}/api/packs`)).json()
assert.ok(Array.isArray(packs.packs))
const maker = await fetch(`${base}/make`)
assert.equal(maker.status, 200)
assert.match(await maker.text(), /id="char-list"/)

// 换端口接口：同端口是幂等 no-op（真换端口会断 SSE，冒烟测试不动）
const samePort = await (
  await fetch(`${base}/api/port`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: network.port }),
  })
).json()
assert.equal(samePort.port, network.port)

const page = await fetch(`${base}/room/SMOKE`)
assert.equal(page.status, 200)
assert.match(page.headers.get('content-type') ?? '', /text\/html/)
const html = await page.text()
assert.match(html, /\/room-assets\/room\.css/)
assert.match(html, /\/room-assets\/room\.js/)
assert.match(html, /id="join-screen"/)
assert.match(html, /id="messages"/)
assert.match(html, /id="member-list"/)
assert.match(html, /id="gm-bar"/)
for (const asset of ['room.css', 'room.js']) {
  const response = await fetch(`${base}/room-assets/${asset}`)
  assert.equal(response.status, 200, asset)
}
console.log('页面与静态资源 OK')

// 2. 建房 + 两人加入（页面同款调用）
const created = await api('/api/rooms', {
  method: 'POST',
  body: { title: '页面契约冒烟', gmName: '澪', sessionId: 'smoke-session' },
})
const roomId = created.room.id
assert.equal(created.room.sessionId, 'smoke-session')
const invite = created.inviteToken
const gmToken = created.gm.token

const player = await api(`/api/rooms/${roomId}/join`, {
  method: 'POST',
  body: { name: '小满', role: 'player', inviteToken: invite },
})
const viewer = await api(`/api/rooms/${roomId}/join`, {
  method: 'POST',
  body: { name: '阿透', role: 'spectator', inviteToken: invite },
})
assert.equal(player.role, 'player')
assert.equal(viewer.role, 'spectator')
console.log('建房与加入 OK：' + roomId)

// 3. 页面刷新后的恢复路径：用成员令牌读房间
const restored = await api(`/api/rooms/${roomId}`, { token: player.token })
assert.equal(restored.room.id, roomId)
console.log('成员令牌恢复 OK')

// 3.5 自我游玩：单人房间，别人进不来
const solo = await api('/api/rooms', { method: 'POST', body: { gmName: '澪', solo: true } })
assert.equal(solo.room.solo, true)
assert.equal(solo.room.maxPlayers, 1)
await assert.rejects(
  api(`/api/rooms/${solo.room.id}/join`, {
    method: 'POST',
    body: { name: '路人', inviteToken: solo.inviteToken },
  }),
  (error) => /单人/.test(error.message),
)
console.log('单人房间 OK')

// 4. SSE：页面用成员令牌订阅，先拿 snapshot
const controller = new AbortController()
const stream = await fetch(`${base}/api/rooms/${roomId}/events?t=${encodeURIComponent(viewer.token)}&since=0`, {
  headers: { accept: 'text/event-stream' },
  signal: controller.signal,
})
const events = []
const reader = stream.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
const pump = (async () => {
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        events.push(parseEvent(chunk))
      }
    }
  } catch {
    /* abort 正常退出 */
  }
})()

await waitFor(events, (e) => e.event === 'snapshot')
const snapshot = JSON.parse(events.find((e) => e.event === 'snapshot').data)
assert.equal(snapshot.room.id, roomId)
assert.ok(Array.isArray(snapshot.messages))
assert.ok(Array.isArray(snapshot.room.members))
console.log('SSE snapshot OK')

// 5. 玩家发言 → 观战端收到 message 与 ai 状态
await api(`/api/rooms/${roomId}/messages`, {
  method: 'POST',
  token: player.token,
  body: { text: '门后面是谁在呼吸？' },
})
const messageEvent = await waitFor(events, (e) => e.event === 'message' && e.data.includes('门后面'))
const message = JSON.parse(messageEvent.data).message
assert.equal(message.kind, 'user')
assert.equal(message.role, 'player')
console.log('message 事件 OK（seq=' + message.seq + '）')

// 6. 观众发言：能进消息流，但 inAiContext=false
const spectatorMessage = await api(`/api/rooms/${roomId}/messages`, {
  method: 'POST',
  token: viewer.token,
  body: { text: '我只是路过看看' },
})
assert.equal(spectatorMessage.message.inAiContext, false)
console.log('观众发言不进上下文 OK')

// 7. 房主改职位 → members 事件
await api(`/api/rooms/${roomId}/members/${viewer.memberId}`, {
  method: 'PATCH',
  token: gmToken,
  body: { role: 'player' },
})
const membersEvent = await waitFor(events, (e) => e.event === 'members')
const members = JSON.parse(membersEvent.data).members
assert.equal(members.find((m) => m.id === viewer.memberId).role, 'player')
console.log('改职位广播 OK')

// 8. 推进剧情 → ai 状态回到 idle
await api(`/api/rooms/${roomId}/advance`, { method: 'POST', token: gmToken })
await waitFor(events, (e) => e.event === 'ai' && e.data.includes('"idle"'), 8000)
console.log('推进剧情 OK')

// 9. 关闭房间 → room 事件
await api(`/api/rooms/${roomId}`, { method: 'DELETE', token: gmToken })
await waitFor(events, (e) => e.event === 'room' && e.data.includes('"closed":true'))
console.log('关闭房间广播 OK')

// 10. 房间列表能查到 + GM 重新开放（继续上次）
const listed = await api('/api/rooms')
const listedRoom = listed.rooms.find((room) => room.id === roomId)
assert.ok(listedRoom, '房间列表里应该有这间房')
assert.equal(listedRoom.closed, true)
const reopened = await api(`/api/rooms/${roomId}`, {
  method: 'PATCH',
  token: gmToken,
  body: { closed: false },
})
assert.equal(reopened.room.closed, false)
console.log('房间列表 + 重新开放 OK')

// 11. 永久删除（本机/ GM 都可）→ 列表与房间都没了
await api(`/api/rooms/${roomId}/purge`, { method: 'POST', token: gmToken })
await assert.rejects(
  api(`/api/rooms/${roomId}`, { token: gmToken }),
  (error) => /404/.test(error.message),
)
const afterPurge = await api('/api/rooms')
assert.ok(!afterPurge.rooms.some((room) => room.id === roomId))
console.log('永久删除 OK')

controller.abort()
await pump
console.log('\n全部通过 ✓')
