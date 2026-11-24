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
const workspaces = []
const hostHistory = new Map()
const mirrorTargets = new Set()
let activeWorkspace = null
let activeId = null
let fontSize = 12.5
const busyConversations = new Set()

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

const tabById = (id) => tabs.find((t) => t.id === id)

// 把旧版本存在 hostId-2 / hostId-3 等 key 下的记忆，合并成对话（幂等）
async function mergeLegacyConvs(tab) {
  const consumed = []
  try {
    const list = await window.st.histList(tab.hostId)
    if (!Array.isArray(list)) return consumed
    for (const rec of list) {
      if (!rec || rec.key === tab.hostId) continue
      const id = 'legacy-' + rec.key
      const already = tab.agent.convs.some((c) => c.id === id)
      if (already) {
        // 内容已经在当前会话里了，源 key 可以直接回收
        consumed.push(rec.key)
        continue
      }
      const v = await window.st.histGet(rec.key)
      if (!v) continue
      const log = Array.isArray(v.log) ? v.log : []
      const history = Array.isArray(v.history) ? v.history : []
      if (!log.length && !history.length) continue
      tab.agent.convs.push({
        id,
        title: convTitleFrom(log, tab.name),
        log,
        history,
        createdAt: rec.createdAt || Date.now(),
        updatedAt: rec.updatedAt || rec.createdAt || Date.now(),
      })
      consumed.push(rec.key)
    }
  } catch (e) {}
  return consumed
}

// ---------------- 助手对话（每个 SSH 会话下挂多段对话）
function newConvObj(title) {
  return {
    id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title: title || '\u65b0\u5bf9\u8bdd',
    log: [], history: [], createdAt: Date.now(), updatedAt: Date.now(),
  }
}

function convTitleFrom(log, fallback) {
  const first = (log || []).find((m) => m.cls === 'me')
  const t = first && first.text ? String(first.text).trim() : ''
  return (t || fallback || '\u65b0\u5bf9\u8bdd').slice(0, 24)
}

// 兼容旧结构 { log, history }：迁移成一段对话
function normalizeAgent(saved, fallbackTitle) {
  const out = { convs: [], activeId: null }
  if (saved && Array.isArray(saved.convs) && saved.convs.length) {
    out.convs = saved.convs.map((c) => ({
      id: c.id || ('c' + Math.random().toString(36).slice(2, 8)),
      title: c.title || '\u65b0\u5bf9\u8bdd',
      log: Array.isArray(c.log) ? c.log : [],
      history: Array.isArray(c.history) ? c.history : [],
      createdAt: c.createdAt || Date.now(),
      updatedAt: c.updatedAt || c.createdAt || Date.now(),
    }))
    out.activeId = saved.activeId || out.convs[out.convs.length - 1].id
  } else {
    const legacyLog = saved && Array.isArray(saved.log) ? saved.log : null
    const legacyHist = saved && Array.isArray(saved.history) ? saved.history : null
    if ((legacyLog && legacyLog.length) || (legacyHist && legacyHist.length)) {
      const c = newConvObj(convTitleFrom(legacyLog, fallbackTitle))
      c.log = legacyLog || []
      c.history = legacyHist || []
      out.convs.push(c)
      out.activeId = c.id
    }
  }
  return out
}

function activeConv(tab) {
  if (!tab.agent || !Array.isArray(tab.agent.convs)) tab.agent = normalizeAgent(tab.agent, tab.name)
  const a = tab.agent
  if (!a.convs.length) {
    const c = newConvObj()
    a.convs.push(c)
    a.activeId = c.id
  }
  let c = a.convs.find((x) => x.id === a.activeId)
  if (!c) { c = a.convs[a.convs.length - 1]; a.activeId = c.id }
  return c
}

function persistTabAgent(tab) {
  if (!tab.memKey) return Promise.resolve(false)
  // 关键：历史还没加载完就保存，会用“空对话”覆盖掉磁盘上的真实记录。
  // 事故：新建标签 → renderSub → 保存空状态 → 再 histGet 读回来已是空的，重启必丢。
  if (!tab.historyLoaded) return Promise.resolve(false)
  const c = activeConv(tab)
  const count = tab.agent.convs.reduce((n, x) => n + (x.log ? x.log.length : 0), 0)
  try {
    return window.st.histSave(tab.memKey, {
      convs: tab.agent.convs,
      activeId: tab.agent.activeId,
      hostId: tab.hostId,
      name: c.title,
      count,
      createdAt: tab.memCreatedAt || (tab.memCreatedAt = Date.now()),
    }).catch((error) => { statusEl.textContent = error.message; return false })
  } catch (e) { return Promise.resolve(false) }
}

// ---------------- window controls
el('wMin').onclick = () => window.st.winMinimize()
el('wMax').onclick = () => window.st.winMaximize()
el('wClose').onclick = () => window.st.winClose()

// ---------------- view switching
function showView() {
  const pane = tabById(activeId)
  el('toolbar').hidden = !pane
  el('empty').hidden = !!pane
  el('vaultNav').hidden = !!pane
  el('libraryHome').classList.toggle('on', !pane)
  if (!pane) el('searchWrap').hidden = true
  renderTabRow()
  renderSub()
  updateHeads()
}

function updateHeads() {
  const t = tabById(activeId)
  el('subTarget').textContent = t ? t.name : '未连接'
  el('subNew').title = t ? '新建 ' + t.name + ' 的对话' : '请先连接主机'
  const busy = !!t?.historyLoaded && busyConversations.has(activeConv(t))
  el('subSend').disabled = busy
  const why = !t?.sessionId ? '请先连接主机' : !t.historyLoaded ? '正在载入对话' : !hasApi() ? '请在设置中填写 API Key' : ''
  el('subSend').title = busy ? '正在获取回复' : why || '发送（Enter）'
  el('subInput').placeholder = why || '向当前主机提问…'
  el('subInput').disabled = busy
  el('connectionState').textContent = t ? t.userTarget + ' · ' + (t.pending ? '连接中' : t.sessionId ? '已连接' : '已断开') : '未连接'
  el('connectionState').dataset.connected = String(!!t?.sessionId)
  el('terminalTarget').textContent = t?.userTarget || ''
  updateFileView()
}

function hasApi() { return !!settings.agent?.configured }

// ---------------- hosts
let allHosts = []
let hostGroups = []
const collapsed = {}

async function loadHosts() {
  try { allHosts = await window.st.hosts() } catch (error) { statusEl.textContent = error.message; return }

  try { hostGroups = await window.st.groups() } catch (e) {}
  renderHosts()
}

function renderHosts(resetLibrary = false) {
  const query = el('hostSearch').value.trim().toLowerCase()
  const matches = allHosts.filter((h) => [h.name, h.host, h.user, h.group].some((v) => String(v || '').toLowerCase().includes(query)))
  window.shrimpWorkspace.renderHosts(el('hostLibrary'), {
    hosts: allHosts, recent: settings.recentHosts || [], favorites: settings.favoriteHosts || [],
    section: librarySection, groups: hostGroups, online: tabs.filter((pane) => pane.sessionId).map((pane) => pane.hostId),
    onOpen: (host) => openHost(host), onFavorite: toggleFavorite, onEdit: (host) => openDialog(host),
    onNew: () => openDialog(null), onQuick: (target) => openDialog(null, true, target),
  }, resetLibrary)

  // group order: declared groups first, then whatever the hosts reference, then ""
  const declared = hostGroups
  const used = []
  for (const h of allHosts) {
    const g = h.group || ''
    if (g && !used.includes(g)) used.push(g)
  }
  const order = []
  for (const g of declared.concat(used)) if (!order.includes(g)) order.push(g)
  const hasUngrouped = allHosts.some((h) => !h.group)

  hostList.replaceChildren()
  const buckets = order.map((g) => ({ name: g, items: matches.filter((h) => (h.group || '') === g) }))
  if (hasUngrouped || !order.length) buckets.push({ name: '', items: matches.filter((h) => !h.group) })

  for (const b of buckets) {
    if (!b.items.length && b.name) continue
    const g = document.createElement('div')
    g.className = 'group' + (collapsed[b.name] && !query ? ' collapsed' : '')

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
      if (tabs.some((pane) => pane.hostId === h.id && pane.sessionId)) d.classList.add('on')
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
async function openDialog(host, quick = false, target = '') {
  editingId = host ? host.id : null
  el('dialog').querySelector('h3').textContent = host ? '编辑连接' : quick ? '快速连接' : '新建连接'
  el('fName').value = host ? (host.name || '') : ''
  el('fHost').value = host ? (host.host || '') : ''
  el('fPort').value = host ? String(host.port || 22) : '22'
  el('fUser').value = host ? (host.user || 'ubuntu') : 'ubuntu'
  el('fKey').value = host ? (host.key || '') : ''
  if (quick && target) {
    const connection = /^(?:ssh\s+)?(?:-p\s+(\d+)\s+)?(?:(\S+)@)?(\[[\da-f:]+\]|[\w.\-]+)(?::(\d+))?$/i.exec(target)
    if (connection) {
      el('fHost').value = connection[3].replace(/^\[|\]$/g, '')
      el('fUser').value = connection[2] || 'ubuntu'
      el('fPort').value = connection[4] || connection[1] || '22'
    }
  }
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
  const usePwd = !!host?.hasPassword
  document.querySelector('input[name=auth][value=pwd]').checked = usePwd
  document.querySelector('input[name=auth][value=key]').checked = !usePwd
  el('fPwd').value = ''
  el('fPwd').placeholder = usePwd ? '留空保留已保存的密码' : ''
  resetDeleteBtn()
  el('fErr').textContent = ''
  el('btnDelete').style.display = host ? '' : 'none'
  syncAuth()
  el('overlay').classList.add('on')
  requestAnimationFrame(() => el(quick ? 'fHost' : 'fName').focus())
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
el('btnTest').onclick = () => el('btnSave').onclick(true)
el('btnSave').onclick = async (connect) => {
  const pwd = document.querySelector('input[name=auth]:checked').value === 'pwd'
  const wantHost = el('fHost').value.trim()
  const wantName = el('fName').value.trim() || wantHost || '未命名'
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
  if (!wantHost || !Number.isInteger(wantPort) || wantPort < 1 || wantPort > 65535) {
    el('fErr').textContent = '请填写主机地址和有效的 SSH 端口。'
    return
  }

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
  if (pwd) { host.authType = 'password'; host.password = el('fPwd').value }
  else host.key = el('fKey').value.trim()
  try {
    const saved = await window.st.saveHost(host)
    if (!saved) throw new Error('请填写连接地址。')
    el('overlay').classList.remove('on')
    await loadHosts()
    if (connect === true) openHost(saved, null, true)
  } catch (error) { el('fErr').textContent = error.message }
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
  if (!t || !t.historyLoaded) {
    const d = document.createElement('div')
    d.className = 'msg intro'
    d.textContent = t?.historyError || (t ? '正在载入对话…' : '连接 SSH 主机后即可提问。')
    box.appendChild(d)
    return
  }
  const conv = activeConv(t)
  if (!conv.log.length) {
    const d = document.createElement('div')
    d.className = 'msg intro'
    d.textContent = '\u65b0\u5bf9\u8bdd \u00b7 \u53ea\u4f5c\u7528\u4e8e ' + t.name + '\u3002\u4e0a\u4e00\u6bb5\u5bf9\u8bdd\u5728\u300c\u5386\u53f2\u4f1a\u8bdd\u300d\u91cc\u3002'
    box.appendChild(d)
  }
  for (const m of conv.log) {
    if (m.cls === 'task' && m.task) {
      box.appendChild(renderInlineTask(m.task))
      continue
    }
    const d = document.createElement('div')
    d.className = 'msg ' + m.cls
    fillMsg(d, m.cls, m.text)
    box.appendChild(d)
  }
  box.scrollTop = box.scrollHeight
}

async function askSub() {
  const input = el('subInput')
  const text = input.value.trim()
  const pane = tabById(activeId)
  if (!pane?.sessionId) { statusEl.textContent = '请先连接 SSH 主机。'; return }
  if (!pane.historyLoaded) { statusEl.textContent = pane.historyError || '正在载入对话…'; return }
  if (!text) return
  if (!hasApi()) { openGlobal('api'); return }

  const conv = activeConv(pane)
  if (busyConversations.has(conv)) return
  busyConversations.add(conv)
  input.value = ''
  conv.log.push({ cls: 'me', text })
  if (conv.title === '新对话') conv.title = convTitleFrom(conv.log, pane.name)
  const thinking = { cls: 'thinking', text: '思考中…' }
  conv.log.push(thinking)
  updateHeads()
  renderSub()
  pane.term.focus()

  try {
    const result = await window.st.ask({
      text, sessionId: pane.sessionId, conversationId: conv.id, history: conv.history,
    })
    if (result.error) conv.log.push({ cls: 'err', text: result.error })
    if (result.reply) {
      conv.log.push({ cls: 'bot', text: result.reply })
      conv.history.push({ role: 'user', content: text }, { role: 'assistant', content: result.reply })
    }
  } catch (error) {
    conv.log.push({ cls: 'err', text: error.message })
  } finally {
    const index = conv.log.indexOf(thinking)
    if (index >= 0) conv.log.splice(index, 1)
    conv.updatedAt = Date.now()
    busyConversations.delete(conv)
    void persistTabAgent(pane)
    const current = tabById(activeId)
    if (current?.hostId === pane.hostId) { updateHeads(); renderSub() }
  }
}

el('subSend').onclick = askSub
el('subInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    askSub()
  }
})

const taskLabels = {
  waiting: '待确认', running: '执行中', succeeded: '已完成', failed: '失败',
  cancelled: '已取消', timeout: '超时', unknown: '结果未知',
}

function renderInlineTask(task) {
  const card = document.createElement('section')
  card.className = 'inline-task'
  card.dataset.status = task.status
  const heading = document.createElement('div')
  heading.className = 'inline-task-head'
  const title = document.createElement('span')
  title.textContent = task.note || 'Agent 命令'
  const state = document.createElement('span')
  state.dataset.status = task.status
  state.textContent = taskLabels[task.status] || task.status
  heading.append(title, state)
  card.appendChild(heading)

  const target = document.createElement('p')
  target.className = 'inline-task-target'
  target.textContent = task.target || ''
  card.appendChild(target)
  const command = document.createElement('pre')
  command.textContent = '$ ' + task.command
  card.appendChild(command)

  for (const [label, output] of [['输出', task.stdout], ['错误输出', task.stderr], ['状态', task.error]]) {
    if (!output) continue
    const row = document.createElement('p')
    row.className = 'inline-task-output'
    row.textContent = label + ' · ' + output
    card.appendChild(row)
  }

  if (task.status === 'waiting' || task.status === 'running') {
    const actions = document.createElement('div')
    actions.className = 'inline-task-actions'
    if (task.status === 'waiting') {
      const confirm = document.createElement('button')
      confirm.className = 'workspace-button confirm-task'
      confirm.textContent = '确认执行'
      confirm.onclick = async () => {
        confirm.disabled = true
        try { await window.st.confirmTask(task.id) } catch (error) { statusEl.textContent = error.message }
      }
      actions.appendChild(confirm)
    }
    const cancel = document.createElement('button')
    cancel.className = 'workspace-button'
    cancel.textContent = '取消'
    cancel.onclick = async () => {
      try { await window.st.cancelTask(task.id) } catch (error) { statusEl.textContent = error.message }
    }
    actions.appendChild(cancel)
    card.appendChild(actions)
  }
  return card
}

async function receiveTask(task) {
  if (!task || task.removed) return
  let pane = tabs.find((item) => item.sessionId === task.sessionId)
  pane ||= tabs.find((item) => item.paneId === task.paneId)
  pane ||= tabs.find((item) => item.hostId === task.hostId)
  if (!pane) return
  if (!pane.historyLoaded) await loadConversation(pane)
  const conversation = pane.agent.convs.find((item) => item.id === task.conversationId)
  if (!conversation) return
  const existing = conversation.log.find((item) => item.cls === 'task' && item.task?.id === task.id)
  if (existing) existing.task = task
  else conversation.log.push({ cls: 'task', task })
  conversation.updatedAt = Date.now()
  void persistTabAgent(pane)
  if (pane.id === activeId && activeConv(pane).id === task.conversationId) renderSub()
}
window.st.onTask((task) => { void receiveTask(task) })

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
    t.wrap.style.setProperty('--terminal-background', t.term.options.theme.background)
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
  el('gKey').value = ''
  el('gKey').placeholder = a.configured ? '留空保留已保存的密钥' : 'API Key'
  el('gModel').value = a.model || ''
  el('gFullAccess').checked = settings.agentFullAccess === true
  el('gFullAccessState').textContent = settings.agentFullAccess === true ? '已开启 · 直接执行命令' : '关闭 · 执行前确认'
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
el('gFullAccess').onchange = () => {
  el('gFullAccessState').textContent = el('gFullAccess').checked ? '已开启 · 直接执行命令' : '关闭 · 执行前确认'
}
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
  settings.agentFullAccess = el('gFullAccess').checked
  try { settings = await window.st.saveSettings(settings) } catch (e) {
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
function setPanelVisible(visible) {
  el('panel').classList.toggle('hidden', !visible)
  if (visible && !activeId) el('hostSearch').focus()
}
function setRightVisible(visible) {
  el('right').classList.toggle('hidden', !visible)
  el('btnSubToggle').classList.toggle('on', visible)
  if (visible && !el('filesPanel').hidden) setFilesVisible(false)
}
el('panelHide').onclick = () => setPanelVisible(false)

el('subHide').onclick = () => setRightVisible(false)
el('btnSubToggle').onclick = () => setRightVisible(el('right').classList.contains('hidden'))
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

    for (const pane of tabs.filter((item) => item.hostId === hid)) {
      pane._hasFsOverride = !!next.fontSize
      pane.fs = next.fontSize || settings.fontSize
      pane.term.options.fontSize = pane.fs
      pane._hasThOverride = !!next.terminal
      pane.th = next.terminal || termThemeName
      pane.term.options.theme = TERM_THEMES[pane.th] || TERM_THEMES.dark
      pane.wrap.style.setProperty('--terminal-background', pane.term.options.theme.background)
      fitPane(pane)
      if (pane.sessionId) window.st.setEncoding(pane.sessionId, next.encoding || settings.encoding || 'utf-8')
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
  try { settings = await window.st.saveSettings(settings) } catch (e) {
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
  if (host.hasPassword) { copy.authType = 'password'; copy.cloneFrom = host.id; delete copy.key }
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
  if (a === 'open') { hideCtx(); openHost(host, null, true); return }
  if (a === 'favorite') { hideCtx(); toggleFavorite(host.id); return }
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
    closePanes(tabs.filter((x) => x.hostId === host.id))
    loadHosts()
    statusEl.textContent = '\u5df2\u5220\u9664\uff0c\u5176 agent \u8bb0\u5fc6\u4e00\u5e76\u6e05\u7406'
    setTimeout(() => { statusEl.textContent = '' }, 2600)
  }
}

// ---------------- session memory picker
async function openMemSel() {
  const cur = tabById(activeId)
  if (!cur?.historyLoaded) { statusEl.textContent = '\u5148\u6253\u5f00\u4e00\u4e2a\u4f1a\u8bdd'; return }
  activeConv(cur)
  el('memMsg').textContent = ''
  const box = el('memList')
  box.replaceChildren()

  const head = document.createElement('div')
  head.style.cssText = 'font-size:11.5px;color:var(--dim2);line-height:1.7;display:flex;align-items:center;gap:8px'
  const txt = document.createElement('span')
  txt.style.flex = '1'
  txt.textContent = (cur.name || '') + ' \u00b7 \u5171 ' + cur.agent.convs.length + ' \u6bb5\u5bf9\u8bdd\uff0c\u70b9\u300c\u6253\u5f00\u300d\u53ef\u56de\u5230\u90a3\u4e00\u6bb5\u7ee7\u7eed\u95ee\u3002'
  const btnNew = document.createElement('button')
  btnNew.className = 'pill'
  btnNew.textContent = '\uff0b \u65b0\u4f1a\u8bdd'
  btnNew.onclick = () => {
    const c = newConvObj()
    cur.agent.convs.push(c)
    cur.agent.activeId = c.id
    persistTabAgent(cur)
    renderSub()
    el('memsel').classList.remove('on')
    el('subInput').focus()
  }
  head.append(txt, btnNew)
  box.appendChild(head)

  const convs = cur.agent.convs.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  for (const c of convs) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--line);border-radius:8px'
    const info = document.createElement('div')
    info.style.cssText = 'flex:1;min-width:0'
    const nm = document.createElement('div')
    nm.style.cssText = 'font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    nm.textContent = c.title || '\u65b0\u5bf9\u8bdd'
    const sub = document.createElement('div')
    sub.style.cssText = 'font-size:10.5px;color:var(--dim2)'
    const when = c.updatedAt ? new Date(c.updatedAt).toLocaleString() : ''
    const isCur = c.id === cur.agent.activeId
    sub.textContent = (c.log ? c.log.length : 0) + ' \u6761 \u00b7 ' + when + (isCur ? ' \u00b7 \u5f53\u524d' : '')
    info.append(nm, sub)

    const btnOpen = document.createElement('button')
    btnOpen.className = 'pill'
    btnOpen.textContent = isCur ? '\u5f53\u524d' : '\u6253\u5f00'
    btnOpen.disabled = isCur
    btnOpen.onclick = () => {
      cur.agent.activeId = c.id
      persistTabAgent(cur)
      renderSub()
      updateHeads()
      el('memsel').classList.remove('on')
      statusEl.textContent = '\u5df2\u5207\u56de\uff1a' + (c.title || '\u65b0\u5bf9\u8bdd')
      setTimeout(() => { statusEl.textContent = '' }, 2000)
    }

    const btnDel = document.createElement('button')
    btnDel.className = 'pill'
    btnDel.textContent = '\u5220\u9664'
    btnDel.onclick = () => {
      const doDelete = async () => {
        if (busyConversations.has(c)) { statusEl.textContent = '这段对话仍在获取回复。'; return }
        try { await window.st.clearTasks(cur.hostId, c.id) } catch (error) { el('memMsg').textContent = error.message; return }
        cur.agent.convs = cur.agent.convs.filter((x) => x.id !== c.id)
        if (!cur.agent.convs.length) cur.agent.convs.push(newConvObj())
        if (!cur.agent.convs.some((x) => x.id === cur.agent.activeId)) {
          cur.agent.activeId = cur.agent.convs[cur.agent.convs.length - 1].id
        }
        persistTabAgent(cur)
        renderSub()
        updateHeads()
        openMemSel()
      }
      confirmDialog(
        '删除对话',
        '「' + (c.title || '新对话') + '」这段对话记录会被永久删除，无法恢复。\n（终端连接和其他对话都不受影响）',
        '删除',
        doDelete
      )
    }

    row.append(info, btnOpen, btnDel)
    box.appendChild(row)
  }
  el('memsel').classList.add('on')
}
el('subHist').onclick = openMemSel

// --- 通用确认框：有副作用的操作先问一句（防误触）
let cfmCb = null
function closeConfirm() {
  cfmCb = null
  el('cfm').classList.remove('on')
}
function confirmDialog(title, message, okText, onOk) {
  el('cfmTitle').textContent = title || '确认'
  el('cfmMsg').textContent = message || ''
  el('cfmOk').textContent = okText || '确定'
  cfmCb = onOk || null
  el('cfm').classList.add('on')
  setTimeout(() => { try { el('cfmOk').focus() } catch (e) {} }, 0)
}
el('cfmOk').onclick = () => {
  const cb = cfmCb
  closeConfirm()
  if (cb) {
    try { cb() } catch (e) { statusEl.textContent = '操作失败：' + (e && e.message ? e.message : e) }
  }
}
el('cfmCancel').onclick = closeConfirm
el('cfmX').onclick = closeConfirm
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && el('cfm').classList.contains('on')) { ev.preventDefault(); closeConfirm() }
})

// 清理空对话：只保留“当前这段”和有内容的对话，避免点几次新会话就堆几个空壳
function pruneEmptyConvs(t) {
  const a = t.agent
  if (!a || !Array.isArray(a.convs)) return 0
  const before = a.convs.length
  a.convs = a.convs.filter((c) => c.id === a.activeId || (c.log && c.log.length) || (c.history && c.history.length))
  if (!a.convs.length) {
    const c = newConvObj()
    a.convs.push(c)
    a.activeId = c.id
  } else if (!a.convs.some((c) => c.id === a.activeId)) {
    a.activeId = a.convs[a.convs.length - 1].id
  }
  return before - a.convs.length
}

// --- 新会话：新建一段对话，旧的原样保留；有内容时先确认，避免误触
function createNewConv(t) {
  t.agent = t.agent && Array.isArray(t.agent.convs) ? t.agent : normalizeAgent(t.agent, t.name)
  pruneEmptyConvs(t)
  const c = newConvObj()
  t.agent.convs.push(c)
  t.agent.activeId = c.id
  el('subInput').value = ''
  persistTabAgent(t)
  renderSub()
  updateHeads()
  el('subInput').focus()
  statusEl.textContent = '已新建对话；上一段保留在「历史会话」'
}
el('subNew').onclick = () => {
  const t = tabById(activeId)
  if (!t?.historyLoaded) { statusEl.textContent = '请先连上主机并等待对话载入。'; return }
  const conv = activeConv(t)
  const msgs = (conv.log || []).filter((m) => m.cls === 'me')
  const empty = !msgs.length
  confirmDialog(
    '新建会话',
    empty
      ? '当前这段对话还没有内容。\n\n要新建一段新的对话吗？'
      : '当前这段对话「' + (conv.title || '新对话') + '」不会删除，会保留在「历史会话」里，随时可以切回。\n\n要新建一段对话吗？',
    '新建',
    () => createNewConv(t)
  )
}


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
  try { settings = Object.assign(settings, await window.st.settings()) } catch (e) { statusEl.textContent = e.message }
  settings.sessions = settings.sessions || {}
  fontSize = Number(settings.fontSize) || 12.5
  el('fontVal').textContent = String(fontSize)
  applyTheme()

  // 把「跑的是哪一版」直接显示出来：标题栏 + 启动时状态栏 4 秒
  try {
    const info = await window.st.appInfo()
    const tag = 'v' + info.version + (info.build && info.build.commit ? ' · ' + info.build.commit : '')
    document.title = 'ShrimpTerm ' + tag
    statusEl.textContent = 'ShrimpTerm ' + tag + (info.build && info.build.builtAt ? '（构建于 ' + info.build.builtAt + '）' : '')
    setTimeout(() => { statusEl.textContent = '' }, 4500)
  } catch (e) {}

  if (!settings.onboarded) {
    el('obBase').value = (settings.agent && settings.agent.baseUrl) || 'https://api.deepseek.com/v1'
    el('obKey').value = ''
    el('obModel').value = (settings.agent && settings.agent.model) || 'deepseek-flash'
    el('onboard').classList.add('on')
  }


  setRightVisible(false)
  setPanelVisible(false)
  showView('term')
  await loadHosts()
  updateHeads()
  if (settings.onboarded) requestAnimationFrame(() => el('hostLibrary').querySelector('input')?.focus())
  try { await Promise.all((await window.st.tasks()).map(receiveTask)) } catch (error) { statusEl.textContent = error.message }
}
