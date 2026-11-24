'use strict'

const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const { createServer } = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { setTimeout: delay } = require('node:timers/promises')
const { createSessions } = require('../lib/ssh')
const { execBackground } = require('../lib/background')

async function availablePort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise((resolve) => socket.close(resolve))
  return port
}

async function waitFor(read) {
  const start = Date.now()
  while (Date.now() - start < 6000) {
    const value = read()
    if (value) return value
    await delay(25)
  }
  throw new Error('Timed out waiting for SSH/Vim fixture')
}

test('OpenSSH runs diagnostics while Vim keeps its unsaved buffer, mode and caret', {
  skip: process.platform !== 'linux' ? 'Requires Linux OpenSSH and Vim' : false,
  timeout: 25_000,
}, async (t) => {
  const sshd = process.env.SHRIMP_TEST_SSHD || '/usr/sbin/sshd'
  assert.ok(fs.existsSync(sshd), 'Install openssh-server and Vim and create /run/sshd.')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrimp-ssh-'))
  const file = (name) => path.join(dir, name)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const port = await availablePort()
  for (const name of ['host', 'identity']) {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file(name)])
  }
  fs.writeFileSync(file('sshd_config'), [
    'Port ' + port,
    'ListenAddress 127.0.0.1',
    'HostKey ' + file('host'),
    'PidFile ' + file('pid'),
    'AuthorizedKeysFile ' + file('identity.pub'),
    'PasswordAuthentication no',
    'PermitRootLogin prohibit-password',
    'UsePAM yes',
    'StrictModes no',
  ].join('\n') + '\n')
  const server = spawn(sshd, ['-D', '-e', '-f', file('sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] })
  t.after(() => server.kill())
  let serverLog = ''
  server.stderr.on('data', (bytes) => { serverLog += bytes })
  await waitFor(() => {
    assert.equal(server.exitCode, null, serverLog)
    return serverLog.includes('Server listening')
  })
  const a = { id: 'a', host: '127.0.0.1', port, user: os.userInfo().username, key: file('identity') }
  let terminal = ''
  const sessions = createSessions({
    keyFile: file('known-hosts.json'), onClose() {}, password() {},
    send: (event, payload) => {
      if (event === 'term:data' && payload.id === sessionA) terminal += payload.data
    },
  })
  t.after(() => sessions.closeAll())
  const trust = await sessions.open(a, {})
  const { id: sessionA } = await sessions.open(a, { trustToken: trust.trust.token })
  sessions.attach(sessionA)
  const { id: sessionB } = await sessions.open({ ...a, id: 'b' }, {})
  sessions.attach(sessionB)
  const snapshots = file('vim-state')
  fs.writeFileSync(file('vimrc'), [
    'autocmd VimEnter * call writefile(["ready"], "' + file('vim-ready') + '")',
    'inoremap <C-G> <Cmd>call writefile([json_encode([mode(1), getcurpos()[1:2], getline(1, "$")])], "' + snapshots + '", "a")<CR>',
  ].join('\n') + '\n')
  sessions.input(sessionA, 'vim -Nu ' + file('vimrc') + ' -n -i NONE ' + file('example.txt') + '\r')
  await waitFor(() => fs.existsSync(file('vim-ready')))
  // Give Vim real keyboard input and snapshot the editing state without leaving Insert mode.
  sessions.input(sessionA, 'iworking draft\x07')
  const readStates = () => fs.existsSync(snapshots)
    ? fs.readFileSync(snapshots, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  const before = await waitFor(() => readStates()[0])
  assert.match(before[0], /^i/)
  assert.deepEqual(before[2], ['working draft'])
  const main = sessions.get(sessionA)
  let output = ''
  const running = execBackground(main.conn, 'df -h /', { onOutput: (name, value) => {
    if (name === 'stdout') output = value
  } })
  assert.equal(sessions.input(sessionB, 'echo separate-pane\r'), true)
  assert.equal((await running).status, 'succeeded')
  assert.match(output, /Filesystem/)
  sessions.input(sessionA, '\x07')
  const after = await waitFor(() => readStates()[1])
  assert.deepEqual(after, before)
  assert.equal(fs.existsSync(file('example.txt')), false)
  assert.doesNotMatch(terminal, /df -h|Filesystem/)
})
