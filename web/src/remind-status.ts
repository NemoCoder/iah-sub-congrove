/// 「这场活动的提醒到底投出去没有」——★判据抽成纯函数,因为它极容易写成一个会撒谎的数字★。
///
/// ══ 为什么要有这个东西 ══
/// 2026-08-16:prod 上出过「没收到提醒」,而★界面上完全看不出提醒过没有★,
/// 只能进库查 `activity_participants.reminded_at`。可这两种情况的处置完全不同:
///   · **没投** → 是我们这边的问题(扫描没跑到 / 判据把它排除了);
///   · **投了没收到** → 是站内信那一段的问题(registry 不可达、被去重吞掉)。
/// 没有这一行,这两种情况在界面上长得一模一样。
///
/// ══ ★最容易写错的是分母★ ══
/// 直觉写法是「已提醒数 / 参会人数」。但 `remind.rs` 的 WHERE 里明写着
/// `p.status <> 'declined'` —— **拒绝了的人本来就不发**。
/// 分母算上他们,这行就会永远停在「3 / 4」,看着像漏了一个人,★而系统完全正确★。
/// ⇒ 判据必须和 `remind.rs` 那几条 WHERE **同源**,否则这行本身就是误导。
///
/// ⚠ 同源的还有一条:旁听者不收提醒(`p.kind <> 'observer'`)——
///   调用方传进来的名单已经滤过旁听,所以这里不再滤一次(滤两次不会错,
///   但会让「哪一层负责哪条判据」变糊)。

export type 提醒态 =
  /// 没有人该收提醒(全员拒绝 / 名单为空)—— ★这时候什么都别显示★:
  /// 「0 人已提醒」读起来像坏了,而事实是「没有可提醒的对象」。
  | { kind: 'none' }
  /// 一个都还没投
  | { kind: 'pending'; total: number }
  /// 全投完了
  | { kind: 'done'; total: number; at: string }
  /// ★投了一半★:一跳最多 200 条,剩下的下一跳补 —— 这个中间态是**正常**的,
  /// 但把它显示成「已发」就是在谎报。
  | { kind: 'partial'; sent: number; total: number; at: string }

export function 算提醒态(
  参会人: { status: string; kind?: string; reminded_at: string | null }[],
): 提醒态 {
  const 该收 = 参会人.filter((p) => p.status !== 'declined')
  if (该收.length === 0) return { kind: 'none' }
  const 已发 = 该收.filter((p) => p.reminded_at)
  if (已发.length === 0) return { kind: 'pending', total: 该收.length }
  // 同一跳投出去的时刻几乎一样;取**最早**那条当「什么时候提醒的」——
  // 取最晚的话,分批补投时这个时间会一路往后跳,读的人会以为提醒发了很多次。
  const at = 已发.map((p) => p.reminded_at!).sort()[0]
  return 已发.length === 该收.length
    ? { kind: 'done', total: 该收.length, at }
    : { kind: 'partial', sent: 已发.length, total: 该收.length, at }
}
