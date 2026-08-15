// 上传三级策略(2026-08-03 事故后定型,详见 DESIGN.md §8-1 复盘):
// ①预签直传(装 CA 的设备,字节不过 pod)→ ②同源分片代理(8MiB/片,穿得过任意代理)
// → ③整文件 POST(仅小文件)。主窗与将来的其它入口共用这一份。
import { api } from './api'

/// 上传控制器:取消时中断当前 xhr 并让分片循环退出。
export type UploadCtl = { canceled: boolean; xhr: XMLHttpRequest | null }
export const CANCELED = 'upload-canceled'
export function newCtl(): UploadCtl { return { canceled: false, xhr: null } }
export function cancelUpload(c: UploadCtl) { c.canceled = true; try { c.xhr?.abort() } catch { /* 已结束 */ } }

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

/// 文件指纹:大小 + 最后修改时间 + 文件名。断点续传靠它认出「你重新拖进来的就是上次那个文件」。
/// 不用内容 hash:GB 级录屏算一遍 sha256 要好几十秒,而这三样组合起来碰撞的概率对本场景足够低
/// (同一个人、同一目录、24 小时内、同名同大小同修改时间 —— 那就是同一个文件)。
function fingerprint(f: File): string {
  return `${f.size}:${f.lastModified}:${f.name}`.slice(0, 300)
}

export async function directUpload(
  pid: number, file: File, parentId: number | null, onProgress: (p: number) => void,
  mode: 'presigned' | 'proxy', ctl: UploadCtl = newCtl(),
  /// 内容的 sha256(调用方在秒传预检时已经算过,顺手带来):有它服务端就按内容寻址落对象,
  /// 同内容全库一份。没有也能传,只是不去重。
  /// 命中断点时回调一次(跳过的片数、已有的字节数),调用方用来提示「从断点继续」。
  onResume?: (skippedParts: number, skippedBytes: number) => void,
  sha256?: string,
): Promise<boolean> {
  const begin = await fetch(`/api/projects/${pid}/media/begin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: file.name, size: file.size, mime: file.type || 'application/octet-stream',
      parent_id: parentId, fp: fingerprint(file), sha256: sha256 || null,
    }),
  })
  if (begin.status === 501) return false
  if (begin.status === 401) {
    window.location.href = `/auth/login?return=${encodeURIComponent(window.location.pathname)}`
    throw new Error('未登录')
  }
  if (!begin.ok) throw new Error(((await begin.json()) as { error?: string }).error || `${begin.status}`)
  const { item_id, upload_id, part_size, part_urls, uploaded_parts } = (await begin.json()) as {
    item_id: number; upload_id: string; part_size: number; part_urls: string[]
    uploaded_parts?: { part_number: number; size: number }[]
  }
  // ★断点续传★:服务端问过 S3 了,这些片上次已经传好——跳过它们,进度条直接推到对应位置。
  // (以服务端的清单为准,不信任何本地记录:换标签页/清缓存都不影响,而且不会和 S3 实际状态打架。)
  const doneSet = new Set((uploaded_parts ?? []).map((p) => p.part_number))
  let sent = (uploaded_parts ?? []).reduce((a, p) => a + p.size, 0)
  if (doneSet.size) { onProgress(Math.round((sent / file.size) * 100)); onResume?.(doneSet.size, sent) }
  try {
    const parts: { part_number: number; etag: string }[] = []
    for (let i = 0; i < part_urls.length; i++) {
      if (ctl.canceled) throw new Error(CANCELED)
      if (doneSet.has(i + 1)) continue
      const blob = file.slice(i * part_size, Math.min(file.size, (i + 1) * part_size))
      const report = (loaded: number) => onProgress(Math.round(((sent + loaded) / file.size) * 100))
      // presigned:浏览器直发 Garage(最快,要过 s3api 证书关);
      // proxy:同源发给我们再转推 S3(绕开证书关,也绕开入口层对大请求的限——每片只有 32MiB)。
      // 每片重试 3 次(1s/2s 退避):公网入口层偶发掐断时不必整个文件重来。
      let etag = ''
      for (let attempt = 1; ; attempt++) {
        try {
          etag = mode === 'presigned'
            ? await putPart(part_urls[i], blob, report, false, ctl)
            : await putPart(`/api/items/${item_id}/media/part?upload_id=${encodeURIComponent(upload_id)}&part_number=${i + 1}`, blob, report, true, ctl)
          break
        } catch (pe) {
          if (ctl.canceled || (pe as Error).message === CANCELED) throw new Error(CANCELED)
          if (attempt >= 3) throw new Error(`第 ${i + 1}/${part_urls.length} 片失败（已重试 3 次）:${(pe as Error).message}`)
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
    // ★只有「用户主动取消」才 abort★:abort 会把已经传好的片一起删掉,断点就没了。
    // 网络断、分片重试耗尽这类**失败**要**保留**半截上传——用户重新拖同一个文件即可续传
    // (24h 内有效;超时由后端清扫任务 abort,不会永久占存储)。
    if (ctl.canceled || (e as Error).message === CANCELED) {
      await api(`/api/items/${item_id}/media/abort`, { method: 'POST', body: JSON.stringify({ upload_id }) }).catch(() => {})
    }
    throw e
  }
}

function putPart(url: string, blob: Blob, onLoaded: (loaded: number) => void, viaProxy = false, ctl?: UploadCtl): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    if (ctl) ctl.xhr = xhr
    xhr.onabort = () => reject(new Error(CANCELED))
    xhr.open('PUT', url)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onLoaded(e.loaded) }
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let detail = `${xhr.status}`
        try { detail = JSON.parse(xhr.responseText).error || detail } catch { /* 非 JSON */ }
        return reject(new Error(`分片上传失败：${detail}`))
      }
      // 代理模式 ETag 在 JSON 体里;直传模式在响应头(跨源可读靠桶 CORS ExposeHeaders:[ETag])。
      const etag = viaProxy ? (JSON.parse(xhr.responseText).etag as string) : xhr.getResponseHeader('ETag')
      if (etag) resolve(etag.replaceAll('"', ''))
      else reject(new Error(viaProxy ? '分片响应缺 etag' : 'part 直传缺 ETag（桶 CORS？）'))
    }
    xhr.onerror = () => reject(new Error(viaProxy ? '分片上传网络错误' : 'part 直传网络错误（证书/CORS？）'))
    xhr.send(blob)
  })
}

/// XHR 上传(fetch 至今无标准上传进度,对抗核查 §7.4b-5):onProgress 喂给 antd Upload 画进度条。
/// ★把响应体交出去★(2026-08-09):上传接口会告诉调用方「这份是完全重复的、没有新建行」
/// (方案 C),而原来这里 `resolve()` 什么都不带 —— 调用方只能一律报「上传完成」,
/// 而列表里并没有多出东西。**报成功却什么都没发生**比重复本身更让人困惑。
export function xhrUpload(url: string, file: File, onProgress: (percent: number) => void, ctl?: UploadCtl): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    if (ctl) ctl.xhr = xhr
    xhr.onabort = () => reject(new Error(CANCELED))
    xhr.open('POST', url)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)) }
    xhr.onload = () => {
      if (xhr.status === 401) { window.location.href = `/auth/login?return=${encodeURIComponent(window.location.pathname)}`; return }
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)) } catch { resolve(undefined) }
        return
      }
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

