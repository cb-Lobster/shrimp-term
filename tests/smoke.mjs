// 冒烟测试：真实 Electron 窗口 + 假后端，走一遍关键路径。
//
//   npm run smoke
//
// 实现方式：自己启动 Electron（--remote-debugging-port），再用 CDP 接管窗口。
// 不用 playwright 的 electron 启动器——它与本项目的 preload/主进程注入方式冲突。
//
// 依赖主进程测试接缝（SHRIMP_SMOKE=1）：假 SSH 会话 + 假模型回复，
// 所以不需要真实服务器与 API Key；数据目录用临时目录，不碰真实配置。

import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9333

let pass = 0
let fail = 0
const ok = (n) => { pass++; console.log('  ok   ' + n) }
const bad = (n, d) => { fail++; console.log('  FAIL ' + n + (d ? '\n         ' + String(d).slice(0, 300) : '')) }

async function check(name, fn) {
  try { await fn(); ok(name) } catch (e) { bad(name, e && e.message ? e.message : e) }
}

async function waitFor(fn, desc, timeout = 8000) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v } catch (e) { last = e }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('等待超时：' + desc + (last ? '（' + last.message + '）' : ''))
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shrimp-smoke-'))
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  onboarded: true, theme: 'dark', terminal: 'dark', fontSize: 12.5,
  agent: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'smoke-key', model: 'smoke' },
}, null, 2))
fs.writeFileSync(path.join(dataDir, 'hosts.json'), JSON.stringify({
  groups: ['测试环境'],
  hosts: [{ id: 'smoke1', name: 'SmokeHost', host: '127.0.0.1', port: 22, user: 'demo', group: '测试环境' }],
}, null, 2))

const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

function launchElectron() {
  const env = { ...process.env, SHRIMP_SMOKE: '1', SHRIMP_DATA_DIR: dataDir }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, ['.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT, env, stdio: 'ignore', windowsHide: false,
  })
  child.on('error', (e) => console.error('  启动失败:', e.message))
  return child
}

async function connect() {
  const deadline = Date.now() + 20000
  let browser = null
  while (Date.now() < deadline && !browser) {
    try {
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + PORT)
    } catch (e) {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  if (!browser) throw new Error('连不上 CDP 端口 ' + PORT)
  const ctx = browser.contexts()[0]
  const pages = ctx.pages()
  const page = pages.length ? pages[0] : await ctx.waitForEvent('page')
  await page.waitForLoadState('domcontentloaded')
  return { browser, page }
}

async function connectHost(page) {
  await waitFor(async () => (await page.locator('#hostList .host').count()) > 0, '主机列表出现')
  await page.locator('#hostList .host').first().click()
  await waitFor(async () => (await page.locator('#subTarget').textContent()) === 'SmokeHost', '右侧绑定 SmokeHost')
  await waitFor(async () => page.locator('#subSend').isEnabled(), '发送按钮可用')
}

async function ask(page, text) {
  await page.fill('#subInput', text)
  await page.click('#subSend')
  await waitFor(async () => (await page.locator('#subLog .msg.bot').count()) > 0, '助手回复出现')
}

async function openHistory(page) {
  await page.click('#subHist')
  await waitFor(async () => page.locator('#memsel.on').count(), '历史会话打开')
}

async function closeShell(page) {
  await page.evaluate(() => document.getElementById('memsel').classList.remove('on'))
}

async function main() {
  console.log('\n== 冒烟测试（Electron + 假后端） ==')
  let child = launchElectron()
  let { browser, page } = await connect()

  await check('标题显示版本号', async () => {
    await waitFor(async () => /ShrimpTerm v\d/.test(await page.title()), '标题含版本')
  })

  await check('点会话能连上并绑定右侧面板', () => connectHost(page))

  await check('提问能拿到回复', async () => {
    await ask(page, '你好')
    const txt = await page.locator('#subLog .msg.bot').last().textContent()
    if (!txt || !txt.includes('冒烟固定回复')) throw new Error('回复内容异常: ' + txt)
  })

  await check('新会话弹确认框 -> 新建成功', async () => {
    await page.click('#subNew')
    await waitFor(async () => page.locator('#cfm.on').count(), '确认框出现')
    const msg = await page.locator('#cfmMsg').textContent()
    if (!msg || !msg.includes('不会删除')) throw new Error('确认文案不对: ' + msg)
    await page.click('#cfmOk')
    await waitFor(async () => (await page.locator('#cfm.on').count()) === 0, '确认框关闭')
    await waitFor(async () => (await page.locator('#subLog .msg.me').count()) === 0, '已切到新对话')
  })

  await check('历史会话列出 2 段对话', async () => {
    await openHistory(page)
    const rows = await page.locator('#memList > div').count()
    if (rows < 2) throw new Error('对话数量不足: ' + rows)
    await closeShell(page)
  })

  await check('删除确认框浮在历史会话之上', async () => {
    await openHistory(page)
    await page.locator('#memList .pill', { hasText: '删除' }).first().click()
    await waitFor(async () => page.locator('#cfm.on').count(), '删除确认框出现')
    const z = await page.evaluate(() => [
      Number(getComputedStyle(document.getElementById('cfm')).zIndex),
      Number(getComputedStyle(document.getElementById('memsel')).zIndex),
    ])
    if (!(z[0] > z[1])) throw new Error('确认框层级没有更高: ' + z.join(' vs '))
    await page.click('#cfmCancel')
    await waitFor(async () => (await page.locator('#cfm.on').count()) === 0, '取消后关闭')
    await closeShell(page)
  })

  await check('重启后对话仍在（持久化回归）', async () => {
    await browser.close().catch(() => {})
    child.kill()
    await new Promise((r) => setTimeout(r, 1200))
    child = launchElectron()
    const again = await connect()
    browser = again.browser
    page = again.page
    await connectHost(page)
    await openHistory(page)
    const rows = await page.locator('#memList > div').count()
    if (rows < 2) throw new Error('重启后对话丢失，只剩 ' + rows + ' 段')
  })

  await browser.close().catch(() => {})
  child.kill()

  console.log('\n通过 ' + pass + ' 条，失败 ' + fail + ' 条')
  if (fail === 0) console.log('测试数据目录：' + dataDir)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('\n冒烟测试异常退出：', e && e.stack ? e.stack : e)
  process.exit(1)
})
