// ---------------- terminals
async function loadConversation(pane) {
  let state = hostHistory.get(pane.hostId)
  if (!state) {
    state = (async () => {
      const saved = await window.st.histGet(pane.hostId)
      const owner = { ...pane, agent: normalizeAgent(saved, pane.name), historyLoaded: true }
      if (saved?.log && owner.agent.convs.length) {
        owner.agent.convs[0].id = 'legacy-' + pane.hostId
        owner.agent.activeId = owner.agent.convs[0].id
      }
      const consumed = await mergeLegacyConvs(owner)
      if (consumed.length && await persistTabAgent(owner)) {
        for (const key of consumed) await window.st.histClear(key)
      }
      return owner
    })()
    hostHistory.set(pane.hostId, state)
    state.catch(() => hostHistory.delete(pane.hostId))
  }
  try {
    const owner = await state
    // 每个窗格保有自己的选中对话，共用该主机的内容与保存队列。
    Object.defineProperty(pane.agent, 'convs', {
      get: () => owner.agent.convs,
      set: (convs) => { owner.agent.convs = convs },
    })
    pane.agent.activeId = owner.agent.activeId
    pane.historyLoaded = true
  } catch (error) {
    pane.historyError = error.message
  }
  if (activeId === pane.id) { renderSub(); updateHeads() }
}

function toggleFavorite(id) {
  const favorites = new Set(settings.favoriteHosts || [])
  if (favorites.has(id)) favorites.delete(id)
  else favorites.add(id)
  settings.favoriteHosts = [...favorites]
  window.st.saveSettings(settings).catch((error) => { statusEl.textContent = error.message })
  renderHosts()
}

async function openHost(host, split = null, fresh = false) {
  if (host.disabled) return openDialog(host)
  if (!split && !fresh) {
    const existing = tabs.filter((pane) => pane.hostId === host.id)
      .sort((a, b) => Number(Boolean(b.sessionId)) - Number(Boolean(a.sessionId)) || b.usedAt - a.usedAt)[0]
    if (existing) { selectTerm(existing.id); return }
  }
  if (split) {
    const size = split.direction === 'horizontal' ? split.base.frame.clientWidth : split.base.frame.clientHeight
    if (size < 300) { statusEl.textContent = '窗格空间不足，请扩大窗口或收起侧栏。'; return }
  }
  const workspace = split?.base.workspace || { id: 'tab-' + (++paneSequence), name: host.name || host.id }
  if (!split) {
    workspace.root = document.createElement('div')
    workspace.root.className = 'workspace'
    termsEl.appendChild(workspace.root)
    workspaces.push(workspace)
  }
  const pane = createPane(workspace, host)
  if (split) window.shrimpWorkspace.split(split.base.frame, pane.frame, split.direction)
  else workspace.root.appendChild(pane.frame)
  pane.term.open(pane.wrap)
  pane.wrap.style.setProperty('--terminal-background', pane.term.options.theme.background)
  pane.observer.observe(pane.wrap)
  if (!split) setPanelVisible(false)
  selectTerm(pane.id)
  void loadConversation(pane)
  void connectPane(pane)
}

async function connectPane(pane, trustToken) {
  if (!tabs.includes(pane) || pane.pending || pane.sessionId) return
  const restoreFocus = document.activeElement === pane.reconnect
  pane.pending = true
  pane.reason = ''
  const host = allHosts.find((item) => item.id === pane.hostId)
  if (host) pane.userTarget = (host.user || 'ubuntu') + '@' + host.host + ':' + (host.port || 22)
  pane.trust = null
  refreshPane(pane)
  try {
    const result = await window.st.open(pane.hostId, {
      paneId: pane.id, encoding: settings.sessions?.[pane.hostId]?.encoding || settings.encoding || 'utf-8', trustToken,
    })
    if (!tabs.includes(pane)) { if (result.id) await window.st.close(result.id); return }
    if (result.trust) {
      pane.trust = result.trust
      pane.reason = '请核验首次连接的主机指纹。'
      return
    }
    if (pane.connectedBefore) pane.term.write('\x1b[?1049l\x1b[0m\r\n──────── 已建立新的 SSH 会话 ────────\r\n')
    pane.connectedBefore = true
    pane.sessionId = result.id
    pane.pending = false
    await window.st.attach(result.id)
    fitPane(pane)
    if (restoreFocus && activeId === pane.id && document.activeElement === document.body) pane.term.focus()
    if (pane.sessionId === result.id) {
      settings.recentHosts = [pane.hostId, ...(settings.recentHosts || []).filter((id) => id !== pane.hostId)].slice(0, 15)
      window.st.saveSettings(settings).catch((error) => { statusEl.textContent = error.message })
    }
  } catch (error) {
    pane.reason = error.message
  } finally {
    pane.pending = false
    if (tabs.includes(pane)) refreshPane(pane)
    renderHosts()
  }
}

let paneSequence = 0
function createPane(workspace, host) {
  const frame = document.createElement('section')
  frame.className = 'terminal-pane'
  const header = document.createElement('div')
  header.className = 'terminal-pane-head'
  const label = document.createElement('span')
  const reconnect = document.createElement('button')
  const close = document.createElement('button')
  close.textContent = '×'
  close.title = '关闭窗格'
  reconnect.textContent = '重新连接'
  header.append(label, reconnect, close)
  const notice = document.createElement('div')
  notice.className = 'pane-notice'
  notice.hidden = true
  const wrap = document.createElement('div')
  wrap.className = 'termwrap'
  frame.append(header, notice, wrap)
  const ov = settings.sessions?.[host.id] || {}
  const fs = Number(ov.fontSize) || fontSize
  const th = ov.terminal || termThemeName
  const term = new TerminalCtor({
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    fontSize: fs, theme: TERM_THEMES[th] || TERM_THEMES.dark,
    cursorBlink: true, lineHeight: 1.3, scrollback: 5000, allowProposedApi: true,
  })
  const fit = new FitCtor()
  const search = SearchCtor ? new SearchCtor() : null
  term.loadAddon(fit)
  if (search) term.loadAddon(search)
  const pane = {
    id: 'pane-' + (++paneSequence), workspace, name: host.name || host.id, hostId: host.id,
    userTarget: (host.user || 'ubuntu') + '@' + host.host + ':' + (host.port || 22),
    frame, wrap, label, reconnect, notice, term, fit, search, fs, th, usedAt: Date.now(),
    _hasFsOverride: !!ov.fontSize, _hasThOverride: !!ov.terminal,
    memKey: host.id, historyLoaded: false, agent: normalizeAgent(null, host.name),
  }
  frame.dataset.paneId = pane.id
  tabs.push(pane)
  pane.observer = new ResizeObserver(() => fitPane(pane))
  term.onResize(({ cols, rows }) => {
    if (pane.sessionId) window.st.resize(pane.sessionId, cols, rows).catch(() => {})
  })
  term.onData((data) => {
    if (!pane.sessionId || pane.id !== activeId) return
    window.st.input(pane.sessionId, data).catch((error) => { statusEl.textContent = error.message })
    if (mirrorEl.checked) {
      for (const target of tabs) {
        if (target !== pane && target.sessionId && mirrorTargets.has(target.id)) window.st.input(target.sessionId, data).catch((error) => { statusEl.textContent = error.message })
      }
    }
  })
  frame.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('button') && activeId !== pane.id) selectTerm(pane.id, false)
  })
  frame.addEventListener('focusin', () => { if (activeId !== pane.id) selectTerm(pane.id, false) })
  close.onclick = () => closeTab(pane.id)
  reconnect.onclick = () => {
    if (pane.trust) confirmDialog('核验 SSH 主机指纹', pane.trust.endpoint + '\n' + pane.trust.fingerprint,
      '信任并连接', () => connectPane(pane, pane.trust?.token))
    else connectPane(pane)
  }
  refreshPane(pane)
  return pane
}

function refreshPane(pane) {
  pane.label.textContent = pane.name + (pane.pending ? ' · 连接中' : pane.sessionId ? '' : ' · 已断开')
  pane.frame.classList.toggle('is-connected', !!pane.sessionId)
  pane.reconnect.hidden = !!pane.sessionId || pane.pending
  pane.reconnect.textContent = pane.trust ? '核验指纹' : '重新连接'
  pane.reconnect.title = pane.reason || ''
  pane.notice.hidden = !(pane.pending || pane.reason)
  pane.notice.textContent = pane.pending ? '正在连接 ' + pane.userTarget + '…' : pane.reason
  renderTabRow()
  if (activeId === pane.id) updateHeads()
}

function fitPane(pane) {
  if (!pane.wrap.clientWidth || !pane.wrap.clientHeight) return
  pane.fit.fit()
  if (pane.sessionId) window.st.resize(pane.sessionId, pane.term.cols, pane.term.rows).catch(() => {})
}

function selectTerm(id, focus = true) {
  const pane = tabById(id)
  activeId = pane?.id || null
  activeWorkspace = pane?.workspace || null
  if (pane) { pane.usedAt = Date.now(); activeWorkspace.activePane = pane.id }
  for (const item of workspaces) item.root.hidden = item !== activeWorkspace
  for (const other of tabs) other.frame.classList.toggle('active', other === pane)
  showView()
  if (pane) {
    fitPane(pane)
    if (focus) pane.term.focus()
  } else if (focus) requestAnimationFrame(() => el('hostLibrary').querySelector('input')?.focus())
}

function renderTabRow() {
  tabRow.replaceChildren()
  for (const t of workspaces) {
    const d = document.createElement('div')
    d.className = 'tab' + (t === activeWorkspace ? ' active' : '')
    d.draggable = true
    d.dataset.tabId = t.id
    const dot = document.createElement('span')
    dot.className = 'dot'
    if (!tabs.some((pane) => pane.workspace === t && pane.sessionId)) dot.style.background = 'var(--dim2)'
    const n = document.createElement('span')
    const count = tabs.filter((pane) => pane.workspace === t).length
    n.textContent = t.name + (count > 1 ? ' · ' + count : '')
    const x = document.createElement('button')
    x.className = 'x'
    x.textContent = '×'
    x.title = '关闭标签'
    x.onclick = (event) => {
      event.stopPropagation()
      const members = tabs.filter((pane) => pane.workspace === t)
      closePanes(members)
    }
    d.append(dot, n, x)
    d.onclick = () => selectTerm(t.activePane)

    // drag to reorder
    d.ondragstart = (ev) => {
      dragTabId = t.id
      d.classList.add('dragging')
      try {
        ev.dataTransfer.effectAllowed = 'move'
        ev.dataTransfer.setData('text/plain', t.id)
      } catch (e) {}
    }
    d.ondragend = () => {
      dragTabId = null
      clearDropMarks()
      d.classList.remove('dragging')
    }
    d.ondragover = (ev) => {
      if (!dragTabId || dragTabId === t.id) return
      ev.preventDefault()
      try { ev.dataTransfer.dropEffect = 'move' } catch (e) {}
      const r = d.getBoundingClientRect()
      const after = ev.clientX > r.left + r.width / 2
      clearDropMarks()
      d.classList.add(after ? 'drop-after' : 'drop-before')
    }
    d.ondragleave = () => { d.classList.remove('drop-before', 'drop-after') }
    d.ondrop = (ev) => {
      ev.preventDefault()
      const r = d.getBoundingClientRect()
      const after = ev.clientX > r.left + r.width / 2
      clearDropMarks()
      if (dragTabId) moveTab(dragTabId, t.id, after)
      dragTabId = null
    }

    tabRow.appendChild(d)
  }
}

let dragTabId = null

function clearDropMarks() {
  tabRow.querySelectorAll('.tab').forEach((el2) => el2.classList.remove('drop-before', 'drop-after'))
}

function moveTab(fromId, toId, after) {
  const from = workspaces.findIndex((x) => x.id === fromId)
  if (from < 0) return
  if (fromId === toId) return
  const [item] = workspaces.splice(from, 1)
  let idx = workspaces.findIndex((x) => x.id === toId)
  if (idx < 0) { workspaces.splice(from, 0, item); return }
  if (after) idx += 1
  workspaces.splice(idx, 0, item)
  renderTabRow()
}

function closePanes(panes) {
  const ids = new Set(panes.map((pane) => pane.sessionId).filter(Boolean))
  const running = [...taskRecords.values()].some((task) => ids.has(task.sessionId) && ['running', 'waiting'].includes(task.status))
  const remove = () => { for (const pane of panes) disposePane(pane) }
  if (running) confirmDialog('关闭连接', '当前连接上的 Agent 命令会中断。', '关闭连接', remove)
  else remove()
}

function closeTab(id) {
  const pane = tabById(id)
  if (pane) closePanes([pane])
}

function disposePane(pane) {
  if (!tabs.includes(pane)) return
  tabs.splice(tabs.indexOf(pane), 1)
  mirrorTargets.delete(pane.id)
  if (!mirrorTargets.size) mirrorEl.checked = false
  if (pane.sessionId) window.st.close(pane.sessionId)
  pane.observer.disconnect()
  pane.term.dispose()
  window.shrimpWorkspace.removePane(pane.frame)
  const remaining = tabs.filter((other) => other.workspace === pane.workspace)
  if (!remaining.length) {
    pane.workspace.root.remove()
    workspaces.splice(workspaces.indexOf(pane.workspace), 1)
  } else if (pane.workspace.activePane === pane.id) pane.workspace.activePane = remaining[0].id
  if (activeId === pane.id) selectTerm(remaining[0]?.id || workspaces.at(-1)?.activePane)
  else renderTabRow()
  renderHosts()
  updateMirrorMarks()
}

window.st.onData(({ id, data }) => {
  const pane = tabs.find((item) => item.sessionId === id)
  if (pane) pane.term.write(data)
})

window.st.onClosed(({ id, reason }) => {
  const pane = tabs.find((item) => item.sessionId === id)
  if (!pane) return
  pane.sessionId = null
  pane.reason = reason
  mirrorTargets.delete(pane.id)
  if (!mirrorTargets.size) mirrorEl.checked = false
  refreshPane(pane)
  updateMirrorMarks()
  renderHosts()
})

function updateMirrorMarks() {
  for (const pane of tabs) pane.frame.classList.toggle('mirror-target', mirrorEl.checked && mirrorTargets.has(pane.id))
  el('mirrorCount').textContent = mirrorEl.checked ? String(mirrorTargets.size) : ''
}

el('mirrorConfig').onclick = () => {
  const options = el('mirrorChoices')
  options.replaceChildren()
  for (const pane of tabs.filter((item) => item.sessionId && item.id !== activeId)) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = pane.id
    input.checked = mirrorTargets.has(pane.id)
    label.append(input, pane.name + ' · ' + pane.id)
    options.append(label)
  }
  if (!options.childElementCount) options.textContent = '请先连接另一个窗格。'
  el('mirrorDialog').showModal()
}
el('mirrorApply').onclick = () => {
  mirrorTargets.clear()
  for (const input of el('mirrorChoices').querySelectorAll('input:checked')) mirrorTargets.add(input.value)
  mirrorEl.checked = !!mirrorTargets.size
  updateMirrorMarks()
}
mirrorEl.onchange = () => {
  if (mirrorEl.checked && !mirrorTargets.size) { mirrorEl.checked = false; el('mirrorConfig').click() }
  updateMirrorMarks()
}

el('hostSearch').oninput = renderHosts
el('hostSearch').onkeydown = (event) => {
  if (event.key === 'Enter' && !event.isComposing) hostList.querySelector('.host')?.click()
}

el('splitMenu').onclick = () => {
  const pane = tabById(activeId)
  if (!pane) return
  const list = el('splitHost')
  list.replaceChildren()
  for (const host of allHosts.filter((item) => !item.disabled)) {
    const option = document.createElement('option')
    option.value = host.id
    option.textContent = host.name
    list.append(option)
  }
  list.value = pane.hostId
  el('splitDialog').showModal()
}
for (const direction of ['horizontal', 'vertical']) {
  el('split-' + direction).onclick = () => {
    const pane = tabById(activeId)
    const host = allHosts.find((item) => item.id === el('splitHost').value)
    if (pane && host) openHost(host, { base: pane, direction })
  }
}

boot()
