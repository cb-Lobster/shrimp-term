// 哨兵式命令执行的回归测试（不启动 Electron）
// 直接从 main.js 抽出真实实现来跑，避免"测试通过但代码不同"。
//
// 覆盖的事故场景：终端会把发出去的命令原样回显，而回显里含有 token 的字面文本，
// 旧实现用 indexOf(token) 会在命令还没跑完时提前命中，于是抓到的是回显本身，
// exit_code 为 null，真实输出丢失。

const fs = require('fs')
const path = require('path')

const MAIN = path.join(__dirname, '..', 'main.js')
const src = fs.readFileSync(MAIN, 'utf8')
const start = src.indexOf('function stripAnsi')
const end = src.indexOf('async function runCommand')
if (start < 0 || end < 0) {
  console.error('无法从 main.js 抽取 stripAnsi/cleanOutput，测试放弃')
  process.exit(1)
}
const code = 'const CMD_OUTPUT_MAX = 6000;\n' + src.slice(start, end) +
  '\nmodule.exports = { stripAnsi, cleanOutput }'
const mod = { exports: {} }
new Function('module', 'exports', code)(mod, mod.exports)
const { cleanOutput } = mod.exports

// 与 runCommand 中保持一致的常量
const token = '__SHRIMP_AB12CD_DONE__'
const cmd = 'df -h | head -3'
const wrapped = cmd + ' ; printf "\\n' + token + ':%s\\n" "$?"'
const doneRe = new RegExp('(?:\\r?\\n)' + token + ':(\\d+)')

function simulate(capture) {
  const hit = capture.match(doneRe)
  if (!hit) return { ok: false, output: cleanOutput(capture, wrapped, token) }
  return {
    ok: true,
    exit_code: Number(hit[1]),
    output: cleanOutput(capture.slice(0, hit.index), wrapped, token),
  }
}

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         want=' + JSON.stringify(want) + '\n         got =' + JSON.stringify(got)))
  ok ? pass++ : fail++
}

// 1. 回显里含字面 \n + token：不能提前命中，且要拿到真实输出
check('回显不误判 + 取到真实输出',
  simulate('ubuntu@srv:~$ ' + wrapped + '\r\nFilesystem Size Used Avail Use% Mounted\r\n' + token + ':0\r\n'),
  { ok: true, exit_code: 0, output: 'Filesystem Size Used Avail Use% Mounted' })

// 2. 事故场景：只有回显，命令尚未结束 → 必须返回"还没结束"
check('只有回显时不返回成功',
  simulate('ubuntu@srv:~$ ' + wrapped + '\r\n'),
  { ok: false, output: '' })

// 3. 非零退出码
check('退出码透传',
  simulate('$ ' + wrapped + '\nboom\n' + token + ':1\n'),
  { ok: true, exit_code: 1, output: 'boom' })

// 4. ANSI 颜色被清除
check('清除 ANSI 转义',
  simulate('$ ' + wrapped + '\n\u001b[31mERROR\u001b[0m connect failed\n' + token + ':2\n'),
  { ok: true, exit_code: 2, output: 'ERROR connect failed' })

// 5. 多行输出保留
check('多行输出保留',
  simulate('$ ' + wrapped + '\na\nb\nc\n' + token + ':0\n'),
  { ok: true, exit_code: 0, output: 'a\nb\nc' })

// 6. 超长输出保留尾部
const long = simulate('$ ' + wrapped + '\n' + 'x'.repeat(9000) + '\n' + token + ':0\n')
check('超长输出保留尾部', long.output.endsWith('x') && long.output.length <= 6100, true)

console.log('\n通过 ' + pass + ' 条，失败 ' + fail + ' 条')
process.exit(fail ? 1 : 0)
