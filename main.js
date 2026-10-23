'use strict'
/**
 * shrimp-term -- SSH client with an ops agent baked in (demo).
 *
 * Architecture:
 *   renderer  = xterm.js, one Terminal per tab, no network access
 *   main      = owns the SSH sessions (ssh2, pure JS) and calls the LLM
 *   agent     = the ONLY thing it can do is type into the visible terminals, so
 *               every action it takes is on screen in front of you.
 */

const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const https = require('node:https')
const { Client } = require('ssh2')
const iconv = require('iconv-lite')

app.setName('ShrimpTerm')
const DIR = __dirname
const HOSTS_FILE = path.join(DIR, 'hosts.json')

let win = null

// ---------------------------------------------------------------- settings
const SETTINGS_FILE = path.join(DIR, 'settings.json')
const DEFAULT_SETTINGS = {
  onboarded: false,
  theme: 'dark',
  terminal: 'dark',
  fontSize: 12.5,
  accent: '#2f7ae5',
  webEnabled: true,
  agent: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-flash' },
}

function readSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return Object.assign({}, DEFAULT_SETTINGS, j, { agent: Object.assign({}, DEFAULT_SETTINGS.agent, j.agent || {}) })
  } catch (e) { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) }
}

function writeSettings(next) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2))
  return next
}

// ---------------------------------------------------------------- agent memory
// Keyed by host id (plus "__agent__" for the global agent), so a conversation
// survives closing the tab or restarting the app. Only an explicit clear drops it.
const HISTORY_FILE = path.join(DIR, 'history.json')

function readHistoryAll() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { return {} }
}

function writeHistoryAll(o) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(o)) } catch (e) {}
}

ipcMain.handle('hist:get', (_e, key) => {
  const rec = readHistoryAll()[key]
  if (!rec || !Array.isArray(rec.log)) return null
  return { log: rec.log, history: Array.isArray(rec.history) ? rec.history : [] }
})

function trimAgentState(v) {
  if (!v || typeof v !== 'object') return v
  const meta = {
    hostId: v.hostId || '', name: v.name || '',
    createdAt: v.createdAt || Date.now(), updatedAt: Date.now(),
  }
  if (Array.isArray(v.convs)) {
    meta.convs = v.convs.slice(-30).map((c) => ({
      id: c.id, title: c.title, createdAt: c.createdAt,
      log: (c.log || []).slice(-300), history: (c.history || []).slice(-80),
    }))
    meta.activeId = v.activeId
    return meta
  }
  meta.log = (v.log || []).slice(-300)
  meta.history = (v.history || []).slice(-80)
  return meta
}

// Every terminal tab gets its own key (hostId#suffix), so two tabs on the same
// server never overwrite each other. This lists what is stored for one host.
ipcMain.handle('hist:list', (_e, hostId) => {
  const all = readHistoryAll()
  const out = []
  for (const key of Object.keys(all)) {
    const v = all[key] || {}
    if (key === '__agent__' || Array.isArray(v.convs) || Array.isArray(v.topLevel)) continue
    if (key === '__agent__') continue
    if (v.convs) continue
    const owner = v.hostId || String(key).split('#')[0]
    if (hostId && owner !== hostId) continue
    out.push({
      key,
      hostId: owner,
      name: v.name || '',
      createdAt: v.createdAt || 0,
      updatedAt: v.updatedAt || 0,
      count: (v.log || []).length,
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
})

ipcMain.handle('hist:save', (_e, key, value) => {
  if (!key) return false
  const all = readHistoryAll()
  all[key] = trimAgentState(value)
  writeHistoryAll(all)
  return true
})

ipcMain.handle('hist:clear', (_e, key) => {
  const all = readHistoryAll()
  delete all[key]
  writeHistoryAll(all)
  return true
})

// ---------------------------------------------------------------- hosts
function loadHosts() {
  try {
    return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8').replace(/^\uFEFF/, '')).hosts || []
  } catch (e) {
    return []
  }
}

// ---------------------------------------------------------------- ssh sessions
const sessions = new Map() // id -> { conn, stream, host, tail }
let seq = 0

function tailAppend(s, chunk) {
  s.tail = (s.tail + chunk).slice(-8000)
}

const CONNECT_DEADLINE_MS = 12000

function openSession(host, opts) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    const id = 's' + (++seq)
    let settled = false
    const started = Date.now()

    // Hard deadline: ssh2's readyTimeout covers the handshake only, a dead IP can
    // sit in TCP SYN for far longer. Without this the UI looks frozen.
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      try { conn.end() } catch (e) {}
      try { if (conn._sock) conn._sock.destroy() } catch (e) {}
      reject(new Error('\u8fde\u63a5\u8d85\u65f6\uff08' + Math.round(CONNECT_DEADLINE_MS / 1000)
        + ' \u79d2\u5185\u65e0\u54cd\u5e94\uff0c\u53ef\u80fd\u662f IP \u9519\u8bef\u3001\u9632\u706b\u5899\u62e6\u622a\u6216\u673a\u5668\u672a\u5f00\u673a\uff09'))
    }, CONNECT_DEADLINE_MS)

    const done = (fn, v) => { clearTimeout(deadline); fn(v) }

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 120, rows: 30 }, (err, stream) => {
        if (err) { settled = true; conn.end(); return done(reject, err) }
        const s = { id, conn, stream, host, tail: '', encoding: (opts && opts.encoding) || 'utf-8' }
        sessions.set(id, s)

        stream.on('data', (data) => {
          const text = decodeChunk(data, s.encoding)
          tailAppend(s, text)
          if (win && !win.isDestroyed()) win.webContents.send('term:data', { id, data: text })
        })
        stream.stderr.on('data', (data) => {
          const text = decodeChunk(data, s.encoding)
          tailAppend(s, text)
          if (win && !win.isDestroyed()) win.webContents.send('term:data', { id, data: text })
        })
        stream.on('close', () => {
          sessions.delete(id)
          conn.end()
          if (win && !win.isDestroyed()) win.webContents.send('term:closed', { id })
        })

        settled = true
        done(resolve, { id, host })
      })
    })

    conn.on('error', (e) => {
      try { conn.end() } catch (_) {}
      if (!settled) {
        settled = true
        const secs = Math.round((Date.now() - started) / 1000)
        done(reject, new Error(e.message + '\uff08' + secs + ' \u79d2\uff09'))
      }
    })

    const opts = {
      host: host.host,
      port: Number(host.port || 22),
      username: host.user || 'ubuntu',
      readyTimeout: 9000,
      // demo: trust on first use, like ssh -o StrictHostKeyChecking=accept-new
      hostVerifier: () => true,
    }
    try {
      if (host.key && fs.existsSync(host.key)) opts.privateKey = fs.readFileSync(host.key)
      else if (host.password) opts.password = host.password
      else throw new Error('host ' + host.id + ' has neither key nor password')
      conn.connect(opts)
    } catch (e) {
      if (!settled) { settled = true; done(reject, e) }
    }
  })
}

function decodeChunk(buf, enc) {
  if (!enc || enc === 'utf-8' || enc === 'utf8') return buf.toString('utf8')
  try { return iconv.decode(buf, enc) } catch (e) { return buf.toString('utf8') }
}

function writeTo(id, text) {
  const s = sessions.get(id)
  if (!s) return false
  s.stream.write(text)
  return true
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ---------------------------------------------------------------- local + app control
let appState = { hosts: [], tabs: [], view: 'agent', theme: '', terminal: '', fontSize: 0 }

ipcMain.handle('app:state', (_e, st) => { appState = st || appState; return true })

function human(b) {
  const u = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  let v = Number(b) || 0
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(i ? 1 : 0) + u[i]
}

function localInfo(kind) {
  const k = String(kind || 'summary').toLowerCase()
  const cpus = os.cpus()
  let disk = null
  try {
    const st = fs.statfsSync('C:')
    const total = st.blocks * st.bsize
    const free = st.bavail * st.bsize
    disk = { total: human(total), free: human(free), usedPct: Math.round((1 - free / total) * 100) }
  } catch (e) { disk = { error: 'unavailable' } }

  const base = {
    hostname: os.hostname(),
    platform: os.platform() + ' ' + os.release(),
    arch: os.arch(),
    uptimeHours: Math.round(os.uptime() / 3600),
    cpu: cpus.length ? cpus[0].model.trim() : 'unknown',
    cores: cpus.length,
    memTotal: human(os.totalmem()),
    memFree: human(os.freemem()),
    memUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    disk: disk,
    user: os.userInfo().username,
  }

  if (k === 'cpu') return { model: base.cpu, cores: base.cores, loadavg: os.loadavg(), speed: cpus.length ? cpus[0].speed : 0 }
  if (k === 'memory') return { total: base.memTotal, free: base.memFree, usedPct: base.memUsedPct }
  if (k === 'disk') return disk
  if (k === 'os') return { platform: base.platform, arch: base.arch, hostname: base.hostname, user: base.user }
  if (k === 'uptime') return { hours: base.uptimeHours }
  if (k === 'network') {
    const out = {}
    const ifs = os.networkInterfaces()
    for (const name of Object.keys(ifs)) {
      const list = (ifs[name] || []).filter((a) => !a.internal)
      if (list.length) out[name] = list.map((a) => a.address + '/' + a.family)
    }
    return out
  }
  return base
}

function findTabInState(t) {
  const list = appState.tabs || []
  return list.find((x) => x.id === t) || list.find((x) => (x.name || '').includes(t)) || null
}

function listConversations() {
  const all = readHistoryAll()
  const out = []
  const g = all['__agent__']
  if (g && Array.isArray(g.convs)) {
    for (const c of g.convs) {
      out.push({ scope: 'global', id: c.id, title: c.title || '', messages: (c.log || []).length })
    }
  }
  for (const key of Object.keys(all)) {
    if (key === '__agent__') continue
    const v = all[key] || {}
    if (Array.isArray(v.convs)) continue
    out.push({
      scope: 'session', key, hostId: v.hostId || key, name: v.name || '',
      messages: (v.log || []).length, updatedAt: v.updatedAt || 0,
    })
  }
  return out
}

function readConversation(target) {
  const all = readHistoryAll()
  const t = String(target || '')
  const g = all['__agent__']
  if (g && Array.isArray(g.convs)) {
    const c = g.convs.find((x) => x.id === t || (x.title || '') === t)
    if (c) return { scope: 'global', title: c.title || '', log: c.log || [] }
  }
  const key = Object.keys(all).find((k) => {
    if (k === '__agent__') return false
    const v = all[k] || {}
    if (Array.isArray(v.convs)) return false
    return k === t || (v.hostId || '') === t || (v.name || '') === t
  })
  if (key) {
    const v = all[key]
    return { scope: 'session', hostId: v.hostId || key, name: v.name || '', log: v.log || [] }
  }
  return { error: 'no such conversation: ' + t + '. use list_conversations first.' }
}

function appAction(action, target, value, data) {
  const a = String(action || '')
  const t = String(target || '')
  const v = String(value || '')
  const d = (data && typeof data === 'object') ? data : {}

  // ---------- read: connections
  if (a === 'list_hosts') return { hosts: appState.hosts || [] }

  if (a === 'add_host' || a === 'update_host') {
    const all = readHostsFile()
    const list = all.hosts || []
    const base = {
      name: String(d.name || d.host || 'new host'),
      host: String(d.host || ''),
      port: Number(d.port) || 22,
      user: String(d.user || 'ubuntu'),
      group: String(d.group || ''),
    }
    if (d.key) base.key = String(d.key)
    if (d.password) base.password = String(d.password)

    if (a === 'add_host') {
      if (!base.host) return { error: 'add_host needs data.host' }
      let id = String(d.id || base.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 12) || ('h' + Date.now().toString(36))
      let n = 2
      while (list.some((h) => h.id === id)) { id = id.replace(/-\d+$/, '') + '-' + n; n++ }
      const rec = Object.assign({ id }, base)
      rec.name = uniqueName(list, rec.name, rec.id)
      list.push(rec)
      all.hosts = list
      fs.writeFileSync(HOSTS_FILE, JSON.stringify(all, null, 2))
      send(['refresh_hosts', ''])
      return { ok: true, created: { id: rec.id, name: rec.name } }
    }

    const hit = list.find((h) => h.id === t) || list.find((h) => (h.name || '') === t)
    if (!hit) return { error: 'no such host: ' + t }
    Object.assign(hit, base)
    if (d.key) hit.key = String(d.key)
    if (d.password) hit.password = String(d.password)
    delete hit.disabled
    hit.name = uniqueName(list, hit.name, hit.id)
    all.hosts = list
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(all, null, 2))
    send(['refresh_hosts', ''])
    return { ok: true, updated: { id: hit.id, name: hit.name } }
  }

  if (a === 'delete_host') {
    const all = readHostsFile()
    const list = all.hosts || []
    const hit = list.find((h) => h.id === t) || list.find((h) => (h.name || '') === t)
    if (!hit) return { error: 'no such host: ' + t }
    all.hosts = list.filter((h) => h.id !== hit.id)
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(all, null, 2))
    const hist = readHistoryAll()
    if (hist[hit.id]) { delete hist[hit.id]; writeHistoryAll(hist) }
    send(['refresh_hosts', ''])
    return { ok: true, deleted: hit.name }
  }

  if (a === 'add_group') {
    const all = readHostsFile()
    all.groups = all.groups || []
    const nm = String(d.name || t || '').trim()
    if (nm && !all.groups.includes(nm)) all.groups.push(nm)
    fs.writeFileSync(HOSTS_FILE, JSON.stringify(all, null, 2))
    send(['refresh_hosts', ''])
    return { ok: true, groups: all.groups }
  }

  // ---------- sessions
  if (a === 'list_sessions') return { sessions: appState.tabs || [], view: appState.view }

  if (a === 'open_host') {
    const hit = (appState.hosts || []).find((h) => h.id === t || h.name === t)
    if (!hit) return { error: 'no such host: ' + t + '. hosts: ' + (appState.hosts || []).map((h) => h.id + '/' + h.name).join(', ') }
    if (hit.disabled) return { error: 'host is not configured yet (no address): ' + hit.name }
    if ((appState.tabs || []).some((x) => x.hostId === hit.id)) {
      send(['focus_session', (appState.tabs || []).find((x) => x.hostId === hit.id).id])
      return { ok: true, note: hit.name + ' is already open, focused it' }
    }
    send(['open_host', hit.id])
    return { ok: true, opening: hit.name }
  }

  if (a === 'close_session' || a === 'focus_session') {
    const hit = findTabInState(t)
    if (!hit) return { error: 'no such session: ' + t + '. open: ' + (appState.tabs || []).map((x) => x.name).join(', ') }
    send([a === 'close_session' ? 'close_session' : 'focus_session', hit.id])
    return { ok: true, session: hit.name }
  }

  if (a === 'get_session_output') {
    const hit = findTabInState(t)
    const id = hit ? hit.id : t
    const sess = sessions.get(id)
    if (!sess) return { error: 'that session is not connected: ' + (hit ? hit.name : t) }
    return { session: (sess.host && sess.host.name) || id, output: String(sess.tail || '').slice(-6000) || '(no output yet)' }
  }

  if (a === 'send_to_session') {
    const hit = findTabInState(t)
    if (!hit) return { error: 'no such session: ' + t }
    const sess = sessions.get(hit.id)
    if (!sess) return { error: 'that session is not connected: ' + hit.name }
    const text = v.endsWith('\n') ? v : v + '\n'
    sess.tail = ''
    sess.stream.write(text)
    return { ok: true, typed_into: hit.name, text }
  }

  if (a === 'switch_view') { send(['switch_view', v === 'term' ? 'term' : 'agent']); return { ok: true } }

  // ---------- conversations
  if (a === 'list_conversations') return { conversations: listConversations() }
  if (a === 'get_conversation') return readConversation(t || v)

  // ---------- settings
  if (a === 'get_settings') {
    const st = readSettings()
    return {
      theme: st.theme, terminal: st.terminal, encoding: st.encoding,
      accent: st.accent, fontSize: st.fontSize,
      agent: { baseUrl: (st.agent || {}).baseUrl, model: (st.agent || {}).model, hasKey: !!(st.agent || {}).apiKey },
      sessions: st.sessions || {},
    }
  }
  if (a === 'set_theme') { send(['set_theme', v === 'dark' ? 'dark' : 'light']); return { ok: true } }
  if (a === 'set_accent') { send(['set_accent', v]); return { ok: true } }
  if (a === 'set_font_size') { send(['set_font_size', v]); return { ok: true } }
  if (a === 'set_terminal_theme') { send(['set_terminal_theme', v]); return { ok: true } }
  if (a === 'open_settings') { send(['open_settings', v || 'appear']); return { ok: true } }
  if (a === 'new_conversation') { send(['new_conversation', '']); return { ok: true } }
  if (a === 'clear_conversation') { send(['clear_conversation', '']); return { ok: true } }

  return { error: 'unknown action: ' + a }
}

function send(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('app:cmd', { action: payload[0], target: payload[1], value: payload[2] })
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('only http(s) allowed'))
    https.get(u, { timeout: 20000, headers: { 'user-agent': 'ShrimpTerm/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        return fetchText(res.headers.location).then(resolve, reject)
      }
      let d = ''
      res.setEncoding('utf8')
      res.on('data', (c) => {
        d += c
        if (d.length > 60000) res.destroy()
      })
      res.on('end', () => resolve(d))
      res.on('close', () => resolve(d))
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')) })
  })
}

// ---------------------------------------------------------------- llm
function loadKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  try {
    const p = path.join(process.env.APPDATA || '', 'dsh-desktop', 'harness', '.credentials.yaml')
    const y = fs.readFileSync(p, 'utf8')
    const m = y.match(/DEEPSEEK_API_KEY:\s*(\S+)/)
    if (m) return m[1]
  } catch (e) {}
  return null
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request({
      host: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: headers || {}, timeout: 20000,
    }, (res) => {
      let d = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { d += c })
      res.on('end', () => {
        let j = null
        try { j = JSON.parse(d) } catch (e) { j = null }
        if (res.statusCode >= 400) {
          const msg = (j && (j.error && (j.error.message || j.error) || j.message)) || ('HTTP ' + res.statusCode)
          return reject(new Error(String(msg).slice(0, 240)))
        }
        resolve(j)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.end()
  })
}

function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = https.request({
      host: u.hostname, path: u.pathname, method: 'POST',
      headers: Object.assign({
        'content-type': 'application/json; charset=utf-8',
        'content-length': payload.length,
      }, headers || {}),
      timeout: 120000,
    }, (res) => {
      let d = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { d += c })
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(new Error('bad json: ' + d.slice(0, 300))) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('llm timeout')) })
    req.write(payload)
    req.end()
  })
}

const TOOL = {
  type: 'function',
  function: {
    name: 'run_in_terminals',
    description: 'Type a command line into the selected terminal sessions and wait for output. '
      + 'The user watches this happen live, so keep commands short and safe. '
      + 'One call = one command line sent to every selected session.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command line to type.' },
        note: { type: 'string', description: 'One short sentence for the user about what this does.' },
      },
      required: ['command'],
    },
  },
}

const T_LOCAL = {
  type: 'function',
  function: {
    name: 'local_info',
    description: 'Read basic information about the computer ShrimpTerm is running on. Read-only, no shell.',
    parameters: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['summary', 'cpu', 'memory', 'disk', 'os', 'uptime', 'network'] } },
      required: ['kind'],
    },
  },
}

const T_APP = {
  type: 'function',
  function: {
    name: 'app_control',
    description: 'Full control over the ShrimpTerm application. You may read and change anything the app '
      + 'itself holds: connections, groups, settings, open sessions, terminal output, and every agent '
      + 'conversation. You still have NO shell on this computer.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'list_hosts', 'add_host', 'update_host', 'delete_host', 'add_group',
            'list_sessions', 'open_host', 'close_session', 'focus_session', 'switch_view',
            'get_session_output', 'send_to_session',
            'list_conversations', 'get_conversation',
            'get_settings', 'set_theme', 'set_accent', 'set_font_size', 'set_terminal_theme',
            'open_settings', 'new_conversation', 'clear_conversation',
          ],
        },
        target: { type: 'string', description: 'host id/name, session id/name, conversation id/title/host, or settings tab' },
        value: { type: 'string', description: 'theme name, hex color, font size, view name, or text to type' },
        data: {
          type: 'object',
          description: 'for add_host/update_host: {name, host, port, user, key, password, group}; for add_group: {name}',
        },
      },
      required: ['action'],
    },
  },
}

const T_WEB = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: 'Fetch an http(s) URL and return its body as text (truncated). Use for docs, versions, changelogs.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
}

const MAIN_SYS = 'You are ShrimpTerm\'s built-in assistant. You live inside an SSH client application.\n'
  + 'Your permissions cover this whole application, plus basic read-only facts about the machine it runs on. You can:\n'
  + '1. local_info - read basic facts about this computer (read-only; you cannot run commands).\n'
  + '2. app_control - you own this application. You can list, add, edit and delete connections and '
  + 'groups; open, close and focus sessions; read what a terminal currently shows; type into a session; '
  + 'read every agent conversation (global and per-session); change theme, accent, font size and terminal '
  + 'palette; open settings; create or clear agent conversations.\n'
  + '3. web_fetch - fetch an http(s) page when you need current information. Networking is always on.\n\n'
  + 'You have NO shell on this machine and cannot read arbitrary files. Never pretend otherwise.\n'
  + 'Be concrete: inspect before you act, then act through the tools. Answer in the language the user used.\n\n'
  + 'Formatting: the UI renders markdown. Use a table when comparing several items, keep tables to 5 columns '
  + 'or fewer, one row per line, header row then a |---|---| separator, no blank lines inside a table. '
  + 'Wrap commands or paths in fenced code blocks. Keep prose brief.'

const SUB_SYS = 'You are shrimp, an operations agent embedded in an SSH client.\n'
  + 'You can ONLY act through the run_in_terminals tool, which types a command into the terminal sessions '
  + 'the user has selected. The user sees every keystroke on screen.\n'
  + 'Work step by step: inspect first, then act. Keep commands short. After each tool result, '
  + 'decide whether you need another command. When done, reply with a short summary of what '
  + 'you found or changed, in the language the user used.\n'
  + 'Never claim something happened unless you saw it in the tool output.\n\n'
  + 'Formatting of your final answer (the UI renders markdown):\n'
  + '- If you report more than one host, or more than two metrics, use a markdown table.\n'
  + '- Keep tables narrow: at most 5 columns. Abbreviate values ("68%", "1.2G") instead of sentences.\n'
  + '- Table syntax must be exact: one row per line, a header row, then a separator like '
  + '|---|---|, and no indentation or blank lines inside the table.\n'
  + '- Wrap commands and raw output in fenced code blocks.\n'
  + '- Keep prose to one or two sentences; put the detail in the table.'

async function runAgent({ text, targets, history, scope }) {
  const cfg = readSettings().agent || {}
  const key = cfg.apiKey || loadKey()
  if (!key) return { error: '\u5c1a\u672a\u914d\u7f6e agent API key\uff0c\u8bf7\u5230\u8bbe\u7f6e\u91cc\u586b\u5199\u3002' }
  const baseUrl = String(cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const model = cfg.model || 'deepseek-flash'

  const isMain = scope === 'global'

  if (!isMain && (!targets || !targets.length)) return { error: 'No terminal selected.' }

  const tools = isMain ? [T_LOCAL, T_APP, T_WEB] : [TOOL]

  const messages = [{ role: 'system', content: isMain ? MAIN_SYS : SUB_SYS }]
  if (history && history.length) messages.push(...history.slice(-8))
  messages.push({ role: 'user', content: text })

  const actions = []
  const maxRounds = isMain ? 8 : 6

  for (let round = 0; round < maxRounds; round++) {
    const res = await postJson(baseUrl + '/chat/completions', {
      model, messages, tools, tool_choice: 'auto', max_tokens: 2000,
    }, { authorization: 'Bearer ' + key })

    if (!res || !res.choices || !res.choices[0]) {
      return { error: 'LLM error: ' + JSON.stringify(res).slice(0, 300), actions }
    }
    const msg = res.choices[0].message
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls })

    const calls = msg.tool_calls || []
    if (!calls.length) return { reply: msg.content || '(\u6ca1\u6709\u56de\u590d)', actions }

    for (const call of calls) {
      let args = {}
      try { args = JSON.parse(call.function.arguments || '{}') } catch (e) {}
      const name = call.function.name
      let out = ''

      try {
        if (name === 'local_info') {
          out = JSON.stringify(localInfo(args.kind), null, 2)
          actions.push({ command: 'local_info(' + (args.kind || 'summary') + ')', note: '' })

        } else if (name === 'app_control') {
          const r = appAction(args.action, args.target, args.value, args.data)
          out = JSON.stringify(r, null, 2)
          actions.push({
            command: 'app:' + args.action + (args.target ? ' ' + args.target : '') + (args.value ? ' ' + args.value : ''),
            note: r && r.error ? r.error : '',
          })
          await sleep(250)

        } else if (name === 'web_fetch') {
          const body = await fetchText(String(args.url || ''))
          out = String(body).slice(0, 8000)
          actions.push({ command: 'web_fetch ' + String(args.url || '').slice(0, 80), note: '' })

        } else {
          // per-session tool: type into terminals
          const cmd = String(args.command || '').trim()
          if (!cmd) { messages.push({ role: 'tool', tool_call_id: call.id, content: 'ERROR: empty command' }); continue }
          for (const id of targets) {
            const sess = sessions.get(id)
            if (sess) { sess.tail = ''; writeTo(id, cmd + '\n') }
          }
          await sleep(Math.min(4000, 900 + cmd.length * 12))
          let acc = ''
          for (const id of targets) {
            const sess = sessions.get(id)
            if (!sess) continue
            acc += '--- ' + ((sess.host && sess.host.name) || id) + ' ---\n' + sess.tail.slice(-1500) + '\n'
          }
          out = acc.slice(0, 6000) || '(no output)'
          actions.push({ command: cmd, note: String(args.note || '') })
        }
      } catch (e) {
        out = 'ERROR: ' + String((e && e.message) || e)
      }

      messages.push({ role: 'tool', tool_call_id: call.id, content: String(out).slice(0, 9000) || '(empty)' })
    }
  }
  return { reply: '\u8fbe\u5230\u6b65\u6570\u4e0a\u9650\u4e86\uff0c\u770b\u4e0a\u9762\u7684\u6267\u884c\u8bb0\u5f55\u3002', actions }
}

// ---------------------------------------------------------------- window
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1000, minHeight: 600,
    backgroundColor: '#ffffff', title: 'ShrimpTerm',
    icon: path.join(DIR, 'assets', 'shrimp-256.png'),
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.loadFile(path.join(DIR, 'renderer', 'index.html'))
  win.once('ready-to-show', () => { win.show() })
}

ipcMain.handle('win:minimize', () => { if (win) win.minimize() })
ipcMain.handle('win:maximize', () => { if (win) { win.isMaximized() ? win.unmaximize() : win.maximize() } })
ipcMain.handle('win:close', () => { if (win) win.close() })

ipcMain.handle('settings:get', () => readSettings())
ipcMain.handle('settings:save', (_e, next) => writeSettings(Object.assign(readSettings(), next)))

ipcMain.handle('hosts:list', () => loadHosts())

function readHostsFile() {
  try { return JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { return { hosts: [] } }
}

function uniqueName(list, wantName, selfId) {
  const others = list.filter((h) => h.id !== selfId)
  const base = String(wantName || '').trim() || 'untitled'
  if (!others.some((h) => (h.name || '') === base)) return base
  let k = 2
  let cand = base + ' (' + k + ')'
  while (others.some((h) => (h.name || '') === cand)) { k++; cand = base + ' (' + k + ')' }
  return cand
}

ipcMain.handle('hosts:save', (_e, host) => {
  const all = readHostsFile()
  const list = all.hosts || []
  if (!host || !host.id) return false
  host.name = uniqueName(list, host.name, host.id)
  const i = list.findIndex((h) => h.id === host.id)
  if (i >= 0) list[i] = Object.assign({}, list[i], host)
  else {
    // ids must stay unique even if a caller hands us a duplicate
    let id = host.id
    let n = 2
    while (list.some((h) => h.id === id)) { id = host.id + '-' + n; n++ }
    host.id = id
    list.push(host)
  }
  all.hosts = list
  fs.writeFileSync(HOSTS_FILE, JSON.stringify(all, null, 2))
  return true
})

ipcMain.handle('hosts:delete', (_e, id) => {
  if (!id) return false
  const all = readHostsFile()
  const before = (all.hosts || []).length
  all.hosts = (all.hosts || []).filter((h) => h.id !== id)
  fs.writeFileSync(HOSTS_FILE, JSON.stringify(all, null, 2))
  // its agent memory goes with it
  const hist = readHistoryAll()
  if (hist[id]) { delete hist[id]; writeHistoryAll(hist) }
  return all.hosts.length !== before
})

ipcMain.handle('hosts:groups', () => readHostsFile().groups || [])

ipcMain.handle('hosts:addGroup', (_e, name) => {
  const all = readHostsFile()
  all.groups = all.groups || []
  const n = String(name || '').trim()
  if (n && !all.groups.includes(n)) all.groups.push(n)
  fs.writeFileSync(HOSTS_FILE, JSON.stringify(all, null, 2))
  return all.groups
})

ipcMain.handle('term:open', async (_e, hostId, opts) => {
  const host = loadHosts().find((h) => h.id === hostId)
  if (!host) throw new Error('unknown host ' + hostId)
  return openSession(host, opts || {})
})

ipcMain.handle('term:setEncoding', (_e, id, enc) => {
  const s = sessions.get(id)
  if (s) s.encoding = enc || 'utf-8'
  return true
})

ipcMain.handle('term:input', (_e, { id, data }) => writeTo(id, data))

ipcMain.handle('term:resize', (_e, { id, cols, rows }) => {
  const s = sessions.get(id)
  if (s && s.stream && s.stream.setWindow) {
    try { s.stream.setWindow(rows, cols, 0, 0) } catch (e) {}
  }
  return true
})

ipcMain.handle('term:close', (_e, id) => {
  const s = sessions.get(id)
  if (s) { try { s.stream.end() } catch (e) {}; try { s.conn.end() } catch (e) {}; sessions.delete(id) }
  return true
})

// Validate baseUrl + key before the user is let in. /models is free; if the
// provider lacks it, fall back to a 1-token chat completion.
ipcMain.handle('agent:test', async (_e, cfg) => {
  const baseUrl = String((cfg && cfg.baseUrl) || '').trim().replace(/\/+$/, '')
  const key = String((cfg && cfg.apiKey) || '').trim()
  const model = String((cfg && cfg.model) || '').trim() || 'deepseek-flash'
  if (!baseUrl) return { ok: false, error: 'Base URL \u4e0d\u80fd\u4e3a\u7a7a' }
  if (!key) return { ok: false, error: 'API Key \u4e0d\u80fd\u4e3a\u7a7a' }
  if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: 'Base URL \u9700\u8981\u4ee5 http(s):// \u5f00\u5934' }

  const auth = { authorization: 'Bearer ' + key }

  try {
    const r = await getJson(baseUrl + '/models', auth)
    const list = (r && r.data) || []
    const ids = list.map((m) => m && m.id).filter(Boolean)
    return { ok: true, via: 'models', models: ids.slice(0, 12), modelKnown: !ids.length || ids.includes(model) }
  } catch (e1) {
    try {
      const r = await postJson(baseUrl + '/chat/completions', {
        model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1,
      }, auth)
      if (r && (r.choices || r.id)) return { ok: true, via: 'chat' }
      return { ok: false, error: '\u63a5\u53e3\u8fd4\u56de\u5f02\u5e38: ' + JSON.stringify(r).slice(0, 200) }
    } catch (e2) {
      return { ok: false, error: String((e2 && e2.message) || e2).slice(0, 240) }
    }
  }
})

ipcMain.handle('agent:ask', async (_e, req) => runAgent(req))

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  for (const s of sessions.values()) { try { s.conn.end() } catch (e) {} }
  if (process.platform !== 'darwin') app.quit()
})
