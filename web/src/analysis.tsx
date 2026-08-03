// 录屏 AI 纪要面板:排队/进度、三份纪要、可点击跳转的逐字稿。
// 后端 worker 在 media_ai.rs;ASR 端点由平台提供(AI_Talks 0123),没开通时这里明确提示。
import { App as AntdApp, Alert, Button, Empty, Progress, Segmented, Space as AntSpace, Tag, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Item } from './api'
import { MarkdownView } from './preview'

type Seg = { start: number; end: number; text: string; speaker?: string | null }
type Data = {
  job: { status: string; stage: string; progress: number; error: string | null } | null
  transcript: { text: string; segments: Seg[] | null; duration_sec: number | null } | null
  summaries: { kind: string; content: string }[]
  asr_ready: boolean
}

function clock(s: number) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

export function Analysis({ item, onSeek }: { item: Item; onSeek: (t: number) => void }) {
  const { message } = AntdApp.useApp()
  const [d, setD] = useState<Data | null>(null)
  const [tab, setTab] = useState('brief')
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api<Data>(`/api/items/${item.id}/analysis`)
      setD(r)
      // 跑着就 5s 轮询一次,停了就停轮询(别让空闲页面一直打后端)。
      const running = r.job?.status === 'queued' || r.job?.status === 'running'
      if (running && timer.current == null) {
        timer.current = window.setInterval(() => void load(), 5000)
      } else if (!running && timer.current != null) {
        window.clearInterval(timer.current); timer.current = null
      }
    } catch { /* 无权限/未就绪都静默,不打扰播放 */ }
  }, [item.id])

  useEffect(() => {
    void load()
    return () => { if (timer.current != null) { window.clearInterval(timer.current); timer.current = null } }
  }, [load])

  if (!d) return null
  const job = d.job
  const running = job?.status === 'queued' || job?.status === 'running'
  const sum = d.summaries.find((s) => s.kind === tab)

  return (
    <div style={{ marginTop: 14 }}>
      <AntSpace style={{ marginBottom: 8 }} wrap>
        <Typography.Text strong>AI 会议纪要</Typography.Text>
        {!d.transcript && !running && (
          <Button size="small" type="primary" disabled={!d.asr_ready}
            onClick={async () => {
              try { await api(`/api/items/${item.id}/analyze`, { method: 'POST' }); message.success('已排队,几分钟后回来看'); void load() }
              catch (e) { message.error((e as Error).message) }
            }}>
            生成纪要
          </Button>
        )}
        {d.transcript && !running && (
          <Button size="small" onClick={async () => {
            try { await api(`/api/items/${item.id}/analyze`, { method: 'POST' }); message.success('已重新排队'); void load() }
            catch (e) { message.error((e as Error).message) }
          }}>重新生成</Button>
        )}
        {job?.status === 'failed' && <Tag color="red">上次失败</Tag>}
      </AntSpace>

      {!d.asr_ready && !d.transcript && (
        <Alert type="info" showIcon style={{ marginBottom: 10 }}
          message="语音转写服务尚未开通"
          description="已向平台提交开通申请(AI_Talks 0123)。开通后本功能自动可用,无需更新。" />
      )}
      {running && (
        <div style={{ marginBottom: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>{job?.stage || '排队中'}</Typography.Text>
          <Progress percent={job?.progress ?? 0} size="small" status="active" />
        </div>
      )}
      {job?.status === 'failed' && job.error && (
        <Alert type="error" showIcon style={{ marginBottom: 10 }} message="生成失败" description={job.error} />
      )}

      {(d.summaries.length > 0 || d.transcript) && (
        <>
          <Segmented size="small" value={tab} onChange={(v) => setTab(v as string)}
            options={[
              { value: 'brief', label: '摘要' },
              { value: 'outline', label: '分段大纲' },
              { value: 'decisions', label: '决议与待办' },
              { value: 'transcript', label: '逐字稿' },
            ]}
            style={{ marginBottom: 10 }} />
          {tab === 'transcript' ? (
            d.transcript?.segments?.length ? (
              <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 6, padding: 10 }}>
                {d.transcript.segments.map((s, i) => (
                  <div key={i} style={{ marginBottom: 6, fontSize: 13, lineHeight: 1.7 }}>
                    {/* 点时间戳跳到视频那一刻 */}
                    <a onClick={() => onSeek(s.start)} style={{ fontFamily: 'ui-monospace, monospace', marginRight: 8 }}>
                      {clock(s.start)}
                    </a>
                    {s.speaker && <Tag color="cyan" style={{ marginRight: 6 }}>{s.speaker}</Tag>}
                    {s.text}
                  </div>
                ))}
              </div>
            ) : (
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{d.transcript?.text || '—'}</Typography.Paragraph>
            )
          ) : sum ? (
            <MarkdownView text={sum.content} />
          ) : (
            <Empty description={running ? '生成中…' : '还没有这部分内容'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </>
      )}
    </div>
  )
}
