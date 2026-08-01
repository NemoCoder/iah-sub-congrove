// IAH 统一品牌页眉(子系统契约):◆IAH 在上、子系统名在下,点击回 hub.ruciah.com。
// 样式复刻自 _template 占位页(原 app/main.py),别删别改结构。
import { VERSION } from './version'

const MARK = (
  <svg viewBox="0 0 64 64" width="34" height="34" style={{ flex: '0 0 auto' }}>
    <defs>
      <linearGradient id="iahg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#6366f1" />
        <stop offset="1" stopColor="#7c3aed" />
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="15" fill="url(#iahg)" />
    <path d="M32 16.5 L47.5 32 L32 47.5 L16.5 32 Z" fill="#ffffff" />
    <path d="M32 25 L39 32 L32 39 L25 32 Z" fill="#7c3aed" />
  </svg>
)

export function IahHeader({ extra }: { extra?: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '12px 22px',
        background: '#fff',
        borderBottom: '1px solid #ececf1',
      }}
    >
      <a
        href="https://hub.ruciah.com/"
        title="返回 IAH 开发平台"
        style={{ display: 'flex', alignItems: 'center', gap: 11, textDecoration: 'none' }}
      >
        {MARK}
        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.18 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#6366f1', letterSpacing: 0.3 }}>◆ IAH 开发平台</span>
          <span style={{ fontSize: 18, fontWeight: 800, color: '#111827' }}>
            汇流 Congrove <span style={{ fontSize: 12, fontWeight: 600, color: '#9ca3af', marginLeft: 7 }}>{VERSION}</span>
          </span>
        </span>
      </a>
      <div style={{ marginLeft: 'auto' }}>{extra}</div>
    </div>
  )
}
