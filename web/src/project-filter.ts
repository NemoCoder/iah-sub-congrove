// 项目左栏的筛选取值 —— 抽成纯函数是为了能单测。
//
// ★这里出过一个「界面卡死」的 bug★(2026-08-07):切换控件只在「有归档项目」时渲染,
// 而筛选值是独立的 state。恢复掉最后一个归档项目后 → 控件消失、state 还停在 'archived'
// → 列表永远筛不出东西,**且用户连切回去的按钮都没有了**。
//
// 修法不是「在恢复动作里记得 setScope('active')」——那是同步两份状态,迟早再漏一处;
// 而是让**可见性与取值来自同一个事实**:没有归档项目就一定是 'active'。
export type Scope = 'active' | 'archived'

/// 控件该不该显示。一个都没有时不显示 —— 多一个永远指向空列表的开关只是噪音。
export const showScopeSwitch = (archivedCount: number) => archivedCount > 0

/// 实际生效的筛选值。★与 showScopeSwitch 同源★:控件不显示时,取值必然回落 'active'。
export const effectiveScope = (scope: Scope, archivedCount: number): Scope =>
  archivedCount === 0 ? 'active' : scope

/// 项目页右侧那组 tab 实际生效的 key。
///
/// ★2026-08-09 liaoruili 撞到:停在别的项目的「成员/活动/设置」tab,切到「我的活动材料」
/// → 右边整个空白★。因为材料区只有「文档」一个 tab(其余三个对它是空话),
/// 而 `activeKey` 还停在一个**已经不存在的 key** 上 —— AntD 的 Tabs 于是什么都不渲染,
/// 只剩一条悬空的下划线。
///
/// ★这和 effectiveScope 是同一个 bug★(控件没了、选中值还指着它),所以修法也一样:
/// **不同步两份状态,而是派生** —— 可选项没了,取值自动回落到第一个。
/// 「切项目时记得 setPtab('items')」那种写法解决不了下一处,因为它要求每个新入口都记得。
export const effectiveTab = (tab: string, keys: string[]): string =>
  keys.includes(tab) ? tab : (keys[0] ?? tab)

/// 左栏最终显示哪些行 —— 材料区置顶 + 项目按 scope/搜索筛。
///
/// ★材料区不参与搜索,但**要参与「进行中 / 已归档」**★
/// （2026-08-13 liaoruili 截图:「已归档里面为啥有我的活动材料」）。
///
/// ⚠ 我原来把这两件事当成同一条规则,写成「永远置顶、永远显示」。
///   置顶那一半是对的(2026-08-09 liaoruili 明确要的),★但「永远显示」不该覆盖到「已归档」这一档★:
///   - 搜索是**在同一份列表里找**,材料区被关键词筛掉一次,人就会以为它没了 → 该豁免;
///   - 「已归档」不是筛选,是**换了一份列表**:那一格里的每一行都在宣称「我是归档的」。
///     把一个永不归档的系统格子摆进去,它就被这份列表的语义标成了归档 ——
///     ★破绽是计数与行数对不上:标签写「已归档 1」,底下却列出两行。★
///     (计数早就只数真项目了,漏的是显示这一侧。)
///
/// 所以判据分开:搜索豁免它,scope 不豁免它。
export function shownProjects<T extends { name: string; archived_at?: string | null }>(
  all: T[], isMat: (p: T) => boolean, scope: Scope, kw: string,
): T[] {
  const 词 = kw.trim().toLowerCase()
  return [
    // 归档档里不摆材料区 —— 它永远不是归档的
    ...(scope === 'archived' ? [] : all.filter(isMat)),
    ...all
      .filter((p) => !isMat(p))
      .filter((p) => (scope === 'archived' ? !!p.archived_at : !p.archived_at))
      .filter((p) => !词 || p.name.toLowerCase().includes(词)),
  ]
}
