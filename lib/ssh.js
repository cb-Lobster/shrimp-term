'use strict'

const fs = require('node:fs')
const { createHash, randomUUID } = require('node:crypto')
const { Client } = require('ssh2')
const iconv = require('iconv-lite')
const { readJson, writeJson } = require('./storage')

const supportedEncodings = new Set(['utf-8', 'gbk', 'big5', 'latin1'])
const getEncoding = (name) => supportedEncodings.has(name) ? name : 'utf-8'

function createSessions({ keyFile, send, onClose, password, smoke }) {
  const sessions = new Map()
  const pendingTrust = new Map()

  function publish(session, event, payload) {
    if (session.attached) send(event, payload)
    else {
      session.buffer.push([event, payload])
      session.bufferSize += payload.data?.length || 0
      while (session.bufferSize > 256 * 1024 && session.buffer.length > 1) {
        session.bufferSize -= session.buffer.shift()[1].data?.length || 0
      }
    }
  }

  function closed(session, reason) {
    if (session.closed) return
    session.closed = true
    onClose(session.id)
    publish(session, 'term:closed', { id: session.id, reason })
    if (session.attached) sessions.delete(session.id)
    else setTimeout(() => sessions.delete(session.id), 15_000).unref()
  }

  function newSession(host, opts, conn, stream) {
    const id = randomUUID()
    const target = (host.user || 'ubuntu') + '@' + host.host + ':' + (host.port || 22)
    const session = {
      id, conn, stream, host: { id: host.id, name: host.name }, target,
      paneId: typeof opts.paneId === 'string' ? opts.paneId.slice(0, 100) : undefined,
      encoding: getEncoding(opts.encoding), buffer: [], bufferSize: 0, attached: false,
    }
    sessions.set(id, session)
    return session
  }

  function offerTrust(endpoint, fingerprint) {
    for (const [token, item] of pendingTrust) {
      if (Date.now() > item.expires || item.endpoint === endpoint) pendingTrust.delete(token)
    }
    const token = randomUUID()
    pendingTrust.set(token, { endpoint, fingerprint, expires: Date.now() + 120_000 })
    return { token, endpoint, fingerprint }
  }

  function open(host, opts) {
    if (smoke) {
      const session = newSession(host, opts)
      session.fake = true
      publish(session, 'term:data', { id: session.id, data: 'smoke shell ready\r\n$ ' })
      return Promise.resolve({ id: session.id })
    }
    return new Promise((resolve, reject) => {
      const conn = new Client()
      const port = Number(host.port || 22)
      const endpoint = host.host.toLowerCase() + ':' + port
      let session
      let settled = false
      let challenge
      let verificationError
      const deadline = setTimeout(() => {
        settle(new Error('SSH 连接超时。'))
        conn.destroy()
      }, 12_000)

      function settle(error) {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        if (verificationError) reject(verificationError)
        else if (challenge) resolve({ trust: challenge })
        else if (error) reject(error)
        else resolve({ id: session.id })
      }

      conn.on('error', (error) => {
        if (session) closed(session, error.message)
        settle(error)
        conn.destroy()
      })
      conn.on('close', () => {
        if (session) closed(session, 'SSH 连接已断开。')
        settle(new Error('SSH 连接已关闭。'))
      })
      conn.once('ready', () => {
        conn.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (error, stream) => {
          if (settled) { stream?.close(); return }
          if (error) { settle(error); conn.end(); return }
          session = newSession(host, opts, conn, stream)
          for (const output of [stream, stream.stderr]) {
            let encoding
            let decoder
            const write = (data) => {
              if (data && !session.closed) publish(session, 'term:data', { id: session.id, data })
            }
            output.on('data', (bytes) => {
              if (encoding !== session.encoding) {
                write(decoder?.end())
                encoding = session.encoding
                decoder = iconv.getDecoder(encoding)
              }
              write(decoder.write(bytes))
            })
            output.on('end', () => write(decoder?.end()))
            output.on('error', (error) => { closed(session, error.message); conn.end() })
          }
          stream.once('close', () => { closed(session, '远端终端已退出。'); conn.end() })
          settle()
        })
      })

      const trust = pendingTrust.get(opts.trustToken)
      pendingTrust.delete(opts.trustToken)
      const config = {
        host: host.host, port, username: host.user || 'ubuntu',
        readyTimeout: 9000, keepaliveInterval: 15000, keepaliveCountMax: 2,
        hostVerifier(key) {
          try {
            const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
            const known = readJson(keyFile, {})
            if (Object.hasOwn(known, endpoint)) {
              if (known[endpoint] === fingerprint) return true
              throw new Error('SSH 主机指纹已变化。已阻止连接。请通过独立渠道核验 ' + endpoint + '\n服务器提供：' + fingerprint)
            }
            if (trust?.endpoint === endpoint && trust.fingerprint === fingerprint && trust.expires >= Date.now()) {
              writeJson(keyFile, { ...known, [endpoint]: fingerprint })
              return true
            }
            challenge = offerTrust(endpoint, fingerprint)
          } catch (error) {
            verificationError = error
          }
          return false
        },
      }
      try {
        if (host.key) config.privateKey = fs.readFileSync(host.key)
        else if (password(host)) config.password = password(host)
        else throw new Error('请设置 SSH 密钥文件或密码。')
        conn.connect(config)
      } catch (error) {
        settle(error)
        conn.destroy()
      }
    })
  }

  return {
    open,
    get(id) {
      const session = sessions.get(id)
      return session?.closed ? undefined : session
    },
    attach(id) {
      const session = sessions.get(id)
      if (!session || session.attached) return
      session.attached = true
      for (const [event, payload] of session.buffer) send(event, payload)
      session.buffer = []
      if (session.closed) sessions.delete(id)
    },
    input(id, data) {
      const session = this.get(id)
      if (!session || typeof data !== 'string' || data.length > 1024 * 1024) return false
      if (session.fake) {
        if (data === '\x04') closed(session, '模拟远端断开。')
        else publish(session, 'term:data', { id, data })
      }
      else session.stream.write(iconv.encode(data, session.encoding))
      return true
    },
    encoding(id, encoding) {
      const session = this.get(id)
      if (session) session.encoding = getEncoding(encoding)
    },
    resize(id, cols, rows) {
      const session = this.get(id)
      if (!session || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2 || cols > 1000 || rows > 1000) return
      session.stream?.setWindow(rows, cols, 0, 0)
    },
    close(id) {
      const session = sessions.get(id)
      if (!session) return
      sessions.delete(id)
      closed(session, '已关闭连接。')
      session.stream?.close()
      session.conn?.end()
    },
    closeAll() {
      for (const id of sessions.keys()) this.close(id)
    },
  }
}

module.exports = { createSessions }
