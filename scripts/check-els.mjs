/**
 * 前端引用检查：els.X 用到的键必须在 els 里定义，且对应的 HTML id 存在。
 * 这类错误在浏览器里表现为「点了没反应」，Node 语法检查抓不到。
 *
 *   node scripts/check-els.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function check(jsFile, htmlFile, label) {
  const js = readFileSync(join(root, jsFile), 'utf8')
  const html = readFileSync(join(root, htmlFile), 'utf8')

  const block = js.match(/const els = \{([\s\S]*?)\n  \}/)
  if (!block) throw new Error(`${label}: 找不到 els 定义`)

  const defined = new Set()
  const idMap = new Map()
  for (const line of block[1].split('\n')) {
    const key = line.match(/^\s*(\w+):/)
    if (!key) continue
    defined.add(key[1])
    const id = line.match(/\$\('([^']+)'\)/)
    if (id) idMap.set(key[1], id[1])
  }

  const used = new Set()
  for (const match of js.matchAll(/els\.(\w+)/g)) used.add(match[1])

  const problems = []
  for (const key of used) {
    if (!defined.has(key)) problems.push(`els 里缺少：${key}`)
  }
  for (const [key, id] of idMap) {
    if (!new RegExp(`id="${id}"`).test(html)) problems.push(`HTML 里没有 id="${id}"（els.${key}）`)
  }

  if (problems.length > 0) {
    console.error(`[${label}] 失败：\n  - ` + problems.join('\n  - '))
    process.exitCode = 1
    return
  }
  console.log(`[${label}] OK：els ${defined.size} 个键，全部有定义且 HTML 中都有对应 id`)
}

check('public/room.js', 'public/room.html', 'room')
check('public/host.js', 'public/host.html', 'host')
check('public/make.js', 'public/make.html', 'make')
check('public/profile.js', 'public/profile.html', 'profile')
check('public/draw.js', 'public/draw.html', 'draw')
