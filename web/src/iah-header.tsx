// IAH 统一品牌页眉(子系统契约):「◆ IAH 开发平台」小字归属在上、子系统名在下,
// 点击回 hub.ruciah.com。图标 2026-08-02 起换 congrove 自有 logo(用户要求区分于平台紫钻),
// 归属小字保留 —— 页眉结构与契约不变,只换图。
import { CongroveLogo } from './logo'
import { VERSION } from './version'

/// 通道按**运行时域名**判,不能编进构建产物:promote 复用 dev 镜像,
/// 任何写死在代码里的通道标记都会跟着跑到 prod(2026-08-05 用户在 prod 上看到 .dev)。
/// 平台域名约定:dev = `<slug>-dev.sub.ruciah.com`,prod = `<slug>.sub.ruciah.com`。
const IS_DEV = typeof window !== 'undefined' && /(^|\.)[a-z0-9-]+-dev\.sub\./.test(window.location.hostname)

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
        <CongroveLogo />
        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.18 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: '#0d9488', letterSpacing: 0.3 }}>◆ IAH 开发平台</span>
          {/* 名字统一成「Congrove·汇流」(2026-08-04 用户定,与浏览器标签页同一写法);
              中点用居中的 `·`,前后不留空格——原来的「汇流 Congrove」中英之间那个空格显得散。 */}
          <span style={{ fontSize: 18, fontWeight: 800, color: '#111827', letterSpacing: 0.2 }}>
            Congrove<span style={{ margin: '0 1px', color: '#9ca3af' }}>·</span>汇流
            <span style={{ fontSize: 12, fontWeight: 600, color: '#9ca3af', marginLeft: 7 }}>{VERSION}</span>
            {IS_DEV && (
              <span style={{
                fontSize: 11, fontWeight: 700, color: '#b45309', background: '#fef3c7',
                border: '1px solid #fde68a', borderRadius: 4, padding: '0 5px', marginLeft: 6,
              }}>dev</span>
            )}
          </span>
        </span>
      </a>
      <div style={{ marginLeft: 'auto' }}>{extra}</div>
    </div>
  )
}
