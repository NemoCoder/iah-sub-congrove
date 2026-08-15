// `pw-endpoint.mjs` 的类型声明 —— ★实现只有一份(那个 .mjs)★:
// playwright.config.ts 是 TS、其余脚本是 .mjs,两边共用同一个实现,这里只补类型。
export function pwWs(): string
export function pwSsh(): string | null
