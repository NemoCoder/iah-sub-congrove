//! 录屏自动转写 + 会议纪要(docs/VIDEO-SUMMARY.md 的 P1 实现)。
//!
//! 形态定案(五路调研):**ASR 转写为主干,摘要走平台 LLM 网关**——不用视频大模型直喂
//! (视频模型长视频得分大半来自字幕;通用模型中文会议 CER 19% 而专用 ASR 4~6%;成本差 50~80 倍)。
//! 关键帧 VLM 旁路留到 P3。
//!
//! 流水线:S3 取录屏 → ffmpeg 抽 16k/mono 音轨 → 按时长切段 → ASR → 拼逐字稿 → LLM 出三份纪要。
//! 任务态落 PG(`media_jobs`)而不是内存:无 PVC + pod 随时重建,内存态一重启就丢
//! (citeroot 的教训),重启后 `reclaim_stale` 把 running 打回 queued 续跑。
//!
//! ASR 端点契约(AI_Talks 0123→0124 定案):**走 `IAH_BASE_URL` 同一个网关、同一把 key**,
//! `POST {base}/audio/transcriptions` multipart:`file` / `model=funasr` /
//! `hotword`(空格分隔术语表) / `speaker=true`。平台选型 = **FunASR 一条龙**
//! (转写+标点+说话人+热词一个服务出齐,句级 start/end 与 spk0/spk1 都给,本地模型 cost=0)。
//! ★平台纠正过一个前提:他们的 GPU 是 **H20(Hopper)** 不是 5090——VIDEO-SUMMARY §2 那堆
//! 量化坑(INT8 崩/FP8 慢/必须 Marlin/别 enforce-eager)是消费级 5090 特有,H20 上全不适用。★

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context};
use serde::Serialize;
use sqlx::PgPool;
use tokio::io::AsyncWriteExt;

use crate::state::AppState;

/// 切段时长(秒)。ASR 单次输入普遍有 40~60s 硬上限(FireRedASR2)或按 batch 吃长音频
/// (Qwen3-ASR),这里按 **5 分钟**切:既避开单请求过大,又不至于把语义切太碎。
const CHUNK_SEC: u32 = 300;
/// 摘要的分块上限(字符)。超过就 map-reduce:分块摘要 → 再摘要
/// (时序内容用层级合并,研究显示能匹配甚至略超全上下文,且便宜得多)。
const MAP_CHUNK_CHARS: usize = 12_000;

#[derive(Serialize)]
pub struct Segment {
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
}

/// 后台 worker:每 10s 捞一个排队任务跑。单实例串行——ASR/LLM 都是外部服务,
/// 并发放大只会把网关排队转嫁过去;录屏分析本就是离线批处理,不追求并发。
pub async fn run(state: AppState) {
    // 启动先把上次进程留下的 running 打回 queued(它们的 tokio 任务已随进程消失)。
    if let Err(e) = reclaim_stale(&state.pool).await {
        tracing::warn!(error = %e, "media_ai: 回收僵尸任务失败");
    }
    loop {
        match claim_job(&state.pool).await {
            Ok(Some((job_id, item_id))) => {
                tracing::info!(job_id, item_id, "media_ai: 开始分析");
                let r = process(&state, job_id, item_id).await;
                match r {
                    Ok(()) => {
                        let _ = sqlx::query("UPDATE media_jobs SET status='done', stage='完成', progress=100, updated_at=now() WHERE id=$1")
                            .bind(job_id).execute(&state.pool).await;
                        tracing::info!(job_id, "media_ai: 完成");
                    }
                    Err(e) => {
                        let msg = format!("{e:#}");
                        tracing::warn!(job_id, error = %msg, "media_ai: 失败");
                        let _ = sqlx::query("UPDATE media_jobs SET status='failed', error=$2, updated_at=now() WHERE id=$1")
                            .bind(job_id).bind(&msg).execute(&state.pool).await;
                    }
                }
            }
            Ok(None) => tokio::time::sleep(Duration::from_secs(10)).await,
            Err(e) => {
                tracing::warn!(error = %e, "media_ai: 取任务失败");
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        }
    }
}

async fn reclaim_stale(pool: &PgPool) -> anyhow::Result<()> {
    let n = sqlx::query("UPDATE media_jobs SET status='queued', stage='等待重跑', updated_at=now() WHERE status='running'")
        .execute(pool).await?.rows_affected();
    if n > 0 {
        tracing::info!(n, "media_ai: 上次进程遗留的任务已重新排队");
    }
    Ok(())
}

/// 原子取任务:`FOR UPDATE SKIP LOCKED` 保证多副本时不会取到同一条。
async fn claim_job(pool: &PgPool) -> anyhow::Result<Option<(i64, i64)>> {
    let row: Option<(i64, i64)> = sqlx::query_as(
        "UPDATE media_jobs SET status='running', stage='准备中', updated_at=now()
          WHERE id = (SELECT id FROM media_jobs WHERE status='queued' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, item_id",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

async fn stage(pool: &PgPool, job_id: i64, stage: &str, progress: i32) {
    let _ = sqlx::query("UPDATE media_jobs SET stage=$2, progress=$3, updated_at=now() WHERE id=$1")
        .bind(job_id).bind(stage).bind(progress).execute(pool).await;
}

async fn process(state: &AppState, job_id: i64, item_id: i64) -> anyhow::Result<()> {
    let workdir = PathBuf::from(format!("/tmp/congrove-media/{job_id}"));
    tokio::fs::create_dir_all(&workdir).await.context("建临时目录")?;
    // 无论成败都清临时文件:ephemeral-storage 有限,几个 GB 的录屏残留几次就把 pod 挤爆(被 kubelet 驱逐)。
    let _guard = scopeguard(workdir.clone());

    // 1) 取录屏(流式落盘,别整个进内存——512Mi 资源档)
    stage(&state.pool, job_id, "下载录屏", 5).await;
    let key: String = sqlx::query_scalar("SELECT s3_key FROM items WHERE id=$1 AND kind='video'")
        .bind(item_id).fetch_optional(&state.pool).await?
        .flatten().ok_or_else(|| anyhow!("这不是一个已上传完成的视频"))?;
    let video = workdir.join("input.bin");
    download_to(state, &key, &video).await.context("从对象存储取录屏")?;

    // 2) 抽音轨:16kHz 单声道 PCM —— 所有 ASR 的统一入参
    stage(&state.pool, job_id, "抽取音轨", 15).await;
    let wav = workdir.join("audio.wav");
    run_ffmpeg(&["-i", video.to_str().unwrap(), "-vn", "-ac", "1", "-ar", "16000",
                 "-c:a", "pcm_s16le", "-y", wav.to_str().unwrap()]).await.context("ffmpeg 抽音轨")?;
    let _ = tokio::fs::remove_file(&video).await; // 视频用完即删,腾出临时盘

    // 3) 切段 + 转写
    let asr_base = state.config.asr_base_url.clone()
        .ok_or_else(|| anyhow!("未注入 IAH_BASE_URL,无法调用语音转写"))?;
    stage(&state.pool, job_id, "切分音频", 20).await;
    let parts = split_audio(&wav, &workdir).await.context("切分音频")?;
    let mut segments: Vec<Segment> = Vec::new();
    let total = parts.len().max(1);
    for (i, part) in parts.iter().enumerate() {
        stage(&state.pool, job_id, &format!("语音转写 {}/{}", i + 1, total), 20 + (i as i32 * 55 / total as i32)).await;
        let offset = (i as u32 * CHUNK_SEC) as f64;
        let mut segs = transcribe(state, &asr_base, part).await
            .with_context(|| format!("转写第 {} 段", i + 1))?;
        for s in &mut segs { s.start += offset; s.end += offset; }
        segments.extend(segs);
        let _ = tokio::fs::remove_file(part).await;
    }
    if segments.is_empty() {
        return Err(anyhow!("转写结果为空(录屏可能没有人声)"));
    }
    let full_text: String = segments.iter().map(|s| s.text.trim()).collect::<Vec<_>>().join("\n");
    let duration = segments.last().map(|s| s.end);
    sqlx::query(
        "INSERT INTO transcripts (item_id, text, segments, model, duration_sec) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (item_id) DO UPDATE SET text=EXCLUDED.text, segments=EXCLUDED.segments,
           model=EXCLUDED.model, duration_sec=EXCLUDED.duration_sec, created_at=now()",
    )
    .bind(item_id).bind(&full_text).bind(serde_json::to_value(&segments)?)
    .bind(&state.config.asr_model).bind(duration)
    .execute(&state.pool).await?;

    // 4) 出纪要(三份:摘要 / 分段大纲 / 决议待办)
    stage(&state.pool, job_id, "生成会议纪要", 80).await;
    let condensed = condense(state, &full_text).await.context("压缩长转写")?;
    for (kind, prompt) in [
        ("brief", "用中文写一段 150~300 字的会议摘要,直接给结论,不要客套和小标题。"),
        ("outline", "用中文列出分段大纲:每段一行,格式「时间范围 — 议题:要点」,按时间顺序,不超过 15 行。"),
        ("decisions", "用中文列出这次会议的**关键决议**与**待办事项**(谁负责、做什么、何时);没有就写「无明确决议/待办」。"),
    ] {
        let content = chat(state, prompt, &condensed).await.with_context(|| format!("生成 {kind}"))?;
        sqlx::query(
            "INSERT INTO summaries (item_id, kind, content, model) VALUES ($1,$2,$3,$4)
             ON CONFLICT (item_id, kind) DO UPDATE SET content=EXCLUDED.content, model=EXCLUDED.model, created_at=now()",
        )
        .bind(item_id).bind(kind).bind(&content).bind(&state.config.llm_model)
        .execute(&state.pool).await?;
    }
    Ok(())
}

/// 从 S3 流式下载到本地文件(不进内存)。
async fn download_to(state: &AppState, key: &str, dest: &Path) -> anyhow::Result<()> {
    let (mut stream, _) = state.storage.get_stream(key).await?;
    let mut f = tokio::fs::File::create(dest).await?;
    while let Some(chunk) = stream.try_next().await? {
        f.write_all(&chunk).await?;
    }
    f.flush().await?;
    Ok(())
}

async fn run_ffmpeg(args: &[&str]) -> anyhow::Result<()> {
    let out = tokio::process::Command::new("ffmpeg")
        .args(["-hide_banner", "-loglevel", "error"])
        .args(args)
        .output()
        .await
        .context("ffmpeg 未安装或无法执行")?;
    if !out.status.success() {
        return Err(anyhow!("ffmpeg 失败:{}", String::from_utf8_lossy(&out.stderr).chars().take(400).collect::<String>()));
    }
    Ok(())
}

/// 按 CHUNK_SEC 切成 wav 分段(ffmpeg segment muxer,不重编码)。
async fn split_audio(wav: &Path, dir: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let pattern = dir.join("part-%04d.wav");
    run_ffmpeg(&["-i", wav.to_str().unwrap(), "-f", "segment",
                 "-segment_time", &CHUNK_SEC.to_string(), "-c", "copy", "-y", pattern.to_str().unwrap()]).await?;
    let _ = tokio::fs::remove_file(wav).await;
    let mut parts = Vec::new();
    let mut rd = tokio::fs::read_dir(dir).await?;
    while let Some(e) = rd.next_entry().await? {
        let p = e.path();
        if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("part-")) {
            parts.push(p);
        }
    }
    parts.sort();
    Ok(parts)
}

/// 调 ASR:OpenAI 兼容的 `/audio/transcriptions`(multipart)。
/// 返回带时间戳的分段;若服务只回纯文本,退化为单段(start=0)。
async fn transcribe(state: &AppState, base: &str, part: &Path) -> anyhow::Result<Vec<Segment>> {
    let bytes = tokio::fs::read(part).await?;
    // 契约见 AI_Talks 0124:file / model=funasr / hotword(空格分隔) / speaker。
    let mut form = reqwest::multipart::Form::new()
        .text("model", state.config.asr_model.clone())
        .text("speaker", if state.config.asr_speaker { "true" } else { "false" })
        .part("file", reqwest::multipart::Part::bytes(bytes)
            .file_name("audio.wav").mime_str("audio/wav")?);
    // 热词:治「人名被识成同音字」「术语写成音近词」——研究组场景里这比 CER 那 1 个点更要命。
    // 先用 env 兜底,P2 换成空间级术语表(每个空间维护自己的人名/术语)。
    if let Some(h) = std::env::var("CONGROVE_ASR_HOTWORDS").ok().filter(|s| !s.trim().is_empty()) {
        form = form.text("hotword", h);
    }
    let mut req = crate::auth::build_http_client_long()?
        .post(format!("{base}/audio/transcriptions"))
        .multipart(form);
    if let Some(k) = &state.config.asr_api_key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.context("请求 ASR 服务")?;
    if !resp.status().is_success() {
        let code = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("ASR 返回 {code}:{}", body.chars().take(300).collect::<String>()));
    }
    #[derive(serde::Deserialize)]
    struct Seg { start: Option<f64>, end: Option<f64>, text: String, speaker: Option<String> }
    #[derive(serde::Deserialize)]
    struct Resp { text: Option<String>, segments: Option<Vec<Seg>>, #[allow(dead_code)] duration: Option<f64> }
    let r: Resp = resp.json().await.context("解析 ASR 响应")?;
    if let Some(segs) = r.segments {
        return Ok(segs.into_iter()
            .map(|s| Segment { start: s.start.unwrap_or(0.0), end: s.end.unwrap_or(0.0), text: s.text, speaker: s.speaker })
            .filter(|s| !s.text.trim().is_empty())
            .collect());
    }
    let t = r.text.unwrap_or_default();
    if t.trim().is_empty() { return Ok(vec![]) }
    Ok(vec![Segment { start: 0.0, end: CHUNK_SEC as f64, text: t, speaker: None }])
}

/// 长转写压缩:超过阈值就 map-reduce(分块摘要再合并),避免把 10 万字硬塞进上下文。
async fn condense(state: &AppState, full: &str) -> anyhow::Result<String> {
    if full.chars().count() <= MAP_CHUNK_CHARS {
        return Ok(full.to_string());
    }
    let chars: Vec<char> = full.chars().collect();
    let mut parts = Vec::new();
    for c in chars.chunks(MAP_CHUNK_CHARS) {
        let piece: String = c.iter().collect();
        parts.push(chat(state, "把这段会议转写压缩成要点(中文,保留人名/数字/结论,去掉口水话),不要加评论。", &piece).await?);
    }
    Ok(parts.join("\n\n"))
}

/// 调平台 LLM 网关(OpenAI 兼容)。
async fn chat(state: &AppState, system: &str, user: &str) -> anyhow::Result<String> {
    let base = state.config.llm_base_url.clone().ok_or_else(|| anyhow!("未注入 IAH_BASE_URL,无法调用大模型"))?;
    let body = serde_json::json!({
        "model": state.config.llm_model,
        "messages": [
            {"role": "system", "content": format!("你是会议纪要助手。{system}")},
            {"role": "user", "content": user},
        ],
        "temperature": 0.3,
    });
    let mut req = crate::auth::build_http_client_long()?
        .post(format!("{base}/chat/completions"))
        .json(&body);
    if let Some(k) = &state.config.llm_api_key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.context("请求 LLM 网关")?;
    if !resp.status().is_success() {
        let code = resp.status();
        let t = resp.text().await.unwrap_or_default();
        return Err(anyhow!("LLM 返回 {code}:{}", t.chars().take(300).collect::<String>()));
    }
    let v: serde_json::Value = resp.json().await?;
    Ok(v["choices"][0]["message"]["content"].as_str().unwrap_or_default().trim().to_string())
}

/// 简易 drop 守卫:任务结束(含 panic/早返回)必删临时目录。
fn scopeguard(dir: PathBuf) -> impl Drop {
    struct G(PathBuf);
    impl Drop for G {
        fn drop(&mut self) {
            let d = self.0.clone();
            tokio::spawn(async move { let _ = tokio::fs::remove_dir_all(&d).await; });
        }
    }
    G(dir)
}

use futures_util::TryStreamExt;
