/// 「我的活动类型」管理页（ADR-0002 / 原型 `4-我的活动类型`）。
///
/// ★这一页的形状直接照原型★：一张表，每行是「类型 / 占忙闲 / 能力 / 操作」，
/// 底部一行内联新建。★不做弹窗★ —— 原型就是内联的，弹窗会让人为了建一个类型离开当前上下文。
import { App as AntdApp, Button, Card, Checkbox, Input, Space, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, type ActivityType } from './api'

/// 这一行能改到什么程度。★与后端 `activity_types.rs::scope_of` 必须一致★ ——
/// 前端只管显隐，真判权在后端（前端隐藏按钮不是安全边界）。
///
/// ⚠★2026-08-15:第三档 `'busy'`(预置的简单型可以勾占忙闲)已删★。
///   原型上「个人日程」那一行画的是可勾的复选框,我照着做了 —— 而 `owner === null` 的那一行
///   是**全系统共用的一行**:甲勾一下,乙丙丁的个人日程一起跟着变,谁的界面上都不会提示。
///   ★界面上长得像个人设置、数据上是共享状态★,这是这类 bug 的通用形状。
///   想要「不占忙闲的个人分类」就自建一个(自建行 owner = 我,天然只归我)。
function scopeOf(t: ActivityType, me: string): 'full' | 'none' {
  return t.owner === me ? 'full' : 'none'
}

/// ⚠★内部决策编号(L1/L2)别印在界面上★(2026-08-15 巡检截图看出来的):
///   页脚那两句原来带着「（L1，软删除）」「（L2）」—— 那是 PRD 里的条目号,
///   对用户什么都不是,只会让人以为自己漏读了某份文档。理由该留在代码注释里(就是这儿)。
export default function ActivityTypesView({ me }: { me: string }) {
  const { message } = AntdApp.useApp()
  const [rows, setRows] = useState<ActivityType[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    api<ActivityType[]>('/api/activity-types').then(setRows).catch((e) => message.error((e as Error).message))
  }, [message])
  useEffect(load, [load])

  const patch = async (t: ActivityType, body: Record<string, unknown>) => {
    try {
      // ⚠ 后端的 name 是 COALESCE 更新：不传就保留。改忙闲时**不要**把名字一起送上去，
      //   否则预置行会因为「你在改名」被拒。
      await api(`/api/activity-types/${t.id}`, { method: 'PUT', body: JSON.stringify(body) })
      load()
    } catch (e) { message.error((e as Error).message) }
  }

  return (
    <Card title="我的活动类型" style={{ maxWidth: 920 }}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        自建类型 = <b>一个名字 + 一个开关</b>。★「占忙闲」是唯一的开关★ ——
        它是<b>唯一真正影响别人</b>的属性：决定别人约你时看不看得到你这段时间是忙的。
        参与人与材料对所有类型统一开放，不由类型决定。<br />
        带「系统」标的是<b>全系统共用</b>的预置类型，<b>任何人都改不了</b>（改一下就是替所有人做决定）；
        想要一个不一样的，<b>自己建一个</b> —— 自建的只归你，别人看不到。
      </Typography.Paragraph>
      <Table<ActivityType>
        rowKey="id" size="small" pagination={false} dataSource={rows}
        columns={[
          {
            title: '类型', dataIndex: 'name',
            render: (v: string, t) => (
              <Space>
                <b>{v}</b>
                {t.owner === null && <Tag>系统</Tag>}
              </Space>
            ),
          },
          {
            title: '占忙闲', width: 110,
            render: (_, t) => {
              // 预置行显示**它当前的取值 + 固定**,而不是一个点不动的复选框 ——
              // 灰着的控件会让人一直想去点它,还以为是自己没权限。
              // ⚠ 别写死「✅ 固定」:预置的「个人日程」本来就是**不占**,
              //   写死一个 ✅ 等于告诉人「它占忙闲」—— 安静地显示错东西。
              if (scopeOf(t, me) !== 'full') {
                return <span>{t.busy_default ? '✅ 占' : '— 不占'} · 固定</span>
              }
              return (
                <Checkbox
                  checked={t.busy_default}
                  onChange={(e) => patch(t, { busy_default: e.target.checked })}
                >{t.busy_default ? '占' : '不占'}</Checkbox>
              )
            },
          },
          {
            title: '能力', width: 230,
            // ★「只能排未来」也是一个能力位★(F0/F1,2026-08-09):它决定这类活动能不能补录,
            // 用户在这一页就该看得出来「为什么建会议时日期选不到昨天」——
            // 不标的话那个限制在界面上是没有出处的。
            render: (_, t) => (t.has_minutes || t.needs_project || !t.allow_past
              ? <Space size={4}>
                  {t.has_minutes && <Tag color="blue">纪要</Tag>}
                  {t.needs_project && <Tag color="blue">须关联项目</Tag>}
                  {!t.allow_past && <Tag color="orange">只能排未来</Tag>}
                </Space>
              : <span style={{ color: '#999' }}>简单型 · 可补录</span>),
          },
          {
            title: '', align: 'right' as const,
            render: (_, t) => {
              // ★两行原来各写了一半的限制★(2026-08-15 逐张看巡检截图看出来的):
              //   会议写「不可改」、个人日程写「不可删」—— 摆在一张表里看着像对照,
              //   于是人会推出「会议大概能删」「个人日程大概能改名」,**两个推断都是错的**:
              //   这两条分支都是「返回一段文字、根本不渲染改名/删除按钮」,
              //   所以系统预置的类型**既不能改名也不能删**,区别只在个人日程还能调占忙闲 ——
              //   而那件事已经由左边那个**能点的复选框**表达了,不该再挤进这一列。
              //   ★半句真话比不说更坏★:它看起来是在告诉你规则,实际给的是错的规则。
              //   合成一条:`scopeOf` 里 owner===null 只会得到 'none' 或 'busy',
              //   所以「预置行」这个判据本来就是 `t.owner === null` 一句话,拆成两条只会让人以为它们不一样。
              if (t.owner === null) return <span style={{ color: '#999' }}>系统预置 · 不可改名/删除</span>
              return (
                <Space size={4}>
                  <Button type="link" size="small" onClick={() => {
                    const n = prompt('新名字', t.name)?.trim()
                    if (n && n !== t.name) patch(t, { name: n })
                  }}>改名</Button>
                  <Button type="link" size="small" danger onClick={async () => {
                    try {
                      await api(`/api/activity-types/${t.id}`, { method: 'DELETE' }); load()
                    } catch (e) { message.error((e as Error).message) }
                  }}>删除</Button>
                </Space>
              )
            },
          },
        ]}
      />
      <Space style={{ marginTop: 12 }}>
        <Input placeholder="新类型的名字，如「写作」" value={name} maxLength={12}
               onChange={(e) => setName(e.target.value)} style={{ width: 260 }} />
        <Checkbox checked={busy} onChange={(e) => setBusy(e.target.checked)}>占忙闲</Checkbox>
        <Button type="primary" loading={saving} disabled={!name.trim()} onClick={async () => {
          setSaving(true)
          try {
            await api('/api/activity-types', {
              method: 'POST', body: JSON.stringify({ name: name.trim(), busy_default: busy }),
            })
            setName(''); load()
          } catch (e) { message.error((e as Error).message) } finally { setSaving(false) }
        }}>新建</Button>
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        ★删除一个类型★：用过它的历史活动<b>照常显示这个类型名</b>（统计不断档），
        只是新建时不再出现在下拉里（软删除）。<br />
        ★没有「改类型」这个功能★ —— 改类型相当于删除重建，与其提供一个会悄悄吃掉
        参与人和纪要的按钮，不如诚实地不给。
      </Typography.Paragraph>
    </Card>
  )
}
