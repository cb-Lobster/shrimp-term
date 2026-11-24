'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { once } = require('node:events')
const { test } = require('node:test')
const { generateKeyPairSync } = require('node:crypto')
const { Server, utils: { sftp: { OPEN_MODE, STATUS_CODE: STATUS } } } = require('ssh2')
const { createSessions } = require('../lib/ssh')
const { createFiles } = require('../lib/files')

function serveFiles(channel, contents) {
  const handles = new Map()
  let sequence = 0
  const attrs = (file) => ({ mode: file === '/home/test' ? 0o40755 : 0o100644, size: contents.get(file)?.length || 0 })
  const handle = (id, info) => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(++sequence)
    handles.set(sequence, info)
    channel.handle(id, buffer)
  }
  const openFile = (key) => handles.get(key.readUInt32BE())
  channel.on('REALPATH', (id, file) => channel.name(id, [{
    filename: file === '.' ? '/home/test' : file, longname: file, attrs: attrs('/home/test'),
  }]))
  channel.on('OPENDIR', (id, file) => file === '/home/test' ? handle(id, { file }) : channel.status(id, STATUS.NO_SUCH_FILE))
  channel.on('READDIR', (id, key) => {
    const info = openFile(key)
    if (info.read) return channel.status(id, STATUS.EOF)
    info.read = true
    channel.name(id, [...contents.keys()].map((file) => ({
      filename: path.posix.basename(file), longname: file, attrs: attrs(file),
    })))
  })
  function stat(id, file) {
    if (!contents.has(file) && file !== '/home/test') return channel.status(id, STATUS.NO_SUCH_FILE)
    channel.attrs(id, attrs(file))
  }
  channel.on('STAT', stat)
  channel.on('LSTAT', stat)
  channel.on('FSTAT', (id, key) => stat(id, openFile(key).file))
  channel.on('OPEN', (id, file, flags) => {
    if (flags & OPEN_MODE.WRITE) {
      if (contents.has(file)) return channel.status(id, STATUS.FAILURE)
      contents.set(file, Buffer.alloc(0))
    } else if (!contents.has(file)) return channel.status(id, STATUS.NO_SUCH_FILE)
    handle(id, { file })
  })
  channel.on('WRITE', (id, key, offset, bytes) => {
    const { file } = openFile(key)
    const previous = contents.get(file)
    const data = Buffer.alloc(Math.max(previous.length, offset + bytes.length))
    previous.copy(data)
    bytes.copy(data, offset)
    contents.set(file, data)
    channel.status(id, STATUS.OK)
  })
  channel.on('READ', (id, key, offset, length) => {
    const data = contents.get(openFile(key).file)
    if (offset >= data.length) return channel.status(id, STATUS.EOF)
    channel.data(id, data.subarray(offset, offset + length))
  })
  channel.on('CLOSE', (id, key) => {
    handles.delete(key.readUInt32BE())
    channel.status(id, STATUS.OK)
  })
  channel.on('RENAME', (id, input, output) => {
    if (contents.has(output)) return channel.status(id, STATUS.FAILURE)
    contents.set(output, contents.get(input))
    contents.delete(input)
    channel.status(id, STATUS.OK)
  })
  channel.on('REMOVE', (id, file) => {
    contents.delete(file)
    channel.status(id, STATUS.OK)
  })
}

test('SFTP lists and transfers files over a separate SSH channel, preserving the PTY', { timeout: 15_000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shrimp-sftp-'))
  const source = path.join(temp, '日志.txt')
  const saved = path.join(temp, 'saved.txt')
  const cancelled = path.join(temp, 'cancelled.txt')
  const payload = Buffer.from('文件传输\n'.repeat(15000))
  await fs.writeFile(source, payload)
  const serverFiles = new Map([['/home/test/initial.log', Buffer.from('hello')]])
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const clients = new Set()
  let writesToShell = 0
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (context) => context.method === 'password' ? context.accept() : context.reject(['password']))
    client.on('ready', () => client.on('session', (accept) => {
      const channel = accept()
      channel.on('pty', (acceptPty) => acceptPty())
      channel.on('shell', (acceptShell) => acceptShell().on('data', () => { writesToShell++ }))
      channel.on('sftp', (acceptSftp) => serveFiles(acceptSftp(), serverFiles))
    }))
  })
  const sessions = createSessions({ keyFile: path.join(temp, 'known.json'), password: () => 'test', send() {}, onClose() {} })
  try {
    const listening = once(server, 'listening')
    server.listen(0, '127.0.0.1')
    await listening
    const host = { id: 'test', host: '127.0.0.1', port: server.address().port, user: 'tester' }
    const { trust } = await sessions.open(host, {})
    const { id } = await sessions.open(host, { trustToken: trust.token })
    sessions.attach(id)
    const events = []
    let cancelNext = false
    const files = createFiles({
      session: (id) => sessions.get(id),
      chooseUpload: () => source,
      chooseDownload: () => cancelNext ? cancelled : saved,
      notify(event) {
        events.push(event)
        if (cancelNext && event.status === 'running' && event.bytes > 0) files.cancel(event.id)
      },
    })
    await assert.rejects(files.list(id, 'relative'), /绝对路径/)
    const listing = await files.list(id)
    assert.equal(listing.directory, '/home/test')
    assert.equal(listing.entries[0].name, 'initial.log')
    assert.equal(listing.entries[0].size, 5)
    const upload = await files.upload(id, listing.directory)
    assert.equal(upload.status, 'done', upload.error)
    assert.deepEqual(serverFiles.get('/home/test/日志.txt'), payload)
    const sameName = await files.upload(id, listing.directory)
    assert.equal(sameName.status, 'failed')
    assert.match(sameName.error, /同名/)
    const download = await files.download(id, '/home/test/日志.txt')
    assert.equal(download.status, 'done', download.error)
    assert.deepEqual(await fs.readFile(saved), payload)
    cancelNext = true
    assert.equal((await files.download(id, '/home/test/日志.txt')).status, 'cancelled')
    await assert.rejects(fs.stat(cancelled), { code: 'ENOENT' })
    assert.ok(events.some((event) => event.status === 'running' && event.bytes > 0))
    assert.equal(writesToShell, 0)
    assert.ok(sessions.get(id))
    assert.equal([...serverFiles.keys()].some((file) => file.endsWith('.part')), false)
    assert.equal((await fs.readdir(temp)).some((file) => file.endsWith('.part')), false)
  } finally {
    sessions.closeAll()
    for (const client of clients) client.end()
    server.close()
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 2 })
  }
})
