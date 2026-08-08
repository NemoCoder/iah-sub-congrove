// 个人面板（原型 me 视图）—— 左侧名片 + 设置，右侧「我的投入」与「我主持的项目」。
//
// ★这一页的价值全在「我的投入」★：会议协同最容易变成「开了一堆会，年底说不清干了什么」。
// 它把时间摊开给本人看 —— 所以口径必须**保守**：只算已经开完的会、拒绝的不算。
// 一个虚高的数字比没有数字更糟，因为它会被拿去汇报。
//
// ⚠ 口径**全在后端**（`/api/me/stats` 的 handler 注释里），前端一个数都不自己算：
// 同一个数字两处各算一套，迟早对不上，而对不上的时候没人知道该信哪边。
import { Card, Empty, Segmented, Space, Spin, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { api, type Me } from './api'

type Row = { id: number; name: string; archived: boolean; count: number; hours: number; minutes_done: number }
type Host = { id: number; name: string; archived: boolean; members: number; minutes_pending: number }
type Stats = {
  range: string
  /// 我是成员的项目数(当下的身份,与时间段无关)
  member_of: number
  totals: {
    meetings: number; hours: number; projects: number; minutes_todo: number
    /// ★口径来源★(D5):这个数字会被拿去做季度汇报,来源不透明就会有争议
    hours_by_source: { recording: number; manual: number; scheduled: number }
  }
  by_project: Row[]
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

        <Card size="small" title="设置" style={{ marginTop: 12 }}>
          {/* ★只放已经做出来的入口★:原型里的「会前提醒时间」「通知偏好」属于 M2,
              先摆一个不通的链接比不摆更糟 —— 用户点了没反应会以为是坏了。 */}
          <div style={{ lineHeight: 2.2, fontSize: 13 }}>
            <a onClick={onOpenShares}>我的分享</a>
            <div style={{ color: '#bfbfbf' }}>会前提醒 / 通知偏好（M2）</div>
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
                <Stat n={data.totals.meetings} label="参会次数" />
                <Stat n={data.totals.hours} label="小时" />
                <Stat n={data.totals.projects} label="涉及项目" />
                <Stat n={data.totals.minutes_todo} label="待写纪要" warn />
              </div>
              <Table
                size="small" style={{ marginTop: 12 }} rowKey="id" pagination={false}
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
                一场会可关联多个项目，因此分项目的次数之和可能大于总次数。
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
