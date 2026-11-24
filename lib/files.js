'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

function remotePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 4096 || value.includes('\0')) {
    throw new Error('请输入远端绝对路径。')
  }
  return path.posix.normalize(value)
}

function remoteChild(parent, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\0]/.test(name)) {
    throw new Error('文件名无效。')
  }
  return path.posix.join(remotePath(parent), name)
}

function request(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    let timer
    const done = (error, result) => {
      clearTimeout(timer)
      sftp.removeListener('close', closed)
      if (error) reject(error)
      else resolve(result)
    }
    const closed = () => done(new Error('SFTP 通道已关闭。'))
    timer = setTimeout(() => done(new Error('SFTP 请求超时。')), 20_000)
    sftp.once('close', closed)
    try { sftp[method](...args, done) } catch (error) { done(error) }
  })
}

function createFiles({ session, notify, chooseUpload, chooseDownload }) {
  const active = new Map()

  function get(id) {
    const bound = session(id)
    if (!bound) throw new Error('请先连接终端。')
    return bound
  }

  async function open(bound) {
    const sftp = await request(bound.conn, 'sftp')
    sftp.on('error', () => {})
    return sftp
  }

  function update(transfer, patch) {
    Object.assign(transfer, patch)
    notify({ ...transfer })
  }

  async function transfer(bound, direction, file, total, run) {
    const id = randomUUID()
    const controller = new AbortController()
    const record = { id, sessionId: bound.id, target: bound.target, direction, name: file, total, bytes: 0, status: 'running' }
    active.set(id, { controller, sessionId: bound.id })
    update(record, {})
    let bytes = 0
    let last = 0
    const progress = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length
        if (Date.now() - last >= 120) {
          last = Date.now()
          update(record, { bytes })
        }
        callback(null, chunk)
      },
    })
    try {
      await run(progress, controller.signal)
      update(record, { status: 'done', bytes })
    } catch (error) {
      update(record, {
        status: controller.signal.aborted ? 'cancelled' : 'failed',
        bytes,
        error: controller.signal.aborted ? '传输已停止。' : error.message,
      })
    } finally {
      active.delete(id)
    }
    return record
  }

  return {
    async list(id, directory) {
      const bound = get(id)
      if (bound.fake) {
        return {
          directory: directory || '/home/demo',
          entries: [{ name: 'logs', directory: true, size: 0 }, { name: 'readme.txt', directory: false, size: 48 }],
        }
      }
      const sftp = await open(bound)
      try {
        const canonical = await request(sftp, 'realpath', directory ? remotePath(directory) : '.')
        const entries = await request(sftp, 'readdir', canonical)
        return {
          directory: remotePath(canonical),
          entries: entries.filter(({ filename }) => filename !== '.' && filename !== '..').map(({ filename, attrs }) => ({
            name: filename, directory: attrs.isDirectory(), symlink: attrs.isSymbolicLink(), size: attrs.size, modified: attrs.mtime,
          })),
        }
      } finally { sftp.end() }
    },
    async upload(id, directory) {
      const bound = get(id)
      const parent = remotePath(directory)
      if (bound.fake) return
      const local = await chooseUpload()
      if (!local) return
      if (get(id) !== bound) throw new Error('原连接已变化，请重新选择文件。')
      const name = path.basename(local)
      const target = remoteChild(parent, name)
      const stat = await fsp.stat(local)
      if (!stat.isFile()) throw new Error('请选择普通文件。')
      return transfer(bound, 'upload', name, stat.size, async (meter, signal) => {
        const sftp = await open(bound)
        const temporary = remoteChild(parent, '.shrimp-' + randomUUID() + '.part')
        let needsCleanup = false
        try {
          const exists = await request(sftp, 'lstat', target).then(() => true, (error) => {
            if (error.code === 2) return false
            throw error
          })
          if (exists) throw new Error('远端已有同名文件。请先重命名本地文件。')
          signal.throwIfAborted()
          const dest = sftp.createWriteStream(temporary, { flags: 'wx' })
          dest.once('open', () => { needsCleanup = true })
          await pipeline(fs.createReadStream(local), meter, dest, { signal })
          signal.throwIfAborted()
          await request(sftp, 'rename', temporary, target)
          needsCleanup = false
        } finally {
          if (needsCleanup) await request(sftp, 'unlink', temporary).catch(() => {})
          sftp.end()
        }
      })
    },
    async download(id, remote) {
      const bound = get(id)
      const target = remotePath(remote)
      const name = path.posix.basename(target)
      if (bound.fake) return
      const local = await chooseDownload(name)
      if (!local) return
      if (get(id) !== bound) throw new Error('原连接已变化，请重新选择文件。')
      const sftp = await open(bound)
      try {
        const attrs = await request(sftp, 'stat', target)
        if (!attrs.isFile()) throw new Error('请选择普通文件。')
        return await transfer(bound, 'download', name, attrs.size, async (meter, signal) => {
          const temporary = path.join(path.dirname(local), '.shrimp-' + randomUUID() + '.part')
          try {
            await pipeline(sftp.createReadStream(target), meter, fs.createWriteStream(temporary, { flags: 'wx' }), { signal })
            signal.throwIfAborted()
            await fsp.rename(temporary, local)
          } finally { await fsp.rm(temporary, { force: true }) }
        })
      } finally { sftp.end() }
    },
    cancel(id) { active.get(id)?.controller.abort() },
    disconnect(id) {
      for (const task of active.values()) {
        if (task.sessionId === id) task.controller.abort()
      }
    },
  }
}

module.exports = { createFiles }
