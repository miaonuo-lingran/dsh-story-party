/**
 * 桩宿主测试：用假 ctx + 桩模块跑**真实的 src/index.js**，
 * 验证「插件入口 → 配置 → 房间服务 → ctx.llm.stream → AI 消息」整条链路。
 *
 *   node scripts/host-sim.mjs
 *   $env:HOSTSIM_RETRY='1'; node scripts/host-sim.mjs   # 先占端口，验证自动重试
 *
 * 这里验证不了的是 DSH 真实 ctx.llm 的入参形状（用桩 BlockAssembler 代替），
 * 其余接线与产品代码一致。
 */
import { registerHooks } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const stubUrl = (name) => pathToFileURL(join(here, 'host-sim', 'stubs', name)).href

const STUBS = {
  '@deepseek-ai/schemastery': stubUrl('schemastery.mjs'),
  '@deepseek-ai/dsh-llm': stubUrl('dsh-llm.mjs'),
  '@deepseek-ai/dsh-home-paths': stubUrl('dsh-home-paths.mjs'),
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mapped = STUBS[specifier]
    if (mapped) return { url: mapped, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const port = Number(process.env.HOSTSIM_PORT ?? 7306)
const retryMode = process.env.HOSTSIM_RETRY === '1'
process.env.HOSTSIM_DSH_HOME = join(root, '.hostsim')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(100)
  }
  throw new Error(`超时：${label}${last ? '（' + last.message + '）' : ''}`)
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${data.error ?? ''}`)
  return data
}

const calls = []
const llm = {
  async *stream(options) {
    calls.push(options)
    await sleep(40)
    yield '（桩模型）天台的门被风吹开，楼梯上传来脚步声。'
  },
  async resolveModelInfo() {
    return { reasoning: { efforts: [{ id: 'off' }] } }
  },
}

const disposers = []
const logger = {
  info: (...args) => console.log('[ctx.info]', ...args),
  warn: (...args) => console.log('[ctx.warn]', ...args),
  error: (...args) => console.log('[ctx.error]', ...args),
}

const agentDefaultModel = { currentSelection: () => ({ provider: 'stub-provider', model: 'stub-model' }) }
const ctx = {
  logger,
  llm,
  agentDefaultModel,
  // 插件用 ctx.get 软取服务（对应 cordis 的 ctx.get(name, false)）
  get(name, fallback) {
    if (name === 'llm') return llm
    if (name === 'agentDefaultModel') return agentDefaultModel
    return fallback
  },
  // 宿主 webServer：插件注册「当前端口」配置路由
  webServer: {
    register() {
      return () => {}
    },
  },
  effect(fn) {
    disposers.push(fn())
  },
}

let occupier
try {
  if (retryMode) {
    occupier = createNetServer()
    await new Promise((resolve, reject) => {
      occupier.once('error', reject)
      occupier.listen(port, '127.0.0.1', resolve)
    })
    console.log(`[sim] 先占住 127.0.0.1:${port}，模拟「standalone 还在跑」`)
  }

  const plugin = await import(pathToFileURL(join(root, 'src', 'index.js')).href)
  plugin.apply(ctx, {
    port,
    hostname: '127.0.0.1',
    maxPlayers: 4,
    debounceMs: 150,
    contextMessages: 20,
    aiName: '旁白',
    provider: '',
    model: '',
  })

  if (retryMode) {
    await sleep(1200)
    await new Promise((resolve) => occupier.close(resolve))
    console.log('[sim] 释放端口，等插件自己重试…')
  }

  await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`)
      return response.ok
    },
    retryMode ? 15000 : 5000,
    '房间服务监听',
  )
  console.log('[sim] 房间服务已监听')

  const created = await api('/api/rooms', { method: 'POST', body: { title: '桩宿主测试', gmName: '澪' } })
  const roomId = created.room.id
  const joined = await api(`/api/rooms/${roomId}/join`, {
    method: 'POST',
    body: { name: '小满', role: 'player', inviteToken: created.inviteToken },
  })
  await api(`/api/rooms/${roomId}/messages`, {
    method: 'POST',
    token: joined.token,
    body: { text: '门后面是谁在呼吸？' },
  })

  const history = await waitFor(
    async () => {
      const data = await api(`/api/rooms/${roomId}/messages?since=0&t=${created.inviteToken}`)
      return data.messages.some((message) => message.kind === 'ai') ? data : null
    },
    6000,
    'AI 回复',
  )
  const aiMessage = history.messages.find((message) => message.kind === 'ai')

  assert.equal(aiMessage.text, '（桩模型）天台的门被风吹开，楼梯上传来脚步声。')
  assert.ok(calls.length >= 1, '应该调用过 llm.stream')
  const call = calls[0]
  assert.equal(call.sessionId, `galgame-room:${roomId}`)
  assert.equal(call.provider, 'stub-provider')
  assert.equal(call.model, 'stub-model')
  assert.equal(call.temperature, 1)
  assert.equal(call.reasoningEffort, 'off')
  assert.ok(call.system.includes('【行为规则】'), 'system 应包含行为规则')
  assert.ok(call.system.includes('【世界观与设定】'), 'system 应包含世界观')
  assert.ok(call.system.includes('选择性接话'), 'system 应包含选择性接话指令')
  const first = call.messages[0]
  assert.equal(first.role, 'user')
  assert.ok(first.content[0].text.includes('小满（玩家）：'), '上下文应带昵称与职位')

  const file = join(root, '.hostsim', 'galgame-room', 'rooms', roomId + '.json')
  assert.ok(existsSync(file), '房间 JSON 应已落盘')

  console.log('\n[sim] 通过：')
  console.log(`  - 插件 apply 挂载、监听 ${port} 正常`)
  console.log(`  - 建房 / 加入 / 发言 / AI 回复全链路 OK（seq=${history.seq}）`)
  console.log(`  - llm.stream 入参：sessionId=${call.sessionId} provider=${call.provider} model=${call.model}`)
  console.log(`  - system ${call.system.length} 字，上下文首条：${first.content[0].text}`)
  console.log(`  - 落盘：${file}`)
} catch (error) {
  console.error('\n[sim] 失败：', error instanceof Error ? error.stack : error)
  process.exitCode = 1
} finally {
  for (const dispose of disposers) {
    try {
      await dispose?.()
    } catch {
      /* ignore */
    }
  }
  if (occupier && occupier.listening) await new Promise((resolve) => occupier.close(resolve))
  await sleep(200)
  process.exit(process.exitCode ?? 0)
}
