/**
 * 客户端重复执行保护：DSH 同一次 web boot 里如果把 client bundle 执行两次，
 * client-modules 会在第二次 load 时抛 duplicate factory registration，
 * 直接把启动打断。这里用两个带 query 的 import 模拟“同一段代码执行两次”，
 * 让 stub 的 load 在第二次时抛重复注册错误，断言错误被吞掉、首次注册保留。
 *
 *   node scripts/client-duplicate-test.mjs
 */
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const file = join(here, '..', 'client', 'client.js')

let registered = null

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      if (registered) {
        throw new Error(
          'client-modules: duplicate factory registration for "dsh-story-party" (bundle executed twice without invalidate?)',
        )
      }
      registered = entry
    },
  },
}

await import(pathToFileURL(file).href + '?first')
// 第二次执行：load 抛 duplicate，应被 client.js 里的 try/catch 吞掉，而不是冒泡
await import(pathToFileURL(file).href + '?second')

assert.ok(registered, '首次执行应正常注册 factory')
assert.equal(registered.id, 'dsh-story-party')
console.log('[client-duplicate] 通过：第二次执行吞掉 duplicate，首次注册保留 dsh-story-party')
