'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(path.basename(file) + ' 读取失败，已保留原文件。')
  }
}

function writeJson(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function createSecrets(safeStorage) {
  const memory = new Map()
  function available() {
    return safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  }
  return {
    migrate(record, field, id) {
      const { [field]: plaintext, ...copy } = record
      return typeof plaintext === 'string' && plaintext ? this.set(copy, field, id, plaintext) : copy
    },
    get(record, field, id) {
      if (memory.has(id)) return memory.get(id)
      if (record[field + 'Encrypted']) {
        try { return safeStorage.decryptString(Buffer.from(record[field + 'Encrypted'], 'base64')) } catch {}
      }
      return ''
    },
    set(record, field, id, secret) {
      const copy = { ...record }
      delete copy[field]
      delete copy[field + 'Encrypted']
      if (secret && available()) {
        copy[field + 'Encrypted'] = safeStorage.encryptString(secret).toString('base64')
        memory.delete(id)
      } else if (secret) memory.set(id, secret)
      else memory.delete(id)
      return copy
    },
  }
}

module.exports = { readJson, writeJson, createSecrets }
