/* AI 画我猜（单人）：AI 画几何图形，玩家猜词 */
(() => {
  'use strict'

  try {
    if (window.self !== window.top) document.documentElement.classList.add('embed')
  } catch {
    document.documentElement.classList.add('embed')
  }

  const $ = (id) => document.getElementById(id)
  const els = {
    round: $('draw-round'),
    score: $('draw-score'),
    board: $('draw-board'),
    answer: $('draw-answer'),
    hint: $('draw-hint'),
    form: $('draw-form'),
    input: $('draw-input'),
    submit: $('draw-submit'),
    hintBtn: $('draw-hint-btn'),
    skip: $('draw-skip'),
    next: $('draw-next'),
    restart: $('draw-restart'),
    message: $('draw-message'),
    finished: $('draw-finished'),
    summary: $('draw-summary'),
    again: $('draw-again'),
    history: $('draw-history'),
    toasts: $('toasts'),
  }

  const state = {
    session: null,
    busy: false,
  }

  function toast(text, kind) {
    if (!els.toasts) return
    const node = document.createElement('div')
    node.className = 'toast' + (kind === 'error' ? ' error' : '')
    node.textContent = text
    els.toasts.append(node)
    setTimeout(() => {
      node.style.transition = 'opacity .25s'
      node.style.opacity = '0'
      setTimeout(() => node.remove(), 260)
    }, 2400)
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    return data
  }

  function setBusy(busy, message) {
    state.busy = busy
    if (message !== undefined) els.message.textContent = message
    els.input.disabled = busy
    els.submit.disabled = busy
    els.hintBtn.disabled = busy
    els.skip.disabled = busy
    els.next.disabled = busy
    els.restart.disabled = busy
  }

  function svgEl(name) {
    return document.createElementNS('http://www.w3.org/2000/svg', name)
  }

  function renderShapes(shapes) {
    els.board.textContent = ''
    for (const shape of Array.isArray(shapes) ? shapes : []) {
      let node
      if (shape.type === 'circle') {
        node = svgEl('circle')
        node.setAttribute('cx', shape.cx)
        node.setAttribute('cy', shape.cy)
        node.setAttribute('r', shape.r)
        node.setAttribute('fill', shape.fill || 'none')
      } else if (shape.type === 'ellipse') {
        node = svgEl('ellipse')
        node.setAttribute('cx', shape.cx)
        node.setAttribute('cy', shape.cy)
        node.setAttribute('rx', shape.rx)
        node.setAttribute('ry', shape.ry)
        node.setAttribute('fill', shape.fill || 'none')
      } else if (shape.type === 'rect') {
        node = svgEl('rect')
        node.setAttribute('x', shape.x)
        node.setAttribute('y', shape.y)
        node.setAttribute('width', shape.width)
        node.setAttribute('height', shape.height)
        if (shape.rx) node.setAttribute('rx', shape.rx)
        node.setAttribute('fill', shape.fill || 'none')
      } else if (shape.type === 'line') {
        node = svgEl('line')
        node.setAttribute('x1', shape.x1)
        node.setAttribute('y1', shape.y1)
        node.setAttribute('x2', shape.x2)
        node.setAttribute('y2', shape.y2)
        node.setAttribute('fill', 'none')
      } else if (shape.type === 'polyline' || shape.type === 'polygon') {
        node = svgEl(shape.type)
        node.setAttribute('points', (shape.points || []).map((point) => point.join(',')).join(' '))
        node.setAttribute('fill', shape.fill || 'none')
      } else {
        continue
      }
      node.setAttribute('stroke', shape.stroke || '#334155')
      node.setAttribute('stroke-width', shape.strokeWidth || 1.2)
      node.setAttribute('stroke-linecap', 'round')
      node.setAttribute('stroke-linejoin', 'round')
      node.setAttribute('vector-effect', 'non-scaling-stroke')
      els.board.append(node)
    }
  }

  function renderHistory() {
    els.history.textContent = ''
    for (const [index, item] of ((state.session && state.session.history) || []).entries()) {
      const row = document.createElement('li')
      const label = document.createElement('span')
      label.textContent = `第 ${index + 1} 题`
      const answer = document.createElement('strong')
      answer.textContent = item.answer
      const result = document.createElement('span')
      result.className = 'muted small'
      result.textContent = item.correct
        ? `猜对 · +${item.points} 分`
        : item.skipped
          ? '跳过'
          : '未猜出'
      row.append(label, answer, result)
      els.history.append(row)
    }
  }

  function render() {
    const session = state.session
    if (!session) return
    els.round.textContent = `第 ${session.round}/${session.total} 题`
    els.score.textContent = `${session.score} 分`
    renderShapes(session.shapes)
    els.hint.textContent = session.hint ? `提示：${session.hint}` : ''
    if (session.solved && session.answer) {
      els.answer.hidden = false
      els.answer.textContent = `答案是：${session.answer}`
    } else {
      els.answer.hidden = true
      els.answer.textContent = ''
    }
    const locked = session.solved || session.finished || state.busy
    els.input.disabled = locked
    els.submit.disabled = locked
    els.hintBtn.disabled = locked
    els.skip.disabled = locked
    els.next.hidden = !(session.solved || session.finished)
    els.next.disabled = state.busy
    els.next.textContent = session.finished ? '查看结算' : '下一题'
    els.finished.hidden = !session.finished
    els.summary.textContent = `本局得分：${session.score} 分`
    renderHistory()
    if (!locked) els.input.focus()
  }

  async function startGame() {
    setBusy(true, 'AI 正在画第一题…')
    state.session = null
    try {
      const data = await api('/api/draw/sessions', { method: 'POST', body: { rounds: 5 } })
      state.session = data.session
      els.message.textContent = '看图猜词，猜对得分。'
      render()
      els.input.focus()
    } catch (error) {
      els.message.textContent = error.message
      toast(error.message, 'error')
    } finally {
      setBusy(false)
      render()
    }
  }

  async function nextRound() {
    if (!state.session) return
    setBusy(true, 'AI 正在画下一题…')
    try {
      const data = await api(`/api/draw/sessions/${encodeURIComponent(state.session.id)}/next`, {
        method: 'POST',
      })
      state.session = data.session
      els.message.textContent = '看图猜词，猜对得分。'
      render()
    } catch (error) {
      els.message.textContent = error.message
      toast(error.message, 'error')
    } finally {
      setBusy(false)
      render()
    }
  }

  async function submitGuess(event) {
    event.preventDefault()
    if (!state.session || state.busy) return
    const text = els.input.value.trim()
    if (!text) return
    setBusy(true, '')
    try {
      const data = await api(`/api/draw/sessions/${encodeURIComponent(state.session.id)}/guess`, {
        method: 'POST',
        body: { text },
      })
      state.session = data
      els.message.textContent = data.message || (data.correct ? '猜对了！' : '不对，再想想')
      if (data.correct) els.input.value = ''
      render()
    } catch (error) {
      els.message.textContent = error.message
      toast(error.message, 'error')
    } finally {
      setBusy(false)
      render()
    }
  }

  async function skipRound() {
    if (!state.session || state.busy) return
    setBusy(true, '')
    try {
      const data = await api(`/api/draw/sessions/${encodeURIComponent(state.session.id)}/skip`, {
        method: 'POST',
      })
      state.session = data
      els.message.textContent = data.message || '已跳过'
      render()
    } catch (error) {
      els.message.textContent = error.message
      toast(error.message, 'error')
    } finally {
      setBusy(false)
      render()
    }
  }

  async function showHint() {
    if (!state.session || state.busy) return
    try {
      const data = await api(`/api/draw/sessions/${encodeURIComponent(state.session.id)}/hint`, {
        method: 'POST',
      })
      els.message.textContent = data.message
    } catch (error) {
      els.message.textContent = error.message
    }
  }

  els.form.addEventListener('submit', submitGuess)
  els.hintBtn.addEventListener('click', showHint)
  els.skip.addEventListener('click', skipRound)
  els.next.addEventListener('click', () => {
    if (state.session && state.session.finished) {
      els.finished.hidden = false
      return
    }
    void nextRound()
  })
  els.restart.addEventListener('click', () => void startGame())
  els.again.addEventListener('click', () => void startGame())

  void startGame()
})()
