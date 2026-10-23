/**
 * 客户端半侧契约测试：在 Node 里模拟 window.__ModuleLoader__ + slots，
 * 验证 client.js 注册的标签 id / order / label，以及渲染出来的 iframe 地址。
 *
 *   node scripts/client-sim.mjs
 */
import assert from 'node:assert/strict'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry
    },
  },
}

await import(pathToFileURL(join(here, '..', 'client', 'client.js')).href)
assert.ok(loaded, 'client.js 应该调用 window.__ModuleLoader__.load')
assert.equal(loaded.id, 'dsh-story-party')

const react = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  Fragment: 'Fragment',
  // 极简 hooks：初始值直接取出，effect 立即执行（fetch 会因相对 URL 失败，被 .catch 吞掉）
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect(effect) {
    effect()
  },
}

const moduleExports = loaded.factory((name) => {
  if (name === 'react') return react
  throw new Error('未预期的 require：' + name)
})

assert.equal(typeof moduleExports.apply, 'function')
assert.deepEqual(moduleExports.inject, ['slots'])

let registered = null
const ctx = {
  slots: {
    inject(name, fn) {
      assert.equal(name, 'conversation.view')
      fn()
    },
    register(options, component) {
      registered = { options, component }
      return () => {}
    },
  },
}

moduleExports.apply(ctx)
assert.ok(registered, '应该注册 conversation.view')
assert.equal(registered.options.name, 'conversation.view')
assert.equal(registered.options.id, 'galgame-room')
assert.equal(registered.options.order, 30)
assert.equal(registered.options.label(), '联机模式')

const tree = registered.component()
assert.equal(tree.type, 'div')
const iframe = tree.children.find((child) => child && child.type === 'iframe')
assert.ok(iframe, '视图里应该有 iframe')
assert.match(iframe.props.src, /^http:\/\/127\.0\.0\.1:7302\//)
const bar = tree.children[0]
assert.ok(bar, '顶部应该有工具栏')
const homeButton = bar.children.find((child) => child && child.type === 'button')
assert.ok(homeButton, '工具栏应该有「回本机」按钮')
assert.equal(homeButton.children[0], '回本机')

console.log('[client-sim] 通过：')
console.log('  - 标签 id=galgame-room，order=30（chat 0 / 轨迹 10 / galgame 20）')
console.log('  - label=联机模式')
console.log('  - 顶部工具栏（本机版本 + 回本机）；加入房间走页面里的「加入房间」')
console.log('  - 视图 iframe → ' + iframe.props.src)
