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
