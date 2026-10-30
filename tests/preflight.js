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

// 7. hist:get 必须同时兼容新（convs）与旧（log）两种结构
//    事故：数据改成多段对话后，hist:get 仍按 Array.isArray(rec.log) 判断，
//    新记录没有 log 字段 → 直接返回 null → 重启后对话全部丢失。
step('hist:get 兼容多段对话结构', () => {
  const main = fs.readFileSync(rel('main.js'), 'utf8')
  const i = main.indexOf("ipcMain.handle('hist:get'")
  if (i < 0) throw new Error('找不到 hist:get handler')
  const seg = main.slice(i, i + 800)
  if (!seg.includes('rec.convs')) {
    throw new Error('hist:get 未处理 convs 结构 —— 重启后对话会全部丢失')
  }
  if (!seg.includes('rec.log')) {
    throw new Error('hist:get 不再兼容旧结构 —— 老用户的历史会读不出来')
  }
  return 'convs 与旧 log 两种结构都支持'
})

// 8. 关键事件处理器：每个只能注册一次
//    事故：脚本批量替换时括号匹配错位，留下第二处 el('subNew').onclick = ...，
//    后一个把前一个覆盖掉，新逻辑等于没生效（点了没反应，也没有提示）。
step('关键事件处理器各注册一次', () => {
  const app = fs.readFileSync(rel(path.join('renderer', 'app.js')), 'utf8')
  const ids = ['subNew', 'subHist', 'subSend', 'btnSubToggle', 'rightHandle',
    'cfmOk', 'cfmCancel', 'cfmX']
  const bad = []
  for (const id of ids) {
    const n = (app.match(new RegExp("el\\('" + id + "'\\)\\.onclick", 'g')) || []).length
    if (n !== 1) bad.push(id + ' 注册 ' + n + ' 次')
  }
  if (bad.length) throw new Error(bad.join('; '))
  return ids.length + ' 个处理器各一次'
})

// 9. 确认框层级必须高于普通弹窗
//    事故：删除对话的确认框被「历史会话」弹窗盖住——#cfm 在 DOM 里排在
//    #memsel 前面，而 .ovl 都没设 z-index，后出现的自然盖住它。
step('确认框层级高于普通弹窗', () => {
  const html = fs.readFileSync(rel(path.join('renderer', 'index.html')), 'utf8')
  const ovl = html.match(/\.ovl \{[^}]*z-index:\s*(\d+)/)
  const cfm = html.match(/#cfm \{\s*z-index:\s*(\d+)/)
  if (!cfm) throw new Error('#cfm 没有设置 z-index，会被历史会话等弹窗盖住')
  if (ovl && Number(cfm[1]) <= Number(ovl[1])) {
    throw new Error('#cfm 的 z-index(' + cfm[1] + ') 必须大于 .ovl(' + ovl[1] + ')')
  }
  return '#cfm ' + cfm[1] + ' > .ovl ' + (ovl ? ovl[1] : '?')
})

// 10. 保存必须在历史加载之后
//    事故：新建标签 → renderSub 触发保存 → 空对话覆盖磁盘上的历史 →
//    随后 histGet 读回已被清空的记录，每次启动都丢一遍。
step('保存受 historyLoaded 守卫', () => {
  const app = fs.readFileSync(rel(path.join('renderer', 'app.js')), 'utf8')
  const i = app.indexOf('function persistTabAgent(')
  if (i < 0) throw new Error('找不到 persistTabAgent')
  const head = app.slice(i, i + 600)
  if (!head.includes('historyLoaded')) {
    throw new Error('persistTabAgent 缺少 historyLoaded 守卫 —— 会在历史加载前用空数据覆盖磁盘')
  }
  const rs = app.indexOf('function renderSub(')
  const re = app.indexOf('\n}\n', rs)
  if (rs >= 0 && re > rs && app.slice(rs, re).includes('persistTabAgent')) {
    throw new Error('renderSub 里不应保存 —— 渲染不代表数据变了')
  }
  return 'persistTabAgent 有守卫，renderSub 不落盘'
})

// 11. 测试接缝必须是环境变量开关，且默认关闭
//    事故预防：SHRIMP_SMOKE 的假会话/假模型一旦写死成 true，
//    正式版就会变成“假装在执行”的空壳。
step('测试接缝由环境变量开关', () => {
  const main = fs.readFileSync(rel('main.js'), 'utf8')
  if (!/const SMOKE = process\.env\.SHRIMP_SMOKE === '1'/.test(main)) {
    throw new Error('找不到 SMOKE 开关，或它不再由 SHRIMP_SMOKE=1 控制')
  }
  const uses = (main.match(/\bSMOKE\b/g) || []).length
  if (uses < 3) throw new Error('SMOKE 分支异常：只有 ' + uses + ' 处引用')
  if (/const SMOKE = true/.test(main)) throw new Error('SMOKE 被写死为 true')
  return 'SHRIMP_SMOKE=1 才启用，共 ' + uses + ' 处引用'
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
