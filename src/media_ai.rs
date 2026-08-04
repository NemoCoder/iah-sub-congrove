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
    // 启动扫地:正常结束由 scopeguard 的 Drop 清,但进程被 OOM/驱逐/重启打断时 Drop 跑不到,
    // 半截录屏会留在容器可写层里慢慢攒(2026-08-04 用户问到)。反正内存态任务都随进程没了,
    // 上面刚把它们打回 queued 要重跑,残留文件一个都不用留。
    if tokio::fs::remove_dir_all("/tmp/congrove-media").await.is_ok() {
        tracing::info!("media_ai: 已清理上次进程遗留的临时录屏目录");
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
    // ★转写术语表★(迁移 0007):本空间的词表 + env 全局兜底。人名/专业词按组不同,
    // 所以主真相源是空间设置里那张表(空间管理员维护),env 只留给「全所都要纠」的少数词。
    let hotwords = load_hotwords(&state.pool, item_id).await;
    if !hotwords.is_empty() {
        tracing::info!(words = hotwords.split_whitespace().count(), "转写将带术语表");
    }
    // ★整段一次送★:说话人聚类与句子边界都由服务端在全局做,这是标签跨段一致的前提。
    stage(&state.pool, job_id, "语音转写(整段)", 25).await;
    let mut asr_full_text = String::new();
    let mut char_ts: Vec<(f64, f64)> = Vec::new();
    let mut segments: Vec<Segment> = match transcribe(state, &asr_base, &audio, &end_user, &hotwords).await {
        Ok(a) => { asr_full_text = a.text; char_ts = a.char_ts; a.segments }
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
                let a = transcribe(state, &asr_base, part, &end_user, &hotwords).await
                    .with_context(|| format!("转写第 {} 段", i + 1))?;
                if !a.text.trim().is_empty() { asr_full_text.push_str(&a.text); asr_full_text.push('\n'); }
                let mut segs = a.segments;
                for s in &mut segs { s.start += offset; s.end += offset; s.speaker = None; }
                // 字级时间戳同样要加回段偏移,否则拼起来的全局数组是错的。
                char_ts.extend(a.char_ts.into_iter().map(|(x, y)| (x + offset, y + offset)));
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
        "INSERT INTO transcripts (item_id, text, segments, model, duration_sec, char_ts) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (item_id) DO UPDATE SET text=EXCLUDED.text, segments=EXCLUDED.segments,
           model=EXCLUDED.model, duration_sec=EXCLUDED.duration_sec, char_ts=EXCLUDED.char_ts, created_at=now()",
    )
    .bind(item_id).bind(&full_text).bind(serde_json::to_value(&segments)?)
    .bind(&state.config.asr_model).bind(duration)
    .bind((!char_ts.is_empty()).then(|| serde_json::to_value(&char_ts)).transpose()?)
    .execute(&state.pool).await?;

    // 4) 出纪要(三份:摘要 / 分段大纲 / 决议待办)
    // ★喂给 LLM 的稿子必须带时间戳★(2026-08-04 反馈:大纲里时间全是 00:00)——
    // 之前喂的是纯 full_text,一个时间都没有,模型只能瞎编一个 00:00。
    // 现在按段落(200 字/60 秒)前缀 [mm:ss],模型照抄即可,前端再把它变成可点的跳转。
    stage(&state.pool, job_id, "压缩长转写", 78).await;
    let timed = timed_transcript(&full_text, &segments, &char_ts);
    let condensed = condense(state, &timed, &end_user).await.context("压缩长转写")?;
    for (kind, prompt, label, prog) in [
        ("brief", "用中文写一段 150~300 字的会议摘要,直接给结论,不要客套和小标题。", "生成摘要", 84),
        ("outline", "用中文列出分段大纲,按时间顺序,不超过 15 行。★每行必须以原文里出现过的时间戳开头★,\
格式:`[mm:ss] 议题 — 要点`。时间戳只能从原文抄,**绝对不许自己编**(原文每段开头的 [mm:ss] 就是它的真实时间);\
一行一个议题,行与行之间用换行分隔,不要写成一段。", "生成分段大纲", 90),
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

/// ★用全文把分段的句界重排★(2026-08-04 实测,FunASR 1.4.0 仍有):
/// `sentence_info` 的句界**系统性右移一个字**——「我来的是柯老师来了文本关系然。」「后呢这，」
/// 「个就是我跟徐晨老师讨论之后呢我,」;而**同一次响应里的全文 `text` 标点完全正确**——
/// 「……文本关系。然后呢,这个就是我跟徐晨老师讨论之后呢,我们……」。
/// 即:错的只是分段索引,不是识别结果。所以**文本只信全文、时间轴只信分段**:
/// 去掉标点与空白后两条字符流逐字相同(实测 1476 段全程对得上),按字符位置把全文重新切段,
/// 每个字的时间在其所属分段内线性插值。
///
/// 为什么不在 congrove 侧「凑合合并」:合并只能拼接**同一说话人的相邻段**,而错位往往正好
/// 发生在说话人标签翻转处(「第一。」spk0 /「步,」spk3),合并被阻断 → 留下 2 字 cue 一闪而过。
/// 根治只能回到字符级。⚠ 对不上就返回 None,调用方退回原分段——宁可保守也不能把时间轴搞错。
pub fn realign(text: &str, segs: &[Segment], char_ts: &[(f64, f64)]) -> Option<Vec<Segment>> {
    if text.trim().is_empty() || segs.is_empty() { return None }
    // 分段侧:每个「实字」(非标点非空白)一条 (字, 起, 止, 说话人),段内按字数线性插值。
    #[allow(clippy::type_complexity)]
    let mut chars: Vec<(char, f64, f64, Option<String>)> = Vec::with_capacity(text.chars().count());
    // token 边界(下标, 字数):字级时间戳是**按 token 给的**,详见下面 char_ts 那段。
    let mut tokens: Vec<(usize, usize)> = Vec::new();
    for s in segs {
        // 先摊平成实字,并记住「与上一个实字之间是否隔着空白/标点」——切 token 要用它。
        let mut content: Vec<(char, bool)> = Vec::new();
        let mut sep = true;
        for c in s.text.chars() {
            if is_skippable(c) { sep = true; continue }
            content.push((c, sep));
            sep = false;
        }
        if content.is_empty() { continue }
        let base = chars.len();
        let (n, span) = (content.len() as f64, (s.end - s.start).max(0.0));
        for (i, (c, brk)) in content.iter().enumerate() {
            // 兜底时间:段内按字数线性插值(没有字级时间戳时就用这个)。
            let a = s.start + span * (i as f64) / n;
            chars.push((*c, a, a + span / n, s.speaker.clone()));
            // 连着的 ASCII 字母数字算**一个** token(「metric」1 条不是 6 条);其余每字一个。
            let joins = !*brk && c.is_ascii_alphanumeric()
                && tokens.last().is_some_and(|&(st, ln)| {
                    st + ln == chars.len() - 1 && chars[st].0.is_ascii_alphanumeric()
                });
            if joins { tokens.last_mut().unwrap().1 += 1 } else { tokens.push((chars.len() - 1, 1)) }
        }
        debug_assert!(chars.len() - base == content.len());
    }
    // ★有字级时间戳就用它★(平台 asr-funasr v4 起提供,0137)——这是 46 秒漂移的解药:
    // 时间不再由 sentence_info 的句界决定,而是每个字自己的 CIF 对齐时间。
    // ⚠ 它是**按 token 给的,不是按字**:2026-08-04 线上实测 61 分钟那段 char_ts=16792 条、
    //   实字 17338 个,差 546——正好等于「英文/数字连写整串算一条」的差额
    //   (按分段文本切出的 token 数 = 16792,**逐个吻合**)。
    //   必须拿**分段文本**切:全文里英文之间没有空格(evaluation+function 粘成 evaluationfunction),
    //   只有分段文本保留了空格。对上之后最后一个实字落在 3670.2s = 音频真实结尾(此前 3624s 就用完)。
    if char_ts.len() == tokens.len() {
        for (&(st, ln), t) in tokens.iter().zip(char_ts.iter()) {
            // 一个 token 里的多个字符(英文单词)按字数均分它的时间跨度。
            let (a, b) = (t.0, t.1);
            for k in 0..ln {
                chars[st + k].1 = a + (b - a) * (k as f64) / (ln as f64);
                chars[st + k].2 = a + (b - a) * ((k + 1) as f64) / (ln as f64);
            }
        }
    } else if char_ts.len() == chars.len() {
        // 万一哪天服务端改成按字给,也直接能用。
        for (c, t) in chars.iter_mut().zip(char_ts.iter()) { c.1 = t.0; c.2 = t.1 }
    }
    // 全文侧:实字必须与分段侧逐字相同,否则说明两边不是同一次响应(或热词替换只改了一边)。
    let full: Vec<char> = text.chars().collect();
    // ⚠ 比对**忽略大小写**:全文里句首英文会被大写(「……都没有听清Ok就是」),分段里是原样小写
    //   (「听清ok就是」)。实测 17338 个实字里只有这一类差异,不放过就会整段退回原分段(白修)。
    if full.iter().filter(|c| !is_skippable(**c)).count() != chars.len() { return None }
    if full.iter().filter(|c| !is_skippable(**c)).zip(chars.iter())
        .any(|(a, b)| !a.eq_ignore_ascii_case(&b.0)) { return None }

    // 按标点把全文切成细单元(与 sentence_info 本该给的粒度一致),再交给既有的两套合并阈值。
    let mut out: Vec<Segment> = Vec::new();
    let (mut buf, mut spks) = (String::new(), Vec::<Option<String>>::new());
    let (mut start, mut end, mut k) = (0.0_f64, 0.0_f64, 0usize);
    for c in full {
        if !is_skippable(c) {
            let (_, a, b, spk) = &chars[k];
            if buf.chars().all(is_skippable) { start = *a }   // 单元的第一个实字定起点
            end = *b;
            spks.push(spk.clone());
            k += 1;
        }
        buf.push(c);
        if is_break(c) && !buf.chars().all(is_skippable) {
            out.push(Segment { start, end, text: buf.trim().to_string(), speaker: majority(&spks) });
            buf.clear(); spks.clear();
        }
    }
    if !buf.chars().all(is_skippable) {
        out.push(Segment { start, end, text: buf.trim().to_string(), speaker: majority(&spks) });
    }
    (!out.is_empty()).then_some(out)
}

/// 对齐时忽略的字符:标点与空白。全文不带空格而分段在英文两侧补了空格
/// (「这个AI的」vs「这个 AI 的」),所以空白也必须跳过,否则字符流对不上。
fn is_skippable(c: char) -> bool {
    c.is_whitespace() || c.is_ascii_punctuation() || matches!(c,
        '。' | '，' | '、' | '；' | '：' | '？' | '！' | '…' | '—' | '～'
        | '“' | '”' | '‘' | '’' | '（' | '）' | '《' | '》' | '〈' | '〉' | '「' | '」' | '·')
}

/// 细单元的断点:句末与句中标点都断——粒度交给 merge_paragraphs / merge_cues 去收。
fn is_break(c: char) -> bool {
    matches!(c, '。' | '，' | '？' | '！' | '；' | '、' | '：' | '.' | ',' | '?' | '!' | ';')
}

/// 一个单元里出现最多的说话人(错位处会混入邻座一两个字,取众数才稳)。
fn majority(spks: &[Option<String>]) -> Option<String> {
    let mut best: Option<(String, usize)> = None;
    for s in spks.iter().flatten() {
        let n = spks.iter().flatten().filter(|x| *x == s).count();
        if best.as_ref().is_none_or(|(_, m)| n > *m) { best = Some((s.clone(), n)) }
    }
    best.map(|(s, _)| s)
}

/// ★时间轴漂移自检★(2026-08-04 实测):ASR 给的**段时间戳是对的**(尾段落在音频真实结尾),
/// 但**文字被过快消耗**——61 分钟的会,文字在 3624 秒就用完,末尾几段只剩标点,
/// 于是字幕越走越快(一小时累计提前 46 秒,约 1.25%;与英文/数字连写的累计量相关 r=0.66,
/// 是「标点/分词单元 vs timestamp 单元」错配,已发信 0136 请平台透出字级 timestamp)。
///
/// 判据就用这个自证现象:**最后一个「有字」的段离音频结尾差多少**。返回秒数,
/// 前端据此提示「时间轴可能不准」——不能默默给用户一份越走越快的字幕。
/// 阈值交给前端(现取 max(15 秒, 2%)),这里只给事实。
pub fn timeline_drift(segs: &[Segment], duration_sec: Option<f64>) -> Option<f64> {
    let dur = duration_sec?;
    if dur <= 0.0 { return None }
    let last_text_end = segs.iter().rev()
        .find(|s| s.text.chars().any(|c| !is_skippable(c)))
        .map(|s| s.end)?;
    Some((dur - last_text_end).max(0.0))
}

/// 给 LLM 的稿子:每个段落前缀 `[mm:ss]`,让它能写出真实时间的分段大纲。
/// 用与逐字稿同一套合并(200 字/60 秒),所以模型看到的时间点和用户点开逐字稿看到的一致。
pub fn timed_transcript(text: &str, segs: &[Segment], char_ts: &[(f64, f64)]) -> String {
    let fine = realign(text, segs, char_ts).unwrap_or_else(|| segs.to_vec());
    let paras = merge_paragraphs(&fine);
    if paras.is_empty() { return text.to_string() }
    let mut out = String::with_capacity(text.len() + paras.len() * 10);
    for p in &paras {
        let (m, sec) = ((p.start / 60.0) as u64, (p.start % 60.0) as u64);
        out.push_str(&format!("[{m:02}:{sec:02}] "));
        if let Some(spk) = &p.speaker { out.push_str(spk); out.push_str(": ") }
        out.push_str(p.text.trim());
        out.push('\n');
    }
    out
}

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
/// ⚠ 这里的 `try_next` 是 `aws_sdk_s3::primitives::ByteStream` 的**固有方法**,
/// 不需要 `use futures_util::TryStreamExt`(加了反而是 unused import 警告,v0.3.27 清掉了)。
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
/// 一次 ASR 的产出:细分段 + 全文 + **字级时间戳**(与全文实字一一对应,单位秒)。
pub struct Asr { pub segments: Vec<Segment>, pub text: String, pub char_ts: Vec<(f64, f64)> }

/// 取这个视频该用的术语表:所在空间的词表 + `CONGROVE_ASR_HOTWORDS` 全局兜底,去重保序。
/// 查不到空间(视频已删等)也不让转写失败——最多是没热词。
async fn load_hotwords(pool: &PgPool, item_id: i64) -> String {
    let space: Option<String> = sqlx::query_scalar(
        "SELECT s.hotwords FROM items i JOIN spaces s ON s.id = i.space_id WHERE i.id = $1",
    ).bind(item_id).fetch_optional(pool).await.ok().flatten();
    let env = std::env::var("CONGROVE_ASR_HOTWORDS").unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    for w in space.unwrap_or_default().split_whitespace().chain(env.split_whitespace()) {
        if !out.iter().any(|x| x == w) { out.push(w.to_string()) }
    }
    out.join(" ")
}

async fn transcribe(state: &AppState, base: &str, part: &Path, end_user: &str, hotwords: &str) -> anyhow::Result<Asr> {
    let bytes = tokio::fs::read(part).await?;
    // 契约见 AI_Talks 0124:file / model=funasr / hotword(空格分隔) / speaker。
    let mut form = reqwest::multipart::Form::new()
        .text("model", state.config.asr_model.clone())
        .text("speaker", if state.config.asr_speaker { "true" } else { "false" })
        .part("file", reqwest::multipart::Part::bytes(bytes)
            .file_name("audio.opus").mime_str("audio/ogg")?);
    // 热词:治「人名被识成同音字」「术语写成音近词」——研究组场景里这比 CER 那 1 个点更要命。
    // 词表来自空间设置(迁移 0007)+ env 兜底,由 load_hotwords 合并;平台收 `hotword`(空格分隔),
    // 服务端内部转 postprocess_hotwords(拼音模糊匹配的确定性替换,0128→0130)。
    if !hotwords.trim().is_empty() {
        form = form.text("hotword", hotwords.to_string());
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
    struct Seg {
        start: Option<f64>, end: Option<f64>, text: String, speaker: Option<String>,
        /// asr-funasr v4 起每段自带字级时间戳(毫秒);顶层为空时退用它拼。
        timestamp: Option<Vec<Vec<f64>>>,
    }
    #[derive(serde::Deserialize)]
    struct Resp {
        text: Option<String>, segments: Option<Vec<Seg>>, #[allow(dead_code)] duration: Option<f64>,
        /// 顶层全局字级时间戳(毫秒),与全文 text 对齐——这是我们要的那份(0137)。
        timestamp: Option<Vec<Vec<f64>>>,
    }
    let r: Resp = resp.json().await.context("解析 ASR 响应")?;
    let full = r.text.clone().unwrap_or_default();
    // 毫秒 → 秒;顶层优先,顶层空就把每段的按序拼起来(0137 说全 pipeline 下有时只在段里)。
    let ms2s = |v: &Vec<Vec<f64>>| -> Vec<(f64, f64)> {
        v.iter().filter(|p| p.len() >= 2).map(|p| (p[0] / 1000.0, p[1] / 1000.0)).collect()
    };
    let mut char_ts: Vec<(f64, f64)> = r.timestamp.as_ref().map(ms2s).unwrap_or_default();
    if let Some(segs) = r.segments {
        if char_ts.is_empty() {
            char_ts = segs.iter().filter_map(|s| s.timestamp.as_ref()).flat_map(|v| ms2s(v)).collect();
        }
        let v: Vec<Segment> = segs.into_iter()
            .map(|s| Segment { start: s.start.unwrap_or(0.0), end: s.end.unwrap_or(0.0), text: s.text, speaker: s.speaker })
            .filter(|s| !s.text.trim().is_empty())
            .collect();
        // ★这条日志就是 0137 要我验的那点★:字级时间戳条数 vs 全文实字数。
        // 相等 = 「第 i 实字配第 i 时间戳」成立,时间轴根治;不等 = 仍是单元错配,得上 fa-zh 强制对齐。
        let n_chars = full.chars().filter(|c| !is_skippable(*c)).count();
        tracing::info!(char_ts = char_ts.len(), content_chars = n_chars, segs = v.len(),
            aligned = (!char_ts.is_empty() && char_ts.len() == n_chars), "ASR 字级时间戳对齐自检");
        if !v.is_empty() { return Ok(Asr { segments: v, text: full, char_ts }) }
    }
    if full.trim().is_empty() { return Ok(Asr { segments: vec![], text: full, char_ts }) }
    Ok(Asr { segments: vec![Segment { start: 0.0, end: 0.0, text: full.clone(), speaker: None }], text: full, char_ts })
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


#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64, text: &str, spk: &str) -> Segment {
        Segment { start, end, text: text.into(), speaker: Some(spk.into()) }
    }

    /// 样本取自 2026-08-04 线上真实转写(item 20,30 分钟处):句界右移一字、
    /// 且正好在说话人翻转处断开(「第一。」spk0 /「步,」spk3),是最坏的那种。
    #[test]
    fn realign_修正右移一字的句界() {
        let full = "是说接下来我们分两步。第一步，就是说如果说我们评出来这个大模型不错。";
        let segs = vec![
            seg(1824.0, 1826.0, "是说接下来我们分两步第一。", "spk0"),
            seg(1826.0, 1826.2, "步，", "spk3"),
            seg(1826.8, 1830.0, "就是说如果说我们评", "spk3"),
            seg(1830.0, 1835.7, "出来这个大模型不错。", "spk3"),
        ];
        let out = realign(full, &segs, &[]).expect("实字流一致,必须能对齐");
        let texts: Vec<&str> = out.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(texts, vec!["是说接下来我们分两步。", "第一步，", "就是说如果说我们评出来这个大模型不错。"]);
        // 时间轴仍来自分段:第一个单元不能超出它覆盖的字所在的分段范围。
        assert!(out[0].start >= 1824.0 && out[0].end <= 1826.0 + 0.01);
        assert!(out[1].start >= 1824.0 && out[1].end <= 1826.2 + 0.01);
        // 说话人取众数:「第一步,」三个字里 spk0 占两个。
        assert_eq!(out[1].speaker.as_deref(), Some("spk0"));
    }

    /// 全文不带空格、分段在英文两侧补空格——空白必须跳过,否则对不上就白白退回原分段。
    #[test]
    fn realign_忽略英文两侧的空格() {
        let full = "不熟悉这个AI的范式。";
        let segs = vec![seg(0.0, 2.0, "不熟悉这个 AI 的范式。", "spk0")];
        let out = realign(full, &segs, &[]).expect("空白不该算进字符流");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].text, "不熟悉这个AI的范式。");
    }

    /// 全文句首英文被大写、分段里是小写——线上 17338 字里唯一的一类差异,必须能对上。
    #[test]
    fn realign_忽略英文大小写() {
        let out = realign("都没有听清Ok就是。", &[seg(0.0, 2.0, "都没有听清ok就是。", "spk0")], &[]);
        assert_eq!(out.expect("大小写不该算分歧").len(), 1);
    }

    /// ★字级时间戳是按 token 给的★:英文/数字连写整串一条。线上实测 16792 条 vs 17338 实字,
    /// 差 546 全在英文词上。这条用例锁住这个换算,改坏了 46 秒漂移就会回来。
    #[test]
    fn realign_字级时间戳按token对齐英文词() {
        let full = "这个AI的范式。";                       // 全文:英文两侧无空格
        let segs = vec![seg(0.0, 9.0, "这个 AI 的范式。", "spk0")]; // 分段:英文两侧有空格
        // 实字 7 个(这个AI的范式),token 6 个(AI 算一条)。给 6 条时间戳。
        let cts = [(1.0, 2.0), (2.0, 3.0), (3.0, 5.0), (5.0, 6.0), (6.0, 7.0), (7.0, 8.0)];
        let out = realign(full, &segs, &cts).expect("token 数对得上");
        assert_eq!(out.len(), 1);
        assert!((out[0].start - 1.0).abs() < 1e-9, "起点取第一个 token 的起 {}", out[0].start);
        assert!((out[0].end - 8.0).abs() < 1e-9, "终点取最后一个 token 的止 {}", out[0].end);
        // 条数既不等于 token 数也不等于实字数 → 忽略,退回段内插值(绝不硬套)。
        let bad = realign(full, &segs, &[(1.0, 2.0), (2.0, 3.0)]).expect("仍能对齐文本");
        assert!(bad[0].start < 1e-9);
    }

    /// 有字级时间戳(平台 v4,0137)时:时间必须来自它,而不是段内插值。
    #[test]
    fn realign_优先用字级时间戳() {
        let full = "一二三。四五。";
        let segs = vec![seg(0.0, 100.0, "一二三。", "spk0"), seg(100.0, 200.0, "四五。", "spk0")];
        // 5 个实字,给一份与分段插值完全不同的时间,验证确实用了它。
        let cts = [(1.0, 2.0), (2.0, 3.0), (3.0, 4.0), (10.0, 11.0), (11.0, 12.0)];
        let out = realign(full, &segs, &cts).expect("实字数一致");
        assert_eq!(out.len(), 2);
        assert!((out[0].start - 1.0).abs() < 1e-9 && (out[0].end - 4.0).abs() < 1e-9, "{:?}", (out[0].start, out[0].end));
        assert!((out[1].start - 10.0).abs() < 1e-9 && (out[1].end - 12.0).abs() < 1e-9);
        // 条数对不上就必须忽略它、退回段内插值(绝不能拿错位的时间硬套)。
        let out2 = realign(full, &segs, &[(1.0, 2.0)]).expect("仍应能对齐,只是不用字级时间");
        assert!(out2[0].start < 1e-9);
    }

    /// 尾部只剩标点 = 文字提前用完 = 时间轴漂了(线上 61 分钟那份就是这个形状)。
    #[test]
    fn timeline_drift_尾部只剩标点算漂移() {
        let segs = vec![
            seg(0.0, 10.0, "有字的一段。", "spk0"),
            seg(3656.8, 3659.3, "。", "spk0"),
            seg(3669.1, 3670.2, "。", "spk0"),
        ];
        let d = timeline_drift(&segs, Some(3670.2)).unwrap();
        assert!((d - 3660.2).abs() < 0.01, "应按最后一个有字的段算,得到 {d}");
        // 文字铺到结尾就不该报漂移。
        assert!(timeline_drift(&[seg(0.0, 3670.0, "一直说到结尾。", "spk0")], Some(3670.2)).unwrap() < 1.0);
    }

    /// 两边不是同一次响应(字都对不上)时必须放弃,绝不能拿错时间轴硬拼。
    #[test]
    fn realign_字符流不一致时放弃() {
        assert!(realign("完全不同的一句话。", &[seg(0.0, 1.0, "原来那句。", "spk0")], &[]).is_none());
    }
}
