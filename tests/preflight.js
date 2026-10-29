// 提交前自检：npm run check
// 全部用纯 Node 实现（不 spawn 子进程），一条命令覆盖工程约定的硬性项。
//
//   1. 三个入口文件语法可编译
//   2. 哨兵/输出清洗的回归用例
//   3. IPC 契约对齐（preload 暴露的 invoke 通道必须在 main 里有 handler）
//   4. .gitignore 覆盖运行时数据与凭据
//   5. 源码里没有本机绝对路径、公网 IP、密钥残留

const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.join(__dirname, '..')
const rel = (p) => path.join(ROOT, p)
let failed = 0
const results = []

function step(name, fn) {
  try {
    const detail = fn()
    results.push({ ok: true, name, detail })
  } catch (e) {
    failed++
    results.push({ ok: false, name, detail: e && e.message ? e.message : String(e) })
  }
}

// 1. 语法
const ENTRIES = ['main.js', 'preload.js', path.join('renderer', 'app.js')]
step('语法可编译（3 个入口）', () => {
  for (const f of ENTRIES) {
    const code = fs.readFileSync(rel(f), 'utf8')
    try {
      new vm.Script(code, { filename: f })
    } catch (e) {
      throw new Error(f + ': ' + e.message)
    }
  }
  return ENTRIES.join(', ')
})

// 2. 回归用例
step('哨兵/输出清洗回归用例', () => {
  const mod = require('./sentinel.test.js')
  const bad = mod.run({ quiet: true })
  if (bad > 0) throw new Error(bad + ' 条用例失败，跑 npm test 看详情')
  return '全部通过'
})

// 3. IPC 对齐
step('IPC 契约对齐', () => {
  const preload = fs.readFileSync(rel('preload.js'), 'utf8')
  const main = fs.readFileSync(rel('main.js'), 'utf8')
  const pick = (src, re) => {
    const out = new Set()
    let m
    while ((m = re.exec(src))) out.add(m[1])
    return out
  }
  const exposed = pick(preload, /invoke\('([a-z:]+)'/g)
  const handled = pick(main, /ipcMain\.handle\('([a-z:]+)'/g)
  const missing = [...exposed].filter((c) => !handled.has(c))
  if (missing.length) throw new Error('preload 有、main 没有 handler: ' + missing.join(', '))
  return exposed.size + ' 个通道全部有 handler'
})

// 4. .gitignore 覆盖
step('.gitignore 覆盖运行时数据与凭据', () => {
  const gi = fs.readFileSync(rel('.gitignore'), 'utf8')
  const need = ['hosts.json', 'settings.json', 'history.json', '.env', '*.pem', '*.key', 'dist/']
  const missing = need.filter((k) => !gi.includes(k))
  if (missing.length) throw new Error('缺少: ' + missing.join(', '))
  return need.length + ' 项已覆盖'
})

// 5. 敏感残留（只扫会被提交的源码）
step('源码无本机路径 / 公网 IP / 密钥', () => {
  const files = ['main.js', 'preload.js', 'package.json', 'hosts.example.json',
    path.join('renderer', 'app.js'), path.join('renderer', 'index.html')]
  const patterns = [
    [/[A-Za-z]:\\{1,2}Users\\{1,2}[^"'\s]+/i, '本机绝对路径'],
    [/\b(?!10\.|127\.|192\.168\.|203\.0\.113\.|198\.51\.100\.)((?:\d{1,3}\.){3}\d{1,3})\b/, '疑似公网 IP'],
    [/sk-[A-Za-z0-9]{12,}/, '疑似 API Key'],
    [/BEGIN (OPENSSH|RSA|EC) PRIVATE KEY/, '私钥内容'],
  ]
  const hits = []
  for (const f of files) {
    const text = fs.readFileSync(rel(f), 'utf8')
    for (const [re, label] of patterns) {
      const m = text.match(re)
      if (m) hits.push(f + ': ' + label + ' → ' + String(m[0]).slice(0, 40))
    }
  }
  if (hits.length) throw new Error(hits.join(' | '))
  return files.length + ' 个文件干净'
})

// 6. 渲染层核心函数：有且仅有一处定义
//    事故：一次批量删除把 persistTabAgent 的定义删掉了，但 7 处调用还在——
//    语法检查发现不了，运行时才炸。这里做一次静态对账。
step('渲染层核心函数定义齐全', () => {
  const app = fs.readFileSync(rel(path.join('renderer', 'app.js')), 'utf8')
  const need = ['newConvObj', 'convTitleFrom', 'normalizeAgent', 'activeConv',
    'persistTabAgent', 'renderSub', 'askSub', 'openMemSel']
  const problems = []
  for (const fn of need) {
    const defs = app.match(new RegExp('^(?:async )?function ' + fn + '\\(', 'gm')) || []
    const uses = app.match(new RegExp('(?:^|[^.\\w])' + fn + '\\(', 'g')) || []
    if (defs.length !== 1) problems.push(fn + ' 定义 ' + defs.length + ' 处')
    else if (uses.length < 2) problems.push(fn + ' 定义了但没有调用')
  }
  if (problems.length) throw new Error(problems.join('; '))
  return need.length + ' 个函数各一处定义且有调用'
})

// 输出
console.log('')
for (const r of results) {
  console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.detail ? '  —  ' + r.detail : ''))
}
console.log('')
if (failed) {
  console.log('自检未通过：' + failed + ' 项，修完再提交')
  process.exit(1)
}
console.log('自检通过：可以提交（要更新桌面版就 npm run ship）')
