// 个人面板（原型 me 视图）—— 左侧名片 + 设置，右侧「我的投入」与「我主持的项目」。
//
// ★这一页的价值全在「我的投入」★：活动协同最容易变成「开了一堆会，年底说不清干了什么」。
// 它把时间摊开给本人看 —— 所以口径必须**保守**：只算已经开完的会、拒绝的不算。
// 一个虚高的数字比没有数字更糟，因为它会被拿去汇报。
//
// ⚠ 口径**全在后端**（`/api/me/stats` 的 handler 注释里），前端一个数都不自己算：
// 同一个数字两处各算一套，迟早对不上，而对不上的时候没人知道该信哪边。
import { App as AntdApp, Card, Empty, Progress, Segmented, Select, Space, Spin, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { api, type Me, type MyQuota } from './api'
import { fmtSize } from './preview'

/// 时区候选。★不做成全量 IANA 列表★：几百条里挑一个比打字还慢，
/// 而这里的实际需求就是「我在国内 / 我在国外某地」。不够用再加。
const TZS = ['Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'UTC']

type Prefs = { timezone: string | null; default_remind_minutes: number | null }

type Row = { id: number; name: string; archived: boolean; count: number; hours: number; minutes_done: number }
/// 按类型一行（PRD §K 的主视角）。★没有 minutes_done★：纪要是「会议」这一类才有的事，
/// 而这张表里还有个人日程 —— 给它一列「纪要完成 0/3」只会让人以为自己欠了三份纪要。
type TypeRow = { type_id: number; name: string; count: number; hours: number
  hours_by_source: { recording: number; manual: number; scheduled: number } }
type Host = { id: number; name: string; archived: boolean; members: number; minutes_pending: number }
type Stats = {
  range: string
  /// 我是成员的项目数(当下的身份,与时间段无关)
  member_of: number
  totals: {
    activities: number; hours: number; projects: number; minutes_todo: number
    /// ★口径来源★(D5):这个数字会被拿去做季度汇报,来源不透明就会有争议
    hours_by_source: { recording: number; manual: number; scheduled: number }
  }
  by_project: Row[]
  /// ⚠★两个字段都给成可选★:线上前后端是**同一个镜像**、契约不会歪,
  /// 但本地开发时 vite 常常代理到**线上后端**(改前端不必起后端),那一刻它们就是旧的。
  /// ★少一个字段就整页白屏,是把「版本略有出入」放大成「打不开」★ —— 不值得。
  by_type?: TypeRow[]
  totals_by_type?: { activities: number; hours: number }
  hosting: Host[]
}

const RANGES = [
  { value: 'month', label: '本月' },
  { value: 'quarter', label: '本季度' },
  { value: 'year', label: '本年' },
]

/// 四个大数字。★「待写纪要」不为零时标红★ —— 它是这页唯一「欠着事」的指标，
/// 其余三个只是记录，没有好坏之分。
function Stat({ n, label, warn }: { n: number | string; label: string; warn?: boolean }) {
  return (
    <div style={{ flex: 1, textAlign: 'center', padding: '10px 0' }}>
      <div style={{ fontSize: 26, fontWeight: 600, color: warn && Number(n) > 0 ? '#cf1322' : '#0d9488' }}>{n}</div>
      <div style={{ fontSize: 12, color: '#8c8c8c' }}>{label}</div>
    </div>
  )
}

export function MeView({ me, onOpenShares }: { me: Me | null; onOpenShares: () => void }) {
  const { message } = AntdApp.useApp()
  const [quota, setQuota] = useState<MyQuota | null>(null)
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  useEffect(() => {
    api<MyQuota>('/api/me/quota').then(setQuota).catch(() => {})
    api<Prefs>('/api/me/prefs').then(setPrefs).catch(() => {})
  }, [])
  /// ★整对象送★：接口是替换语义（见 me_quota.rs 的注释）——
  /// 只送改动的那半个会把另一半清掉。
  const savePrefs = async (patch: Partial<Prefs>) => {
    const next: Prefs = { timezone: null, default_remind_minutes: null, ...prefs, ...patch }
    setPrefs(next)
    try { await api('/api/me/prefs', { method: 'PUT', body: JSON.stringify(next) }) }
    catch (e) { message.error((e as Error).message) }
  }
  const [range, setRange] = useState('month')
  const [data, setData] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api<Stats>(`/api/me/stats?range=${range}`)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [range])

  const display = me?.name || me?.username || '—'
  const hosting = data?.hosting ?? []

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ width: 280, flexShrink: 0 }}>
        <Card size="small" style={{ textAlign: 'center' }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%', background: '#0d9488', color: '#fff',
            fontSize: 26, lineHeight: '64px', margin: '4px auto 10px',
          }}>{display.slice(0, 1).toUpperCase()}</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{display}</div>
          {/* 没登记姓名的人 display 就是 username,再显示一遍会变成「e2e / e2e」 */}
          {me?.name && me.name !== me.username && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{me.username}</Typography.Text>
          )}
          <div style={{ marginTop: 10 }}>
            <Tag color="gold">主持 {hosting.length} 个项目</Tag>
            {/* ★用 member_of 不用 totals.projects★:后者是「这段时间开会涉及的项目」,
                挂在名片上会被读成「我参与的项目数」,而且会跟着「本月/本季度」变 —— 读起来像我退了几个项目 */}
            <Tag>参与 {data?.member_of ?? 0} 个</Tag>
          </div>
        </Card>

        {/* ★存储配额★（ADR-0004）。M0-6 把额度从项目挪到人之后，项目卡片上那条
            配额进度条被去掉了（一个项目的占用除以**别人的**总额度是误导），
            于是★总额度在界面上一时没了去处★ —— 这里补上，它本来就该在「我」这一页。 */}
        <Card size="small" title="存储配额" style={{ marginTop: 12 }}>
          {quota ? (
            <>
              <Progress
                percent={Math.min(100, Math.round((quota.used_bytes / Math.max(1, quota.quota_bytes)) * 100))}
                size="small" status={quota.used_bytes >= quota.quota_bytes ? 'exception' : 'normal'}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                已用 {fmtSize(quota.used_bytes)} / {fmtSize(quota.quota_bytes)}
              </Typography.Text>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
                算的是<b>你名下所有项目</b>之和；同一份内容放进多个项目只算一次。
                要调额度找超管。
              </Typography.Paragraph>
            </>
          ) : <Spin size="small" />}
        </Card>

        <Card size="small" title="设置" style={{ marginTop: 12 }}>
          <div style={{ lineHeight: 2.2, fontSize: 13 }}>
            <a onClick={onOpenShares}>我的分享</a>
          </div>
          {/* ★时区不设默认★（PRD E0）：没设过就跟浏览器，服务端不猜。 */}
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>时区</Typography.Text>
            <Select size="small" style={{ width: '100%', marginTop: 4 }} allowClear
              placeholder={`跟随浏览器（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`}
              value={prefs?.timezone ?? undefined}
              onChange={(v) => savePrefs({ timezone: v ?? null })}
              options={TZS.map((z) => ({ value: z, label: z }))} />
          </div>
          <div style={{ marginTop: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>默认提前提醒</Typography.Text>
            <Select size="small" style={{ width: '100%', marginTop: 4 }} allowClear
              placeholder="不提醒"
              value={prefs?.default_remind_minutes ?? undefined}
              onChange={(v) => savePrefs({ default_remind_minutes: v ?? null })}
              options={[5, 10, 15, 30, 60].map((n) => ({ value: n, label: `提前 ${n} 分钟` }))} />
            {/* ⚠★这句原来是「提醒的**投递**属 M2，这里先把偏好存下来」★(2026-08-12 改)。
                两个毛病:①`**投递**` 是 markdown 源码,这里不渲染 markdown,用户看到的就是一串星号;
                ②「M2」是我们的里程碑代号,用户不知道那是什么、更不知道什么时候到。
                ★对外文案不许出现内部代号和内部标注符号(★ ⚠ **)★ —— 同批还改了
                「★超管模式生效中★」「★凌晨这一段有活动被折叠了★」两处。
                现在投递已经实现(src/remind.rs),文案要说的是**默认值**:不选=按默认 15 分钟,
                清空=这个人不收提醒。这一条必须写出来,否则「没设过偏好的人突然开始收提醒」
                是一次无声的行为变更。 */}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              不选就按默认提前 15 分钟提醒；清空则不提醒。单场活动可以另外单独设。
            </Typography.Text>
          </div>
        </Card>
      </div>

      <div style={{ flex: 1, minWidth: 420 }}>
        <Card size="small">
          {/* 标题与时间段切换同一行(原型如此):切换的是标题里那个词的口径,分开放会读成两件事 */}
          <Space style={{ marginBottom: 8 }} align="center">
            <span style={{ fontWeight: 600, fontSize: 15 }}>我的投入</span>
            <Segmented size="small" value={range} onChange={(v) => setRange(v as string)} options={RANGES} />
          </Space>
          {loading ? <div style={{ textAlign: 'center', padding: 30 }}><Spin /></div> : !data ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="统计取不到" />
          ) : (
            <>
              <div style={{ display: 'flex', background: '#fafafa', borderRadius: 6 }}>
                <Stat n={data.totals.activities} label="参会次数" />
                <Stat n={data.totals.hours} label="小时" />
                <Stat n={data.totals.projects} label="涉及项目" />
                <Stat n={data.totals.minutes_todo} label="待写纪要" warn />
              </div>
              {/* ★按类型是**主**视角，排在按项目之前★（PRD §K：「按项目分组回答『我为哪个团队
                  花了时间』，按类型分组回答『我在做什么』，★后者才是个人视角的主问题★」）。 */}
              <Table
                size="small" style={{ marginTop: 12 }} rowKey="type_id" pagination={false}
                dataSource={data.by_type ?? []}
                locale={{ emptyText: '这段时间没有已结束的活动' }}
                title={() => <b style={{ fontSize: 13 }}>按类型 · 我在做什么</b>}
                columns={[
                  { title: '活动类型', dataIndex: 'name' },
                  { title: '次数', dataIndex: 'count', width: 80 },
                  { title: '时长', dataIndex: 'hours', width: 90, render: (v: number) => `${v} h` },
                ]}
                summary={() => (
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0}><b>合计</b></Table.Summary.Cell>
                    <Table.Summary.Cell index={1}><b>{data.totals_by_type?.activities ?? 0}</b></Table.Summary.Cell>
                    <Table.Summary.Cell index={2}><b>{data.totals_by_type?.hours ?? 0} h</b></Table.Summary.Cell>
                  </Table.Summary.Row>
                )}
              />
              {/* ⚠★两张表的口径不同，必须各自写明★（liaoruili 2026-08-12 拍板「个人日程算进按类型」）。
                  本仓有条疤：「★两个数字自相矛盾比两个都错更糟★，看的人会以为是自己看错了」——
                  所以不是让人自己去发现「这两个合计怎么不等」，而是当场告诉他为什么。 */}
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                含<b>不关联项目</b>的个人日程（读文献、写作这类）——所以合计通常大于下面那张表。
              </Typography.Text>

              <Table
                size="small" style={{ marginTop: 20 }} rowKey="id" pagination={false}
                title={() => <b style={{ fontSize: 13 }}>按项目 · 我为哪个团队花了时间</b>}
                dataSource={data.by_project}
                locale={{ emptyText: '这段时间没有开完的会' }}
                columns={[
                  {
                    title: '项目', dataIndex: 'name',
                    render: (v: string, r: Row) => <>
                      {v}
                      {r.archived && <Tag style={{ marginLeft: 4 }}>已归档</Tag>}
                    </>,
                  },
                  { title: '次数', dataIndex: 'count', width: 80 },
                  { title: '时长', dataIndex: 'hours', width: 90, render: (v: number) => `${v} h` },
                  {
                    title: '纪要完成', width: 110,
                    render: (_: unknown, r: Row) => `${r.minutes_done} / ${r.count}`,
                  },
                ]}
              />
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                只算<b>关联了项目</b>的协作活动；一场活动关联多个项目会在各项目下各计一次。
              </Typography.Text>

              {/* ★时长口径来源★(D5 原话:「这个数字会被用来做汇报,来源不透明就会有争议;
                  标出来源,争议时可追溯」)。三级回退:录制 > 手工补录 > 按排程估算 —— 
                  ★「按排程估算」的那部分最不可信★(排 2 小时、20 分钟散会是常事),
                  单独标出来,看的人自己判断要不要认。 */}
              {data.totals.hours > 0 && (
                <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '6px 0 0' }}>
                  时长来源：
                  {data.totals.hours_by_source.recording > 0 && `${data.totals.hours_by_source.recording} h 来自录制　`}
                  {data.totals.hours_by_source.manual > 0 && `${data.totals.hours_by_source.manual} h 手工补录　`}
                  {data.totals.hours_by_source.scheduled > 0 && (
                    <Typography.Text type="warning" style={{ fontSize: 12 }}>
                      {data.totals.hours_by_source.scheduled} h 按排程估算
                    </Typography.Text>
                  )}
                </Typography.Paragraph>
              )}
              {/* ★把「分项目之和 ≥ 总数」讲明白★:一场会可以同时关联多个项目,
                  不说的话看表的人会以为哪边算错了。 */}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                一场活动可关联多个项目，因此分项目的次数之和可能大于总次数。
              </Typography.Text>
            </>
          )}
        </Card>

        <Card size="small" title="我主持的项目" style={{ marginTop: 12 }}>
          <Table
            size="small" rowKey="id" pagination={false} dataSource={hosting}
            locale={{ emptyText: '还没有你主持的项目' }}
            showHeader={false}
            columns={[
              {
                dataIndex: 'name',
                render: (v: string, r: Host) => <>
                  <b>{v}</b>
                  {r.archived && <Tag style={{ marginLeft: 4 }}>已归档</Tag>}
                </>,
              },
              { dataIndex: 'members', width: 100, render: (v: number) => <Typography.Text type="secondary">{v} 名成员</Typography.Text> },
              {
                dataIndex: 'minutes_pending', width: 130,
                // 这是给主持人看的欠账:不论记录员是谁,项目里有开完没写完的会就该显示
                render: (v: number) => v > 0 ? <Tag color="orange">{v} 份纪要待整理</Tag> : null,
              },
            ]}
          />
        </Card>
      </div>
    </div>
  )
}
