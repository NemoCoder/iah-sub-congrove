// 活动材料 / 录制的重命名 —— ★一份实现,两个入口共用★(活动详情的材料·录制两个 tab、纪要页的录制列表)。
//
// ⚠★2026-08-09 liaoruili:「材料 录制 上传的文件,也要支持能够重命名」★。
// 在此之前活动材料**在哪儿都改不了名**:项目树那条(`PUT /api/items/{iid}`)按 D10 拒绝,
// 而活动这边压根没有对应的入口 —— 于是「Rec 0001.mp4」这种名字只能永远留着。
// D10 说的是「在**项目树里**只读」(名称与位置由活动决定),不是「永远不可改」,
// 所以改名这个动作发生在活动页,和删除同一个道理。
//
// ★做成 hook 而不是组件★:同一页里两个 tab 的表格都要用,而 Modal 只该有一个 ——
// 与 activity-upload.tsx 的选择一致(那边也是 hook,返回按钮和拖放区两块 JSX)。
import { App as AntdApp, Input, Modal } from 'antd'
import type { InputRef } from 'antd'
import { useRef, useState } from 'react'
import { api } from './api'

type Target = { id: number; name: string }

export function useRenameActivityItem({ activityId, onDone }: {
  activityId: number
  onDone: () => void
}) {
  const { message } = AntdApp.useApp()
  const [target, setTarget] = useState<Target | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<InputRef>(null)

  const save = async () => {
    if (!target) return
    const v = name.trim()
    if (!v) { message.error('名称不能为空'); return }
    if (v === target.name) { setTarget(null); return }
    setBusy(true)
    try {
      await api(`/api/activities/${activityId}/items/${target.id}`, {
        method: 'PUT', body: JSON.stringify({ name: v }),
      })
      setTarget(null); message.success('已改名'); onDone()
    } catch (e) { message.error((e as Error).message) } finally { setBusy(false) }
  }

  /// ★打开时只选中扩展名之前那段★:录屏文件叫 `Rec 0001.mp4`,人要改的是前面那半;
  /// 全选的话他得先手动躲开 `.mp4`,或者一不小心把它删了。
  /// (文件管理器都是这个行为 —— 这不是花活,是省掉每次一步。)
  const selectStem = () => {
    const el = input.current?.input
    if (!el) return
    const dot = el.value.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : el.value.length)
  }

  const modal = (
    <Modal open={!!target} title="重命名" okText="保存" cancelText="取消"
      confirmLoading={busy} onOk={() => void save()} onCancel={() => setTarget(null)}
      afterOpenChange={(o) => { if (o) selectStem() }}
      destroyOnHidden>
      <Input ref={input} value={name} onChange={(e) => setName(e.target.value)}
        onPressEnter={() => void save()} autoFocus />
    </Modal>
  )

  return { modal, open: (it: Target) => { setTarget(it); setName(it.name) } }
}
