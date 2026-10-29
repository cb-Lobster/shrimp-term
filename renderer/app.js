'use strict'
// Renderer.
//   Connections are terminal tabs. The big Agent is its OWN tab at the same level,
//   rendered as a full page chat (like a standalone chat app).
//   Each terminal tab also has a small "本会话" sub-agent on the right, with its
//   own independent memory.

const TerminalCtor = window.Terminal || (window.Xterm && window.Xterm.Terminal)
const FitCtor = (window.FitAddon && window.FitAddon.FitAddon) || window.FitAddon
const SearchCtor = (window.SearchAddon && window.SearchAddon.SearchAddon) || window.SearchAddon

const el = (id) => document.getElementById(id)
const hostList = el('hostList')
const tabRow = el('tabRow')
const termsEl = el('terms')
const emptyEl = el('empty')
const mirrorEl = el('mirror')
const statusEl = el('status')

const tabs = []
let activeId = null
let view = 'term'           // 只剩终端视图
let fontSize = 12.5
let subBusy = false

const AGENT_TAB = '__agent__'

const TERM_THEMES = {
  dark: {
    background: '#0d0f13', foreground: '#dbe1e9', cursor: '#5aa9ff', cursorAccent: '#0d0f13',
    selectionBackground: '#2b3646',
    black: '#22262d', red: '#e5645f', green: '#4ac08a', yellow: '#e0b872',
    blue: '#5aa9ff', magenta: '#c07ce0', cyan: '#4fc1d4', white: '#d5dbe3',
    brightBlack: '#5b6472', brightRed: '#f07b76', brightGreen: '#63d69d',
    brightYellow: '#f0cb86', brightBlue: '#7dbdff', brightMagenta: '#d29bea',
    brightCyan: '#6fd3e3', brightWhite: '#f2f5f9',
  },
  light: {
    background: '#fbfbf9', foreground: '#2a2a28', cursor: '#2f7ae5', cursorAccent: '#fbfbf9',
    selectionBackground: '#dbe7fa',
    black: '#24292f', red: '#c0392b', green: '#2e7d32', yellow: '#a87000',
    blue: '#1565c0', magenta: '#7b1fa2', cyan: '#00838f', white: '#6a737d',
    brightBlack: '#8b949e', brightRed: '#e05c4b', brightGreen: '#3aa757',
    brightYellow: '#c08a00', brightBlue: '#2f7ae5', brightMagenta: '#9c4dcc',
    brightCyan: '#00a3b3', brightWhite: '#1f2328',
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
    brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
    brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  solarized: {
    background: '#002b36', foreground: '#93a1a1', cursor: '#93a1a1', cursorAccent: '#002b36',
    selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75',
    brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
}
let termThemeName = 'dark'
function termTheme() { return TERM_THEMES[termThemeName] || TERM_THEMES.dark }

const tabById = (id) => tabs.find((t) => t.id === id)

function persistAgent(key, state, meta) {
  if (!key || !state || typeof window.st.histSave !== 'function') return
  try {
    window.st.histSave(key, Object.assign(
      { log: state.log, history: state.history },
      meta || {},
    ))
  } catch (e) {}
}

function persistTabAgent(tab) {
  const firstUser = (tab.agent.log.find((m) => m.cls === 'me') || {}).text || tab.name
  persistAgent(tab.memKey, tab.agent, {
    hostId: tab.hostId,
    name: String(firstUser).slice(0, 40),
    createdAt: tab.memCreatedAt || (tab.memCreatedAt = Date.now()),
  })
}

// ---------------- window controls
el('wMin').onclick = () => window.st.winMinimize()
el('wMax').onclick = () => window.st.winMaximize()
el('wClose').onclick = () => window.st.winClose()

// ---------------- left rail
document.querySelectorAll('.railbtn[data-panel]').forEach((b) => {
  b.onclick = () => {
    const name = b.dataset.panel
    if (name === 'settings') { openGlobal('appear'); return }
    document.querySelectorAll('.railbtn').forEach((x) => x.classList.toggle('active', x === b))
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name))
    setPanelVisible(true)
  }
})

// ---------------- view switching
function showView(v) {
  view = 'term'
  termsEl.style.display = ''
  el('toolbar').style.display = ''
  el('right').classList.toggle('hidden', rightHiddenByUser)
  renderTabRow()
  renderSub()
  const t = tabById(activeId)
  if (t) requestAnimationFrame(() => { try { t.fit.fit() } catch (e) {} t.term.focus() })
  updateHeads()
}

function updateHeads() {
  const t = tabById(activeId)
  el('subTarget').textContent = t ? t.name : '未连接'
  el('subSend').disabled = subBusy || !t || !hasApi()
}

function hasApi() { return !!(settings.agent && settings.agent.apiKey) }

// ---------------- hosts
let allHosts = []
const collapsed = {}

async function loadHosts() {
  allHosts = await window.st.hosts()

  // group order: declared groups first, then whatever the hosts reference, then ""
  const declared = []
  try { declared.push(...((await window.st.groups()) || [])) } catch (e) {}
  const used = []
  for (const h of allHosts) {
    const g = h.group || ''
    if (g && !used.includes(g)) used.push(g)
  }
  const order = []
  for (const g of declared.concat(used)) if (!order.includes(g)) order.push(g)
  const hasUngrouped = allHosts.some((h) => !h.group)

  hostList.replaceChildren()
  const buckets = order.map((g) => ({ name: g, items: allHosts.filter((h) => (h.group || '') === g) }))
  if (hasUngrouped || !order.length) buckets.push({ name: '', items: allHosts.filter((h) => !h.group) })

  for (const b of buckets) {
    if (!b.items.length && b.name) continue
    const g = document.createElement('div')
    g.className = 'group' + (collapsed[b.name] ? ' collapsed' : '')

    const head = document.createElement('div')
    head.className = 'ghead'
    const caret = document.createElement('span'); caret.className = 'caret'; caret.textContent = '\u25be'
    const icon = document.createElement('span'); icon.textContent = b.name ? '\u{1F4C1}' : '\u{1F4C2}'
    icon.style.fontSize = '11px'
    const gn = document.createElement('span'); gn.className = 'gname'
    gn.textContent = b.name || '\u672a\u5206\u7ec4'
    const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = b.items.length
    head.append(caret, icon, gn, cnt)
    head.onclick = () => {
      collapsed[b.name] = !collapsed[b.name]
      g.classList.toggle('collapsed')
    }
    g.appendChild(head)

    const body = document.createElement('div')
    body.className = 'gbody'
    for (const h of b.items) {
      const d = document.createElement('div')
      d.className = 'host' + (h.disabled ? ' disabled' : '')
      d.dataset.hostId = h.id
      const dot = document.createElement('span'); dot.className = 'dot'
      const name = document.createElement('span'); name.className = 'name'; name.textContent = h.name || h.id
      const kind = document.createElement('span'); kind.className = 'kind'
      kind.textContent = h.kind === 'local' ? '\u672c\u673a' : ''
      const edit = document.createElement('span'); edit.className = 'edit'; edit.textContent = '\u2699'
      edit.onclick = (ev) => { ev.stopPropagation(); openDialog(h) }
      d.append(dot, name, kind, edit)
      d.onclick = () => {
        if (h.disabled) { openDialog(h); statusEl.textContent = '该会话尚未配置，请先填写连接信息'; return }
        openHost(h)
      }
      d.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); showCtx(h, ev.clientX, ev.clientY) }
      body.appendChild(d)
    }
    g.appendChild(body)
    hostList.appendChild(g)
  }
}

// ---- new folder
const newGroupRow = el('newGroupRow')
const newGroupInput = el('newGroupInput')
el('addGroup').onclick = () => {
  newGroupRow.classList.toggle('on')
  if (newGroupRow.classList.contains('on')) newGroupInput.focus()
}
newGroupInput.addEventListener('keydown', async (ev) => {
  if (ev.key === 'Escape') { newGroupRow.classList.remove('on'); return }
  if (ev.key !== 'Enter') return
  const name = newGroupInput.value.trim()
  if (!name) { newGroupRow.classList.remove('on'); return }
  try { await window.st.addGroup(name) } catch (e) {}
  newGroupInput.value = ''
  newGroupRow.classList.remove('on')
  loadHosts()
})

function markOnline(hostId, on) {
  const n = hostList.querySelector('[data-host-id="' + hostId + '"]')
  if (!n) return
  n.classList.toggle('on', on)
  if (on) { n.classList.remove('fail'); n.title = '' }
}

function markBusy(hostId, on) {
  const n = hostList.querySelector('[data-host-id="' + hostId + '"]')
  if (n) n.classList.toggle('busy', on)
}

function markFailed(hostId, msg) {
  const n = hostList.querySelector('[data-host-id="' + hostId + '"]')
  if (!n) return
  n.classList.remove('on', 'busy')
  n.classList.add('fail')
  n.title = '\u4e0a\u6b21\u8fde\u63a5\u5931\u8d25\uff1a' + msg
}

function writePending(term, host) {
  const C = (s) => '\x1b[' + s + 'm'
  const R = C('0')
  term.writeln('')
  term.writeln(C('1;36') + '\u2192 \u6b63\u5728\u8fde\u63a5' + R + '  ' + (host.host || '?') + ':' + (host.port || 22))
  term.writeln(C('90') + '  \u7528\u6237 ' + (host.user || 'ubuntu') + R)
  term.writeln(C('90') + '  \u6700\u591a\u7b49\u5f85 12 \u79d2\uff0c\u5931\u8d25\u4f1a\u5728\u8fd9\u91cc\u663e\u793a\u539f\u56e0' + R)
  term.writeln('')
}

function writeFailBanner(term, host, ov, msg) {
  const C = (s) => '\x1b[' + s + 'm'
  const R = C('0')
  const how = host.password ? '\u5bc6\u7801' : ('\u5bc6\u94a5 ' + (host.key || '(\u672a\u586b\u5199)'))
  term.writeln('')
  term.writeln(C('1;31') + '\u2716 \u8fde\u63a5\u5931\u8d25' + R)
  term.writeln('')
  term.writeln(C('90') + '\u76ee\u6807   ' + R + (host.host || '(\u672a\u586b\u5199\u5730\u5740)') + ':' + (host.port || 22))
  term.writeln(C('90') + '\u7528\u6237   ' + R + (host.user || 'ubuntu'))
  term.writeln(C('90') + '\u8ba4\u8bc1   ' + R + how)
  term.writeln(C('90') + '\u539f\u56e0   ' + R + C('31') + msg + R)
  term.writeln('')
  term.writeln(C('90') + '\u8fd9\u4e2a\u6807\u7b7e\u4fdd\u7559\u4e0b\u6765\u4e86\uff0c\u65b9\u4fbf\u4f60\u770b\u5230\u5b8c\u6574\u9519\u8bef\u3002' + R)
  term.writeln(C('90') + '\u4fee\u6539\uff1a\u53f3\u952e\u4f1a\u8bdd \u2192 \u300c\u66f4\u6539\u8fde\u63a5\u300d\uff1b\u91cd\u8bd5\uff1a\u518d\u70b9\u4e00\u6b21\u5de6\u4fa7\u4f1a\u8bdd\u3002' + R)
  term.writeln('')
}

// ---------------- terminals
async function openHost(host) {
  const already = tabs.find((x) => x.hostId === host.id)
  if (already) {
    selectTerm(already.id)
    statusEl.textContent = '该会话已打开，已切换到对应标签'
    setTimeout(() => { statusEl.textContent = '' }, 2200)
    return
  }
  if (host.__connecting) return
  host.__connecting = true
  markBusy(host.id, true)

  const ov = (settings.sessions && settings.sessions[host.id]) || {}
  let saved = null
  try { saved = await window.st.histGet(host.id) } catch (e) {}

  // Open the tab FIRST, then connect. A dead IP can sit in TCP SYN for many
  // seconds; an empty window with "connecting" beats an app that looks frozen.
  failSeq += 1
  const tab = createTab('pending-' + failSeq, host, ov, saved, null, true)
  statusEl.textContent = '正在连接 ' + (host.name || host.id) + ' …'

  try {
    const { id } = await window.st.open(host.id, { encoding: ov.encoding || settings.encoding || 'utf-8' })
    tab.id = id
    tab.pending = false
    tab.term.write('\x1b[2J\x1b[3J\x1b[H')
    tab.term.focus()
    markOnline(host.id, true)
    statusEl.textContent = ''
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e)
    tab.pending = false
    tab.failed = true
    writeFailBanner(tab.term, host, ov, msg)
    markFailed(host.id, msg)
    statusEl.textContent = '连接失败: ' + msg
    renderTabRow()
  } finally {
    host.__connecting = false
    markBusy(host.id, false)
  }
}

let failSeq = 0
function createTab(id, host, ov, saved, failMsg, pendingMsg) {
  const wrap = document.createElement('div')
  wrap.className = 'termwrap'
  termsEl.appendChild(wrap)
  emptyEl.style.display = 'none'

  ov = ov || {}
  const fs0 = Number(ov.fontSize) || fontSize
  const th0 = ov.terminal || termThemeName
  const term = new TerminalCtor({
    fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
    fontSize: fs0, theme: TERM_THEMES[th0] || TERM_THEMES.dark, cursorBlink: true, letterSpacing: 0.2,
    scrollback: 5000, allowProposedApi: true,
  })
  const fit = new FitCtor()
  term.loadAddon(fit)
  let search = null
  if (SearchCtor) { try { search = new SearchCtor(); term.loadAddon(search) } catch (e) {} }
  term.open(wrap)

  const tab = {
    id, name: host.name || host.id, hostId: host.id, term, fit, search, wrap,
    fs: fs0, th: th0,
    pending: !!pendingMsg,
    failed: !!failMsg,
    memKey: host.id,
    agent: (saved && Array.isArray(saved.log) && saved.log.length)
      ? { log: saved.log, history: saved.history || [] }
      : { log: [], history: [] },
  }
  tabs.push(tab)

  term.onData((data) => {
    if (tab.pending) return
    window.st.input(tab.id, data)
    if (mirrorEl.checked) for (const x of tabs) if (x.id !== tab.id && !x.pending) window.st.input(x.id, data)
  })

  if (pendingMsg) writePending(term, host)
  if (failMsg) writeFailBanner(term, host, ov, failMsg)

  selectTerm(id)
  requestAnimationFrame(() => { try { fit.fit() } catch (e) {} })
  renderTabRow()
  updateHeads()
  term.focus()
  return tab
}

function selectTerm(id) {
  activeId = id
  for (const t of tabs) t.wrap.classList.toggle('active', t.id === id)
  showView('term')
  renderTabRow()
  const t = tabById(id)
  if (t) requestAnimationFrame(() => { try { t.fit.fit() } catch (e) {} t.term.focus() })
}

function renderTabRow() {
  tabRow.replaceChildren()


  for (const t of tabs) {
    const d = document.createElement('div')
    d.className = 'tab' + (view === 'term' && t.id === activeId ? ' active' : '')
    d.draggable = true
    d.dataset.tabId = t.id
    const dot = document.createElement('span'); dot.className = 'dot'
    if (t.failed) dot.style.background = 'var(--warn)'
    const n = document.createElement('span'); n.textContent = t.name
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '\u00d7'
    x.onclick = (ev) => { ev.stopPropagation(); closeTab(t.id) }
    d.append(dot, n, x)
    d.onclick = () => selectTerm(t.id)

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
  const from = tabs.findIndex((x) => x.id === fromId)
  if (from < 0) return
  if (fromId === toId) return
  const [item] = tabs.splice(from, 1)
  let idx = tabs.findIndex((x) => x.id === toId)
  if (idx < 0) { tabs.splice(from, 0, item); return }
  if (after) idx += 1
  tabs.splice(idx, 0, item)
  renderTabRow()
}

function closeTab(id) {
  const i = tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  window.st.close(id)
  try { tabs[i].term.dispose() } catch (e) {}
  tabs[i].wrap.remove()
  tabs.splice(i, 1)
  if (activeId === id) {
    const next = tabs[tabs.length - 1]
    activeId = next ? next.id : null
    if (!next) {
      emptyEl.style.display = 'flex'
    }
  }
  renderTabRow()
  updateHeads()
}

window.addEventListener('resize', () => {
  const t = tabById(activeId)
  if (t && view === 'term') { try { t.fit.fit() } catch (e) {} }
})

window.st.onData(({ id, data }) => {
  const t = tabById(id)
  if (t) t.term.write(data)
})
window.st.onClosed(({ id }) => closeTab(id))

// ---------------- font + search
function applyFont() {
  el('fontVal').textContent = String(fontSize)
  for (const t of tabs) {
    if (t.fs && t.fs !== fontSize && t._hasFsOverride) continue
    t.term.options.fontSize = fontSize
    try { t.fit.fit() } catch (e) {}
  }
}
el('fontUp').onclick = () => { fontSize = Math.min(20, fontSize + 0.5); applyFont() }
el('fontDown').onclick = () => { fontSize = Math.max(9, fontSize - 0.5); applyFont() }

el('searchInput').addEventListener('input', (ev) => {
  const t = tabById(activeId); if (!t || !t.search || !ev.target.value) return
  try { t.search.findNext(ev.target.value) } catch (e) {}
})
el('searchInput').addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return
  const t = tabById(activeId); if (!t || !t.search) return
  try { ev.shiftKey ? t.search.findPrevious(ev.target.value) : t.search.findNext(ev.target.value) } catch (e) {}
})


// ---------------- connection dialog
let editingId = null
async function openDialog(host) {
  editingId = host ? host.id : null
  el('dialog').querySelector('h3').textContent = host ? '\u7f16\u8f91\u8fde\u63a5' : '\u65b0\u5efa\u8fde\u63a5'
  el('fName').value = host ? (host.name || '') : ''
  el('fHost').value = host ? (host.host || '') : ''
  el('fPort').value = host ? String(host.port || 22) : '22'
  el('fUser').value = host ? (host.user || 'ubuntu') : 'ubuntu'
  el('fKey').value = host ? (host.key || '') : ''
  const groups = []
  for (const h of allHosts) if (h.group && !groups.includes(h.group)) groups.push(h.group)
  try { for (const g of (await window.st.groups()) || []) if (!groups.includes(g)) groups.push(g) } catch (e) {}
  const sel = el('fGroup')
  sel.replaceChildren()
  const opt0 = document.createElement('option'); opt0.value = ''; opt0.textContent = '（未分组）'
  sel.appendChild(opt0)
  for (const g of groups) {
    const o = document.createElement('option'); o.value = g; o.textContent = g
    sel.appendChild(o)
  }
  sel.value = (host && host.group) || ''
  const usePwd = !!(host && host.password)
  document.querySelector('input[name=auth][value=pwd]').checked = usePwd
  document.querySelector('input[name=auth][value=key]').checked = !usePwd
  el('fPwd').value = host ? (host.password || '') : ''
  resetDeleteBtn()
  el('fErr').textContent = ''
  el('btnDelete').style.display = host ? '' : 'none'
  syncAuth()
  el('overlay').classList.add('on')
  setTimeout(() => el('fName').focus(), 30)
}
function syncAuth() {
  const pwd = document.querySelector('input[name=auth]:checked').value === 'pwd'
  el('keyField').style.display = pwd ? 'none' : ''
  el('pwdField').style.display = pwd ? '' : 'none'
}
document.querySelectorAll('input[name=auth]').forEach((r) => { r.onchange = syncAuth })
el('addHost').onclick = () => openDialog(null)
el('btnClose').onclick = () => el('overlay').classList.remove('on')
el('overlay').onclick = (ev) => { if (ev.target === el('overlay')) el('overlay').classList.remove('on') }
el('btnTest').onclick = () => { statusEl.textContent = '\u6d4b\u8bd5\u8fde\u63a5\uff1a\u754c\u9762\u5c31\u7eea\uff0c\u5f85\u63a5\u7ebf' }
el('btnSave').onclick = async () => {
  const pwd = document.querySelector('input[name=auth]:checked').value === 'pwd'
  const wantName = el('fName').value.trim() || '\u672a\u547d\u540d'
  const wantHost = el('fHost').value.trim()
  const wantPort = Number(el('fPort').value) || 22
  const wantUser = el('fUser').value.trim() || 'ubuntu'

  // A name is a handle the user picks. Silently rewriting it is worse than saying no.
  const nameTaken = (allHosts || []).some((h) => h.id !== editingId && (h.name || '') === wantName)
  if (nameTaken) {
    el('fErr').textContent = '\u540d\u79f0\u300c' + wantName + '\u300d\u5df2\u88ab\u5360\u7528\uff0c\u8bf7\u6362\u4e00\u4e2a'
    return
  }

  // Same endpoint + same name + same user = the same connection; refuse quietly-stored junk.
  if (!editingId) {
    const dup = (allHosts || []).find((h) =>
      (h.host || '') === wantHost &&
      Number(h.port || 22) === wantPort &&
      (h.user || 'ubuntu') === wantUser)
    if (dup) {
      el('fErr').textContent = '\u5df2\u5b58\u5728\u6307\u5411\u540c\u4e00\u4e3b\u673a\u7684\u8fde\u63a5\uff08' + dup.name + '\uff09'
      return
    }
  }
  el('fErr').textContent = ''

  let newId = editingId
  let finalName = wantName
  if (!newId) {
    let base = wantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 12)
      || ('h' + Date.now().toString(36))
    newId = base
    let n = 2
    while ((allHosts || []).some((h) => h.id === newId)) { newId = base + '-' + n; n++ }
  }

  const host = {
    id: newId,
    name: finalName,
    host: wantHost,
    port: wantPort,
    user: wantUser,
    group: el('fGroup').value || '',
  }
  if (pwd) host.password = el('fPwd').value
  else host.key = el('fKey').value.trim()
  await window.st.saveHost(host)
  el('overlay').classList.remove('on')
  loadHosts()
}

// ---------------- markdown (no external libs: CSP is self-only)
function escHtml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function mdInline(src) {
  const codes = []
  let s = String(src).replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0001' + (codes.length - 1) + '\u0001' })
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => '<code>' + codes[+i] + '</code>')
  return s
}

function splitRow(line) {
  let t = line.trim()
  if (t.startsWith('|')) t = t.slice(1)
  if (t.endsWith('|')) t = t.slice(0, -1)
  return t.split('|').map((c) => c.trim())
}

function mdToHtml(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // fenced code
    const fence = line.match(/^\s*```([\w+-]*)\s*$/)
    if (fence) {
      const buf = []
      i++
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      out.push('<pre class="code"><code>' + escHtml(buf.join('\n')) + '</code></pre>')
      continue
    }

    // table: header + separator row
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|/.test(lines[i + 1])) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'), r = c.endsWith(':')
        return l && r ? 'center' : r ? 'right' : 'left'
      })
      i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++ }
      let h = '<div class="tblwrap"><table><thead><tr>'
      head.forEach((c, k) => { h += '<th style="text-align:' + (align[k] || 'left') + '">' + mdInline(escHtml(c)) + '</th>' })
      h += '</tr></thead><tbody>'
      for (const r of rows) {
        h += '<tr>'
        for (let k = 0; k < head.length; k++) {
          h += '<td style="text-align:' + (align[k] || 'left') + '">' + mdInline(escHtml(r[k] == null ? '' : r[k])) + '</td>'
        }
        h += '</tr>'
      }
      h += '</tbody></table></div>'
      out.push(h)
      continue
    }

    // heading
    const hm = line.match(/^(#{1,6})\s+(.*)$/)
    if (hm) {
      const n = hm[1].length
      out.push('<h' + n + '>' + mdInline(escHtml(hm[2])) + '</h' + n + '>')
      i++
      continue
    }

    // hr
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push('<hr>'); i++; continue }

    // quote
    if (/^\s*>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      out.push('<blockquote>' + mdInline(escHtml(buf.join('\n')).replace(/\n/g, '<br>')) + '</blockquote>')
      continue
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++ }
      out.push('<ul>' + items.map((x) => '<li>' + mdInline(escHtml(x)) + '</li>').join('') + '</ul>')
      continue
    }

    // ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++ }
      out.push('<ol>' + items.map((x) => '<li>' + mdInline(escHtml(x)) + '</li>').join('') + '</ol>')
      continue
    }

    // blank
    if (!line.trim()) { i++; continue }

    // paragraph
    const buf = []
    while (i < lines.length && lines[i].trim() &&
           !/^\s*```/.test(lines[i]) && !/^\s*\|/.test(lines[i]) &&
           !/^(#{1,6})\s/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
           !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i])) {
      buf.push(lines[i]); i++
    }
    out.push('<p>' + mdInline(escHtml(buf.join('\n')).replace(/\n/g, '<br>')) + '</p>')
  }
  return out.join('')
}

function fillMsg(node, cls, text) {
  if (cls === 'bot') node.innerHTML = mdToHtml(text)
  else node.textContent = text
}

// ---------------- per-session sub agent
function renderSub() {
  const box = el('subLog')
  box.replaceChildren()
  const t = tabById(activeId)
  if (!t) {
    const d = document.createElement('div')
    d.className = 'msg intro'
    d.textContent = '\u5148\u6253\u5f00\u4e00\u4e2a\u4f1a\u8bdd\u3002'
    box.appendChild(d)
    return
  }
  if (!t.agent.log.length) {
    t.agent.log.push({ cls: 'intro', text: '\u53ea\u4f5c\u7528\u4e8e ' + t.name + '\uff0c\u8bb0\u5fc6\u72ec\u7acb\u3002' })
  }
  for (const m of t.agent.log) {
    const d = document.createElement('div')
    d.className = 'msg ' + m.cls
    fillMsg(d, m.cls, m.text)
    box.appendChild(d)
  }
  box.scrollTop = box.scrollHeight
  persistTabAgent(t)
}

async function askSub() {
  const input = el('subInput')
  const text = input.value.trim()
  const t = tabById(activeId)
  if (!text || subBusy || !t) return
  if (!hasApi()) { statusEl.textContent = '尚未配置 Agent API，agent 不可用'; openGlobal('api'); return }

  subBusy = true
  updateHeads()
  input.value = ''
  t.agent.log.push({ cls: 'me', text })
  const thinking = { cls: 'thinking', text: '\u601d\u8003\u4e2d\u2026' }
  t.agent.log.push(thinking)
  renderSub()

  try {
    const res = await window.st.ask({ text, targets: [t.id], history: t.agent.history, scope: 'session' })
    const i = t.agent.log.indexOf(thinking)
    if (i >= 0) t.agent.log.splice(i, 1)
    if (res.error) t.agent.log.push({ cls: 'err', text: res.error })
    else {
      for (const a of res.actions || []) t.agent.log.push({ cls: 'act', text: '$ ' + a.command + (a.note ? '\n  ' + a.note : '') })
      if (res.reply) {
        t.agent.log.push({ cls: 'bot', text: res.reply })
        t.agent.history.push({ role: 'user', content: text })
        t.agent.history.push({ role: 'assistant', content: res.reply })
      }
    }
  } catch (e) {
    const i = t.agent.log.indexOf(thinking)
    if (i >= 0) t.agent.log.splice(i, 1)
    t.agent.log.push({ cls: 'err', text: String(e && e.message ? e.message : e) })
  } finally {
    subBusy = false
    updateHeads()
    persistTabAgent(t)
    renderSub()
    input.focus()
  }
}

el('subSend').onclick = askSub
el('subInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); askSub() }
})
mirrorEl.onchange = () => { statusEl.textContent = mirrorEl.checked ? '\u955c\u50cf\u8f93\u5165\u5df2\u5f00\u542f' : '' }

// ---------------- settings (CRT-style dialogs)
let settings = { theme: 'dark', terminal: 'dark', encoding: 'utf-8', accent: '#5aa9ff', fontSize: 12.5, agent: {}, sessions: {} }

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light'
  if (settings.accent) document.documentElement.style.setProperty('--accent', settings.accent)
  termThemeName = settings.terminal || 'dark'
  for (const t of tabs) {
    if (t._hasThOverride) continue
    t.th = termThemeName
    t.term.options.theme = TERM_THEMES[termThemeName] || TERM_THEMES.dark
  }
}


// --- global dialog
function openGlobal(tab) {
  el('gTheme').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === (settings.theme || 'dark')))
  el('gAccent').value = settings.accent || '#5aa9ff'
  el('gTerm').value = settings.terminal || 'dark'
  el('gFont').value = String(settings.fontSize || 12.5)
  el('gEnc').value = settings.encoding || 'utf-8'
  const a = settings.agent || {}
  el('gBase').value = a.baseUrl || ''
  el('gKey').value = a.apiKey || ''
  el('gModel').value = a.model || ''
  el('gMsg').textContent = ''
  el('gMsg').style.color = ''
  setGlobalTab(tab || 'appear')
  el('gset').classList.add('on')
}

function setGlobalTab(name) {
  document.querySelectorAll('#gset .ni').forEach((n) => n.classList.toggle('active', n.dataset.tab === name))
  document.querySelectorAll('#gset .tp').forEach((t) => t.classList.toggle('active', t.id === 'tp-' + name))
}
document.querySelectorAll('#gset .ni').forEach((n) => { n.onclick = () => setGlobalTab(n.dataset.tab) })
el('gTheme').querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    settings.theme = b.dataset.v
    el('gTheme').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b))
    applyTheme()
  }
})
el('gAccent').oninput = () => { settings.accent = el('gAccent').value; applyTheme() }
el('gTerm').onchange = () => { settings.terminal = el('gTerm').value; applyTheme() }
el('gFont').onchange = () => {
  settings.fontSize = Math.max(9, Math.min(20, Number(el('gFont').value) || 12.5))
  fontSize = settings.fontSize
  applyFont()
}

async function testAgentCfg(cfg) {
  if (typeof window.st.testAgent !== 'function') return { ok: false, error: '主进程接口缺失，请重新部署' }
  try { return await window.st.testAgent(cfg) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
}

el('gTest').onclick = async () => {
  el('gMsg').style.color = ''
  el('gMsg').textContent = '测试中…'
  const r = await testAgentCfg({ baseUrl: el('gBase').value.trim(), apiKey: el('gKey').value.trim(), model: el('gModel').value.trim() })
  if (r.ok) {
    el('gMsg').style.color = 'var(--ok)'
    el('gMsg').textContent = '连接正常' + (r.models && r.models.length ? '（' + r.models.join(', ') + '）' : '')
  } else {
    el('gMsg').style.color = 'var(--warn)'
    el('gMsg').textContent = '失败: ' + (r.error || '')
  }
}

el('gSave').onclick = async () => {
  settings.agent = {
    baseUrl: el('gBase').value.trim() || 'https://api.deepseek.com/v1',
    apiKey: el('gKey').value.trim(),
    model: el('gModel').value.trim() || 'deepseek-flash',
  }
  settings.encoding = el('gEnc').value || 'utf-8'
  try { await window.st.saveSettings(settings) } catch (e) {
    el('gMsg').style.color = 'var(--warn)'
    el('gMsg').textContent = '保存失败: ' + (e && e.message ? e.message : e)
    return
  }
  el('gset').classList.remove('on')
  updateHeads()
}
document.querySelectorAll('[data-close]').forEach((x) => {
  x.onclick = () => el(x.dataset.close).classList.remove('on')
})
document.querySelectorAll('.ovl').forEach((o) => {
  o.onclick = (ev) => { if (ev.target === o) o.classList.remove('on') }
})
el('btnSettings').onclick = () => openGlobal('appear')

// ---------------- panel visibility
function setPanelVisible(v) {
  el('panel').classList.toggle('hidden', !v)
  if (v) {
    // re-fit whatever terminal is showing
    const t = tabById(activeId)
    if (t && view === 'term') setTimeout(() => { try { t.fit.fit() } catch (e) {} }, 60)
  }
}
function setRightVisible(v) {
  el('right').classList.toggle('hidden', !v)
  rightHiddenByUser = !v
  document.body.classList.toggle('right-collapsed', !v)
  el('btnSubToggle').classList.toggle('on', !!v)
  if (v) {
    const t = tabById(activeId)
    if (t) setTimeout(() => { try { t.fit.fit() } catch (e) {} }, 60)
  }
}
let rightHiddenByUser = false
el('panelHide').onclick = () => setPanelVisible(false)

el('subHide').onclick = () => setRightVisible(false)
el('btnSubToggle').onclick = () => setRightVisible(el('right').classList.contains('hidden'))
el('rightHandle').onclick = () => setRightVisible(true)
document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey && ev.shiftKey && !ev.altKey && (ev.key === 'A' || ev.key === 'a')) {
    ev.preventDefault()
    setRightVisible(el('right').classList.contains('hidden'))
  }
})

// --- session dialog
function openSessionSettings(hostId) {
  const hid = hostId || (tabById(activeId) || {}).hostId
  const t = tabs.find((x) => x.hostId === hid) || null
  const host = (allHosts || []).find((h) => h.id === hid) || null
  if (!hid) { statusEl.textContent = '先选择一个会话'; return }
  const label = t ? t.name : (host ? (host.name || host.id) : hid)
  el('ssName').textContent = label + (t ? '' : '（未打开）')
  const ov = (settings.sessions && settings.sessions[hid]) || {}
  const fsSel = el('ssFont')
  fsSel.replaceChildren()
  const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '跟随全局（' + settings.fontSize + '）'
  fsSel.appendChild(o0)
  for (let v = 9; v <= 20; v += 0.5) {
    const o = document.createElement('option'); o.value = String(v); o.textContent = String(v)
    fsSel.appendChild(o)
  }
  fsSel.value = ov.fontSize ? String(ov.fontSize) : ''
  el('ssTerm').value = ov.terminal || ''
  el('ssEnc').value = ov.encoding || ''
  el('ssMsg').textContent = ''
  el('sset').classList.add('on')

  const save = () => {
    settings.sessions = settings.sessions || {}
    const next = {}
    if (el('ssFont').value) next.fontSize = Number(el('ssFont').value)
    if (el('ssTerm').value) next.terminal = el('ssTerm').value
    if (el('ssEnc').value) next.encoding = el('ssEnc').value
    settings.sessions[hid] = next
    window.st.saveSettings(settings).catch(() => {})

    if (t) {
      t._hasFsOverride = !!next.fontSize
      t.fs = next.fontSize || settings.fontSize
      t.term.options.fontSize = t.fs
      t._hasThOverride = !!next.terminal
      t.th = next.terminal || termThemeName
      t.term.options.theme = TERM_THEMES[t.th] || TERM_THEMES.dark
      try { t.fit.fit() } catch (e) {}
    }
    if (next.encoding) {
      if (t && window.st.setEncoding) window.st.setEncoding(t.id, next.encoding)
    }
    el('ssMsg').textContent = '已应用'
    setTimeout(() => { el('ssMsg').textContent = '' }, 1500)
  }
  el('ssFont').onchange = save
  el('ssTerm').onchange = save
  el('ssEnc').onchange = save
}
el('btnSession').onclick = () => openSessionSettings(activeId ? (tabById(activeId) || {}).hostId : null)

// --- first run
el('obGo').onclick = async () => {
  const btn = el('obGo')
  el('obErr').textContent = ''
  const cfg = {
    baseUrl: el('obBase').value.trim() || 'https://api.deepseek.com/v1',
    apiKey: el('obKey').value.trim(),
    model: el('obModel').value.trim() || 'deepseek-flash',
  }
  if (!cfg.apiKey) { el('obErr').textContent = '请填写 API Key'; return }
  btn.disabled = true
  btn.textContent = '测试中…'
  const r = await testAgentCfg(cfg)
  btn.disabled = false
  btn.textContent = '测试连接并进入'
  if (!r.ok) { el('obErr').textContent = '连接失败：' + (r.error || '未知错误'); return }
  if (r.modelKnown === false) { el('obErr').textContent = '连接成功，但模型名可能不对。可用: ' + (r.models || []).join(', '); return }
  settings.onboarded = true
  settings.agent = cfg
  try { await window.st.saveSettings(settings) } catch (e) {
    el('obErr').textContent = '保存失败：' + (e && e.message ? e.message : e)
    return
  }
  el('onboard').classList.remove('on')
}
el('obSkip').onclick = async () => {
  settings.onboarded = true
  try { await window.st.saveSettings(settings) } catch (e) {}
  el('onboard').classList.remove('on')
  statusEl.textContent = '未配置 Agent API，终端可用'
}

// ---------------- host right-click menu
let ctxHost = null

function hideCtx() { el('ctxmenu').classList.remove('on') }

document.addEventListener('click', hideCtx)
document.addEventListener('contextmenu', (ev) => {
  if (!ev.target.closest('.host')) hideCtx()
})
window.addEventListener('blur', hideCtx)

function showCtx(host, x, y) {
  ctxHost = host
  const m = el('ctxmenu')
  m.querySelector('.ctxitem[data-a="delete"]').textContent = '\u5220\u9664\u4f1a\u8bdd'
  m.classList.add('on')
  const w = m.offsetWidth
  const h = m.offsetHeight
  m.style.left = Math.min(x, window.innerWidth - w - 8) + 'px'
  m.style.top = Math.min(y, window.innerHeight - h - 8) + 'px'
}

async function cloneHost(host) {
  const base = host.id.replace(/-\d+$/, '')
  let n = 2
  while ((allHosts || []).some((h) => h.id === base + '-' + n)) n++
  const taken = (nm) => (allHosts || []).some((h) => (h.name || '') === nm)
  let cname = (host.name || host.id) + ' \u526f\u672c'
  let k = 2
  while (taken(cname)) { cname = (host.name || host.id) + ' \u526f\u672c (' + k + ')'; k++ }
  const copy = Object.assign({}, host, { id: base + '-' + n, name: cname })
  delete copy.disabled
  await window.st.saveHost(copy)
  loadHosts()
  statusEl.textContent = '\u5df2\u514b\u9686\u4e3a ' + copy.name
  setTimeout(() => { statusEl.textContent = '' }, 2200)
}

let delArmHost = null
el('ctxmenu').onclick = async (ev) => {
  const item = ev.target.closest('.ctxitem')
  if (!item || !ctxHost) return
  const a = item.dataset.a
  const host = ctxHost
  if (a === 'conn') { hideCtx(); openDialog(host); return }
  if (a === 'settings') { hideCtx(); openSessionSettings(host.id); return }
  if (a === 'clone') { hideCtx(); await cloneHost(host); return }
  if (a === 'delete') {
    if (delArmHost !== host.id) {
      delArmHost = host.id
      item.textContent = '\u518d\u70b9\u4e00\u6b21\u786e\u8ba4'
      setTimeout(() => {
        delArmHost = null
        item.textContent = '\u5220\u9664\u4f1a\u8bdd'
      }, 4000)
      return
    }
    delArmHost = null
    hideCtx()
    await window.st.deleteHost(host.id)
    const openTab = tabs.find((x) => x.hostId === host.id)
    if (openTab) closeTab(openTab.id)
    loadHosts()
    statusEl.textContent = '\u5df2\u5220\u9664\uff0c\u5176 agent \u8bb0\u5fc6\u4e00\u5e76\u6e05\u7406'
    setTimeout(() => { statusEl.textContent = '' }, 2600)
  }
}

// ---------------- session memory picker
async function openMemSel() {
  const cur = tabById(activeId)
  if (!cur) { statusEl.textContent = '先打开一个会话'; return }
  el('memMsg').textContent = ''
  const box = el('memList')
  box.replaceChildren()

  const head = document.createElement('div')
  head.style.cssText = 'font-size:11.5px;color:var(--dim2);line-height:1.7'
  head.textContent = '当前标签独立记忆：' + cur.agent.log.length + ' 条消息。同一主机的不同标签互不影响。'
  box.appendChild(head)

  let list = []
  try { list = await window.st.histList(cur.hostId) } catch (e) {}

  if (!list.length) {
    const d = document.createElement('div')
    d.style.cssText = 'color:var(--dim2);font-size:12px;padding:8px 0'
    d.textContent = '这台主机还没有保存过记忆。'
    box.appendChild(d)
  }

  for (const rec of list) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--line);border-radius:8px'
    const info = document.createElement('div')
    info.style.cssText = 'flex:1;min-width:0'
    const nm = document.createElement('div')
    nm.style.cssText = 'font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    const firstUser = (rec.name || '').trim()
    nm.textContent = firstUser || rec.key
    const sub = document.createElement('div')
    sub.style.cssText = 'font-size:10.5px;color:var(--dim2)'
    const when = rec.updatedAt ? new Date(rec.updatedAt).toLocaleString() : ''
    sub.textContent = rec.count + ' 条 · ' + when + (rec.key === cur.memKey ? ' · 当前' : '')
    info.append(nm, sub)

    const btnLoad = document.createElement('button')
    btnLoad.className = 'pill'
    btnLoad.textContent = '载入'
    btnLoad.onclick = async () => {
      const v = await window.st.histGet(rec.key)
      if (!v) return
      cur.memKey = rec.key
      cur.memCreatedAt = rec.createdAt || Date.now()
      cur.agent = { log: v.log || [], history: v.history || [] }
      renderSub()
      el('memsel').classList.remove('on')
      statusEl.textContent = '已载入该记忆'
      setTimeout(() => { statusEl.textContent = '' }, 2000)
    }

    const btnDel = document.createElement('button')
    btnDel.className = 'pill'
    btnDel.textContent = '删除'
    btnDel.onclick = async () => {
      await window.st.histClear(rec.key)
      if (cur.memKey === rec.key) {
        cur.memKey = cur.hostId
        cur.agent = { log: [], history: [] }
        renderSub()
      }
      openMemSel()
    }

    row.append(info, btnLoad, btnDel)
    box.appendChild(row)
  }
  el('memsel').classList.add('on')
}
el('subHist').onclick = openMemSel


// ---------------- delete a connection
let delArmed = false
function resetDeleteBtn() {
  delArmed = false
  const b = el('btnDelete')
  b.textContent = '\u5220\u9664\u8fde\u63a5'
  b.style.color = ''
}
el('btnDelete').onclick = async () => {
  if (!editingId) return
  if (!delArmed) {
    delArmed = true
    el('btnDelete').textContent = '\u518d\u70b9\u4e00\u6b21\u786e\u8ba4\u5220\u9664'
    el('btnDelete').style.color = 'var(--warn)'
    setTimeout(resetDeleteBtn, 4000)
    return
  }
  await window.st.deleteHost(editingId)
  resetDeleteBtn()
  el('overlay').classList.remove('on')
  loadHosts()
  statusEl.textContent = '\u5df2\u5220\u9664\u8fde\u63a5\uff0c\u5176 agent \u8bb0\u5fc6\u4e00\u5e76\u6e05\u7406'
  setTimeout(() => { statusEl.textContent = '' }, 2600)
}

// ---------------- boot
async function boot() {
  try { settings = Object.assign(settings, await window.st.settings()) } catch (e) {}
  settings.sessions = settings.sessions || {}
  fontSize = Number(settings.fontSize) || 12.5
  el('fontVal').textContent = String(fontSize)
  applyTheme()

  if (!settings.onboarded) {
    el('obBase').value = (settings.agent && settings.agent.baseUrl) || 'https://api.deepseek.com/v1'
    el('obKey').value = (settings.agent && settings.agent.apiKey) || ''
    el('obModel').value = (settings.agent && settings.agent.model) || 'deepseek-flash'
    el('onboard').classList.add('on')
  }


  showView('term')
  await loadHosts()
  updateHeads()
}

boot()
