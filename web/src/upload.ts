// 上传三级策略(2026-08-03 事故后定型,详见 DESIGN.md §8-1 复盘):
// ①预签直传(装 CA 的设备,字节不过 pod)→ ②同源分片代理(8MiB/片,穿得过任意代理)
// → ③整文件 POST(仅小文件)。主窗与将来的其它入口共用这一份。
import { api } from './api'

/// P2 预签名直传:>100MB 或视频走浏览器→Garage 直传(字节不过 pod)。
/// begin 拿全部 part URL → File.slice 逐片 PUT(收集 ETag,跨源可读靠桶 CORS 的 ExposeHeaders)
/// → complete 交回服务端。返回 false = 后端说预签名未启用(501),调用方回退后端流式上传。
export const DIRECT_THRESHOLD = 100 * 1024 * 1024

/// 开局探测:本设备能不能直连 s3api(证书信不信得过)。
/// no-cors 的 HEAD:证书不受信 → fetch 直接 reject;受信则即使 403 也算 resolve(opaque)。
/// 结果缓存在 sessionStorage,每标签页只探一次;探不通就静默走同源分片,不再撞墙报警告。
export async function probeDirect(endpoint: string | null): Promise<boolean> {
  if (!endpoint) return false
  const cached = sessionStorage.getItem('cg_direct_ok')
  if (cached !== null) return cached === '1'
  let ok = false
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 6000)
    await fetch(endpoint, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctl.signal })
    clearTimeout(timer)
    ok = true
  } catch {
    ok = false // 证书不受信 / 该网络到不了 → 走分片
  }
  sessionStorage.setItem('cg_direct_ok', ok ? '1' : '0')
  return ok
}

export async function directUpload(
  sid: number, file: File, parentId: number | null, onProgress: (p: number) => void,
  mode: 'presigned' | 'proxy',
): Promise<boolean> {
  const begin = await fetch(`/api/spaces/${sid}/media/begin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, mime: file.type || 'application/octet-stream', parent_id: parentId }),
  })
  if (begin.status === 501) return false
  if (begin.status === 401) {
    window.location.href = `/auth/login?return=${encodeURIComponent(window.location.pathname)}`
    throw new Error('未登录')
  }
  if (!begin.ok) throw new Error(((await begin.json()) as { error?: string }).error || `${begin.status}`)
  const { item_id, upload_id, part_size, part_urls } = (await begin.json()) as {
    item_id: number; upload_id: string; part_size: number; part_urls: string[]
  }
  try {
    const parts: { part_number: number; etag: string }[] = []
    let sent = 0
    for (let i = 0; i < part_urls.length; i++) {
      const blob = file.slice(i * part_size, Math.min(file.size, (i + 1) * part_size))
      const report = (loaded: number) => onProgress(Math.round(((sent + loaded) / file.size) * 100))
      // presigned:浏览器直发 Garage(最快,要过 s3api 证书关);
      // proxy:同源发给我们再转推 S3(绕开证书关,也绕开入口层对大请求的限——每片只有 32MiB)。
      // 每片重试 3 次(1s/2s 退避):公网入口层偶发掐断时不必整个文件重来。
      let etag = ''
      for (let attempt = 1; ; attempt++) {
        try {
          etag = mode === 'presigned'
            ? await putPart(part_urls[i], blob, report)
            : await putPart(`/api/items/${item_id}/media/part?upload_id=${encodeURIComponent(upload_id)}&part_number=${i + 1}`, blob, report, true)
          break
        } catch (pe) {
          if (attempt >= 3) throw new Error(`第 ${i + 1}/${part_urls.length} 片失败(已重试 3 次):${(pe as Error).message}`)
          await new Promise((r) => setTimeout(r, attempt * 1000))
          report(0)
        }
      }
      sent += blob.size
      parts.push({ part_number: i + 1, etag })
    }
    await api(`/api/items/${item_id}/media/complete`, { method: 'POST', body: JSON.stringify({ upload_id, parts }) })
    return true
  } catch (e) {
    // 失败必 abort:半截 multipart 不清理会永久占存储(后端另有 24h 兜底清扫)。
    await api(`/api/items/${item_id}/media/abort`, { method: 'POST', body: JSON.stringify({ upload_id }) }).catch(() => {})
    throw e
  }
}

function putPart(url: string, blob: Blob, onLoaded: (loaded: number) => void, viaProxy = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onLoaded(e.loaded) }
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let detail = `${xhr.status}`
        try { detail = JSON.parse(xhr.responseText).error || detail } catch { /* 非 JSON */ }
        return reject(new Error(`分片上传失败:${detail}`))
      }
      // 代理模式 ETag 在 JSON 体里;直传模式在响应头(跨源可读靠桶 CORS ExposeHeaders:[ETag])。
      const etag = viaProxy ? (JSON.parse(xhr.responseText).etag as string) : xhr.getResponseHeader('ETag')
      if (etag) resolve(etag.replaceAll('"', ''))
      else reject(new Error(viaProxy ? '分片响应缺 etag' : 'part 直传缺 ETag(桶 CORS?)'))
    }
    xhr.onerror = () => reject(new Error(viaProxy ? '分片上传网络错误' : 'part 直传网络错误(证书/CORS?)'))
    xhr.send(blob)
  })
}

/// XHR 上传(fetch 至今无标准上传进度,对抗核查 §7.4b-5):onProgress 喂给 antd Upload 画进度条。
export function xhrUpload(url: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)) }
    xhr.onload = () => {
      if (xhr.status === 401) { window.location.href = `/auth/login?return=${encodeURIComponent(window.location.pathname)}`; return }
      if (xhr.status >= 200 && xhr.status < 300) resolve()
      else {
        // 后端 JSON 错误取 error 字段;axum 框架层的纯文本错误(如 query 解析失败)取原文,别只剩裸状态码。
        let msg = `${xhr.status}`
        try { msg = JSON.parse(xhr.responseText).error || msg } catch { if (xhr.responseText) msg = `${xhr.status}:${xhr.responseText.slice(0, 120)}` }
        reject(new Error(msg))
      }
    }
    xhr.onerror = () => reject(new Error('网络错误'))
    const fd = new FormData()
    fd.append('file', file)
    xhr.send(fd)
  })
}

