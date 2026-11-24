'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const { generateKeyPairSync } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const { Server } = require('ssh2')
const { execBackground, readOnlyCommand } = require('../lib/background')
const { createTasks } = require('../lib/tasks')
const { createSessions } = require('../lib/ssh')
const { readJson, writeJson, createSecrets } = require('../lib/storage')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrimp-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return (name) => path.join(dir, name)
}

function connection() {
  const conn = new EventEmitter()
  const stream = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.end = () => {}
  stream.close = () => { stream.emit('close') }
  conn.exec = (command, opts, cb) => {
    assert.deepEqual(opts, { pty: false })
    cb(null, stream)
  }
  return { conn, stream }
}

test('exec decodes split UTF-8 and retains stdout, stderr and exit code separately', async () => {
  const { conn, stream } = connection()
  const received = {}
  const result = execBackground(conn, 'df -h /', {
    onOutput: (key, value) => { received[key] = value },
  })
  const buf = Buffer.from('输出')
  stream.emit('data', buf.subarray(0, 2))
  stream.emit('data', buf.subarray(2))
  stream.stderr.emit('data', Buffer.from('错误'))
  stream.emit('exit', 7)
  stream.emit('close', 7)
  assert.deepEqual(received, { stdout: '输出', stderr: '错误' })
  assert.deepEqual(await result, { status: 'failed', error: undefined, exitCode: 7, exitSignal: null })
})

test('exec distinguishes lost connection, cancellation, timeout, rejection and signals', async () => {
  {
    const { conn, stream } = connection()
    const result = execBackground(conn, 'uptime')
    conn.emit('close')
    stream.emit('close', 0)
    assert.equal((await result).status, 'unknown')
  }
  {
    const { conn, stream } = connection()
    const controller = new AbortController()
    const result = execBackground(conn, 'uptime', { signal: controller.signal })
    stream.emit('exit', 0)
    controller.abort('disconnect')
    assert.equal((await result).status, 'succeeded')
  }
  {
    const { conn } = connection()
    const controller = new AbortController()
    const result = execBackground(conn, 'uptime', { signal: controller.signal })
    controller.abort()
    assert.equal((await result).status, 'cancelled')
  }
  {
    const { conn } = connection()
    assert.equal((await execBackground(conn, 'uptime', { timeoutMs: 5 })).status, 'timeout')
    conn.exec = (_command, _opts, cb) => cb(new Error('exec denied'))
    assert.match((await execBackground(conn, 'uptime')).error, /exec denied/)
  }
  {
    const { conn, stream } = connection()
    const result = execBackground(conn, 'uptime')
    stream.emit('exit', null, 'TERM')
    stream.emit('close')
    assert.equal((await result).exitSignal, 'TERM')
  }
  assert.equal(readOnlyCommand('constructor'), undefined)
  assert.equal(readOnlyCommand('disk; echo bad'), undefined)
})

test('confirmation executes once on the original connection and restart does not replay work', async (t) => {
  const file = fixture(t)('tasks.json')
  const platform = connection()
  const sessions = new Map()
  const first = { id: 'a', conn: platform.conn, host: { id: 'same-host' }, target: 'same-host' }
  const second = { ...first, id: 'b', conn: connection().conn }
  sessions.set(first.id, first)
  sessions.set(second.id, second)
  let originalCount = 0
  const exec = first.conn.exec
  first.conn.exec = (...args) => { originalCount++; exec(...args) }
  second.conn.exec = () => assert.fail('wrong SSH connection')
  const service = createTasks({ file, session: (sessionId) => sessions.get(sessionId), notify() {} })
  const queued = service.create(first, 'conv-a', 'uptime', 'inspect', false)
  assert.equal(originalCount, 0)
  const start = service.confirm(queued.id)
  assert.equal(service.confirm(queued.id), false)
  platform.stream.emit('close', 0)
  assert.equal((await start).status, 'succeeded')
  const abandoned = service.create(second, 'conv-b', 'uptime', 'inspect', false)
  const restored = createTasks({ file, session: () => assert.fail('replayed'), notify() {} })
  assert.equal(restored.list().find((task) => task.id === abandoned.id).status, 'unknown')
  assert.equal(restored.confirm(abandoned.id), false)
  assert.equal(originalCount, 1)
})

test('full-access tasks start immediately on the session submitted by the user', async (t) => {
  const file = fixture(t)('tasks.json')
  const platform = connection()
  const session = { id: 'trusted-session', conn: platform.conn, host: { id: 'server-a' }, target: 'ubuntu@server-a:22' }
  let command
  platform.conn.exec = (value, _options, callback) => {
    command = value
    const stream = new EventEmitter()
    stream.stderr = new EventEmitter()
    stream.end = () => { stream.emit('exit', 0); stream.emit('close', 0) }
    callback(null, stream)
  }
  const service = createTasks({ file, session: (id) => id === session.id ? session : undefined, notify() {} })
  const task = await service.create(session, 'conv-a', 'systemctl restart example', 'Restart service', true)
  assert.equal(command, 'systemctl restart example')
  assert.equal(task.status, 'succeeded')
  assert.equal(service.confirm(task.id), false)
})

test('actual SSH channels keep shell input isolated and reject changed host fingerprints', async (t) => {
  const file = fixture(t)('known-hosts.json')
  const clients = new Set()
  let shell, ptyRequests = 0, execRequests = 0, typed = ''
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => ctx.method === 'password' && ctx.password === 'fixture-password' ? ctx.accept() : ctx.reject(['password']))
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => { ptyRequests++; acceptPty() })
      session.on('shell', (acceptShell) => {
        shell = acceptShell()
        shell.on('data', (data) => { typed += data.toString() })
        shell.write('interactive ready')
      })
      session.on('exec', (acceptExec, _rejectExec, { command }) => {
        assert.equal(command, 'df -h /')
        execRequests++
        const channel = acceptExec()
        channel.write('fixture disk')
        channel.exit(0)
        channel.end()
      })
    }))
  })
  t.after(() => {
    for (const client of clients) client.end()
    server.close()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint = { id: 'fixture', host: '127.0.0.1', port: server.address().port, user: 'demo' }
  const events = []
  const sessions = createSessions({ keyFile: file, send: (...event) => events.push(event), onClose() {}, password: () => 'fixture-password' })
  const first = await sessions.open(endpoint, {})
  assert.match(first.trust.fingerprint, /^SHA256:/)
  const { id } = await sessions.open(endpoint, { trustToken: first.trust.token })
  assert.ok(id)
  sessions.attach(id)
  const bound = sessions.get(id)
  let output = ''
  assert.equal((await execBackground(bound.conn, 'df -h /', {
    onOutput: (_kind, text) => { output = text },
  })).status, 'succeeded')
  assert.equal(output, 'fixture disk')
  assert.equal(typed, '')
  assert.equal(ptyRequests, 1)
  assert.equal(execRequests, 1)
  assert.ok(events.some((event) => event[1].data === 'interactive ready'))
  const received = once(shell, 'data')
  assert.equal(sessions.input(id, 'user input'), true)
  await received
  assert.equal(typed, 'user input')
  sessions.close(id)
  writeJson(file, { [first.trust.endpoint]: 'SHA256:changed' })
  await assert.rejects(sessions.open(endpoint, {}), /指纹已变化/)
})

test('corrupt data is preserved and legacy plaintext can be migrated without renderer access', (t) => {
  const file = fixture(t)('settings.json')
  fs.writeFileSync(file, '{broken')
  assert.throws(() => readJson(file, {}), /保留原文件/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
  const ephemeral = createSecrets({ isEncryptionAvailable: () => false })
  const record = ephemeral.migrate({ apiKey: 'test-secret', other: true }, 'apiKey', 'agent')
  assert.deepEqual(record, { other: true })
  assert.equal(ephemeral.get(record, 'apiKey', 'agent'), 'test-secret')
})
