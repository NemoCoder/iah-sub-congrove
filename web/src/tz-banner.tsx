// 「你的设备时区和设置不一样」提示条（PRD E0 的缓解措施）。
//
// ══════ 它为什么存在 ══════
// E0 定的是「时区**手动设**，不做浏览器自动探测」。这个决定有一个自己写明的代价：
// ★没设过的海外用户会看到全错的时间，而他未必意识到要去设置里改。★
// 这条提示就是那个代价的缓解 —— 它不违背「手动设」（不会替用户改任何东西），
// 只是让他知道有这回事，而不是默默看错时间。
//
// ══════ 三条判据 ══════
//  · **只在设过的人身上出现**：没设过的人 `myTz()` 就是浏览器时区，两者永远一致，
//    不该被打扰。⚠ 这也意味着 E0 那个代价对**从没进过设置页**的人依然存在 ——
//    提示条救的是「设过一次、后来人换了地方」的情形。
//  · **可关闭**，关掉的状态存 localStorage。
//  · ★按「设备时区 + 设置时区」这**对组合**记，不是永久关闭★（liaoruili 2026-08-12 拍板）。
//    出差换个地方再打开，应该重新提示一次 —— 那正是这条提示**最该出现**的时刻，
//    而「永久关闭」恰好在那时闭嘴。
import { Alert } from 'antd'
import { useState } from 'react'
import { browserTz, hasExplicitTz, myTz, tzLabel } from './tz'

/// ★键里带着这对组合★：换了任一边就是一个新键，于是重新提示。
const key = (dev: string, set: string) => `congrove.tzbanner.${dev}|${set}`

export function TzBanner({ onGoSettings }: { onGoSettings: () => void }) {
  const dev = browserTz(), set = myTz()
  const k = key(dev, set)
  const [closed, setClosed] = useState(() => {
    try { return localStorage.getItem(k) === '1' } catch { return false }
  })
  // 没显式设过时区的人不打扰；一致的人也不打扰
  if (!hasExplicitTz() || dev === set || closed) return null
  return (
    <Alert
      type="warning" showIcon closable style={{ marginBottom: 12 }}
      onClose={() => {
        // ⚠ localStorage 在隐私模式 / 禁用存储时会抛 —— 关不掉总比整页崩了强
        try { localStorage.setItem(k, '1') } catch { /* 关一次算一次，下次再提示 */ }
        setClosed(true)
      }}
      message={
        <span style={{ fontSize: 13 }}>
          你的设备时区是 <b>{tzLabel(dev)}</b>（{dev}），当前按 <b>{tzLabel(set)}</b>（{set}）显示时间。
          {' '}<a onClick={onGoSettings}>去设置切换</a>
        </span>
      }
    />
  )
}
