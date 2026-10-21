/* 页面内确认弹窗（替代原生 confirm，避免 Electron 标题栏和系统样式） */
(() => {
  'use strict'

  function showConfirm(options) {
    const {
      title = '确认',
      message = '',
      okText = '确定',
      cancelText = '取消',
      danger = false,
    } = options || {}

    return new Promise((resolve) => {
      const overlay = document.createElement('div')
      overlay.className = 'modal'

      const card = document.createElement('div')
      card.className = 'modal-card modal-confirm'
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-modal', 'true')

      const heading = document.createElement('h2')
      heading.textContent = title
      const text = document.createElement('p')
      text.className = 'modal-message'
      text.textContent = message

      const actions = document.createElement('div')
      actions.className = 'modal-actions'
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'ghost'
      cancel.textContent = cancelText
      const ok = document.createElement('button')
      ok.type = 'button'
      ok.className = danger ? 'danger' : 'primary'
      ok.textContent = okText

      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        document.removeEventListener('keydown', onKey)
        overlay.remove()
        resolve(value)
      }
      const onKey = (event) => {
        if (event.key === 'Escape') finish(false)
        if (event.key === 'Enter') finish(true)
      }

      cancel.addEventListener('click', () => finish(false))
      ok.addEventListener('click', () => finish(true))
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) finish(false)
      })
      document.addEventListener('keydown', onKey)

      actions.append(cancel, ok)
      card.append(heading, text, actions)
      overlay.append(card)
      document.body.append(overlay)
      requestAnimationFrame(() => ok.focus())
    })
  }

  window.showConfirm = showConfirm
})()
