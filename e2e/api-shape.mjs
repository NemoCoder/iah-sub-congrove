#!/usr/bin/env node
// ★把响应指纹归约成「形状」★（2026-08-14）——键名 + 类型 + 是不是数组,数值一律丢掉。
//
// ══ 它补的是哪个洞 ══
// 2026-08-13 我把 `/api/projects/{id}/trash` 和 `/api/shares/mine` 的响应体
// 从 `[...]` 改成 `{total, items}` —— ★这是破坏性变更,而八道门禁一道都没红★。
// 查下来:生成的 OpenAPI 契约里响应只写了 `{"description":"成功"}`、**没有 schema**,
// 所以接口面那道闸(oasdiff)对「数组变对象」结构性失明,它只守路径/参数/鉴权档位。
//
// ══ 为什么不去手写 OpenAPI 的 response schema ══
// 那是**关于代码的断言写进文档** —— 本仓 `docs/adr/README.md` 的「不写什么」一节
// 就是为这件事写的:文档里的断言没人验,它会随代码前进自动过期,
// 而过期的文档比没有文档更坏(评审会拿它当真)。
// ★这里改成从**真实响应**里长出来★:它不可能和现实不符,不符就是红。
//
// ══ 为什么归约成形状,而不是直接拿 golden 指纹当基线 ══
// 试过了,不行:`shares.mine` 会**永远累积** —— 撤销的、内容已删的分享仍然列出,
// 没有 purge —— 于是同一份代码连跑两次,指纹就差 32 行(实测)。
// ★那样的闸子天生 flaky,装上等于教所有人忽略它。★
// 而形状不受残留影响:实测同一份代码两次跑,归约后的形状**逐字节相同**。
//
// ⚠★数组要取所有元素形状的并集★:只看第 0 个元素的话,
//   「有的元素多一个字段」这种差异会漏 —— 而那正是加/删字段最常见的样子。
//
// 用法:
//   node e2e/golden.mjs | node e2e/api-shape.mjs        # 从 stdin
//   node e2e/api-shape.mjs <指纹.json>                   # 从文件
import { readFileSync } from 'node:fs'

const 形 = (v) => {
  if (Array.isArray(v)) {
    // ★空数组要标出来,别归约成 `[{}]`★（2026-08-14 被自己的门禁抓到):
    //   `[{}]` 看起来像「一个没有字段的对象」,于是**冻基线那一刻恰好没数据**这件事,
    //   被冻成了「这个数组里的东西就是空的」。等有数据了,门禁当场报 9 行「形状变动」——
    //   ★而产品一个字段都没改,是基线在数据稀薄时被冻歪了。★
    //   标成 `[]`(空数组)之后:空→有数据仍然会红(该红,形状确实第一次被记全),
    //   但报告里能一眼看出「上一次是空的」,不必像这次一样逐行数才敢下结论。
    // ★空数组标成「本次没数据」,而不是一种形状★（2026-08-14 连栽两次,方向还相反）:
    //   第一次:冻基线那刻 `by_project` 恰好是空的 → 记成 `[{}]` → 有数据后报 9 行「形状变动」;
    //   第二次:改标 `[]` 之后重冻(那次有数据) → 下一轮 teardown 刚清完又变空 → 报 11 行,**方向反过来**。
    //   ★两次都不是形状变了,是这一格**天生随数据抖**★ —— 而一个会抖的基线就是 flaky 门禁,
    //   装着比没装更坏:人会学会忽略它,连带忽略真正的形状变化。
    //   所以空数组一律记成同一个哨兵,**不参与形状比对**:
    //   代价是「空的时候看不出元素形状」—— 那本来也无从看起(没有元素);
    //   收益是这一格只在**真的加/删字段**时才红。
    if (v.length === 0) return '<空数组:本次没数据>'
    // 并集:元素是对象就合并键;元素是标量就记 `[类型]`
    const 并 = {}
    for (const x of v) {
      const s = 形(x)
      if (s && typeof s === 'object' && !Array.isArray(s)) Object.assign(并, s)
      else return [s]
    }
    return [并]
  }
  if (v === null) return 'null'
  if (typeof v === 'object') {
    const o = {}
    // ★键排序★:对象键顺序在 JSON 里不稳定,不排就会造出假差异
    for (const k of Object.keys(v).sort()) o[k] = 形(v[k])
    return o
  }
  return typeof v
}

const 读 = () => (process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8'))
const d = JSON.parse(读())
const out = {}
for (const k of Object.keys(d).sort()) out[k] = 形(d[k])
console.log(JSON.stringify(out, null, 1))
