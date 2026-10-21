/**
 * standalone 入口 —— 不开 DSH，直接把房间服务跑起来，用于 curl 自检。
 *
 * 模型是 mock：只在「玩家提问 / 叫旁白 / GM 推进」时接话，其余输出 <silent>，
 * 用来验证「选择性发言」这条调度链路。装进 DSH 后同一份 room-server 会换成
 * 真实的 ctx.llm，接口与行为完全一致。
 *
 * 用法：
 *   node src/standalone.js
 *   $env:GALGAME_ROOM_PORT=7301; node src/standalone.js
 */

import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRoomServer } from './room-server.js'

const port = Number(process.env.GALGAME_ROOM_PORT ?? 7301)
const hostname = process.env.GALGAME_ROOM_HOST ?? '0.0.0.0'
const dataDir = process.env.GALGAME_ROOM_DATA ?? join(process.cwd(), 'data', 'galgame-room', 'rooms')

/** 与插件一致的版本号：/api/version 与 strictVersion 校验用 */
const version = (() => {
  try {
    return String(JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

/** 挑一句「该不该接话」：演示 AI 自己的判断，而不是每条都回 */
function isWorthResponding(text, force) {
  if (force) return true
  const value = String(text ?? '')
  if (value.trim() === '') return false
  return /[?？]|旁白|主持人|推进|然后呢|怎么办|看看|救我|!|！/.test(value)
}

const mockGenerate = async ({ messages, force }) => {
  // 模拟一点网络/模型延迟，方便验证「正在输入」状态
  await new Promise((resolve) => setTimeout(resolve, 150))
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  if (!isWorthResponding(lastUser?.content, force)) return '<silent>'

  const said = String(lastUser?.content ?? '')
    .replace(/^[^：:]*[：:]/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 30)
  const line = force
    ? '（自检回复·推进）下课铃在楼下响起来，铁门后的楼梯传来一步一步的脚步声。'
    : `（自检回复）你说的是「${said}」。风把天台的门又推开半寸，楼下有人抬头往这边看了一眼。`
  return line
}

const server = createRoomServer({
  port,
  hostname,
  dataDir,
  aiName: '旁白',
  version,
  generate: mockGenerate,
})

function lanAddresses() {
  const out = []
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address)
    }
  }
  return out
}

await server.start()
const { port: actualPort } = { port: server.port ?? port }
console.log('')
console.log('  联机 Galgame 房间服务（standalone / mock 模型）')
console.log('  作者:    B站：喵诺澪染 · 开源免费，禁止倒卖')
console.log('  本机:    http://127.0.0.1:' + actualPort)
for (const ip of lanAddresses()) console.log(`  局域网:  http://${ip}:${actualPort}`)
console.log('  数据:    ' + dataDir)
console.log('')
console.log('  房间页:  /room/<房号>?t=<邀请令牌>（建完房后点「复制邀请链接」）')
console.log('  curl 自检：见 README.md 的「验收」一节')
console.log('')

const shutdown = async (signal) => {
  console.log(`\n[galgame-room] 收到 ${signal}，关闭房间服务…`)
  await server.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
