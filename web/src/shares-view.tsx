// 「我的分享」——把发出去的公开链接集中在一处(2026-08-05 用户:别散在每个文件的对话框里)。
// 只列**我自己创建的**:别人的分享与我无关,也不该让我看见。
import { App as AntdApp, Card, Empty, Popconfirm, Table, Tag, Typography } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useState } from 'react'
import { ItemIcon } from './preview'
import { api, type Item } from './api'

type Row = {
  token: string; item_id: number; kind: Item['kind']; name: string; mime: string | null; space: string
  expires_at: string | null; max_visits: number | null; visits: number; allow_download: boolean
  created_at: string; revoked_at: string | null; last_visit_at: string | null
  has_code: boolean; item_count: number; item_deleted: boolean
}

function fmt(s: string | null) {
  if (!s) return '—'
  const d = new Date(s); const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/// 状态是**算出来的**,不是存的:过期/次数用尽都会随时间自然发生,存一个字段就得有人去刷新它。
function status(r: Row) {
  if (r.revoked_at) return <Tag color="red">已撤销</Tag>
  // 内容进了回收站,链接就已经打不开了(服务端 live() 会 404)——排在过期之前,因为它更常见也更意外。
  if (r.item_deleted) return <Tag color="orange">内容已删除</Tag>
  if (r.expires_at && new Date(r.expires_at) < new Date()) return <Tag>已过期</Tag>
  if (r.max_visits != null && r.visits >= r.max_visits) return <Tag>次数用尽</Tag>
  return <Tag color="green">有效</Tag>
}

export function SharesView() {
  const { message } = AntdApp.useApp()
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)

  // ★分页换成服务端的★(2026-08-13)。原来这里也有 `pagination={{pageSize:20}}`,看着像做了分页 ——
  //   ★但它翻的是后端 `LIMIT 500` 截下来的那 500 条★:第 501 条起,翻到天荒地老也翻不出来,
  //   而界面上没有任何迹象。这比不分页坏得多:不分页至少人知道自己看到的是全部。
  //   ⚠ 分享是全系统唯一绕过项目授权的出口 —— ★列不出来的分享就是撤不掉的分享★,
  //     这条是安全问题,不是体验问题。
  const [页, set页] = useState(1)
  const [总数, set总数] = useState(0)
  const 每页 = 20
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await api<{ items: Row[]; total: number }>(`/api/shares/mine?page=${页}&size=${每页}`)
      setRows(r.items); set总数(r.total)
    } catch { setRows([]); set总数(0) } finally { setLoading(false) }
  }, [页])
  useEffect(() => { void load() }, [load])
  // 撤销掉当前页最后一条之后别停在空页上(同 TrashDrawer 的理由)
  useEffect(() => { if (!loading && rows.length === 0 && 页 > 1) set页((n) => n - 1) }, [loading, rows.length, 页])

  /// 复制带内容名的文案。⚠ **提取码这里给不出**——库里存的是加盐哈希,只有生成那一刻能看到;
  /// 所以这条文案只带链接,提取码要分享者自己记着(UI 上已说明)。
  const copy = async (r: Row) => {
    const url = `${window.location.origin}/s/${r.token}`
    const what = r.item_count > 1 ? `${r.name} 等 ${r.item_count} 项` : r.name
    const text = `通过汇流分享：${what}\n链接：${url}${r.has_code ? '\n(需要提取码)' : ''}`
    try { await navigator.clipboard.writeText(text); message.success('已复制') }
    catch { message.info(url) }
  }

  return (
    <Card>
      <Typography.Text strong style={{ fontSize: 15 }}>我发出去的分享</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 12px' }}>
        公开链接:拿到的人不需要是项目成员。撤销后立刻失效,已发出去的也打不开。
        提取码只在生成时显示一次(库里存的是哈希),这里复制的文案只带链接。
      </Typography.Paragraph>
      {/* 10 列,窄屏放不下 —— 给横向滚动而不是让它们互相挤扁(v0.3.55)。 */}
      <Table size="small" rowKey="token" dataSource={rows} loading={loading} scroll={{ x: 1150 }}
        pagination={{ current: 页, pageSize: 每页, total: 总数, onChange: set页,
                      size: 'small', showSizeChanger: false, hideOnSinglePage: true,
                      showTotal: (t) => `共 ${t} 条` }}
        locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有发出过分享链接" /> }}
        columns={[
          { title: '内容', dataIndex: 'name', ellipsis: true,
            render: (_, r) => (
              <span><ItemIcon it={r} />{r.name}
                {r.item_count > 1 && <Tag style={{ marginLeft: 6 }}>共 {r.item_count} 项</Tag>}</span>) },
          { title: '项目', dataIndex: 'space', width: 130, ellipsis: true },
          { title: '链接', width: 150, render: (_, r) => (
            <a onClick={() => copy(r)}><CopyOutlined /> /s/{r.token.slice(0, 8)}…</a>) },
          { title: '提取码', width: 74, render: (_, r) => (r.has_code ? <Tag>有</Tag> : <Tag color="orange">无</Tag>) },
          { title: '下载', width: 64, render: (_, r) => (r.allow_download ? '允许' : '禁止') },
          { title: '访问', width: 74, render: (_, r) => `${r.visits}${r.max_visits ? ` / ${r.max_visits}` : ''}` },
          { title: '最近访问', dataIndex: 'last_visit_at', width: 132, render: (v) => fmt(v) },
          { title: '到期', width: 132, render: (_, r) => (r.expires_at ? fmt(r.expires_at) : '永久') },
          { title: '状态', width: 92, render: (_, r) => status(r) },
          { title: '', width: 52, render: (_, r) => (r.revoked_at ? null : (
            <Popconfirm title="撤销这条链接？" description="撤销后立刻失效，已发出去的链接也打不开。"
              onConfirm={async () => {
                try { await api(`/api/shares/${r.token}`, { method: 'DELETE' }); message.success('已撤销'); await load() }
                catch (e) { message.error((e as Error).message) }
              }}>
              <a style={{ color: '#ff4d4f' }}>撤销</a>
            </Popconfirm>)) },
        ]} />
      {/* ⚠★这一句原来写的是 `共 {rows.length} 条`,改成服务端分页之后当场变成谎话★
          (2026-08-14 实拍第 2 页时看见的):`rows` 只剩**本页那 20 条**,
          于是页面右下角写着「共 49 条」、左下角写着「共 20 条」—— ★两个数字自相矛盾★。
          本仓库有条疤原话是「两个数字自相矛盾比两个都错更糟,看的人会以为是自己看错了」。
          分页器里的 showTotal 已经把总数说清楚了,这里再说一遍就是**第二个真相源** ——
          ★同一个数字只该有一处在讲★,所以直接删掉它。 */}
    </Card>
  )
}
