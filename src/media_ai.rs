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
use futures_util::TryStreamExt;

/// ★整段送,不再自己切★(2026-08-03 事故复盘)。读平台服务端源码(`iah-platform-src/asr-funasr/app.py`)
/// 确认它是 `AutoModel(vad_model="fsmn-vad", spk_model="cam++").generate(batch_size_s=300)`——
/// **它自己带 VAD、自己处理小时级长音频**。我原先按 5 分钟硬切有三宗罪:
///   ① ★说话人聚类是按请求做的:第 1 段的 spk0 和第 2 段的 spk0 根本不是同一个人★(最严重);
///   ② 每个边界把一句话腰斩;③ 丢上下文,VAD 本可按语义停顿切。
/// 体积问题用 **opus 压缩**解决:61 分钟 16k/mono WAV ≈ 117MB → opus 24kbps ≈ 11MB,
/// 服务端反正要用 ffmpeg 转码,收 opus 无碍。
const FALLBACK_CHUNK_SEC: u32 = 900;
/// 摘要的分块上限(字符)。超过就 map-reduce:分块摘要 → 再摘要
/// (时序内容用层级合并,研究显示能匹配甚至略超全上下文,且便宜得多)。
/// 8000 而非 12000:首次实测 12000 字 + 思考模式把网关拖到 **502 上游 ReadTimeout**;
/// 块小一点单次生成短、更不容易触发上游读超时。
const MAP_CHUNK_CHARS: usize = 8_000;
/// LLM 调用重试:网关偶发 502/上游读超时是常态(模型排队/缩零冷启),重试比整个任务失败便宜。
const LLM_RETRIES: u32 = 3;

#[derive(Serialize, serde::Deserialize, Clone)]
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
    // 发起人:网关按 X-Iah-End-User 把用量/计费记到真人头上(subject fail-closed,不带头会被拒)。
    let end_user: String = sqlx::query_scalar("SELECT requested_by FROM media_jobs WHERE id=$1")
        .bind(job_id).fetch_one(&state.pool).await?;
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

    // 2) 抽音轨:16k 单声道,**opus 24kbps**(体积 ≈ WAV 的 1/10,服务端 ffmpeg 照收)
    stage(&state.pool, job_id, "抽取音轨", 15).await;
    let audio = workdir.join("audio.opus");
    run_ffmpeg(&["-i", video.to_str().unwrap(), "-vn", "-ac", "1", "-ar", "16000",
                 "-c:a", "libopus", "-b:a", "24k", "-y", audio.to_str().unwrap()]).await
        .context("ffmpeg 抽音轨")?;
    let _ = tokio::fs::remove_file(&video).await; // 视频用完即删,腾出临时盘

    // 3) 切段 + 转写
    let asr_base = state.config.asr_base_url.clone()
        .ok_or_else(|| anyhow!("未注入 IAH_BASE_URL,无法调用语音转写"))?;
    // ★整段一次送★:说话人聚类与句子边界都由服务端在全局做,这是标签跨段一致的前提。
    stage(&state.pool, job_id, "语音转写(整段)", 25).await;
    let mut asr_full_text = String::new();
    let mut segments: Vec<Segment> = match transcribe(state, &asr_base, &audio, &end_user).await {
        Ok((v, full)) => { asr_full_text = full; v }
        Err(e) => {
            // 整段失败(超时/体积/服务端限制)才回退切段——代价是说话人标签跨段不可比,
            // 所以回退时把 speaker 全部抹掉,免得给用户看错误的"谁在说"。
            tracing::warn!(error = %format!("{e:#}"), "整段转写失败,回退分段(将丢弃说话人标签)");
            stage(&state.pool, job_id, "整段失败,改分段转写", 30).await;
            let parts = split_audio(&audio, &workdir).await.context("切分音频")?;
            let mut acc: Vec<Segment> = Vec::new();
            let total = parts.len().max(1);
            for (i, part) in parts.iter().enumerate() {
                stage(&state.pool, job_id, &format!("语音转写 {}/{}", i + 1, total), 30 + (i as i32 * 45 / total as i32)).await;
                let offset = (i as u32 * FALLBACK_CHUNK_SEC) as f64;
                let (mut segs, full) = transcribe(state, &asr_base, part, &end_user).await
                    .with_context(|| format!("转写第 {} 段", i + 1))?;
                if !full.trim().is_empty() { asr_full_text.push_str(&full); asr_full_text.push('\n'); }
                for s in &mut segs { s.start += offset; s.end += offset; s.speaker = None; }
                acc.extend(segs);
                let _ = tokio::fs::remove_file(part).await;
            }
            acc
        }
    };
    // ★存原始细分段★(不在写库时合并):合并规则按用途不同(逐字稿要长、字幕要短),
    // 放在读取时做,调阈值不必重跑 ASR。调研结论见 docs/VIDEO-SUMMARY.md §10。
    segments.retain(|s| !s.text.trim().is_empty());
    if segments.is_empty() {
        return Err(anyhow!("转写结果为空(录屏可能没有人声)"));
    }
    // 喂 LLM 用**服务端返回的全文**而不是拼分段:标点是对整个输入一次性做的,
    // 全文断句质量高于逐段拼接(FunASR 源码:所有 VAD 段文本 join 后一次 punc 推理)。
    let full_text: String = if asr_full_text.trim().chars().count() > 20 {
        asr_full_text.clone()
    } else {
        segments.iter().map(|s| s.text.trim()).collect::<Vec<_>>().join("\n")
    };
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
    stage(&state.pool, job_id, "压缩长转写", 78).await;
    let condensed = condense(state, &full_text, &end_user).await.context("压缩长转写")?;
    for (kind, prompt, label, prog) in [
        ("brief", "用中文写一段 150~300 字的会议摘要,直接给结论,不要客套和小标题。", "生成摘要", 84),
        ("outline", "用中文列出分段大纲:每段一行,格式「时间范围 — 议题:要点」,按时间顺序,不超过 15 行。", "生成分段大纲", 90),
        ("decisions", "用中文列出这次会议的**关键决议**与**待办事项**(谁负责、做什么、何时);没有就写「无明确决议/待办」。", "生成决议与待办", 96),
    ] {
        stage(&state.pool, job_id, label, prog).await;
        let content = chat(state, prompt, &condensed, &end_user).await.with_context(|| format!("生成 {kind}"))?;
        sqlx::query(
            "INSERT INTO summaries (item_id, kind, content, model) VALUES ($1,$2,$3,$4)
             ON CONFLICT (item_id, kind) DO UPDATE SET content=EXCLUDED.content, model=EXCLUDED.model, created_at=now()",
        )
        .bind(item_id).bind(kind).bind(&content).bind(&state.config.llm_model)
        .execute(&state.pool).await?;
    }
    Ok(())
}

/// 合并规则(2026-08-03 深调研落地,阈值全部有出处):
/// **两套不同的输出,不能共用一套阈值**——
/// - 逐字稿/段落:读的人可以慢慢看,合到 200 字/60 秒,信息密度高;
/// - 字幕 cue:Netflix 简中规范 **单行 16 字 × 最多 2 行 = 32 字**、时长 1.2~7 秒、
///   **≤9 字/秒**;超了就是糊屏,再合并只会更糟(我 v0.3.19 用 120 字喂字幕是错的)。
/// 共同的硬规则:**说话人一变无条件断开**(优先级高于标点),这是"谁说了什么"的分界。
/// 眼动实验(PMC7901653):断错位置让回看次数 +48%、主观疲劳显著上升,但理解率不变——
/// 所以宁可段短,也别在词中间断。
const MERGE_GAP_SEC: f64 = 1.2;
/// 停顿超过它无条件断(whisper 的 long_pause 惯例)。
const HARD_GAP_SEC: f64 = 3.0;

/// 逐字稿:合成可读段落。
pub fn merge_paragraphs(segs: &[Segment]) -> Vec<Segment> {
    merge_with(segs, 200, 60.0, false)
}

/// 字幕 cue:Netflix 简中上限(32 字/7 秒),且不跨句末标点合并。
pub fn merge_cues(segs: &[Segment]) -> Vec<Segment> {
    merge_with(segs, 32, 7.0, true)
}

fn merge_with(segs: &[Segment], max_chars: usize, max_sec: f64, stop_at_sentence_end: bool) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::with_capacity(segs.len() / 3 + 1);
    for s in segs {
        let t = s.text.trim();
        if t.is_empty() { continue }
        let mergeable = match out.last() {
            Some(last) => {
                last.speaker == s.speaker
                    && s.start - last.end <= MERGE_GAP_SEC
                    && s.start - last.end < HARD_GAP_SEC
                    && last.text.chars().count() + t.chars().count() <= max_chars
                    && s.end - last.start <= max_sec
                    // 字幕不跨句末标点合并:一条 cue 就是一句话,读起来才自然
                    && !(stop_at_sentence_end && last.text.ends_with(['。', '?', '？', '!', '！']))
            }
            None => false,
        };
        if mergeable {
            let last = out.last_mut().unwrap();
            last.text.push_str(t);
            last.end = s.end;
        } else {
            out.push(Segment { start: s.start, end: s.end, text: t.to_string(), speaker: s.speaker.clone() });
        }
    }
    out
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
    let pattern = dir.join("part-%04d.opus");
    run_ffmpeg(&["-i", wav.to_str().unwrap(), "-f", "segment",
                 "-segment_time", &FALLBACK_CHUNK_SEC.to_string(), "-c", "copy", "-y", pattern.to_str().unwrap()]).await?;
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
async fn transcribe(state: &AppState, base: &str, part: &Path, end_user: &str) -> anyhow::Result<(Vec<Segment>, String)> {
    let bytes = tokio::fs::read(part).await?;
    // 契约见 AI_Talks 0124:file / model=funasr / hotword(空格分隔) / speaker。
    let mut form = reqwest::multipart::Form::new()
        .text("model", state.config.asr_model.clone())
        .text("speaker", if state.config.asr_speaker { "true" } else { "false" })
        .part("file", reqwest::multipart::Part::bytes(bytes)
            .file_name("audio.opus").mime_str("audio/ogg")?);
    // 热词:治「人名被识成同音字」「术语写成音近词」——研究组场景里这比 CER 那 1 个点更要命。
    // 先用 env 兜底,P2 换成空间级术语表(每个空间维护自己的人名/术语)。
    if let Some(h) = std::env::var("CONGROVE_ASR_HOTWORDS").ok().filter(|s| !s.trim().is_empty()) {
        form = form.text("hotword", h);
    }
    let mut req = crate::auth::build_http_client_long()?
        .post(format!("{base}/audio/transcriptions"))
        .header("X-Iah-End-User", end_user)
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
    let full = r.text.clone().unwrap_or_default();
    if let Some(segs) = r.segments {
        let v: Vec<Segment> = segs.into_iter()
            .map(|s| Segment { start: s.start.unwrap_or(0.0), end: s.end.unwrap_or(0.0), text: s.text, speaker: s.speaker })
            .filter(|s| !s.text.trim().is_empty())
            .collect();
        if !v.is_empty() { return Ok((v, full)) }
    }
    if full.trim().is_empty() { return Ok((vec![], full)) }
    Ok((vec![Segment { start: 0.0, end: 0.0, text: full.clone(), speaker: None }], full))
}

/// 长转写压缩:超过阈值就 map-reduce(分块摘要再合并),避免把 10 万字硬塞进上下文。
async fn condense(state: &AppState, full: &str, end_user: &str) -> anyhow::Result<String> {
    // 注:调用方已把 stage 设为「压缩长转写」;这里不再逐块改 stage(块数多时刷屏)。
    if full.chars().count() <= MAP_CHUNK_CHARS {
        return Ok(full.to_string());
    }
    let chars: Vec<char> = full.chars().collect();
    let mut parts = Vec::new();
    for c in chars.chunks(MAP_CHUNK_CHARS) {
        let piece: String = c.iter().collect();
        parts.push(chat(state, "把这段会议转写压缩成要点(中文,保留人名/数字/结论,去掉口水话),不要加评论。", &piece, end_user).await?);
    }
    Ok(parts.join("\n\n"))
}

/// 调平台 LLM 网关(OpenAI 兼容)。
async fn chat(state: &AppState, system: &str, user: &str, end_user: &str) -> anyhow::Result<String> {
    let mut last: Option<anyhow::Error> = None;
    for attempt in 1..=LLM_RETRIES {
        match chat_once(state, system, user, end_user).await {
            Ok(v) if !v.trim().is_empty() => return Ok(v),
            Ok(_) => last = Some(anyhow!("模型返回空内容")),
            Err(e) => {
                tracing::warn!(attempt, error = %format!("{e:#}"), "LLM 调用失败,重试");
                last = Some(e);
            }
        }
        tokio::time::sleep(Duration::from_secs(3 * attempt as u64)).await;
    }
    Err(last.unwrap_or_else(|| anyhow!("LLM 调用失败")))
}

async fn chat_once(state: &AppState, system: &str, user: &str, end_user: &str) -> anyhow::Result<String> {
    let base = state.config.llm_base_url.clone().ok_or_else(|| anyhow!("未注入 IAH_BASE_URL,无法调用大模型"))?;
    // ★关掉思考模式★:Qwen3.6 默认把推理过程写进 content(实测开头是 "Here's a thinking process:"),
    // 纪要会带一大段自言自语。chat_template_kwargs.enable_thinking=false 实测干净(2026-08-03 验)。
    // max_tokens 兜住:没有上限时思考模型能生成很久,任务看起来像卡死。
    let body = serde_json::json!({
        "model": state.config.llm_model,
        "messages": [
            {"role": "system", "content": format!("你是会议纪要助手。{system}")},
            {"role": "user", "content": user},
        ],
        "temperature": 0.3,
        "max_tokens": 1800,
        "chat_template_kwargs": {"enable_thinking": false},
    });
    let mut req = crate::auth::build_http_client_long()?
        .post(format!("{base}/chat/completions"))
        .header("X-Iah-End-User", end_user)
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
    let raw = v["choices"][0]["message"]["content"].as_str().unwrap_or_default().trim();
    Ok(strip_thinking(raw))
}

/// 兜底剥思考前言:万一某天网关/模型忽略了 enable_thinking,别让"思考过程"混进纪要。
/// 认两种常见形态:`</think>` 结束标记,以及英文思考开场白后的第一个空行分段。
fn strip_thinking(s: &str) -> String {
    if let Some(i) = s.rfind("</think>") {
        return s[i + 8..].trim().to_string();
    }
    let head = s.chars().take(40).collect::<String>().to_lowercase();
    if head.contains("thinking process") || head.starts_with("okay, the user") {
        if let Some(i) = s.rfind("\n\n") {
            return s[i..].trim().to_string();
        }
    }
    s.to_string()
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

