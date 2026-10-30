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

// ---------------------------------------------------------------- 数据目录
// 运行时数据放系统用户目录（%APPDATA%\ShrimpTerm）。
// 原因：装机版可能被装到 Program Files，那里对普通用户只读，
// 把 hosts/settings/history 写在安装目录会导致加连接、存 API Key 全部失败。
const DATA_DIR = app.getPath('userData')
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch (e) {}

// 首次运行：从安装目录迁移旧数据（老版本把数据写在 __dirname），
// 若没有任何 hosts.json，则用随包发布的示例做种子。
function seedDataDir() {
  for (const f of ['settings.json', 'hosts.json', 'history.json']) {
    const to = path.join(DATA_DIR, f)
    const from = path.join(DIR, f)
    if (!fs.existsSync(to) && fs.existsSync(from)) {
      try { fs.copyFileSync(from, to) } catch (e) {}
    }
  }
  const hostsTo = path.join(DATA_DIR, 'hosts.json')
  if (!fs.existsSync(hostsTo)) {
    const seedFile = path.join(DIR, 'hosts.example.json')
    if (fs.existsSync(seedFile)) { try { fs.copyFileSync(seedFile, hostsTo) } catch (e) {} }
  }
}
seedDataDir()

const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json')

// 构建信息（打包时由 scripts/*.ps1 写入）：用来一眼看出"跑的是哪一版"
const BUILD_INFO = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'build-info.json'), 'utf8').replace(/^\uFEFF/, '')) } catch (e) { return null }
})()

let win = null

// ---------------------------------------------------------------- settings
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')
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
const HISTORY_FILE = path.join(DATA_DIR, 'history.json')

function readHistoryAll() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { return {} }
}

function writeHistoryAll(o) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(o)) } catch (e) {}
}

ipcMain.handle('hist:get', (_e, key) => {
  const rec = readHistoryAll()[key]
  if (!rec) return null
  // 新结构：一段会话下挂多段对话
  if (Array.isArray(rec.convs)) {
    return {
      convs: rec.convs,
      activeId: rec.activeId || null,
      hostId: rec.hostId || '',
      name: rec.name || '',
    }
  }
  // 旧结构兼容：单段 { log, history }
  if (!Array.isArray(rec.log)) return null
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
    if (key === '__agent__') continue
    const v = all[key] || {}
    if (Array.isArray(v.convs)) continue          // 多段对话由渲染层直接读
    if (!Array.isArray(v.log)) continue
    if (!v.log.length) continue
    const owner = v.hostId || String(key).split('#')[0]
    // 兼容旧版本：记忆曾按 hostId-2 / hostId-3 这样的前缀另存多份
    const mine = !hostId || owner === hostId || key === hostId || key.startsWith(hostId + '-')
    if (!mine) continue
    out.push({
      key,
      hostId: owner,
      name: v.name || '',
      createdAt: v.createdAt || 0,
      updatedAt: v.updatedAt || 0,
      count: v.log.length,
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

// ---------------------------------------------------------------- 命令执行
// 用哨兵判断命令何时结束，而不是"固定 sleep + 抓末尾"：
//   命令越快返回越快；慢命令不会被截断；能拿到真实退出码。
const CMD_TIMEOUT_MS = Number(process.env.SHRIMP_CMD_TIMEOUT || 30000)
const CMD_POLL_MS = 120
const CMD_OUTPUT_MAX = 6000

function stripAnsi(s) {
  return String(s)
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\u001b[()][A-Za-z0-9]/g, '')
    .replace(/\r\n?/g, '\n')
}

function cleanOutput(raw, echoLine, token) {
  let text = stripAnsi(raw)
  // 去掉命令回显：回显那一行里一定含有 token（printf 的格式串），切到那一行之后
  if (token) {
    const i = text.lastIndexOf(token)
    if (i >= 0) {
      const nl = text.indexOf('\n', i)
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
  }
  const lines = text.split('\n')
  const head = String(echoLine || '').slice(0, 40)
  while (lines.length && (lines[0].trim() === '' || (head && lines[0].includes(head)))) lines.shift()
  text = lines.join('\n').replace(/[ \t]+$/gm, '').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length > CMD_OUTPUT_MAX) text = '\u2026\uff08\u524d\u90e8\u5df2\u622a\u65ad\uff09\n' + text.slice(-CMD_OUTPUT_MAX)
  return text
}

async function runCommand(id, cmd, timeoutMs) {
  const sess = sessions.get(id)
  if (!sess) return { ok: false, error: 'session not found', exit_code: null, output: '' }

  // 标记必须只由“真正的新行 + token + :数字”构成。
  // 关键：终端会把发出去的命令原样回显，回显里的 \n 是字面反斜杠+n，
  // 不是换行——所以用 ^\r?\n 锚定就能把回显排除掉。
  const token = '__SHRIMP_' + Math.random().toString(36).slice(2, 8).toUpperCase() + '_DONE__'
  const doneRe = new RegExp('(?:\\r?\\n)' + token + ':(\\d+)')
  const wrapped = cmd + ' ; printf "\\n' + token + ':%s\\n" "$?"'

  sess.tail = ''
  if (!writeTo(id, wrapped + '\n')) return { ok: false, error: 'write failed', exit_code: null, output: '' }

  const deadline = Date.now() + (timeoutMs || CMD_TIMEOUT_MS)
  while (Date.now() < deadline) {
    await sleep(CMD_POLL_MS)
    const m = sess.tail.match(doneRe)
    if (m && typeof m.index === 'number') {
      return {
        ok: true,
        exit_code: Number(m[1]),
        output: cleanOutput(sess.tail.slice(0, m.index), wrapped, token),
      }
    }
  }
  return {
    ok: false,
    timeout: true,
    exit_code: null,
    output: cleanOutput(sess.tail, wrapped, token),
  }
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
    description: 'Type ONE command line into each selected terminal session and wait until it finishes. '
      + 'Returns, per host: exit_code, timed_out, and the command output (ANSI stripped, tail-kept). '
      + 'Finish is detected by a sentinel marker, so fast commands return immediately and long ones '
      + 'are not cut off. Timeout is 30s per command. The user watches every keystroke live, '
      + 'so keep commands short, idempotent and safe.',
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

async function runAgent({ text, targets, history }) {
  const cfg = readSettings().agent || {}
  const key = cfg.apiKey || loadKey()
  if (!key) return { error: '\u5c1a\u672a\u914d\u7f6e agent API key\uff0c\u8bf7\u5230\u8bbe\u7f6e\u91cc\u586b\u5199\u3002' }
  const baseUrl = String(cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const model = cfg.model || 'deepseek-flash'

  if (!targets || !targets.length) return { error: 'No terminal selected.' }

  const tools = [TOOL]
  const messages = [{ role: 'system', content: SUB_SYS }]
  if (history && history.length) messages.push(...history.slice(-8))
  messages.push({ role: 'user', content: text })

  const actions = []
  const maxRounds = 6

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
      let out = ''
      try {
        const cmd = String(args.command || '').trim()
        if (!cmd) { messages.push({ role: 'tool', tool_call_id: call.id, content: 'ERROR: empty command' }); continue }
        const results = []
        for (const id of targets) {
          const sess = sessions.get(id)
          if (!sess) { results.push({ host: id, error: 'session not found' }); continue }
          const r = await runCommand(id, cmd)
          results.push({
            host: (sess.host && sess.host.name) || id,
            exit_code: r.exit_code,
            timed_out: !!r.timeout,
            output: r.output || '(no output)',
          })
        }
        out = JSON.stringify(results, null, 2)
        actions.push({ command: cmd, note: String(args.note || '') })
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

ipcMain.handle('app:info', () => ({ version: app.getVersion(), build: BUILD_INFO }))

ipcMain.handle('agent:ask', async (_e, req) => runAgent(req))

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => {
  for (const s of sessions.values()) { try { s.conn.end() } catch (e) {} }
  if (process.platform !== 'darwin') app.quit()
})
