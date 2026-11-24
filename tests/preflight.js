'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const libs = fs.readdirSync(path.join(root, 'lib')).map((file) => 'lib/' + file)
const entries = ['main.js', 'preload.js', 'renderer/app.js', 'renderer/terminal.js', 'renderer/tools.js', ...libs]
for (const file of entries) new vm.Script(read(file), { filename: file })

const preload = read('preload.js')
const main = read('main.js')
const declared = new Set([...main.matchAll(/ipcMain\.handle\('([a-z:]+)'/gi)].map((match) => match[1]))
for (const [, channel] of preload.matchAll(/invoke\('([a-z:]+)'/gi)) {
  assert.ok(declared.has(channel), 'Missing handler: ' + channel)
}
for (const [, channel] of preload.matchAll(/subscribe\('([a-z:]+)'/gi)) {
  assert.ok([main, ...libs.map(read)].some((source) => source.includes("'" + channel + "'")), 'Missing event: ' + channel)
}

const ignore = read('.gitignore')
for (const entry of ['hosts.json', 'settings.json', 'history.json', 'tasks.json', 'known-hosts.json', '.env', '*.pem', '*.key', 'dist/']) {
  assert.ok(ignore.split(/\r?\n/).includes(entry), 'Missing .gitignore entry: ' + entry)
}
const files = [...entries, 'package.json', 'hosts.example.json', 'renderer/index.html']
for (const file of files) {
  assert.doesNotMatch(read(file), /[A-Za-z]:\\{1,2}Users\\{1,2}|sk-[A-Za-z0-9]{12,}|BEGIN (OPENSSH|RSA|EC) PRIVATE KEY/, file + ' contains local credentials or paths')
}
assert.ok(main.includes("const SMOKE = process.env.SHRIMP_SMOKE === '1'"))
assert.ok(!main.includes('run_in_terminals'))
console.log('语法、IPC 契约、测试开关、凭据忽略规则通过。')
