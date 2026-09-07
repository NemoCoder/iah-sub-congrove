// ★门禁:React hooks 不许写在条件 return 之后★（2026-09-07，一次整页白屏换来的）
//
// 事故：点「待我处理」里的「接着写」→ **整页白屏**，不跳转、不提示、body 是空的。
// 根因在 `activity-minutes.tsx`：
//     if (loading) return <Spin/>          // 首屏提前返回
//     …
//     const [导出中] = useState(false)      // ★hook 在 return 之后★
// 首屏 loading=true 时这个 hook 没跑；数据回来后 loading=false 它跑了 ——
// ★本次渲染的 hooks 比上次多★ → React #310 → 白屏。
//
// ══ 为什么不是 eslint ══
// `react-hooks/rules-of-hooks` 正是治这个的，但它要求**组件名首字母大写**，
// 而本仓大量组件用中文命名（`用户表`/`审计表`…）——中文字符不算大写，
// 于是它一上来报 **25 条误报**，且规则只有 `additionalHooks` 一个选项，改不掉。
// ★一个开箱 25 条误报的门禁，必然被 `--max-warnings` 糊过去，等于没有。★
// ⇒ 自己写一条**只管这一条不变量、且完全不认名字**的检查，用 TS 自己的解析器走 AST。
//
// ══ 判据 ══
// 对每个函数体：按顺序扫顶层语句；一旦出现「条件里带 return 的 if」，
// 其后再出现 hook 调用（`useXxx(` 或 `X.useXxx(`）即报错。
// ⚠ 只看**同一个函数体的顶层**：嵌套函数（事件处理器、渲染回调）里的
//   return 不影响外层 hooks 顺序，混进来就是误报。
// ⚠★typescript 装在 web/node_modules 里,而本脚本住在 scripts/★:
//   Node 按**脚本所在位置**解析依赖,直接 `import 'typescript'` 会 ERR_MODULE_NOT_FOUND
//   (第一版就是这样)。用 createRequire 从 web/ 那边解析。
//   路径也一律由脚本位置推出来,跟在哪个目录下跑无关。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const 仓根 = join(dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(join(仓根, 'web', 'package.json'))('typescript')
const 根 = join(仓根, 'web', 'src')
const 是hook = (n) => {
  if (!ts.isCallExpression(n)) return null
  const e = n.expression
  if (ts.isIdentifier(e) && /^use[A-Z]/.test(e.text)) return e.text
  if (ts.isPropertyAccessExpression(e) && /^use[A-Z]/.test(e.name.text)) return `${e.expression.getText()}.${e.name.text}`
  return null
}
const 含hook = (node) => {          // 这个函数体里有没有 hook（用来判断"它是不是组件/自定义 hook"）
  let 有 = false
  const 走 = (n) => {
    if (有) return
    if (是hook(n)) { 有 = true; return }
    // 不下钻进嵌套函数：那里的 hook 属于那个函数
    if (n !== node && (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))) return
    ts.forEachChild(n, 走)
  }
  ts.forEachChild(node, 走)
  return 有
}
const 顶层hook = (stmt) => {        // 这条顶层语句里（不进嵌套函数）有没有 hook 调用
  const 命 = []
  const 走 = (n) => {
    const h = 是hook(n)
    if (h) 命.push({ 名: h, pos: n.getStart() })
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return
    ts.forEachChild(n, 走)
  }
  走(stmt)
  return 命
}
const 是条件return = (stmt) => ts.isIfStatement(stmt) && (() => {
  let 有 = false
  const 走 = (n) => { if (ts.isReturnStatement(n)) 有 = true
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return
    ts.forEachChild(n, 走) }
  走(stmt.thenStatement); if (stmt.elseStatement) 走(stmt.elseStatement)
  return 有
})()

const 文件 = []
;(function 扫(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) 扫(p)
    else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)) 文件.push(p)
  }
})(根)

const 命中 = []
for (const p of 文件) {
  const src = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const 查函数 = (fn) => {
    const body = fn.body
    if (!body || !ts.isBlock(body) || !含hook(fn)) return
    let 早return = null
    for (const stmt of body.statements) {
      if (早return !== null) {
        for (const h of 顶层hook(stmt)) {
          const { line } = src.getLineAndCharacterOfPosition(h.pos)
          命中.push(`${p}:${line + 1}  ★hook \`${h.名}\` 在第 ${早return + 1} 行的条件 return 之后★`)
        }
      } else if (是条件return(stmt)) {
        早return = src.getLineAndCharacterOfPosition(stmt.getStart()).line
      }
    }
  }
  const 走 = (n) => {
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) 查函数(n)
    ts.forEachChild(n, 走)
  }
  走(src)
}

if (命中.length) {
  console.log('★hooks 顺序违规 —— 会渲染成整页白屏(React #310)★')
  for (const c of 命中) console.log('  ' + c)
  console.log('修法:把 hook 挪到所有条件 return **之前**,让它每次渲染都无条件跑。')
  process.exit(1)
}
console.log(`★${文件.length} 个文件、hooks 顺序无违规 —— 门禁通过★`)
