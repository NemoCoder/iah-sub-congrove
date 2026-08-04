// 录屏 AI 纪要面板:排队/进度、三份纪要、可点击跳转的逐字稿。
// 后端 worker 在 media_ai.rs;ASR 端点由平台提供(AI_Talks 0123/0124/0125)。
// 分段已在后端合并成可读段落(同说话人+间隔<1.2s 合并,上限 120 字/30 秒),这里直接展示。
import { App as AntdApp, Alert, Button, Empty, Progress, Segmented, Space as AntSpace, Tag, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Item } from './api'
import { MarkdownView } from './preview'

type Seg = { start: number; end: number; text: string; speaker?: string | null }
type Data = {
  job: { status: string; stage: string; progress: number; error: string | null } | null
  transcript: { text: string; segments: Seg[] | null; duration_sec: number | null; drift_sec: number | null } | null
  summaries: { kind: string; content: string }[]
  asr_ready: boolean
}

function clock(s: number) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`
}

/// 逐行渲染带时间戳的文本:行首的 `[mm:ss]` / `mm:ss` / `[hh:mm:ss]` 变成可点的跳转链接。
/// 模型偶尔会写成「00:00 - 标题」或「[00:00] 标题」,两种都认;认不出的行原样显示,不吞内容。
function TimedLines({ text, onSeek }: { text: string; onSeek: (t: number) => void }) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return (
    <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid #f0f0f0', borderRadius: 6, padding: 10 }}>
      {lines.map((line, i) => {
        const m = line.match(/^[-*\s]*\[?(\d{1,2}):(\d{2})(?::(\d{2}))?\]?\s*[-—:：]?\s*(.*)$/)
        if (!m) return <div key={i} style={{ marginBottom: 6, fontSize: 13, lineHeight: 1.7 }}>{line}</div>
        // 三段 = hh:mm:ss,两段 = mm:ss
        const t = m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]
        return (
          <div key={i} style={{ marginBottom: 6, fontSize: 13, lineHeight: 1.7 }}>
            <a onClick={() => onSeek(t)} style={{ fontFamily: 'ui-monospace, monospace', marginRight: 8 }}>
              {m[3] ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`}
            </a>
            {m[4]}
          </div>
        )
      })}
    </div>
  )
}

export function Analysis({ item, onSeek, onTranscript }: {
  item: Item; onSeek: (t: number) => void
  /// 转写就绪时回调一次:播放器据此重挂 <track>——它只在挂载那一刻拉一次 vtt,
  /// 分析跑完时那份是空的,不重挂就永远没字幕(2026-08-04 反馈:字幕只在后开的独立窗口有)。
  onTranscript?: (segs: number) => void
}) {
  const { message } = AntdApp.useApp()
  const [d, setD] = useState<Data | null>(null)
  const [tab, setTab] = useState('brief')
  const timer = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api<Data>(`/api/items/${item.id}/analysis`)
      setD((prev) => {
        const before = prev?.transcript?.segments?.length ?? 0
        const now = r.transcript?.segments?.length ?? 0
        if (now > 0 && now !== before) onTranscript?.(now)
        return r
      })
      // 跑着就 5s 轮询一次,停了就停轮询(别让空闲页面一直打后端)。
      const running = r.job?.status === 'queued' || r.job?.status === 'running'
      if (running && timer.current == null) {
        timer.current = window.setInterval(() => void load(), 5000)
      } else if (!running && timer.current != null) {
        window.clearInterval(timer.current); timer.current = null
      }
    } catch { /* 无权限/未就绪都静默,不打扰播放 */ }
  }, [item.id, onTranscript])

  useEffect(() => {
    void load()
    return () => { if (timer.current != null) { window.clearInterval(timer.current); timer.current = null } }
  }, [load])

  if (!d) return null
  const job = d.job
  const running = job?.status === 'queued' || job?.status === 'running'
  const sum = d.summaries.find((s) => s.kind === tab)
  const drift = d.transcript?.drift_sec ?? null
  const dur = d.transcript?.duration_sec ?? null

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

      {/* ★时间轴漂移提示★(2026-08-04):ASR 的段时间戳是对的,但文字被过快消耗——61 分钟的会
          文字在 3624 秒就用完,字幕越走越快(累计提前 46 秒)。判据 = 最后一个有字的段离结尾多远。
          阈值 max(15 秒, 2%):短视频用绝对值兜底,长视频按比例。已发信 0136 请平台透出字级时间戳,
          修好之前**明说**,不能让用户以为字幕是准的。 */}
      {drift != null && dur != null && drift > Math.max(15, dur * 0.02) && (
        <Alert type="warning" showIcon style={{ marginBottom: 10 }}
          message={`字幕时间轴可能偏快(末尾约 ${Math.round(drift)} 秒没有文字覆盖)`}
          description="转写文字本身是准的,但语音识别服务返回的「文字↔时间」对应会随时长累积偏移,越到后面字幕越提前。已请平台改用字级时间戳,修好后本提示会自动消失。逐字稿与纪要不受影响。" />
      )}

      {!d.asr_ready && !d.transcript && (
        <Alert type="info" showIcon style={{ marginBottom: 10 }}
          message="语音转写服务尚未开通"
          description="平台已确认接入(FunASR:转写+标点+说话人+热词),正在部署中。上线后本功能自动可用,无需更新。" />
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
            // 大纲/决议里模型会照抄原文的 [mm:ss] —— 逐行渲染并把时间变成可点的跳转。
            // 不能交给 MarkdownView:markdown 会把单换行折叠成一整段(2026-08-04 反馈「没有分行」)。
            tab === 'outline' ? <TimedLines text={sum.content} onSeek={onSeek} /> : <MarkdownView text={sum.content} />
          ) : (
            <Empty description={running ? '生成中…' : '还没有这部分内容'} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </>
      )}
    </div>
  )
}
