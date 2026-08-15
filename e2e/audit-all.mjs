#!/usr/bin/env node
// ★全面巡检★（2026-08-13 liaoruili:「每一个按键你都测试了吗。截图了吗？」
// 「截图必须要全部放下来！！！慢没问题，核心是我怕你漏掉！！！」）。
//
// 这不是「验某个功能」的脚本，而是**把界面走一遍**：每个视图、每个项目、每场活动、
// 每个 tab、每个能点的元素，点一下、截一张全页图、记一笔。它要抓的是逐条功能验收
// **结构上看不见**的那一类：点了没反应 / 点了报错 / 点开一片空白。
// 逐条验收只走 happy path，这三样在里面永远不会暴露。
//
// ══ 按 liaoruili 的两条要求定的死规矩 ══
// ★① 全页截图（fullPage）★：视口截图会把长页面**切掉下半截**，而「下半截长什么样」
//    正是他上一次发现问题的地方（24 条转移请求把页面拉到滚不完）。切掉 = 漏掉。
// ★② 不去重、不按名字合并★：同名按钮在不同行上是**不同的按钮**（每个项目行都有「⋯」），
//    按名字去重会让「只有第 7 行那个坏了」永远测不出来。逐个下标点。
//    代价是慢一个数量级 —— 他明确说了慢没问题。
//
// ══ 三条安全纪律 ══
// ① ★破坏性动作只对自己造的数据做★：删除/归档/清空/退出进名单，在真实数据上只截图不点；
//    真正的删除生命周期在最后一段对 `E2E-审计-*` 自己的数据走。
// ② ★弹窗只开不确认★：对话框开了截图就 Esc，绝不点「确定」——
//    审计脚本误改真实数据比漏测一个按钮严重得多。
// ③ ★全程收 console error 与 HTTP >= 400★：很多「点了没反应」在界面上是安静的，
//    只有这两条流水里看得出来。
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const BASE = process.env.CONGROVE_BASE ?? 'https://congrove-dev.sub.ruciah.com'
const KEY = process.env.IAH_E2E_KEY
const WHO = process.env.AUDIT_USER ?? 'liaoruili'
/// ★版本号别手写★（2026-08-15）：这里原来硬编码 `'v0.4.113'`，而线上早就是 v0.4.154 ——
///   于是截图落进**老版本的目录**，报告表头还自称「全面巡检 v0.4.113」。
///   ★一个说着数据并不支持的标签★，和我这两天在界面上抓的是同一类问题，
///   只是它更危险：证据被归错档、报告自称的版本是错的，将来回看会得出错误结论。
///   （这轮侥幸没覆盖上一轮，只因为 RUN 默认值恰好不同 —— ★没被覆盖是运气，不是设计★。）
///   现在从**页面上读**（页眉那个 `vX.Y.Z`），读不到才回落到 env / 'unknown'。
let VER = process.env.AUDIT_VER ?? null
/// ★每一轮一个独立目录★（2026-08-13 踩的第二个坑）：重跑一小段时编号又从 0001 开始，
/// **把上一轮的报告和前 11 张截图直接覆盖掉了** —— 全量那份 178 次点击的报告就此没了
/// （幸好终端日志还在）。截图是证据，证据不能被下一次运行擦掉。
const RUN = process.env.AUDIT_RUN ?? '全量'
let DIR = null   // 版本要等页面打开才知道,目录推迟到那时再建

/// ★判据从黑名单换成白名单★（2026-08-13，栽了两次之后）。
///
/// 原来是「名字里带 删除/归档/清空… 就不点」。两次都从这张网里漏了出去：
///   ① 「进入超管模式」→ 把 liaoruili 的账号**提权两小时**；
///   ② 「标记完成」   → 把他**五场活动的纪要标成定稿**（其中三场原本连纪要记录都没有，
///                      我的点击 upsert 出了空记录，「还没建」再也变不回去了）。
/// 两次的共同点:改数据的动词根本数不完 —— 标记/完成/保存/提交/应用/接受/加入/开启…
/// ★这正是本仓库 ADR-0005 早就写下的那条:判据必须是白名单,不是清单。★
/// 黑名单漏一条就是一次事故,而白名单漏一条只是少测一个按钮。
///
/// 所以:**只读模式**下只点这张白名单上的（纯导航/展开收起/开弹窗），其余一律只截图。
/// 想把每个按钮都真点一遍,请用**自己的沙箱账号**跑（AUDIT_USER=e2e AUDIT_MODE=full），
/// 那里的数据是测试造的,点坏了无所谓 —— ★而不是拿真人的数据去点★。
/// ⚠★2026-08-15 补进来的那一串(进行中/已归档/本月/…/决议与待办)全是 `Segmented`★ ——
///   它们**本来就该在这张白名单上**(纯切视图,不写任何数据),之所以一直没写,
///   是因为选择器根本枚举不到它们、我从没在报告里见过它们,也就没想起来漏了谁。
///   ★覆盖率的洞会自我掩盖:看不见的东西,连「该不该点」都轮不到你判断。★
const 安全可点 = /^(今\s*天|‹|›|周|月|列表|展开|收起|返回|新\s*建|\+?\s*发起活动|回收站( \d+)?|文档|成员|活动|设置|信息与人员|纪要正文|个人面板|我的分享|我的活动类型|开发者|近 7 天|全部|上传文件|接着写\s*›|去整理\s*›|还有 .* 展开 ▾|进行中( \d+)?|已归档( \d+)?|本月|本季度|本年|我参与的|我发起的|已拒绝|已结束|摘要|分段大纲|决议与待办|.*\(无文字\))$|展开|收起/
/// ★无论哪种模式都不点的三样★ —— 理由**不是**「怕弄坏数据」(dev 数据是假的),而是:
///   · 退出登录 / 注销 —— 会把整轮带走,后面全部作废;
///   · 进入超管模式 —— 它改的是**账号状态**不是数据,点了之后这个人此后看得到所有人的东西。
const 绝不点 = /退出登录|超管模式|注\s*销/
/// 会把页面整个带走的（登出、跳外站），以及**会改账号状态**的。
///
/// ⚠★「进入超管模式」是 2026-08-13 第一轮巡检踩的坑★:它不含「删除/归档」这类字眼,
///   于是溜过了破坏性名单 —— 脚本点了它,把 liaoruili 的账号**提权了两小时**。
///   ★破坏性不只是「改数据」,还包括「改这个人的权限状态」★:后者更隐蔽,
///   因为它在界面上什么都不删,只是让这个人此后看得到所有人的东西。
///   (发现方式也值得记:是我逐张看截图时看见顶部那条黄色横幅才发觉的,报告里一个字都没有。)
const 别点 = /退出登录|IAH 开发平台|开发平台|hub\.ruciah|超管模式/
/// 一屏之内可点的东西
///
/// ★`.ant-segmented-item` 是 2026-08-15 补的,补之前这个巡检有个**沉默的大洞**★:
///   全树 **10 个 `<Segmented>` 控件,上一轮 624 次点击里一个都没点到** —— 报告里
///   「进行中 / 已归档 / 本月 / 本季度 / 本年 / 周 / 月 / 列表 / 近 7 天 / 全部 /
///   我参与的 / 我发起的 / 已拒绝 / 已结束 / 摘要 / 分段大纲 / 决议与待办」
///   **各出现 0 次**,而且**也不在「未测」清单里**(未测只记「枚举到了但复位后找不到」)。
///   于是看报告的人会以为覆盖了 —— ★没被枚举到的东西,连「没测」都不会说★。
///   代价是整块整块的界面从没被巡检看过:**月视图、列表视图、已归档项目、已拒绝 tab**……
///
/// ⚠★根因是个纯技术细节,但后果是产品级的★:`[role=radio]` 是**属性**选择器,
///   而 AntD 的 Segmented 渲染成 `<label class="ant-segmented-item"><input type="radio">`,
///   那个 input **没有显式 `role` 属性**(靠标签语义),所以永远匹配不到;
///   input 本身还被 CSS 藏了(宽 0),`:visible` 也过不了 —— 真正可点的是外层 label。
/// ⚠ 更值得记的是**我一直以为它们被点着**:下面「安全可点」白名单里明明写着
///   `周|月|列表|近 7 天|全部` —— ★白名单写了,不等于选择器够得着★。
///   教训:判断覆盖率要看**报告里那一格出现过没有**,不能看「我写了规则让它点」。
const SEL = 'button:visible, a:visible, [role=tab]:visible, [role=radio]:visible, .ant-segmented-item:visible'

const 错误 = [], 网络 = [], 记录 = []
/// ★哪些错误被某次点击认领了★（2026-08-14 补的判据缺口）。
/// 上一轮巡检里 `403 GET /api/_dev/apis` **真实发生了,却没进异常清单** ——
/// 因为它是**打开「开发者」页那一刻**页面自己发的请求,不在任何一次点击的前后窗口里,
/// 而这里只把「点击前后新增的」算作该次点击的异常。
/// ★于是「打开某页就报错」这一整类问题,这个脚本原本一条都抓不到★:
///   它们会安安静静躺在报告末尾的「HTTP >= 400」清单里,而摘要行的「异常 N 处」是 0。
///   ——**看报告的人只会读摘要**,于是这类失败等于不存在。
/// 修法:逐条记认领,收尾时把没人认领的单列一节,并计进摘要。
const 已认领 = new Set()
let n = 0
/// ★截图失败过去是被静默吞掉的★（2026-08-15，本仓「工具没跑→报绿」的第六次）：
///   原来是 `.catch(() => {})` —— 于是报告照常列出一行「ok」，指着一个**根本不存在的截图文件**。
///   实测有多糟：这一轮 **101 次点击只落了 19 张图**（线上数据涨了、页面变高，`fullPage` 超时），
///   而日志里每一条都是 `✓`。★证据悄悄没了，报告看上去却是完整的 —— 比报红坏得多。★
/// 修法三层：① 先试 fullPage；② 超时就降级拍可视区（**截到一部分也远好过没有**）；
///   ③ 两次都失败就**如实记一笔**，收尾时单列一节 —— 绝不再假装拍到了。
const 缺图 = []
/// ⚠★第一版修法把巡检跑死了★（2026-08-15，同一天内的第二次教训）：
///   原来的 `.catch(() => {})` 虽然骗人，但**失败得快**；我改成「超时 15s 再降级」之后,
///   每张拍不成的图都要烧 15 秒 —— 90 分钟只跑完 12 个项目里的 3 个,**报告压根没写出来**。
///   ★诚实的方向是对的,代价我没算★。
///   现在:超时压到 5 秒,而且**一页里只要失败过一次,这页剩下的直接拍可视区** ——
///   同一个页面的高度不会因为点了个按钮就变矮,再逐张去试就是纯烧时间。
let 本页可fullPage = true
let 连续失败 = 0
const shot = async (名) => {
  const f = `${String(++n).padStart(4, '0')}-${名.replace(/[\/\s]+/g, '_').replace(/[^\w一-龥.-]/g, '').slice(0, 48)}.png`
  const o = { path: `${DIR}/${f}`, animations: 'disabled', timeout: 5000 }
  if (本页可fullPage) {
    try { await p.screenshot({ ...o, fullPage: true }); 连续失败 = 0; return f }
    catch { 本页可fullPage = false; 缺图.push(`${f} 起（本页 fullPage 超时,之后改拍可视区）`) }
  }
  try { await p.screenshot(o); 连续失败 = 0 }
  catch (e) {
    缺图.push(`${f}（★两次都失败,这一格没有证据★:${(e.message || '').slice(0, 60)}）`)
    console.log(`  ✗✗ 截图失败 @${f}: ${(e.message || '').split('\n')[0].slice(0, 80)}`)
    // ★环境垮了就大声停,别继续产出漂亮的假报告★（2026-08-15 实测踩到）:
    //   .14 的浏览器服务在一轮 90 分钟的长跑中死了(`ECONNREFUSED`),于是
    //   **截图 759 张里 740 张没有证据**,而摘要照样写着「共点 793 处,★异常 0 处★」——
    //   ★这是最坏的一种输出:看起来像一次彻底的全绿。★
    //   浏览器都拍不出图了,「点得动」这个判据本身也不再可信,继续跑只是在攒垃圾。
    if (++连续失败 >= 10) {
      console.error(`\n★★环境不可信,主动中止★★ 连续 ${连续失败} 次截图失败 —— `
        + `多半是 .14 的浏览器服务挂了:\n`
        + `  ssh liaoruili@172.19.0.14 'systemctl --user restart pw-ui.service'\n`
        + `★本轮作废、不出报告★:没有证据的「异常 0 处」比报红更危险。`)
      process.exit(3)
    }
    return f + '｜★没拍到★'
  }
  return f
}

const b = await chromium.connect('ws://172.19.0.14:9333/congrove', { timeout: 20000 })
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, ignoreHTTPSErrors: true,
  extraHTTPHeaders: { 'X-IAH-E2E-Key': KEY, 'X-IAH-E2E-User': WHO } })
const p = await ctx.newPage()
p.on('console', (m) => { if (m.type() === 'error') 错误.push(m.text().slice(0, 220)) })
p.on('pageerror', (e) => 错误.push('★未捕获异常★ ' + String(e).slice(0, 220)))
p.on('response', (r) => { if (r.status() >= 400) 网络.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`) })

const 到首页 = async () => { await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(2200) }

/// ★版本从页面上读,再建目录★ —— 见上面 VER 那段注释:手写的版本号会悄悄过期。
await 到首页()
if (!VER) {
  const t = await p.locator('body').innerText().catch(() => '')
  VER = (t.match(/v\d+\.\d+\.\d+/) || ['unknown'])[0]
}
DIR = `/iah101/iah_k8s_platform/unit_tests/congrove/screenshots/${VER}/巡检-${RUN}`
mkdirSync(DIR, { recursive: true })
console.log(`★实际在巡检的版本:${VER}★（从页眉读的,不是手写的）`)
const nav = async (名) => { await p.getByText(名, { exact: true }).first().click(); await p.waitForTimeout(1300) }
const 收弹窗 = async () => {
  for (let i = 0; i < 3; i++) {
    if (!(await p.locator('.ant-modal:visible, .ant-drawer:visible, .ant-select-dropdown:visible, .ant-dropdown:visible').count())) break
    await p.keyboard.press('Escape'); await p.waitForTimeout(400)
  }
}

/// ★巡一屏★：把当前屏上所有可点元素**逐个下标**点一遍，每点一次先复位。
/// `复位` 必须把页面带回到「这一屏」，否则下一个下标指向的就不是同一个东西了。
const ONLY = process.env.AUDIT_ONLY
/// (原注:「默认只读,默认值站在不会弄坏真人数据那一边」—— ★这个默认站错了边★,
///  见上面 2026-08-14 那段:代价是巡检只剩一半,而它保护的东西根本不需要保护。)
/// ★默认 full★(2026-08-14 改,见上面那段):dev 数据是假的,不点就等于没测。
/// 想退回只读要**显式**写 `AUDIT_MODE=readonly` —— ★默认值必须站在「真的测了」那一边★。
const MODE = process.env.AUDIT_MODE ?? 'full'
async function 巡一屏(页面, 复位) {
  本页可fullPage = true   // 换一页就再给 fullPage 一次机会(页面高度不同)
  if (ONLY && !页面.includes(ONLY)) return
  await 复位()
  const 全部 = []
  for (const el of await p.locator(SEL).all()) {
    const t = ((await el.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ')
    const aria = (await el.getAttribute('aria-label').catch(() => null)) ?? ''
    全部.push(t || aria || '(无文字)')
  }
  console.log(`\n── ${页面}：${全部.length} 个可点元素 ──`)
  // ★把「可能改数据」的点击排到最后★（2026-08-13 补测纪要页时发现）:
  //   纪要页的「标记完成」排在第 3 个,点完这场会就离开待办列表 —— 整页再也进不去,
  //   于是它后面那 7 个按钮全成了「未测」。★一个破坏性按钮,能把它后面的整屏覆盖掉。★
  //   补铺更多份数据没用:每一份都会在自己的第一次破坏性点击处断掉。
  //   排序之后,一屏之内先把所有只读的点完,最后才动会改状态的 —— 一份数据就能覆盖整屏。
  //   ⚠ 报告里的 `序` 仍是**原始下标**,不是点击顺序:那样才对得上「界面上第几个元素」。
  // ⚠★判据是「点了会不会让这一屏消失」,不是「安不安全」★(第一版按白名单排,没起作用):
  //   「标记完成」和「按答复带入」都不在白名单里,于是仍按原下标先后 —— 前者照旧排在前面。
  //   真正要往后排的是**把当前这条从列表里拿掉**的那些动作(答复完/标记完/删掉/归档掉),
  //   它们一执行,这一屏的入口就没了;而「按答复带入」这类是页内动作,点完页面还在。
  const 会离屏 = /标记完成|删\s*除|归\s*档|取\s*消|接\s*受|拒\s*绝|待\s*定|建议改期|还\s*原|彻底|移\s*除|purge/i
  const 顺序 = 全部.map((名, i) => i)
    .sort((a, b) => (会离屏.test(全部[a]) ? 1 : 0) - (会离屏.test(全部[b]) ? 1 : 0))
  for (const i of 顺序) {
    const 名 = 全部[i]
    if (别点.test(名)) { 记录.push({ 页面, 序: i, 元素: 名, 结果: '跳过(会离开本站/登出)', 截图: '' }); continue }
    // ★复位后按**名字**找回来,不认死下标★（2026-08-13 第一轮巡检暴露的脚本 bug）:
    //   下标会漂移(点了一下之后列表长短变了、或复位落在了别的屏),
    //   死认下标的结果是 8 条「复位后这个位置没有元素了」——
    //   ★而那 8 条的真相是「这个按钮我根本没测到」,不是「它坏了」。★
    //   把没测到报成异常会掩盖真异常;把没测到报成通过更糟。所以单列一类「未测」。
    let el = null
    for (let 轮 = 0; 轮 < 2 && !el; 轮++) {
      await 复位()
      const 现在 = await p.locator(SEL).all()
      const 文 = []
      for (const e of 现在) 文.push(((((await e.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ')) || '(无文字)'))
      if (文[i] === 名) el = p.locator(SEL).nth(i)
      else { const j = 文.indexOf(名); if (j >= 0) el = p.locator(SEL).nth(j) }
    }
    if (!el) { 记录.push({ 页面, 序: i, 元素: 名, 结果: '未测(复位后找不到这个元素)', 截图: '' }); console.log(`  ? [${页面}] #${i} ${名} — 未测:复位后找不到`); continue }
    const 现名 = (((await el.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ')) || '(无文字)'
    if (绝不点.test(名) || 绝不点.test(现名)
        || (MODE !== 'full' && !安全可点.test(名) && !安全可点.test(现名))) {
      记录.push({ 页面, 序: i, 元素: 名,
        结果: MODE === 'full' ? '跳过(会改账号状态)' : '跳过(只读模式:不在安全白名单里,只截图)',
        截图: await shot(`${页面}-${i}-跳过-${名}`) })
      console.log(`  ⊘ [${页面}] #${i} ${名} — 只截图不点`)
      continue
    }
    // ★禁用的按钮不算异常★:点不动一个 disabled 按钮是它**本该有的**行为
    //（「新建」在名字没填时就是灰的），报成「点不动」是脚本在喊狼来了。
    if (await el.isDisabled().catch(() => false)) {
      记录.push({ 页面, 序: i, 元素: 名, 结果: '跳过(按设计禁用)', 截图: await shot(`${页面}-${i}-禁用-${名}`) })
      console.log(`  ⊘ [${页面}] #${i} ${名} — 按设计禁用`)
      continue
    }
    const 错前 = 错误.length, 网前 = 网络.length
    let 结果 = 'ok'
    try { await el.click({ timeout: 6000 }) } catch (e) { 结果 = '★点不动★ ' + String(e).split('\n')[0].slice(0, 90) }
    await p.waitForTimeout(1000)
    const 新错 = 错误.slice(错前), 新网 = 网络.slice(网前)
    for (let k = 错前; k < 错误.length; k++) 已认领.add('e' + k)
    for (let k = 网前; k < 网络.length; k++) 已认领.add('n' + k)
    if (新错.length) 结果 = '★JS 报错★ ' + 新错[0]
    else if (新网.length) 结果 = '★HTTP ' + 新网[0] + '★'
    const f = await shot(`${页面}-${i}-${名}`)
    记录.push({ 页面, 序: i, 元素: 名 + (现名 !== 名 ? ` (复位后是「${现名}」)` : ''), 结果, 截图: f })
    console.log(`  ${结果 === 'ok' ? '✓' : '✗'} [${页面}] #${i} ${名}${结果 === 'ok' ? '' : '   — ' + 结果}`)
    await 收弹窗()
  }
}

console.log(`\n══ 全面巡检 ${VER}（${BASE}，身份 ${WHO}）══`)
console.log(`★全页截图、不去重、逐下标点★；模式 ${MODE}（readonly = 只点安全白名单，其余只截图）`)
console.log(`报告与截图落 ${DIR}\n`)

// ══ 一、三个主视图 ══
await 到首页(); await shot('首页-日程-初始')
await 巡一屏('日程', 到首页)
await 巡一屏('项目', async () => { await 到首页(); await nav('项目') })
await 巡一屏('活动', async () => { await 到首页(); await nav('活动') })

// ══ 二、每个项目 × 每个 tab（按钮大半住在这里）══
await 到首页(); await nav('项目')
const 项目名单 = []
for (const el of await p.locator('.ant-card').filter({ hasText: '项目' }).first()
  .locator('div[style*="cursor"], li, .ant-list-item').all()) {
  const t = ((await el.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ')
  if (t && t.length < 40 && !/进行中|已归档|回收站|新\s*建/.test(t)) 项目名单.push(t.split(/管理员|成员|只读|系统/)[0].trim())
}
const 项目们 = [...new Set(项目名单)].filter(Boolean).slice(0, 8)
console.log(`\n══ 项目共 ${项目们.length} 个：${项目们.join(' / ')} ══`)
for (const 名 of 项目们) {
  const 进项目 = async () => {
    await 到首页(); await nav('项目')
    await p.getByText(名, { exact: false }).first().click(); await p.waitForTimeout(1400)
  }
  await 进项目(); await shot(`项目-${名}-进入`)
  // 右侧 tab 逐个进，进去之后再把那一屏点一遍
  const tabs = []
  for (const t of await p.locator('[role=tab]:visible').all()) {
    const s = ((await t.textContent().catch(() => '')) ?? '').trim()
    if (s) tabs.push(s)
  }
  for (const tb of tabs) {
    await 巡一屏(`项目·${名}·${tb}`, async () => {
      await 进项目()
      const t = p.locator('[role=tab]:visible').filter({ hasText: tb }).first()
      if (await t.count()) { await t.click(); await p.waitForTimeout(1100) }
    })
  }
}

// ══ 三、每场活动的详情页 ══
await 到首页(); await nav('活动')
const 活动们 = []
for (const el of await p.locator('div[style*="cursor"], .ant-list-item').all()) {
  const t = ((await el.textContent().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ')
  if (t && t.length > 2 && t.length < 60) 活动们.push(t.split(/\d{1,2}\/\d{1,2}/)[0].trim())
}
const 活动清单 = [...new Set(活动们)].filter((x) => x && x.length > 2).slice(0, 6)
console.log(`\n══ 活动共巡 ${活动清单.length} 场 ══`)
for (const 名 of 活动清单) {
  await 巡一屏(`活动·${名}`, async () => {
    await 到首页(); await nav('活动')
    const el = p.getByText(名, { exact: false }).first()
    if (await el.count()) { await el.click(); await p.waitForTimeout(1600) }
    // ★复位要回到**同一个面板**,不只是同一个页面★（2026-08-14 的 7 处「未测」就是这么来的）:
    //   纪要页分「信息与人员 / 纪要正文」两个面板,而「带入未应答/拒绝」这类按钮住在前一个里。
    //   前面某次点击把面板切走之后,复位只做到「打开这场活动」——★那一屏的后半截元素
    //   从此再也找不到,全被判成「未测」★(上一轮 7 处里有 5 处是它)。
    //   ⚠ 判成「未测」而不是「通过」这一点是对的(判据没撒谎),但**连着 5 次没测到**
    //     说明的是复位不够,而不是那些按钮有问题。
    const 面板 = p.getByText('信息与人员', { exact: true }).first()
    if (await 面板.count()) { await 面板.click().catch(() => {}); await p.waitForTimeout(700) }
  })
}

// ══ 四、用户菜单四个页面 ══
for (const 项 of ['个人面板', '我的分享', '我的活动类型', '开发者']) {
  await 巡一屏(`菜单·${项}`, async () => {
    await 到首页()
    await p.locator('button').filter({ hasText: new RegExp(WHO.slice(0, 6)) }).first().click().catch(() => {})
    await p.waitForTimeout(700)
    const it = p.locator('.ant-dropdown-menu-item:visible').filter({ hasText: 项 }).first()
    if (await it.count()) { await it.click(); await p.waitForTimeout(1400) }
  })
}

// ══ 汇总 ══
const 坏 = 记录.filter((r) => r.结果 !== 'ok' && !r.结果.startsWith('跳过') && !r.结果.startsWith('未测'))
const 未测 = 记录.filter((r) => r.结果.startsWith('未测'))
/// ★没人认领的失败★:真实发生过,却不属于任何一次点击(多半是**打开某页时**页面自己发的请求)。
/// 上一轮 `403 GET /api/_dev/apis` 就是这么漏掉的 —— 它躺在末尾的 HTTP 清单里,
/// 而摘要行的「异常 2 处」数不到它,于是没人认领。
/// ★「已知且有意」的加载期失败,单独计数、不混进「没人认领」★（2026-08-15）:
///   `403 GET /api/_dev/apis` 是**设计如此** —— 「开发者」页靠这个 403 得知
///   「我有超管资格但超管模式没开」,然后显示那条友好的拦截提示
///   (`apidoc-view.tsx` 的注释:入口留着、点了给提示,2026-08-09 liaoruili 定的)。
///   它每轮都会出现 5 次(console + HTTP 各记一遍 = 10 条)。
/// ⚠★为什么不直接过滤掉不显示★:这一节的用途是「别漏掉真的」,
///   而★噪音会让人学会忽略整节★ —— 和「什么都是警告就等于没有警告」是同一个道理。
///   所以**照样列出来**,只是归到「已知」那一堆里,让「没人认领」那个数字重新变得有意义:
///   它一旦不是 0,就真的值得看一眼。
const 已知无害 = [/403 GET \/api\/_dev\/apis/, /status of 403/]
const 未认领 = [
  ...错误.filter((_, i) => !已认领.has('e' + i)),
  ...网络.filter((_, i) => !已认领.has('n' + i)),
]
const 已知 = 未认领.filter((e) => 已知无害.some((r) => r.test(e)))
const 无主 = 未认领.filter((e) => !已知无害.some((r) => r.test(e)))
writeFileSync(`${DIR}/报告.md`, [
  `# 全面巡检报告 ${VER}`, '',
  `站点 ${BASE}　身份 ${WHO}　共点 ${记录.length} 处，异常 **${坏.length}** 处，`
  + `★没人认领的失败 ${无主.length} 条★，★未测 ${未测.length} 处★，`
  + `截图 ${n} 张（其中 ★${缺图.length} 张没能按 fullPage 拍到★）`, '',
  // ★证据缺了就得说★（2026-08-15）：这一节在，是因为它曾经**不在** ——
  //   截图失败被 `.catch(() => {})` 静默吞掉，报告照常写「ok」并指着一个不存在的文件。
  ...(缺图.length ? ['## ★证据不全的格子★（截图没拍到或只拍到可视区）', '',
    '看报告时注意：这些行的「ok」只代表**点得动、没报错**，', 
    '★但没有全页截图能证明它显示对了★ —— 而「安静地显示错东西」正是只有截图能发现的那一类。', '',
    ...缺图.map((x) => `- ${x}`), ''] : []),
  ...(未测.length ? ['## ★未测清单★（不是通过,是没点到——必须补）', '',
    ...未测.map((r) => `- ${r.页面} #${r.序} ${r.元素}：${r.结果}`), ''] : []),
  ...(坏.length ? ['## ★异常清单★', '', '| 页面 | # | 元素 | 结果 | 截图 |', '|---|---|---|---|---|',
    ...坏.map((r) => `| ${r.页面} | ${r.序} | ${r.元素} | ${r.结果} | ${r.截图} |`), ''] : ['## 异常清单', '（无）', '']),
  '## 全部点击记录', '', '| 页面 | # | 元素 | 结果 | 截图 |', '|---|---|---|---|---|',
  ...记录.map((r) => `| ${r.页面} | ${r.序} | ${r.元素} | ${r.结果} | ${r.截图} |`), '',
  '## ★没人认领的失败★（页面加载时发生,不属于任何一次点击）', '',
  ...(已知.length
    ? ['## 已知且有意的加载期失败（不计入「没人认领」）', '',
       '★列出来但不当问题★:每一条都有明确出处,见 audit-all.mjs 里 `已知无害` 那段注释。', '',
       ...已知.map((e) => '- ' + e), '']
    : []),
  ...(无主.length
    ? ['★这一类最容易被漏掉★:它不在任何一次点击的窗口里,所以摘要行的「异常 N 处」原本数不到它。',
       '「打开某页就报错」正是这个形状 —— 而它对用户的影响比某个按钮点不动更大。', '',
       ...无主.map((e) => '- ' + e)]
    : ['（无）']), '',
  '## console 错误', ...(错误.length ? [...new Set(错误)].map((e) => '- ' + e) : ['（无）']), '',
  '## HTTP >= 400', ...(网络.length ? [...new Set(网络)].map((e) => '- ' + e) : ['（无）']),
].join('\n'))
console.log(`\n══ 共点 ${记录.length} 处，异常 ${坏.length} 处，没人认领的失败 ${无主.length} 条，未测 ${未测.length} 处；`
  + `截图 ${n} 张（缺证据 ${缺图.length}）；console 错误 ${new Set(错误).size} 种，HTTP>=400 ${new Set(网络).size} 种 ══`)
console.log(`报告：${DIR}/报告.md`)
await b.close()
