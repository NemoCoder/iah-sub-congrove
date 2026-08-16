// 版本纪律:每完成一个功能升版本(与后端 Cargo.toml 同步两处)。
// ★不带 .dev 后缀★(2026-08-05 修正):promote 是**复用 dev 镜像**上 prod 的,
// 编进字符串的 .dev 会原样跟到 prod 去(用户在 congrove.sub.ruciah.com 上看到 v0.3.42.dev)。
// 通道靠**运行时域名**判,见 iah-header.tsx 的 CHANNEL。
export const VERSION = 'v0.5.6'
