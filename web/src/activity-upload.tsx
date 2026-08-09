// 活动材料 / 录制的上传口 —— ★一份实现,两个入口共用★(活动详情的材料·录制两个 tab、纪要页的录制面板)。
//
// ⚠★2026-08-09 用户:「上传材料、录制可以拖动上传,并且显示上传进度,视频上传都没有进度显示」★
// 在此之前这两处都是一句裸 `fetch(..., {body: fd})`:
//   · fetch **至今没有上传进度事件**(这不是我们偷懒,是标准里就没有)——
//     于是传一个 2GB 的录屏,界面上**什么都不动**,人只能猜它是在传还是卡死了;
//   · 没有拖放,只能点按钮走文件选择框。
// 而 `upload.ts` 里早就有一个带进度的 `xhrUpload`(项目文件页一直在用)——
// ★同一件事在两个地方长得不一样,而好的那一份就在隔壁★。这里把活动这两处接到同一条路上。
//
// ★为什么不走分片直传★(项目文件页对大文件走的那条):`media/begin` 的入参里
// **没有 activity_id / is_recording**,分片路径落不成「某场活动的材料」。
// 而 `/projects/{pid}/upload` 是**边收边按 8MiB 转推 S3** 的流式实现、并且
// `DefaultBodyLimit::disable()`,大录屏走它内存上是安全的 —— 缺的只是进度,补上即可。
import { App as AntdApp, Button, Progress, Typography } from 'antd'
import { useRef, useState } from 'react'
import { api } from './api'
import { CANCELED, cancelUpload, newCtl, xhrUpload, type UploadCtl } from './upload'

type Task = { key: string; name: string; percent: number; ctl: UploadCtl }

/// ★做成 hook 而不是组件★:按钮和拖放区在页面上离得很远(按钮在标签栏右上角、
/// 拖放区包着下面的文件列表),但它们必须共享同一份任务状态。
/// 组件塞不进两个位置,hook 可以 —— 返回两块 JSX,调用方各摆各的。
///
/// `isRecording` 决定后端要不要把它当录制(只有录制会被转写、并作为活动时长依据,D5)。
export function useActivityUpload({ projectId, activityId, isRecording, accept, label, onDone }: {
  /// 关联项目之一;★null = 这场活动不关联任何项目★(ADR-0002 的「个人日程」),
  /// 此时落点由后端算(PRD §J0:发起人自己的「我的活动材料」),见下面的 dropTarget。
  projectId: number | null
  activityId: number
  isRecording: boolean
  accept?: string
  label: string
  onDone: () => void
}) {
  const { message } = AntdApp.useApp()
  const [tasks, setTasks] = useState<Task[]>([])
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  /// 这一批材料落到哪个项目。
  ///
  /// ⚠★2026-08-09 liaoruili:「个人活动无法上传材料」★。在此之前这里是一句
  /// `if (!projectId) { message.error('这个活动还没有关联项目，材料没地方放'); return }` ——
  /// 而「个人日程」按 ADR-0002 本来就是**零关联项目**,于是整类活动传不了任何东西。
  /// PRD §J0 早就写了答案(材料落发起人的「我的活动材料」),只是没人实现:
  /// ★又一次「文档里写了 ≠ 代码里做了」★(同一天已在 D10 只读区、AI 摘要 kind 上各栽过一次)。
  ///
  /// ★按需解析,不在页面加载时先问★:那个存档区是「第一次真要用才建」的东西,
  /// 打开一次详情页就凭空建一个项目行,是把懒创建做没了。
  const dropTarget = async (): Promise<number> => {
    if (projectId) return projectId
    const r = await api<{ project_id: number }>(`/api/activities/${activityId}/materials-project`, { method: 'POST' })
    return r.project_id
  }

  const send = async (files: File[]) => {
    if (!files.length) return
    let pid: number
    try { pid = await dropTarget() } catch (e) { message.error((e as Error).message); return }
    // ★key 用「时间戳 + 序号 + 文件名」★:同名文件可以同时传两份,不能靠文件名当身份。
    const stamp = Date.now()
    const batch: Task[] = files.map((f, i) => ({ key: `${stamp}-${i}-${f.name}`, name: f.name, percent: 0, ctl: newCtl() }))
    setTasks((t) => [...t, ...batch])
    const patch = (key: string, percent: number) =>
      setTasks((t) => t.map((x) => (x.key === key ? { ...x, percent } : x)))
    const qs = `activity_id=${activityId}&is_recording=${isRecording}`
    // 串行:活动这两处一次通常就一两个文件,而串行能让进度条读起来有意义
    // (并行时几条一起爬,人分不清哪条是哪个)。
    for (let i = 0; i < files.length; i++) {
      const t = batch[i]
      try {
        await xhrUpload(`/api/projects/${pid}/upload?${qs}`, files[i], (p) => patch(t.key, p), t.ctl)
        // 录屏/录音传完后端会自动排队转写(v0.3.49),这里说一声,免得用户以为还要手动点。
        message.success(`${t.name} 上传完成${isRecording ? '——已自动排队转写' : ''}`)
      } catch (e) {
        if (t.ctl.canceled || (e as Error).message === CANCELED) message.info(`${t.name} 已取消`)
        else message.error(`${t.name}：${(e as Error).message}`)
      } finally {
        setTasks((x) => x.filter((y) => y.key !== t.key))
      }
    }
    onDone()
  }

  /// 拖放区:包住文件列表。`children` 是列表本身。
  const zone = (children?: React.ReactNode) => (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault(); setDragging(false)
        void send([...e.dataTransfer.files])
      }}
      style={{
        // ★平时完全不占视觉★:只在拖进来的那一刻显形。常驻一个大虚线框会把
        // 「这里是文件列表」压成「这里是上传区」,而看列表才是这一页大多数时候的用途。
        outline: dragging ? '2px dashed #0d9488' : 'none',
        background: dragging ? '#e6fffb' : undefined,
        borderRadius: 6, padding: dragging ? 6 : 0, transition: 'background .15s',
      }}>
      {dragging && (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
          松开即上传{isRecording ? '录屏 / 录音' : '材料'}
        </Typography.Text>
      )}
      {tasks.map((t) => (
        <div key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <Typography.Text ellipsis style={{ fontSize: 12, width: 180, flexShrink: 0 }} title={t.name}>
            {t.name}
          </Typography.Text>
          <Progress percent={t.percent} size="small" style={{ flex: 1, minWidth: 0, margin: 0 }} />
          <Button size="small" type="link" onClick={() => cancelUpload(t.ctl)}>取消</Button>
        </div>
      ))}
      {children}
    </div>
  )

  const button = (
    <>
      <input ref={input} type="file" multiple accept={accept} style={{ display: 'none' }}
        onChange={(e) => { void send([...(e.target.files ?? [])]); e.target.value = '' }} />
      <Button size="small" type={isRecording ? 'primary' : 'default'} onClick={() => input.current?.click()}>
        {label}
      </Button>
    </>
  )

  return { button, zone }
}
