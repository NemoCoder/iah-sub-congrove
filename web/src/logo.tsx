// congrove 自有 logo(2026-08-02 应用户要求,与平台紫钻区分):
// 词源 con-(汇聚)+ grove(树丛),中文名「汇流」——意象 = 三股溪流自下汇聚成干,
// 上方长成一片三冠树丛:内容从四面八方汇进来,长成团队共同的知识林。
// 色系:青(溪流)→ 绿(树丛)渐变,圆角方底与平台家族观感一致但一眼可辨。
// ⚠ favicon 是同一 SVG 的 data URI 内联在 web/index.html,改这里要**两处同步**。

export function CongroveLogo({ size = 34 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} style={{ flex: '0 0 auto' }}>
      <defs>
        <linearGradient id="cgg" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#0d9488" />
          <stop offset="1" stopColor="#16a34a" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#cgg)" />
      {/* 三股溪流汇入主干 */}
      <path
        d="M12 54 C 22 52 27 46 30 39 M52 54 C 42 52 37 46 34 39 M32 55 L32 34"
        fill="none"
        stroke="#ffffff"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      {/* 树丛冠:三圆相叠 */}
      <circle cx="21" cy="23" r="8.5" fill="#ffffff" />
      <circle cx="43" cy="23" r="8.5" fill="#ffffff" />
      <circle cx="32" cy="15.5" r="9.5" fill="#ffffff" />
      <circle cx="32" cy="21" r="4.5" fill="#15803d" />
    </svg>
  )
}
