'use strict'

const iconv = require('iconv-lite')

const OUTPUT_LIMIT = 6000
const QUERIES = new Map([
  ['disk', 'df -h /'],
  ['uptime', 'uptime'],
  ['memory', 'free -h'],
])

function readOnlyCommand(query) {
  return QUERIES.get(query)
}

function collect(stream, encoding, onOutput, name) {
  const decoder = iconv.getDecoder(encoding)
  let output = ''
  let truncated = false
  let finished = false
  function append(text) {
    if (!text) return
    text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
    if (!text || truncated) return
    truncated ||= output.length + text.length > OUTPUT_LIMIT
    output += text.slice(0, Math.max(0, OUTPUT_LIMIT - output.length))
    onOutput(name, output, truncated)
  }
  stream.on('data', (bytes) => {
    if (!finished) append(decoder.write(bytes))
  })
  return () => {
    if (!finished) append(decoder.end())
    finished = true
  }
}

function execBackground(connection, command, {
  encoding = 'utf-8', signal, timeoutMs = 30_000, onOutput = () => {},
} = {}) {
  return new Promise((resolve) => {
    let channel
    let settled = false
    let exitCode = null
    let exitSignal = null
    let flush = () => {}

    function finish(status, error, stop = false) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', interrupted)
      connection.removeListener('close', disconnected)
      flush()
      if (stop && channel) channel.close()
      resolve({ status, error, exitCode, exitSignal })
    }

    function interrupted() {
      if (signal.reason === 'disconnect') return disconnected()
      finish('cancelled', '已取消，远端进程是否停止尚未证实。', true)
    }

    function disconnected() {
      if (exitCode !== null || exitSignal) closed()
      else finish('unknown', '连接已断开，远端结果未知。')
    }

    function closed() {
      if (exitCode === 0 && !exitSignal) finish('succeeded')
      else if (exitCode !== null || exitSignal) finish('failed')
      else finish('unknown', '服务器未提供退出状态。')
    }

    const timer = setTimeout(() => {
      finish('timeout', '任务超时，远端进程是否停止尚未证实。', true)
    }, timeoutMs)
    if (signal?.aborted) return interrupted()
    signal?.addEventListener('abort', interrupted, { once: true })
    connection.once('close', disconnected)
    try {
      connection.exec(command, { pty: false }, (error, stream) => {
        if (settled) {
          if (stream) {
            stream.on('error', () => {})
            stream.close()
          }
          return
        }
        if (error) return finish('failed', 'SSH 无法打开后台通道：' + error.message)
        channel = stream
        const out = collect(stream, encoding, onOutput, 'stdout')
        const err = collect(stream.stderr, encoding, onOutput, 'stderr')
        flush = () => { out(); err() }
        stream.on('error', () => finish('unknown', 'SSH 执行通道异常，远端结果未知。', true))
        stream.stderr.on('error', () => finish('unknown', 'SSH 错误输出通道异常，远端结果未知。', true))
        stream.on('exit', (code, sig) => {
          exitCode = Number.isInteger(code) ? code : null
          exitSignal = sig || null
        })
        stream.once('close', (code, sig) => {
          if (Number.isInteger(code)) exitCode = code
          if (sig) exitSignal = sig
          closed()
        })
        stream.end() // EOF on the exec channel's stdin
      })
    } catch (error) {
      finish('failed', 'SSH 无法打开后台通道：' + error.message)
    }
  })
}

module.exports = { execBackground, readOnlyCommand }
