// 开发者页面:列出全部 API,并且能就地发请求试。只对超管显示。
//
// 数据来自 GET /api/_dev/apis —— 后端那份清单与路由表由 `apidoc.rs` 里的测试逐条比对,
// ★少写一条、多写一条、路径写错一个字,cargo test 就红★,所以这页永远不会跟实际接口漂移。
//
// 「试一下」是拿当前登录态直接打真实接口(同源、带 cookie),所以:
//   · 你看到的响应就是**你自己这个身份**能拿到的响应,权限判定照常生效;
//   · ⚠ 它是**真的在改数据**——DELETE 就是真删。dev 环境随便点,prod 上想清楚再点。
import { Alert, App as AntdApp, AutoComplete, Button, Card, Input, Segmented, Space, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'

type Api = {
  method: string; path: string; group: string
  auth: string; summary: string; params: string
}

const METHOD_COLOR: Record<string, string> = {
  GET: 'blue', POST: 'green', PUT: 'orange', DELETE: 'red',
}

/// 路径里的 {name} 占位 → 输入框
function placeholders(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
}


/// ★AI 模型:超管在这里选★(2026-08-16 热修)。
///
/// 起因是 prod 上的真实故障:平台换了模型,congrove 还在调 `Qwen3.6-35B-A3B`,
/// 于是 `LLM 返回 403:无权调用模型` —— ★纪要功能整个哑掉,而这边没有任何自助恢复的办法★,
/// 只能等人去改平台的环境变量再重启。配置项该由超管在界面上选。
///
/// ⚠★用 AutoComplete 而不是 Select★:网关的 `/v1/models` **只列常驻模型**,
///   按需(scale-to-zero)的模型不在列表里、但**能调**。只给下拉等于把按需模型全挡了 ——
///   所以列表只是**建议**,手输的名字一律接受。
function LlmModelCard() {
  const { message } = AntdApp.useApp()
  const [cur, setCur] = useState('')
  const [val, setVal] = useState('')
  const [opts, setOpts] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const load = useCallback(() => {
    api<{ current: string; models: string[]; error?: string }>('/api/admin/llm/models')
      .then((d) => { setCur(d.current); setVal(d.current); setOpts(d.models || []); setErr(d.error ?? null) })
      .catch((e) => setErr((e as Error).message))
  }, [])
  useEffect(load, [load])
  return (
    <Card size="small" style={{ marginBottom: 12 }}
      title={<Space><span>AI 模型</span><Tag color="purple">超管</Tag></Space>}>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        生成纪要/摘要用的模型。<b>平台换过模型之后，这里改一下即可</b>，不用改环境变量、也不用重启。
        {/* 这句不是废话:它解释了为什么列表可能不全,免得有人以为列表坏了 */}
        <br />下拉里是网关<b>当前常驻</b>的模型；<b>按需模型不在列表里但可以直接输入</b>。
      </Typography.Paragraph>
      {err && <Alert type="warning" showIcon style={{ marginBottom: 8 }}
        message={`列不出可用模型:${err}`} description="不影响保存 —— 你仍然可以直接输入模型名。" />}
      <Space wrap>
        <AutoComplete style={{ width: 340 }} value={val} onChange={setVal}
          options={opts.map((m) => ({ value: m }))} placeholder="模型名，如 Qwen3.6-35B-A3B"
          filterOption={(i, o) => String(o?.value ?? '').toLowerCase().includes(i.toLowerCase())} />
        <Button type="primary" loading={saving} disabled={!val.trim() || val.trim() === cur}
          onClick={async () => {
            setSaving(true)
            try {
              await api('/api/admin/llm/model', { method: 'PUT', body: JSON.stringify({ model: val.trim() }) })
              message.success('已保存，下一次生成纪要就用它'); load()
            } catch (e) { message.error((e as Error).message) } finally { setSaving(false) }
          }}>保存</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>当前：<b>{cur || '（未设置，用默认）'}</b></Typography.Text>
      </Space>
    </Card>
  )
}

export function ApiDocView() {
  const { message } = AntdApp.useApp()
  const [apis, setApis] = useState<Api[]>([])
  const [loading, setLoading] = useState(true)
  const [kw, setKw] = useState('')
  const [group, setGroup] = useState('全部')

  /// 403 = 我有超管资格但**超管模式没开**(docs/TECH-DESIGN-admin-mode.md)。
  /// ★入口留着、点了给提示★是 2026-08-09 liaoruili 定的:
  /// 直接把菜单项藏掉会让人以为超管被撤了,而一个空白页 + 一句红字 toast 更难懂。
  const [denied, setDenied] = useState(false)
  useEffect(() => {
    api<{ apis: Api[] }>('/api/_dev/apis')
      .then((r) => { setApis(r.apis); setDenied(false) })
      .catch((e) => {
        const m = (e as Error).message
        if (m.includes('forbidden') || m === '403') setDenied(true)
        else message.error(m)
      })
      .finally(() => setLoading(false))
  }, [message])

  const groups = useMemo(
    () => ['全部', ...Array.from(new Set(apis.map((a) => a.group)))],
    [apis],
  )
  const rows = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return apis.filter(
      (a) =>
        (group === '全部' || a.group === group) &&
        (!k || a.path.toLowerCase().includes(k) || a.summary.toLowerCase().includes(k)),
    )
  }, [apis, kw, group])

  if (denied) return (
    <Card>
      <Alert type="warning" showIcon
        message="这一页要超管权限，而你的超管模式没开着"
        description="超管模式平时是关的——那样你在系统里就是个普通用户，看不到别人的项目与活动。开一下就能进，2 小时后自动关。"
        action={<Button type="primary" size="small" onClick={async () => {
          try { await api('/api/me/admin-mode', { method: 'POST', body: JSON.stringify({ on: true }) }); window.location.reload() }
          catch (e) { message.error((e as Error).message) }
        }}>进入超管模式</Button>} />
    </Card>
  )

  return (
    <>
    <LlmModelCard />
    <Card>
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text strong style={{ fontSize: 15 }}>API 一览</Typography.Text>
        <Tag>{apis.length} 个接口</Tag>
        <Input.Search placeholder="搜路径或说明…" allowClear style={{ width: 240 }}
          onChange={(e) => setKw(e.target.value)} />
      </Space>
      <div style={{ marginBottom: 12 }}>
        <Segmented size="small" value={group} onChange={(v) => setGroup(v as string)} options={groups} />
      </div>

      <Table<Api>
        size="small" rowKey={(a) => `${a.method} ${a.path}`} dataSource={rows} loading={loading}
        pagination={false} scroll={{ x: 900 }}
        expandable={{
          expandedRowRender: (a) => <TryIt api={a} />,
          rowExpandable: () => true,
        }}
        columns={[
          {
            title: '方法', width: 80, dataIndex: 'method',
            render: (m: string) => <Tag color={METHOD_COLOR[m] ?? 'default'}>{m}</Tag>,
          },
          {
            title: '路径', dataIndex: 'path', width: 320,
            render: (p: string) => <code style={{ fontSize: 12 }}>{p}</code>,
          },
          {
            // ★评审规范性时最该盯这一列★
            title: '需要身份', dataIndex: 'auth', width: 190,
            render: (t: string) => <span style={{ fontSize: 12 }}>{t}</span>,
          },
          { title: '说明', dataIndex: 'summary', ellipsis: true },
          {
            title: '入参', dataIndex: 'params', width: 200, ellipsis: true,
            render: (t: string) => (t ? <code style={{ fontSize: 11 }}>{t}</code> : <span style={{ color: '#bfbfbf' }}>—</span>),
          },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
        展开任意一行可就地发请求。请求带当前登录态，<b>看到的就是你这个身份能拿到的响应</b>；
        <b style={{ color: '#d4380d' }}> 它真的在改数据</b>，DELETE 就是真删。
      </Typography.Paragraph>
    </Card>
    </>
  )
}

/// 单个接口的「试一下」:填路径参数与 body → 发请求 → 看状态码、耗时、响应体。
function TryIt({ api: a }: { api: Api }) {
  const ph = useMemo(() => placeholders(a.path), [a.path])
  const [vals, setVals] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [body, setBody] = useState(a.method === 'GET' || a.method === 'DELETE' ? '' : '{\n  \n}')
  const [resp, setResp] = useState<{ status: number; ms: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const url = useMemo(() => {
    let u = a.path
    for (const p of ph) u = u.replace(`{${p}}`, encodeURIComponent(vals[p] ?? `{${p}}`))
    return u + (query.trim() ? (query.trim().startsWith('?') ? query.trim() : `?${query.trim()}`) : '')
  }, [a.path, ph, vals, query])

  const send = useCallback(async () => {
    setBusy(true)
    const t0 = performance.now()
    try {
      const init: RequestInit = { method: a.method, headers: {} }
      if (body.trim() && a.method !== 'GET') {
        init.headers = { 'Content-Type': 'application/json' }
        init.body = body
      }
      const r = await fetch(url, init)
      const text = await r.text()
      let pretty = text
      try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch { /* 非 JSON 原样显示 */ }
      setResp({ status: r.status, ms: Math.round(performance.now() - t0), text: pretty.slice(0, 20000) })
    } catch (e) {
      setResp({ status: 0, ms: Math.round(performance.now() - t0), text: String(e) })
    } finally { setBusy(false) }
  }, [a.method, body, url])

  const codeColor = (s: number) =>
    s === 0 ? '#8c8c8c' : s < 300 ? '#389e0d' : s < 400 ? '#d46b08' : '#cf1322'

  return (
    <div style={{ padding: '4px 8px 8px' }}>
      {ph.length > 0 && (
        <Space wrap style={{ marginBottom: 8 }}>
          {ph.map((p) => (
            <Input key={p} addonBefore={p} style={{ width: 220 }} placeholder="值"
              value={vals[p] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [p]: e.target.value }))} />
          ))}
        </Space>
      )}
      <Space wrap style={{ marginBottom: 8, width: '100%' }}>
        <Input addonBefore="query" style={{ width: 340 }} placeholder="如 username=alice"
          value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button type="primary" loading={busy} onClick={send}>发送</Button>
        <code style={{ fontSize: 12, color: '#595959' }}>{a.method} {url}</code>
      </Space>

      {a.method !== 'GET' && (
        <Input.TextArea rows={4} value={body} onChange={(e) => setBody(e.target.value)}
          placeholder="JSON body（不需要就留空）"
          style={{ fontFamily: 'monospace', fontSize: 12, marginBottom: 8 }} />
      )}

      {resp && (
        <div>
          <Space style={{ marginBottom: 4 }}>
            <b style={{ color: codeColor(resp.status) }}>
              {resp.status === 0 ? '请求失败' : `HTTP ${resp.status}`}
            </b>
            <span style={{ color: '#8c8c8c', fontSize: 12 }}>{resp.ms} ms</span>
          </Space>
          <pre style={{
            background: '#fafafa', border: '1px solid #f0f0f0', borderRadius: 4, padding: 10,
            fontSize: 12, maxHeight: 340, overflow: 'auto', margin: 0,
          }}>{resp.text || '（空响应体）'}</pre>
        </div>
      )}
    </div>
  )
}
