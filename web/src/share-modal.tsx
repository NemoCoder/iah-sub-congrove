// 分享对话框 —— ★项目页与活动详情页共用★（D7：材料有两个入口，分享自然也有两个）。
//
// 原本长在 projects-view 里，活动详情页的材料行因此没有分享按钮：同一份材料，
// 从项目进能分享、从活动进不能，纯粹是代码住哪儿决定的，不是产品决定的。
//
// ★这是全系统唯一绕过项目授权的入口★（见 src/http/share.rs 头注），所以对话框顶上那条
// 警告不能删：提取码 / 有效期 / 访问次数是仅有的三道闸，发出去之后唯一的后悔药是撤销。
import { Alert, App as AntdApp, Button, Input, Modal, Select, Space as AntSpace, Switch, Typography } from 'antd'
import { useState } from 'react'
import { api, type Item } from './api'

/// ★只要这四个字段★:项目页传的是 Item、活动页传的是 ActivityItem,两者形状不同但
/// 分享用得着的就这些。收窄到这里,两边都不用为了满足类型去 as 强转。
export type ShareTarget = Pick<Item, 'id' | 'name' | 'kind' | 'mime'>
import { ItemIcon } from './preview'

export function ShareModal({ items, onClose }: { items: ShareTarget[]; onClose: () => void }) {
  const item = items[0]  // 主项:标题与「已有链接」列表按它查(多选时其余项登记在 share_items)
  const { message } = AntdApp.useApp()
  const [code, setCode] = useState(randomCode())
  const [useCode, setUseCode] = useState(true)
  const [days, setDays] = useState<number | null>(7)
  const [maxVisits, setMaxVisits] = useState<number | null>(null)
  const [allowDownload, setAllowDownload] = useState(true)
  const [busy, setBusy] = useState(false)
  // 刚生成的这条:提取码**只在此刻拿得到**(库里存的是加盐哈希,事后取不回),
  // 所以留在对话框里让用户能再复制一次。
  const [lastLink, setLastLink] = useState<{ url: string; code: string | null; text: string } | null>(null)


  const create = async () => {
    setBusy(true)
    try {
      const r = await api<{ token: string; code: string | null }>(`/api/items/${item.id}/shares`, {
        method: 'POST',
        body: JSON.stringify({
          code: useCode ? code.trim() : null,
          expires_days: days, max_visits: maxVisits, allow_download: allowDownload,
          items: items.map((i) => i.id),   // 多选分享:一条链接带这些内容
        }),
      })
      // ★复制文案带内容名★(2026-08-05 用户:不然对方不知道分享的是啥;百度网盘也是
      //   「通过网盘分享的文件:xxx」开头)。多项时给第一个名字 + 「等 N 项」。
      const url = `${window.location.origin}/s/${r.token}`
      const what = items.length > 1 ? `${item.name} 等 ${items.length} 项` : item.name
      const life = days ? `${days} 天内有效` : '长期有效'
      const text = [
        `通过汇流分享:${what}`,
        `链接:${url}`,
        ...(r.code ? [`提取码:${r.code}`] : []),
        life,
      ].join('\n')
      setLastLink({ url, code: r.code, text })
      try { await navigator.clipboard.writeText(text); message.success('分享文案已复制' + (r.code ? '(含提取码)' : '')) }
      catch { message.info('链接已生成,见下方') }
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal open onCancel={onClose} footer={null} width={620}
      title={<span><ItemIcon it={item} />
        {items.length > 1 ? `分享 ${items.length} 项(${item.name} 等)` : `分享「${item.name}」`}</span>}>
      <Alert type="warning" showIcon style={{ marginBottom: 12 }}
        message="这是公开链接:拿到链接的人不需要是本项目成员"
        description="提取码、有效期、访问次数是仅有的三道闸;发出去之后唯一的后悔药是撤销。" />
      <AntSpace direction="vertical" style={{ width: '100%' }} size={10}>
        <AntSpace wrap>
          <Switch size="small" checked={useCode} onChange={setUseCode} />
          <Typography.Text>需要提取码</Typography.Text>
          {useCode && (
            <AntSpace.Compact>
              <Input value={code} onChange={(e) => setCode(e.target.value)} style={{ width: 130 }} maxLength={32} />
              <Button onClick={() => setCode(randomCode())}>换一个</Button>
            </AntSpace.Compact>
          )}
        </AntSpace>
        <AntSpace wrap>
          <Typography.Text>有效期</Typography.Text>
          <Select value={days} onChange={setDays} style={{ width: 130 }}
            options={[{ value: 1, label: '1 天' }, { value: 7, label: '7 天' }, { value: 30, label: '30 天' },
                      { value: null as unknown as number, label: '永久有效' }]} />
          <Typography.Text>访问次数</Typography.Text>
          <Select value={maxVisits} onChange={setMaxVisits} style={{ width: 130 }}
            options={[{ value: null as unknown as number, label: '不限' }, { value: 1, label: '1 次' },
                      { value: 10, label: '10 次' }, { value: 50, label: '50 次' }]} />
        </AntSpace>
        <AntSpace>
          <Switch size="small" checked={allowDownload} onChange={setAllowDownload} />
          <Typography.Text>允许下载原件(关掉则只能在线看)</Typography.Text>
        </AntSpace>
        <Button type="primary" loading={busy} onClick={create}>生成链接并复制</Button>
      </AntSpace>

      {/* 「已有链接」不在这里列了(2026-08-05 用户):生成链接的对话框就该只管生成,
          管理散落在每个文件里没法用。全部分享集中在顶部「🔗 我的分享」页。 */}
      {lastLink && (
        <Alert type="success" showIcon style={{ marginTop: 14 }}
          message="已生成(文案已复制到剪贴板)"
          description={
            <AntSpace direction="vertical" size={6} style={{ width: '100%' }}>
              <Input.TextArea readOnly value={lastLink.text} autoSize style={{ fontSize: 12 }}
                onFocus={(e) => e.target.select()} />
              <AntSpace wrap>
                <Button size="small" onClick={() => { void navigator.clipboard.writeText(lastLink.text); message.success('已复制') }}>
                  复制文案
                </Button>
                {lastLink.code && (
                  // ?pwd= 是百度那套「提取码自动填充」的做法:一步直达,代价是**链接即等于码**。
                  // 两种都给,让用户按场景选:要分开发就用上面的文案,图省事就用这个。
                  <Button size="small" onClick={() => {
                    void navigator.clipboard.writeText(`${lastLink.url}?pwd=${lastLink.code}`)
                    message.success('已复制(链接自带提取码,打开即免输)')
                  }}>复制免输码链接</Button>
                )}
              </AntSpace>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                ⚠ 提取码只在这里能看到一次(库里存的是哈希,事后取不回)。
              </Typography.Text>
            </AntSpace>
          } />
      )}
    </Modal>
  )
}


/// 4 位提取码(去掉易混的 0/O/1/l/I)。只是默认值,用户可改。
function randomCode(): string {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join('')
}
