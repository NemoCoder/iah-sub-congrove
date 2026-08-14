//! 内容树:文件夹 / 文档(markdown)/ 文件。字节全在 S3,PG 只有元数据(无 PVC 铁律)。
//!
//! S3 key = blobs/<sha256> —— ★内容寻址:同样内容全库只存一份★。
//! (版本恢复、原样重存)天然去重;key 带 item_id,**跨 item 不共享对象**,所以删 item 时
//! 只需对本 item 的 key 做引用计数(items.s3_key + item_versions.s3_key),不会误删别人的。
//!
//! 录屏(video,GB 级)P2 走预签名直传,不从这个文件的 upload 进来(60MB body limit 挡着)。

use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::audit;
use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::perm::{require_role, Role};
use crate::state::AppState;

/// 流式上传的 part 缓冲(S3 multipart 最小 5MiB;8MiB 平衡内存与 part 数——512Mi 资源档下
/// 单上传常驻内存 ≈ 一个 part)。**单文件不限大小**(2026-08-02 用户定,录屏几百 MB 常见),
/// 真正的闸是每项目总配额 quota_bytes(默认 10GiB)。
pub const PART_SIZE: usize = 8 * 1024 * 1024;

/// 内容寻址的对象 key(2026-08-05 去重):**同样内容全库只存一份**。
/// 删除按引用计数(purge_subtree),所以谁删都不影响还引用着它的人。
pub(crate) fn blob_key(sha: &str) -> String {
    format!("blobs/{sha}")
}

/// 上传落地前的**临时** key —— ★与任何哈希无关★。
///
/// ⚠★这是 A2 的根治点(2026-08-09 全量审计,两路独立视角同时报出)★。
/// 不变量是「`blobs/<H>` 里的字节哈希必须等于 H」,整套去重/秒传/引用计数都建在它上面。
/// 而预签名直传原来直接拿**客户端申报的 sha** 当 key,于是:
///   · 占位:先申报别人文件的哈希 H 把 `blobs/H` 占了、塞垃圾;真正拥有那份文件的人
///     后来上传时,流式那条路「对象已存在就直接引用」→ ★静默引用到垃圾,还打上 sha_verified★;
///   · 覆盖:begin 时的 `exists()` 与 complete 之间隔着 6 小时的分片有效期(TOCTOU)。
///
/// ★根治的形式是「谁能往 blobs/* 写」★:收敛成**只有服务端算过哈希的路径**(promote)。
/// 直传一律先落这个临时 key,以后新增任何上传路径也不会重新打开这个洞
/// —— 除非它显式去写 `blobs/`,而那由 `scripts/blobkey-check.sh` 挡着。
pub(crate) fn tmp_upload_key(iid: i64, rand: &str) -> String {
    format!("uploads/{iid}-{rand}")
}

/// 我能不能读到某份内容(按 sha256)——**秒传的安全闸**。
/// 百度网盘那个著名的坑:只凭哈希就能「认领」文件 = 知道哈希的人可以把别人的私有文件
/// 秒传进自己账户。所以这里区分两件事:
///   - **省空间**无条件:真传完字节的人指向同一对象(他确实拥有这份文件,安全);
///   - **省时间(秒传)有条件**:只有当调用者本来就能读到同 sha 的内容时才免传。
pub(crate) async fn readable_blob(state: &AppState, id: &Identity, sha: &str) -> AppResult<Option<(String, Option<i64>, Option<String>)>> {
    let rows: Vec<(i64, String, Option<i64>, Option<String>)> = sqlx::query_as(
        // ★只认 sha_verified★(迁移 0005):客户端申报的哈希不能当秒传源,
        // 否则「申报别人文件的哈希、传自己的内容」会让真正拥有那份文件的人秒传到错误字节。
        "SELECT project_id, s3_key, size, mime FROM items_alive
          WHERE sha256 = $1 AND sha_verified AND s3_key IS NOT NULL AND deleted_at IS NULL -- limit-ok: 内部候选 —— 秒传时找同哈希的若干候选逐个校验可读性,
          --   取到一个能用的就返回;不是给人看的列表。
          LIMIT 50",
    ).bind(sha).fetch_all(&state.pool).await?;
    for (pid, key, size, mime) in rows {
        if crate::perm::effective_role(&state.pool, id, pid).await?.is_some() {
            return Ok(Some((key, size, mime)));
        }
    }
    Ok(None)
}

#[derive(Deserialize)]
pub struct PrecheckIn {
    pub sha256: String,
    pub size: i64,
    pub name: String,
    pub mime: Option<String>,
    pub parent_id: Option<i64>,
}

/// POST /api/projects/{pid}/precheck —— 秒传预检(≥editor)。
/// 命中(我本来就能读到同内容)→ 直接建行指过去,**零字节传输**;否则告诉前端照常传。
pub async fn precheck(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Json(input): Json<PrecheckIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    check_parent(&state.pool, pid, input.parent_id).await?;
    let sha = input.sha256.trim().to_lowercase();
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("sha256 形状不对".into()));
    }
    // ★size 必须非负★(v0.3.55 审计):下面命中时用 `size.unwrap_or(input.size)` —— 库里那份
    // size 为 NULL(历史行)时会退回客户端申报值。申报个负数,配额判断 `used + size > quota`
    // 恒为假、直接放行,还会把负数写进 items.size,把整个空间的已用量算小(甚至算成负的)。
    if input.size < 0 {
        return Err(AppError::BadRequest("size 不能为负".into()));
    }
    let Some((key, size, mime)) = readable_blob(&state, &id, &sha).await? else {
        // 没命中(或命中了但我读不到那份)→ 照常传。key 给出去,传完就是内容寻址的共享对象。
        return Ok(Json(json!({ "instant": false })));
    };
    // 配额照算:秒传省的是传输与存储,不是配额额度(否则同一份东西被反复「免费」摆进各空间)。
    let (quota, used) = owner_quota_used(&state.pool, &project_owner(&state.pool, pid).await?).await?;
    if used + size.unwrap_or(input.size) > quota {
        return Err(AppError::BadRequest("超出配额,删些内容或找超管调额度".into()));
    }
    let name = { let n = input.name.trim(); if n.is_empty() { "unnamed" } else { n } };
    let mime = input.mime.or(mime).unwrap_or_else(|| "application/octet-stream".into());
    let kind = if mime.starts_with("video/") { "video" } else { "file" };
    let iid: i64 = sqlx::query_scalar(
        "INSERT INTO items (project_id, parent_id, kind, name, mime, created_by, s3_key, size, sha256, sha_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING id",
    )
    .bind(pid).bind(input.parent_id).bind(kind).bind(name).bind(&mime)
    .bind(id.require_username()?).bind(&key).bind(size.unwrap_or(input.size)).bind(&sha)
    .fetch_one(&state.pool).await?;
    tracing::info!(item = iid, sha = %&sha[..8], "秒传命中:零字节建立引用");
    crate::http::media::enqueue_analysis(&state, iid, id.require_username()?).await;
    Ok(Json(json!({ "instant": true, "id": iid })))
}

/// 某人的配额与已用量（ADR-0004）。★额度挂在人身上，不挂在项目上★。
///
/// 用量 = 这个人**名下所有项目**里的对象之和。三条判据都是有理由的：
///
/// ① ★算 owner，不算上传者★（口径改过一次，PRD L3）：按上传者的话，项目主持人可以
///    拉一堆人来传东西，占的是**别人**的额度 —— 而材料是他的。
/// ② ★同一 owner 内按 blob 去重★（`GROUP BY t.k`，**不带 project_id**，PRD J2）：
///    内容寻址已经让同内容全库只存一份，同一个人把同一份材料放进两个项目还算两遍，
///    是在收他没花的钱。跨 owner 不去重 —— 否则谁先传谁吃亏。
/// ③ 按 **key** 分组取 `max(size)`，不是按 `(key,size)` 去重：同一个 key 若两行记了
///    不同 size（历史行与当前行先后写入的窗口），`DISTINCT (k,sz)` 会把它算两遍（2026-08-04 审计）。
///
/// ★「没有 user_quota 行」= 用系统默认，不是 0★ —— 新用户不该一上来就超额。
pub async fn owner_quota_used(pool: &sqlx::PgPool, owner: &str) -> AppResult<(i64, i64)> {
    let row: (i64, i64) = sqlx::query_as(
        "SELECT COALESCE((SELECT q.quota_bytes FROM user_quota q WHERE q.username = $1), $2)::bigint,
                COALESCE((SELECT sum(u.sz) FROM (
                    SELECT t.k, max(t.sz) sz FROM (
                        SELECT i.s3_key k, i.size sz FROM items_alive i
                          JOIN projects p ON p.id = i.project_id
                         WHERE p.owner = $1 AND p.deleted_at IS NULL AND i.s3_key IS NOT NULL
                        UNION ALL
                        SELECT v.s3_key, v.size FROM item_versions v
                          JOIN items_alive i ON i.id = v.item_id
                          JOIN projects p ON p.id = i.project_id
                         WHERE p.owner = $1 AND p.deleted_at IS NULL
                    ) t GROUP BY t.k) u), 0)::bigint",
    )
    .bind(owner)
    .bind(crate::config::DEFAULT_QUOTA_BYTES)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// 项目的 owner —— 配额判据要用它（额度算 owner 的，不算操作者的）。
pub async fn project_owner(pool: &sqlx::PgPool, pid: i64) -> AppResult<String> {
    sqlx::query_scalar("SELECT owner FROM projects WHERE id = $1 AND deleted_at IS NULL")
        .bind(pid).fetch_optional(pool).await?.ok_or(AppError::NotFound)
}

/// 某场活动在某个项目里的**专属文件夹**(根下一层),没有就建一个,返回它的 item_id。
///
/// ★命名 = 日期 + 活动标题★(2026-08-09 liaoruili),如 `2026-08-09 组会`。
/// 日期在前是为了**按名字排序就等于按时间排序** —— 一个项目开一年会之后,
/// 这一条比什么都有用。
///
/// ★认领靠 activity_id,不靠名字★:活动改名之后仍然是同一个文件夹,
/// 不会因为标题变了就又建一个、材料散成两处。
/// (代价是文件夹名停在建它的那一刻 —— 可以接受:它记的是「那场会」,不是标题的最新值。)
///
/// ⚠ 并发同时传两个文件会各查各的、都查不到 → 建出两个同名文件夹。
/// 这里靠**部分唯一索引**兜(见 0001_init.sql 的 `items_activity_folder_uniq`):
/// 第二个 INSERT 冲突,回头再查一次拿到第一个建好的那个。
async fn activity_folder(state: &AppState, pid: i64, mid: i64, actor: &str) -> AppResult<i64> {
    if let Some(fid) = find_activity_folder(&state.pool, pid, mid).await? {
        return Ok(fid);
    }
    // 标题里的 `/` 之类不必转义:这是**数据库里的一行**,不是文件系统路径。
    let (title, starts_at, tzname): (String, chrono::DateTime<chrono::Utc>, String) =
        sqlx::query_as("SELECT title, starts_at, timezone FROM activities WHERE id = $1")
            .bind(mid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    let name = activity_folder_name(starts_at, &title, crate::tzutil::parse(&tzname));
    let made: Option<i64> = sqlx::query_scalar(
        "INSERT INTO items (project_id, parent_id, kind, name, created_by, activity_id)
         VALUES ($1, NULL, 'folder', $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id")
        .bind(pid).bind(&name).bind(actor).bind(mid)
        .fetch_optional(&state.pool).await?;
    match made {
        Some(fid) => Ok(fid),
        // 冲突 = 刚刚被另一个并发请求建好了,再查一次
        None => find_activity_folder(&state.pool, pid, mid).await?.ok_or(AppError::NotFound),
    }
}

/// 活动材料文件夹的名字 —— ★全树唯一的定义★。
///
/// ⚠★必须只有一处★:建文件夹在这个文件、改名在 `activities.rs::update`(活动改标题/改时间时
/// 跟着改)。两边各写一遍 `format!` 的话,改一个格式就会漂 —— 而漂了之后
/// **老文件夹和新文件夹长得不一样,却都是"对的"**,没有任何检查会红。
/// (2026-08-09 一天之内已经在「AI 摘要的 kind」「时间粒度」上各栽过一次。)
///
/// ★按东八区取日期,不按 UTC★:UTC 下「8-09 早上 7 点的会」是 8-08,
/// 文件夹名会比会议日期早一天 —— 与 `notify.rs::fmt_when` 用同一个偏移。
///
/// 日期在前 = 按名字排序就等于按时间排序,一个项目开一年会之后这条比什么都有用。
/// ⚠★这一处**不跟着看的人走**,跟着活动自己的时区走★(2026-08-12 实现时纠正的设计)。
/// 设计里把四处写死东八区一并写成「按收件人的时区」,但这一处根本不是显示 ——
/// 它是**存进 `items.name` 的文件夹名**:
///   · 名字一旦建好就固定了,后来者看到的是同一个字符串,「跟着谁走」这个问题本身不成立;
///   · 同一场会不该因为**谁先点开材料页**而得到不同的文件夹名。
/// ★「这场会是哪一天的」是活动自己的属性★,而 `activities.timezone` 正是「按哪儿的钟说的」。
/// 空字符串(老数据 / E1 上线前建的)兜底东八区 —— 与改动前逐字一致。
pub fn activity_folder_name(starts_at: chrono::DateTime<chrono::Utc>, title: &str, tz: chrono_tz::Tz) -> String {
    format!("{} {}", starts_at.with_timezone(&tz).format("%Y-%m-%d"), title.trim())
}

/// 重名时的下一个名字:`a.pdf` → `a (2).pdf` → `a (3).pdf`。★纯函数,单测够得着★。
///
/// ⚠ 扩展名要**留在最后**:`a (2).pdf` 而不是 `a.pdf (2)` —— 后者会让系统按扩展名认类型时失手,
/// 而人也认不出那还是个 PDF。没有扩展名(如 `README`)就直接缀在后面。
pub fn numbered_name(name: &str, n: u32) -> String {
    match name.rfind('.') {
        // 开头就是点的是隐藏文件(`.gitignore`),那个点不算扩展名分隔符
        Some(i) if i > 0 => format!("{} ({}){}", &name[..i], n, &name[i..]),
        _ => format!("{name} ({n})"),
    }
}

async fn find_activity_folder(pool: &sqlx::PgPool, pid: i64, mid: i64) -> AppResult<Option<i64>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM items_alive
          WHERE project_id = $1 AND activity_id = $2 AND kind = 'folder' AND deleted_at IS NULL
          LIMIT 1")
        .bind(pid).bind(mid).fetch_optional(pool).await?)
}

/// item 所属空间(判权都要先拿它;不存在 = 404)。
pub async fn project_of(pool: &sqlx::PgPool, item_id: i64) -> AppResult<i64> {
    sqlx::query_scalar("SELECT project_id FROM items WHERE id = $1")
        .bind(item_id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound)
}

/// 同 `project_of`,但**已经进回收站的条目一律当不存在**(404)。
///
/// ★为什么要有第二个函数,而不是把 `project_of` 直接改严★:
/// `undelete` / `purge` / 引用计数 / 配额 **必须**解析得到已删的条目 —— 改严了它们全废。
/// 所以两个语义并存,由调用方选:★读内容的路径用 `_alive`,回收站生命周期用原来那个。★
///
/// ⚠★这个洞是 2026-08-14 的软删矩阵抓出来的,共 5 处★
/// (`/versions` `/progress` `/subtitles.vtt` `/analysis` `items/{id}/shares`)。
/// 它们躲过了 v0.3.55 那次「一次补齐 11 处」,也躲得过任何
/// 「读 items 的 SQL 必须带 deleted_at IS NULL」的静态检查 —— 原因是同一个:
/// ★它们的数据查询根本不碰 `items` 表★,查的是 `item_versions` / `play_progress` /
/// `transcripts` / `media_jobs` / `share_links` 这些**兄弟表**,只在最开始用
/// `project_of` 解析一下归属。于是「读的是不是已删内容」这件事,在 SQL 层面看不出来。
/// 其中 `/subtitles.vtt` 和 `/analysis` 漏的是**内容本身**(字幕正文、AI 摘要正文)。
pub async fn project_of_alive(pool: &sqlx::PgPool, item_id: i64) -> AppResult<i64> {
    sqlx::query_scalar("SELECT project_id FROM items_alive WHERE id = $1 AND deleted_at IS NULL")
        .bind(item_id)
        .fetch_optional(pool)
        .await?
        .ok_or(AppError::NotFound)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ItemRow {
    pub id: i64,
    /// 所属空间。列表接口用不着(调用方本来就按空间拉),但**分享链接**要靠它:
    /// 拿到 /i/{id} 只知道 item,得先定位到空间才能打开(迁移无关,纯查询字段)。
    #[sqlx(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<i64>,
    pub parent_id: Option<i64>,
    pub kind: String,
    pub name: String,
    pub size: Option<i64>,
    pub mime: Option<String>,
    pub created_by: String,
    /// 上传/创建时间。★列表展示用它而不是 updated_at★:移动、重命名都会刷新 updated_at
    /// (update handler 两条路径都写了 now()),用户看到「刚挪了一下位置,修改时间就变了」很困惑
    /// (2026-08-05 反馈)。
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    /// ★这一项是不是某场活动的材料★(D10 的只读区)。前端靠它决定**不画**改名/移动/删除 ——
    /// 后端已经拒了(update/remove 里有判断),但界面上摆着一个必然失败的按钮
    /// 等于**引导人去犯错**,而报错信息永远比按钮不出现更晚、更难懂。
    #[sqlx(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_id: Option<i64>,
    /// ★客户端申报的哈希与服务端算出的真值不符★(A2/D3):很可能在传输中损坏了。
    /// 预签名分片上没有 checksum,complete 只对**字节数** —— 保长度的损坏能整条过闸。
    /// 不阻止使用(内容自洽),但界面要说出来:此前这个信号被直接改写成了「已核验」。
    #[sqlx(default)]
    pub sha_declared_mismatch: bool,
}

/// GET /api/projects/{pid}/items —— 整空间平铺一次拉全(≥viewer),前端组树。
/// 空间量级(百~千条)不值得做 parent 分页;真到瓶颈再加。
pub async fn list(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
) -> AppResult<Json<Vec<ItemRow>>> {
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    // ★过滤未完成的上传占位行★(s3_key IS NULL 的 file/video):media/begin 会先建行拿 item_id
    // 用于拼 S3 key,传完才回填 s3_key。不过滤的话「还没传完就出现在列表里」(2026-08-03 反馈),
    // 而且点它会 404。上传中的条目由前端自己在表头渲染(带进度与取消)。
    let rows: Vec<ItemRow> = sqlx::query_as(
        "SELECT id, parent_id, kind, name, size, mime, created_by, created_at, updated_at, activity_id, sha_declared_mismatch
           FROM items_alive WHERE project_id = $1 AND deleted_at IS NULL AND (kind IN ('folder','doc') OR s3_key IS NOT NULL)
          ORDER BY kind = 'folder' DESC, name",
    )
    .bind(pid)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// GET /api/items/{id} —— 单项元数据(≥viewer)。独立播放窗(/viewer/{id})靠它拿到
/// 名称/类型/mime,而不必先拉整个空间的列表。
pub async fn detail(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<ItemRow>> {
    let pid = project_of_alive(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let row: Option<ItemRow> = sqlx::query_as(
        "SELECT id, project_id, parent_id, kind, name, size, mime, created_by, created_at, updated_at, activity_id, sha_declared_mismatch
           FROM items_alive WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(iid)
    .fetch_optional(&state.pool)
    .await?;
    row.map(Json).ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
pub struct ProgressIn {
    pub position_sec: f64,
    pub duration_sec: Option<f64>,
}

/// GET /api/items/{id}/progress —— 我上次看到哪(≥viewer)。没看过回 position_sec=0。
pub async fn progress_get(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of_alive(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let row: Option<(f64, Option<f64>)> = sqlx::query_as(
        "SELECT position_sec, duration_sec FROM play_progress WHERE username = $1 AND item_id = $2",
    )
    .bind(id.require_username()?)
    .bind(iid)
    .fetch_optional(&state.pool)
    .await?;
    let (pos, dur) = row.unwrap_or((0.0, None));
    Ok(Json(json!({ "position_sec": pos, "duration_sec": dur })))
}

/// PUT /api/items/{id}/progress —— 记录播放位置(≥viewer,覆盖写)。
/// 前端每 ~5s 与暂停/关窗时打一次;快到结尾(剩 <15s)当作看完,归零以免下次一进来就跳到片尾。
pub async fn progress_put(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Json(input): Json<ProgressIn>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let mut pos = input.position_sec.max(0.0);
    if let Some(d) = input.duration_sec {
        if d > 0.0 && pos > d - 15.0 {
            pos = 0.0; // 看到尾了,下次从头
        }
    }
    sqlx::query(
        "INSERT INTO play_progress (username, item_id, position_sec, duration_sec) VALUES ($1,$2,$3,$4)
         ON CONFLICT (username, item_id) DO UPDATE SET position_sec = EXCLUDED.position_sec,
           duration_sec = COALESCE(EXCLUDED.duration_sec, play_progress.duration_sec), updated_at = now()",
    )
    .bind(id.require_username()?)
    .bind(iid)
    .bind(pos)
    .bind(input.duration_sec)
    .execute(&state.pool)
    .await?;
    Ok(Json(json!({ "ok": true, "position_sec": pos })))
}

#[derive(Deserialize)]
pub struct ItemIn {
    pub kind: String, // 'folder' | 'doc'(file/video 走 upload/预签名,不走这)
    pub name: String,
    pub parent_id: Option<i64>,
}

/// 校验 parent:必须存在、是 folder、在同一空间(防把子树挂到别的空间绕权限)、**且不在回收站里**。
/// ★deleted_at IS NULL★(v0.3.55 审计):原先没这一条,于是能把新建或移动的内容挂到一个
/// 已经删掉的文件夹底下 —— 子项自己 deleted_at 是 NULL、父却不在树里,tree 拉不到它的父,
/// 结果是个**谁也看不见、回收站里也找不到的孤儿**(要等有人恰好还原了那个父目录才会重现)。
pub async fn check_parent(pool: &sqlx::PgPool, pid: i64, parent_id: Option<i64>) -> AppResult<()> {
    // ⚠ 内层变量**不能**也叫 pid:那会遮蔽外层的项目 id,让下面的同项目校验恒假
    //   (2026-08-06 批量改名 sid→pid 时真的踩过一次)。
    if let Some(parent) = parent_id {
        let ok: Option<(i64, String, Option<i64>)> =
            sqlx::query_as("SELECT project_id, kind, activity_id FROM items_alive WHERE id = $1 AND deleted_at IS NULL")
                .bind(parent)
                .fetch_optional(pool)
                .await?;
        match ok {
            // ★不许往活动文件夹里塞东西★(D10 的**写入方向**,2026-08-09 全量审计 A6)。
            //
            // ⚠ 这是 2026-08-09 那次修复**没修完的另一半**:当时堵的是「把活动材料拿出去」
            //   (改名/移动/删除,见 update/remove 里那两处守卫),而「把别的东西塞进来」一直没人管——
            //   `check_parent` 只验「存在 / 是文件夹 / 同项目 / 未软删」,**从不问父节点是不是活动文件夹**。
            //   于是 editor 在项目树里进到 `📁 2026-08-09 组会` 就能直接上传/新建/移入,
            //   产生的行 activity_id 为 NULL → 不受那两道守卫约束、可继续改名删除,却坐在只读区里;
            //   活动页按 activity_id 过滤看不到它们,项目树里看得到 —— 两边各说各话。
            // ★守卫只看「被操作项自己」是不够的,父节点那一侧同样是入口。★
            Some((_, _, Some(_))) =>
                return Err(AppError::BadRequest("这是活动的材料文件夹,只读;要加东西请到那场活动的页面里传".into())),
            Some((parent_pid, kind, None)) if parent_pid == pid && kind == "folder" => {}
            _ => return Err(AppError::BadRequest("父节点不存在或不是本项目的文件夹".into())),
        }
    }
    Ok(())
}

/// 这场活动的材料该不该落在这个项目里 —— ★A1:判权判的是项目,写的却是活动,两者必须对账★。
///
/// ⚠★2026-08-09 全量审计发现的越权口子★:`upload` 判的是**路径上的 pid**(我在这个项目里是不是
/// editor),写进库的却是**请求参数里的 activity_id**,而这两者之间**一次校验都没有**
/// (`items.rs` 全文 `activity_projects` 出现 0 次)。于是:
///   任何登录用户建一个自己的项目 P(自动 admin)→ `POST /projects/P/upload?activity_id=<别人的会>`
///   → 文件出现在**别人活动**的材料/录制里、署我的名;而对方**删不掉也改不了**
///   (那两条接口判的是 item 所属项目,他们在 P 里没角色 → 404);
///   带 `is_recording=true` 还能改写对方的时长统计(口径取 max(duration_sec))。
///
/// 判据与 `activities::materials_project` **同一套**,别在这里另立一套:
///   · 活动有关联项目 → pid 必须是其中之一(且项目未软删);
///   · 活动零关联项目(ADR-0002 的「个人日程」)→ pid 必须是**发起人本人**的材料区。
pub async fn check_activity_target(pool: &sqlx::PgPool, mid: i64, pid: i64, actor: &str) -> AppResult<()> {
    let linked: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM activity_projects mp JOIN projects p ON p.id = mp.project_id
          WHERE mp.activity_id = $1 AND p.deleted_at IS NULL LIMIT 1")
        .bind(mid).fetch_optional(pool).await?;
    if linked.is_some() {
        let ok: Option<i32> = sqlx::query_scalar(
            "SELECT 1 FROM activity_projects WHERE activity_id = $1 AND project_id = $2")
            .bind(mid).bind(pid).fetch_optional(pool).await?;
        // ★回 404 不回 403★:他连「这场活动存在」都不该从这条路确认(与 perm.rs 的口径一致)
        return if ok.is_some() { Ok(()) } else { Err(AppError::NotFound) };
    }
    let ok: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM activities a JOIN projects p ON p.id = $2 AND p.kind = 'materials' AND p.owner = a.organizer
          WHERE a.id = $1 AND a.organizer = $3")
        .bind(mid).bind(pid).bind(actor).fetch_optional(pool).await?;
    if ok.is_some() { Ok(()) } else { Err(AppError::NotFound) }
}

/// POST /api/projects/{pid}/items —— 建文件夹/空文档(≥editor)。
pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Json(input): Json<ItemIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    if input.kind != "folder" && input.kind != "doc" {
        return Err(AppError::BadRequest("kind 只能是 folder 或 doc(文件走上传)".into()));
    }
    let name = input.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("名称不能为空".into()));
    }
    check_parent(&state.pool, pid, input.parent_id).await?;
    let iid: i64 = sqlx::query_scalar(
        "INSERT INTO items (project_id, parent_id, kind, name, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    )
    .bind(pid)
    .bind(input.parent_id)
    .bind(&input.kind)
    .bind(name)
    .bind(id.require_username()?)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(json!({ "id": iid })))
}

#[derive(Deserialize)]
pub struct ItemPatch {
    pub name: Option<String>,
    /// Some(None) 表示移到根:JSON 里传 parent_id: null 移根,不传字段则不动。
    #[serde(default, deserialize_with = "double_option")]
    pub parent_id: Option<Option<i64>>,
}

/// 区分「字段缺席」与「显式 null」:serde 默认二者同貌,包一层 Option。
fn double_option<'de, D>(de: D) -> Result<Option<Option<i64>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<i64>::deserialize(de)?))
}

/// PUT /api/items/{id} —— 改名/移动(≥editor)。移动校验目标 parent 同空间,并拒把文件夹挪进自己的子树(成环即整棵树从视图消失)。
#[derive(Deserialize)]
pub struct CopyIn {
    /// 复制到哪个项目
    pub project_id: i64,
    /// 目标项目里的哪个文件夹（不给 = 根）
    #[serde(default)] pub parent_id: Option<i64>,
    /// 副本叫什么（不给 = 沿用原名）
    #[serde(default)] pub name: Option<String>,
}

/// POST /api/items/{id}/copy —— ★跨项目复制★（PRD J2）。
///
/// ══════ 为什么它「几乎免费」 ══════
/// v0.4 已经是内容寻址（`blobs/<sha256>` + 引用计数），所以复制 =
/// **在目标项目建一行 items 指向同一个 blob**，S3 上一个字节都不增加（秒传用的就是这套）。
///
/// ══════ 四道判据，每道都不能少 ══════
///
///  ① ★源要能读★（`require_role(源项目, Viewer)`）：不判这条就是百度那个
///    「凭一个 id 把别人的文件搬进自己项目」的洞 —— 复制不需要下载，
///    ★所以它绕过了下载路径上的所有检查★，必须自己判一次。
///  ② ★目标要能写★（`require_role(目标项目, Editor)`）：复制是往目标项目里写。
///  ③ ★目标项目的 owner 要有额度★：算的是**目标** owner 的（PRD L3：额度归主持人）。
///    ⚠ 同一 owner 内复制**用量不变** —— 配额 SQL 本来就 `GROUP BY s3_key`
///    （不带 project_id），物理上盘里就一份，为自己的同一份文件收两次费解释不通
///    （2026-08-08 liaoruili 推翻了 PRD 原文的「各算一份」）。
///  ④ ★回收站里的东西不给复制★：与改名/移动同一条纪律（v0.3.55 审计）——
///    要动它先还原，否则「删了但还能复制出来」等于软删除形同虚设。
///
/// ⚠★材料区不能当目标★（ADR-0005 / J1）：它是系统给的个人存档区、整块只读，
///   往里塞东西会绕过「材料归活动」这个结构。**源**可以是材料区 ——
///   PRD J2 的原话就是「把那个 PDF 复制进课题组的项目」，方向正是从材料区往外。
///
/// ⚠★只复制单个文件/文档，不递归复制文件夹★：M1 的闭环判据说的是
///   「给其中一条传一个 PDF，并把那个 PDF 复制进课题组的项目」。
///   递归复制要处理层级、命名冲突、部分失败回滚，是**另一件事**；
///   现在遇到文件夹**明确拒绝并说清楚**，而不是悄悄只复制一层。
pub async fn copy(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Json(p): Json<CopyIn>,
) -> AppResult<Json<serde_json::Value>> {
    // ① 源要能读
    let src_pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, src_pid, Role::Viewer).await?;
    // ② 目标要能写
    require_role(&state.pool, &id, p.project_id, Role::Editor).await?;

    // ⚠ 材料区不能当目标(kind='materials')
    let dst_kind: String = sqlx::query_scalar("SELECT kind FROM projects WHERE id=$1 AND deleted_at IS NULL")
        .bind(p.project_id).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    if dst_kind == "materials" {
        return Err(AppError::BadRequest("「我的活动材料」是系统存档区,不能作为复制目标".into()))
    }

    // ④ 源必须活着,且不是文件夹
    let src: (String, String, Option<String>, Option<String>, Option<i64>, Option<String>) = sqlx::query_as(
        "SELECT kind, name, mime, s3_key, size, sha256 FROM items_alive
          WHERE id = $1 AND deleted_at IS NULL")
        .bind(iid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    if src.0 == "folder" {
        return Err(AppError::BadRequest("暂不支持复制文件夹,请逐个复制里面的文件".into()))
    }

    // ③ 目标 owner 的额度
    let sz = src.4.unwrap_or(0);
    let owner = project_owner(&state.pool, p.project_id).await?;
    let (quota, used) = owner_quota_used(&state.pool, &owner).await?;
    // ⚠★同一 owner 内复制不该被额度挡★:用量按 blob 去重,复制完 used 根本不变。
    //   所以先问一句「这个 blob 在目标 owner 名下已经有了吗」——有就不占新空间。
    let 已有: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM items_alive i JOIN projects pr ON pr.id = i.project_id
                         WHERE pr.owner = $1 AND pr.deleted_at IS NULL AND i.s3_key = $2)")
        .bind(&owner).bind(&src.3).fetch_one(&state.pool).await?;
    if !已有 && used + sz > quota {
        return Err(AppError::BadRequest("目标项目主持人的配额不够,删些内容或找超管调额度".into()))
    }

    let name = p.name.as_deref().map(str::trim).filter(|x| !x.is_empty()).unwrap_or(&src.1);
    // ★副本是独立的一行★:改名/删除互不影响,共享的只有 blob(引用计数保证不被误删)。
    // ⚠ 不带 activity_id —— 副本与源活动脱钩,否则它会跟着出现在那场活动的材料里。
    let new_id: i64 = sqlx::query_scalar(
        "INSERT INTO items (project_id, parent_id, kind, name, mime, created_by, s3_key, size, sha256, sha_verified)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true) RETURNING id")
        .bind(p.project_id).bind(p.parent_id).bind(&src.0).bind(name).bind(&src.2)
        .bind(id.require_username()?).bind(&src.3).bind(sz).bind(&src.5)
        .fetch_one(&state.pool).await?;

    crate::audit::record(&state.pool, id.require_username()?, "item.copy",
        &new_id.to_string(), &format!("从 #{iid} 复制到项目 #{}", p.project_id)).await;
    Ok(Json(json!({ "id": new_id, "name": name })))
}

pub async fn update(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Json(p): Json<ItemPatch>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    // 回收站里的东西不给改名/移动 —— 要动它先还原(v0.3.55 审计)。
    let alive: Option<i64> = sqlx::query_scalar("SELECT id FROM items_alive WHERE id = $1 AND deleted_at IS NULL")
        .bind(iid).fetch_optional(&state.pool).await?;
    if alive.is_none() { return Err(AppError::NotFound) }
    // ★活动材料在项目树里不许改名/移动★(D10;2026-08-09 liaoruili 强调「项目文件夹中的会议
    // 内容是不可修改的」)。
    // ⚠ 这条规则 D10 从一开始就写着,`activities.rs` 的注释也写着「在项目树里不允许对它
    //   改名/移动/删除」—— ★但 handler 里一个判断都没有,三年来只是**注释在描述一件没做的事**★。
    //   (和 AI 摘要那个 kind、时间粒度只写进一处,是同一族问题:说过 ≠ 做了。)
    // 为什么必须挡在**后端**:名字与位置是**从活动派生**的(日期+标题、根下独立文件夹) ——
    // 允许改名就等于允许把「某场会的材料」伪装成别的东西,而活动页那边完全看不出来。
    let from_activity: Option<i64> = sqlx::query_scalar(
        "SELECT activity_id FROM items WHERE id = $1").bind(iid).fetch_one(&state.pool).await?;
    if from_activity.is_some() {
        return Err(AppError::BadRequest("活动材料的名称和位置由活动决定,不能在项目里改".into()));
    }
    if let Some(new_parent) = p.parent_id {
        check_parent(&state.pool, pid, new_parent).await?;
        if let Some(np) = new_parent {
            // 递归 CTE 查 np 的祖先链里有没有 iid(含 np 自己):有 = 成环,拒。
            let cyclic: bool = sqlx::query_scalar(
                "WITH RECURSIVE up AS (
                   SELECT id, parent_id FROM items WHERE id = $1
                   UNION ALL SELECT i.id, i.parent_id FROM items i JOIN up ON i.id = up.parent_id
                 ) SELECT EXISTS (SELECT 1 FROM up WHERE id = $2)",
            )
            .bind(np)
            .bind(iid)
            .fetch_one(&state.pool)
            .await?;
            if cyclic {
                return Err(AppError::BadRequest("不能把文件夹移进它自己的子树".into()));
            }
        }
        sqlx::query("UPDATE items SET parent_id = $1, updated_at = now() WHERE id = $2")
            .bind(new_parent)
            .bind(iid)
            .execute(&state.pool)
            .await?;
    }
    if let Some(name) = &p.name {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::BadRequest("名称不能为空".into()));
        }
        sqlx::query("UPDATE items SET name = $1, updated_at = now() WHERE id = $2")
            .bind(name)
            .bind(iid)
            .execute(&state.pool)
            .await?;
    }
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/items/{id} —— **软删除**(≥editor,2026-08-05 用户:「所有的删除都是软删除」)。
/// 整棵子树打 deleted_at 标记,S3 对象一个字节都不动;进回收站,空间 admin 可还原或彻底删除,
/// 满 30 天由清理任务自动 purge。★配额仍然计入回收站里的东西★——占着空间就该算,
/// 这也是「清空回收站」的动力(与网盘一致)。
pub async fn remove(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    // ★项目树里删不掉活动材料★(D10;2026-08-09 liaoruili:「要去会议里面删除」)。
    // ★入口不同,接口就该不同★ —— 后端看不见「用户点的是哪个页面」,
    // 只靠前端藏按钮的话,这条规则等于没有(本仓库自己的原则:前端隐藏不是安全边界)。
    // 想删就走 DELETE /api/activities/{mid}/items/{iid},那条路上删的人知道自己在删一场会的材料。
    let from_activity: Option<i64> = sqlx::query_scalar(
        "SELECT activity_id FROM items WHERE id = $1").bind(iid).fetch_one(&state.pool).await?;
    if from_activity.is_some() {
        return Err(AppError::BadRequest("活动材料请到活动页里删除".into()));
    }
    let actor = id.require_username()?;
    let n = sqlx::query(
        "WITH RECURSIVE sub AS (
           SELECT id FROM items_alive WHERE id = $1
           UNION ALL SELECT i.id FROM items_alive i JOIN sub ON i.parent_id = sub.id
         )
         UPDATE items SET deleted_at = now(), deleted_by = $2
          WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL",
    ).bind(iid).bind(actor).execute(&state.pool).await?.rows_affected();
    audit::record(&state.pool, actor, "item.delete", &iid.to_string(),
        &format!("project={pid} 软删除 {n} 项(进回收站)")).await;
    Ok(Json(json!({ "ok": true, "trashed": n })))
}

/// GET /api/projects/{id}/trash —— 回收站(≥editor;材料区认主人)。只列**被直接删除的那一项**
/// (子树里的行也打了标记,但它们是被连带的,列出来只会刷屏)。
///
/// ⚠ 走 `require_material_owner` 而不是 `require_role` —— 后者的写闸按「need >= Editor」
///   判定,会把材料区的回收站一起拦掉(2026-08-13 巡检点出来的 403,详见那个函数的头注)。
///   普通项目的口径**一个字没变**:那个函数对非材料区就是 `require_role(Editor)`。
pub async fn trash(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    axum::extract::Query(q): axum::extract::Query<crate::http::Page>,
) -> AppResult<Json<serde_json::Value>> {
    crate::perm::require_material_owner(&state.pool, &id, pid).await?;
    // ★真分页,不是写死 LIMIT★(2026-08-13 改):原来是 `LIMIT 500` 且不返回 total ——
    //   删满 500 条之后,第 501 条起在界面上**凭空消失**,而它还在库里、还占着配额
    //   (「配额仍计入回收站」是明写的规矩)。★人以为清干净了,实际没有★,
    //   而且界面一个字都不提示。这不是「列表太长」,是**界面替数据库撒谎**。
    //   `COUNT(*) OVER()` 一次查询同时拿到本页和总数,不多跑一趟。
    let (limit, offset) = q.slice();
    let rows: Vec<(i64, String, String, Option<i64>, Option<String>, String,
                   chrono::DateTime<chrono::Utc>, i64)> = sqlx::query_as(
        "SELECT i.id, i.kind, i.name, i.size, i.mime, COALESCE(i.deleted_by,''), i.deleted_at,
                COUNT(*) OVER() AS total
           FROM items i
          WHERE i.project_id = $1 AND i.deleted_at IS NOT NULL
            -- 只要「删除动作的根」:父节点没被删(或没有父节点)的那些
            AND (i.parent_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM items p WHERE p.id = i.parent_id AND p.deleted_at IS NOT NULL))
          ORDER BY i.deleted_at DESC LIMIT $2 OFFSET $3",
    ).bind(pid).bind(limit).bind(offset).fetch_all(&state.pool).await?;
    // ★空页也要回 total=0 而不是省略字段★:前端拿不到 total 会退化成「不知道有多少」,
    //   那就又回到了「看到的就是全部」的错觉。
    let total = rows.first().map(|r| r.7).unwrap_or(0);
    Ok(Json(json!({
        "total": total,
        "items": rows.into_iter().map(|(id, kind, name, size, mime, by, at, _)| json!({
            "id": id, "kind": kind, "name": name, "size": size, "mime": mime,
            "deleted_by": by, "deleted_at": at,
        })).collect::<Vec<_>>(),
    })))
}

/// POST /api/items/{id}/undelete —— 从回收站还原(≥editor;材料区认主人)。整棵子树一起还原;
/// 若它的父目录也在回收站里(没被一起还原),就还原到空间根 —— 否则还原出来的东西看不见。
///
/// ⚠ 同 `trash`:材料区的「删了能还原」是 PRD §J1b-2 明写的(2026-08-08 liaoruili 拍板),
///   而它此前被 require_role 的写闸一并拦掉 —— 露出来的回收站按钮点进去 403、
///   ★就算列得出来也还不了原★,那不叫回收站。
pub async fn undelete(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    crate::perm::require_material_owner(&state.pool, &id, pid).await?;
    let actor = id.require_username()?;
    let mut tx = state.pool.begin().await?;
    // ★只还原「和它同一批被删的」行★(v0.3.55 审计)。remove 是一条 UPDATE 打的标记,
    // 同一次删除动作里所有行的 deleted_at 完全相等,拿它当批次号。
    // 原先用 `deleted_at IS NOT NULL` 还原整棵子树,会把**先前单独删掉的子项一起复活**:
    //   删文件 a(T1) → 删它的父目录 F(T2,a 因已有标记不动) → 还原 F ⇒ a 也回来了。
    // 用户明确删过的东西自己爬回来,是数据错误,不是便利。
    let batch: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT deleted_at FROM items WHERE id = $1")
            .bind(iid).fetch_optional(&mut *tx).await?.flatten();
    let Some(batch) = batch else {
        return Err(AppError::BadRequest("这一项不在回收站里".into()));
    };
    let n = sqlx::query(
        "WITH RECURSIVE sub AS (
           SELECT id FROM items WHERE id = $1
           UNION ALL SELECT i.id FROM items i JOIN sub ON i.parent_id = sub.id
         )
         UPDATE items SET deleted_at = NULL, deleted_by = NULL
          WHERE id IN (SELECT id FROM sub) AND deleted_at = $2",
    ).bind(iid).bind(batch).execute(&mut *tx).await?.rows_affected();
    // ★父目录一起还原★(2026-08-05 用户纠正:原来是挪到空间根)。
    // 还原一份材料却把它从原来的目录里拽出来,等于"还原了但路径没了" —— 用户要找回的是
    // 「东西回到它原来在的地方」。所以沿 parent 链往上,把还在回收站里的祖先一并还原。
    let n2 = sqlx::query(
        "WITH RECURSIVE up AS (
           SELECT id, parent_id FROM items WHERE id = $1
           UNION ALL SELECT i.id, i.parent_id FROM items i JOIN up ON i.id = up.parent_id
         )
         UPDATE items SET deleted_at = NULL, deleted_by = NULL
          WHERE id IN (SELECT id FROM up) AND deleted_at IS NOT NULL",
    ).bind(iid).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    audit::record(&state.pool, actor, "item.undelete", &iid.to_string(),
        &format!("project={pid} 还原 {n} 项(含连带还原的上级目录 {n2} 层)")).await;
    Ok(Json(json!({ "ok": true, "restored": n + n2 })))
}

/// DELETE /api/items/{id}/purge —— **彻底删除**(空间 **admin**)。行删掉、对象按引用计数清。
/// ⚠ 引用计数必须把**软删除的行也算上**:回收站里的东西还指着同一个对象,
/// 现在删掉它,回收站里那份还原出来就是个空壳(内容寻址共享对象之后,这是最容易踩的坑)。
pub async fn purge(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Admin).await?;
    let actor = id.require_username()?;
    // ★必须先在回收站里★(v0.3.55 审计):原先这里不看 deleted_at,空间 admin 直接
    // DELETE /api/items/{id}/purge 就能把一个**正常的、没删过的**文件永久抹掉,绕开回收站
    // ——正对着「所有的删除都是软删除」这条要求。UI 上没这个入口,但 API 是公开的,
    // 而且到期清理任务也调 purge_subtree,唯有在这道人工入口上钉死才算数。
    let trashed: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT deleted_at FROM items WHERE id = $1")
            .bind(iid).fetch_optional(&state.pool).await?.flatten();
    if trashed.is_none() {
        return Err(AppError::BadRequest("只能彻底删除回收站里的内容,请先删除(软删除)".into()));
    }
    let n = purge_subtree(&state, iid).await?;
    audit::record(&state.pool, actor, "item.purge", &iid.to_string(), &format!("project={pid} 彻底删除,清对象 {n}")).await;
    Ok(Json(json!({ "ok": true, "objects_deleted": n })))
}

/// 彻底删一棵子树:先收集候选对象 key,删行,再对**已无人引用**的 key 删对象。返回真正删掉的对象数。
/// 删一批 S3 对象,★但只删「已经没人引用」的★。
///
/// ⚠ 2026-08-05 内容寻址(`blobs/<sha256>`)之后,**同一个 key 会被任意多个项目、
/// 任意多个人共享** —— 两个毫不相干的人上传同一份 PDF 就共用一个 blob。
/// 所以「我删我的东西」绝不能直接 `storage.delete(key)`:那会把**别人的文件**一起打空
/// (items 行还在、名字还在、点开是空的)。
///
/// ★2026-08-08 抽成公共函数★:此前 `purge_subtree` 做了计数、`projects::remove` **没做**,
/// 两份实现只有一份是对的。而 `projects::remove` 那段的注释还停在内容寻址之前的模型
/// (「key 带 project_id 前缀,不会误伤别的项目」)—— ★一条过期的注释就是下一次事故的许可证★。
/// 后果是:任何登录用户建个项目、传一份和别人相同的文件、再删掉自己的项目,
/// 就能永久销毁别人项目里的那一份。
pub(crate) async fn delete_unreferenced(state: &AppState, keys: &[String]) -> usize {
    let mut gone = 0usize;
    for k in keys {
        // ★含软删除行★:回收站里的东西也算引用,它还等着被还原。
        let refs: i64 = match sqlx::query_scalar(
            "SELECT (SELECT count(*) FROM items WHERE s3_key = $1)
                  + (SELECT count(*) FROM item_versions WHERE s3_key = $1)",
        ).bind(k).fetch_one(&state.pool).await {
            Ok(v) => v,
            // ★查不出引用数就**不删**★(fail-closed):删错了不可逆,留个孤儿对象只是占点空间
            Err(e) => { tracing::warn!(error = %e, key = %k, "引用计数查询失败,跳过删除"); continue }
        };
        if refs == 0 {
            if let Err(e) = state.storage.delete(k).await {
                tracing::warn!(error = %e, key = %k, "s3 清理失败(孤儿对象,待巡检)");
            } else { gone += 1 }
        }
    }
    gone
}

pub(crate) async fn purge_subtree(state: &AppState, iid: i64) -> AppResult<usize> {
    let keys: Vec<String> = sqlx::query_scalar(
        "WITH RECURSIVE sub AS (
           SELECT id FROM items WHERE id = $1
           UNION ALL SELECT i.id FROM items i JOIN sub ON i.parent_id = sub.id
         )
         SELECT DISTINCT k FROM (
           SELECT s3_key k FROM items WHERE id IN (SELECT id FROM sub) AND s3_key IS NOT NULL
           UNION SELECT s3_key FROM item_versions WHERE item_id IN (SELECT id FROM sub)
         ) t",
    ).bind(iid).fetch_all(&state.pool).await?;
    sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await?;
    Ok(delete_unreferenced(state, &keys).await)
}

/// GET /api/items/{id}/content —— 文档正文(≥viewer)。空文档(还没保存过)回空串。
pub async fn content_get(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Response> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let key: Option<String> = sqlx::query_scalar("SELECT s3_key FROM items_alive WHERE id = $1 AND kind = 'doc' AND deleted_at IS NULL")
        .bind(iid)
        .fetch_optional(&state.pool)
        .await?
        .ok_or(AppError::NotFound)?;
    let text = match key {
        Some(k) => state.storage.get_bytes(&k).await.map_err(AppError::Other)?,
        None => Vec::new(),
    };
    Ok(([(header::CONTENT_TYPE, "text/markdown; charset=utf-8")], text).into_response())
}

#[derive(Deserialize)]
pub struct ContentIn {
    pub text: String,
    /// 版本标签(可选),如「初稿」「会前定稿」。
    pub label: Option<String>,
}

/// PUT /api/items/{id}/content —— 保存文档(≥editor):内容寻址写 S3 → 旧版入 item_versions → 更新 items。
/// 同内容重复保存(sha 相同)是 no-op,不产生新版本。
pub async fn content_put(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Json(input): Json<ContentIn>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    // 回收站里的文档不接受写入(v0.3.55 审计):否则改完还得先还原才看得见,白改一场。
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT kind, s3_key, sha256 FROM items_alive WHERE id = $1 AND deleted_at IS NULL")
            .bind(iid)
            .fetch_optional(&state.pool)
            .await?;
    let Some((kind, old_key, old_sha)) = row else { return Err(AppError::NotFound) };
    if kind != "doc" {
        return Err(AppError::BadRequest("只有文档能在线编辑".into()));
    }
    let bytes = input.text.into_bytes();
    let sha = hex::encode(Sha256::digest(&bytes));
    if old_sha.as_deref() == Some(sha.as_str()) {
        return Ok(Json(json!({ "ok": true, "unchanged": true })));
    }
    let size = bytes.len() as i64;
    let (quota, used) = owner_quota_used(&state.pool, &project_owner(&state.pool, pid).await?).await?;
    if used + size > quota {
        return Err(AppError::BadRequest("超出配额,删些内容或找超管调额度".into()));
    }
    // ★统一走内容寻址★(2026-08-06 清库时收口):文档此前用 `spaces/{pid}/{iid}/{sha}` 前缀,
    // 与文件/录屏的 blobs/<sha> 是两套。同一份内容在不同文档里重复保存时,旧前缀会各存一份;
    // 收口之后全库一份,而且删除的引用计数逻辑也只剩一套。
    let key = blob_key(&sha);
    state.storage.put_bytes(&key, bytes, "text/markdown; charset=utf-8").await.map_err(AppError::Other)?;
    let actor = id.require_username()?;
    let mut tx = state.pool.begin().await?;
    if let Some(ok) = old_key {
        // 旧当前版进历史(内容寻址:同 sha 的历史行指向同一对象,不重复存)。
        sqlx::query(
            "INSERT INTO item_versions (item_id, s3_key, size, sha256, label, created_by)
             SELECT id, s3_key, size, sha256, NULL, $2 FROM items WHERE id = $1 AND s3_key = $3",
        )
        .bind(iid)
        .bind(actor)
        .bind(&ok)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE items SET s3_key = $1, size = $2, sha256 = $3, mime = 'text/markdown', updated_at = now() WHERE id = $4")
        .bind(&key)
        .bind(size)
        .bind(&sha)
        .bind(iid)
        .execute(&mut *tx)
        .await?;
    if let Some(label) = &input.label {
        // 带标签的保存,同时给「新当前版」记一行历史(命名快照语义,DESIGN §1)。
        sqlx::query("INSERT INTO item_versions (item_id, s3_key, size, sha256, label, created_by) VALUES ($1,$2,$3,$4,$5,$6)")
            .bind(iid)
            .bind(&key)
            .bind(size)
            .bind(&sha)
            .bind(label.trim())
            .bind(actor)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({ "ok": true, "sha256": sha })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct VersionRow {
    pub id: i64,
    pub size: Option<i64>,
    pub sha256: Option<String>,
    pub label: Option<String>,
    pub created_by: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// GET /api/items/{id}/versions —— 版本历史(≥viewer)。
pub async fn versions(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
) -> AppResult<Json<Vec<VersionRow>>> {
    let pid = project_of_alive(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Viewer).await?;
    let rows: Vec<VersionRow> = sqlx::query_as(
        "SELECT id, size, sha256, label, created_by, created_at FROM item_versions WHERE item_id = $1 ORDER BY id DESC",
    )
    .bind(iid)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

/// POST /api/items/{id}/restore/{version_id} —— 恢复到某历史版本(≥editor)。
/// 恢复 = 把当前版存进历史,再把 items 指回历史对象(纯改指针,零字节搬运——内容寻址的红利)。
pub async fn restore(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path((iid, vid)): Path<(i64, i64)>,
) -> AppResult<Json<serde_json::Value>> {
    let pid = project_of(&state.pool, iid).await?;
    require_role(&state.pool, &id, pid, Role::Editor).await?;
    let v: Option<(String, Option<i64>, Option<String>)> =
        sqlx::query_as("SELECT s3_key, size, sha256 FROM item_versions WHERE id = $1 AND item_id = $2")
            .bind(vid)
            .bind(iid)
            .fetch_optional(&state.pool)
            .await?;
    let Some((vkey, vsize, vsha)) = v else { return Err(AppError::NotFound) };
    let actor = id.require_username()?;
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO item_versions (item_id, s3_key, size, sha256, label, created_by)
         SELECT id, s3_key, size, sha256, '恢复前自动快照', $2 FROM items WHERE id = $1 AND s3_key IS NOT NULL",
    )
    .bind(iid)
    .bind(actor)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE items SET s3_key = $1, size = $2, sha256 = $3, updated_at = now() WHERE id = $4")
        .bind(&vkey)
        .bind(vsize)
        .bind(&vsha)
        .bind(iid)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct UploadQuery {
    /// 空串按 None 收(浏览器拼 `?parent_id=` 是常见形态,直接 400 太脆——2026-08-03 线上踩过)。
    #[serde(default, deserialize_with = "empty_as_none")]
    pub parent_id: Option<i64>,
    /// ★活动材料★(D10):非空表示这份材料属于某次活动的只读区。
    /// 上传落在**关联项目之一**(前端传 projects[0]),但靠 activity_id 让**所有**关联项目的成员都看得到
    /// —— 这就是 D4「一次活动多个项目、材料整份进所有关联项目」的实现方式(不复制文件)。
    #[serde(default, deserialize_with = "empty_as_none")]
    pub activity_id: Option<i64>,
    /// ★录制 ≠ 材料★(D5):只有它为真的文件会被转写、并作为活动时长依据。
    #[serde(default)]
    pub is_recording: bool,
}

fn empty_as_none<'de, D>(de: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s: Option<String> = Option::deserialize(de)?;
    match s.as_deref() {
        None | Some("") => Ok(None),
        Some(v) => v.parse().map(Some).map_err(serde::de::Error::custom),
    }
}

/// POST /api/projects/{pid}/upload —— **流式** multipart 上传(≥editor,单文件不限大小)。
/// 浏览器 → pod 边收边按 8MiB part 转推 S3(常驻内存≈一个 part,512Mi 资源档安全);
/// sha256 边收边算(存 DB 做完整性记录)。⚠ 流式下 key 用不了内容寻址(开传时 sha 未知,
/// S3 rename=拷贝,Garage 上不划算)→ 文件/录屏的 key 是 `spaces/<pid>/<iid>/blob`,
/// 一上传一 item 行天然唯一;**文档**(content_put)仍是 sha 内容寻址(版本去重靠它)。
/// 配额:开传前查一次(拦明显超的),每收一块再累计判(拦"传一半才超"的),超即 abort+删行。
pub async fn upload(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(pid): Path<i64>,
    Query(q): Query<UploadQuery>,
    mut mp: Multipart,
) -> AppResult<Json<serde_json::Value>> {
    // ★材料区在 require_role 上是全只读的★(PRD §J1),但活动材料必须传得进去 ——
    // 所以带 activity_id 的上传走 `require_material_owner`(材料区认「这是我自己的区」,
    // 普通项目照旧 ≥editor);不带 activity_id 的照常走 require_role,于是
    // 「直接往材料区里传散文件」自动被挡住,不必再写一句判断。
    let actor0 = id.require_username()?;
    match q.activity_id {
        Some(mid) => {
            crate::perm::require_material_owner(&state.pool, &id, pid).await?;
            // ★A1:活动与项目必须对账★——判权判的是 pid,写的是 mid,少这一句就是越权注入口
            check_activity_target(&state.pool, mid, pid, actor0).await?;
        }
        None => { require_role(&state.pool, &id, pid, Role::Editor).await?; }
    }
    check_parent(&state.pool, pid, q.parent_id).await?;
    let (quota, used) = owner_quota_used(&state.pool, &project_owner(&state.pool, pid).await?).await?;
    if used >= quota {
        return Err(AppError::BadRequest("空间配额已满,删些内容或找超管调配额".into()));
    }
    let actor = id.require_username()?;

    // ★活动材料落进「根下面一个属于这场活动的文件夹」★（2026-08-09 liaoruili:
    // 「不应该根据开会的日期+会议标题存到文件夹下面吗?怎么直接放到这里了」
    //  「而且是单独放到根下面的一个文件夹」）。
    // 之前活动材料的 parent_id 一直是 NULL —— ★全都散在项目根目录，和人自己整理的文件混在一起★，
    // 一场会传 4 段录屏就是根目录上 4 行,几场会之后项目文件页就没法看了。
    // ★带 activity_id 就一律落活动文件夹,**忽略** parent_id★(A6)。
    // 原来是 `Some(mid) if q.parent_id.is_none()`,于是同时带上 parent_id 就能把活动材料
    // 放到项目树的任意角落 —— 而「名称与位置由活动决定」正是 D10 的全部内容。
    let parent = match q.activity_id {
        Some(mid) => Some(activity_folder(&state, pid, mid, actor).await?),
        None => q.parent_id,
    };

    // 收**所有**文件字段(2026-08-04 审计):原来处理完第一个就 return,同一请求里的第二个文件
    // **连报错都没有、直接消失**。前端是一文件一请求,但接口不该静默丢数据。
    // 兼容:响应仍带首个文件的 id/sha256/size,另加 items 数组列全部。
    let mut done: Vec<serde_json::Value> = Vec::new();
    while let Some(mut field) = mp.next_field().await.map_err(|e| AppError::BadRequest(e.to_string()))? {
        if field.file_name().is_none() {
            continue;
        }
        let fname = { let f = field.file_name().unwrap_or("unnamed").trim(); if f.is_empty() { "unnamed".to_string() } else { f.to_string() } };
        let mime = field.content_type().unwrap_or("application/octet-stream").to_string();
        // 先插行拿 item_id(key 要用);kind 按 mime 粗分,失败路径统一删行。
        let kind = if mime.starts_with("video/") { "video" } else { "file" };
        let iid: i64 = sqlx::query_scalar(
            // activity_id / is_recording:活动材料走同一条上传路径(D10 说活动材料是只读区,
            // 唯一写入口是活动详情页 —— 那指的是**入口**,不必为它另写一套 79 行的流式上传)。
            "INSERT INTO items (project_id, parent_id, kind, name, mime, created_by, activity_id, is_recording)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        )
        .bind(pid).bind(parent).bind(kind).bind(&fname).bind(&mime).bind(actor)
        .bind(q.activity_id).bind(q.is_recording)
        .fetch_one(&state.pool)
        .await?;
        // ★先落临时 key,算完真实 sha 再按内容寻址归位★:边收边算哈希,收完才知道内容的 key。
        // 直接按客户端申报的 sha 写会给「内容投毒」开门(写坏别人引用着的同名对象)——
        // 服务端自己算出来的哈希才作数。
        let tmp_key = format!("tmp/{pid}-{iid}");
        // ★配额算项目 owner 的★（ADR-0004）：不是操作者的 —— 材料归项目，额度归主持人。
        let owner = project_owner(&state.pool, pid).await?;
        let (q_now, used_now) = owner_quota_used(&state.pool, &owner).await?;
        match stream_field_to_s3(&state, &mut field, &tmp_key, &mime, q_now - used_now).await {
            Ok((sha, total)) => {
                // 归位:对象已存在就直接引用(哈希是我们自己算的,内容必然一致),否则服务端复制过去。
                let key = blob_key(&sha);
                if !state.storage.exists(&key).await {
                    if let Err(e) = state.storage.copy(&tmp_key, &key).await {
                        let _ = state.storage.delete(&tmp_key).await;
                        let _ = sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await;
                        return Err(AppError::Other(e));
                    }
                }
                let _ = state.storage.delete(&tmp_key).await;

                // ★同名怎么办:分「完全重复」与「新版本」两种,它们的用户意图完全不同★
                // (2026-08-09 liaoruili:「为啥可以上传两份一模一样的文件」,选了方案 C)。
                //
                // 盘上本来就只有一份(内容寻址),所以这不是空间问题 —— 是**人分不清哪个是哪个**,
                // 「删哪个」变成猜谜。文件管理器不允许同目录重名,网盘也会问你「替换还是保留两份」。
                //   · 同名 **且同 sha** = 误传了两次 → ★不建新行★,直接告诉他「已经有了」;
                //   · 同名但内容不同 = 传了新版本 → 自动缀序号,两份都留着。
                // ⚠ 判据必须放在**算完 sha 之后**:开传的那一刻还不知道内容一不一样。
                let dup: Option<i64> = sqlx::query_scalar(
                    "SELECT id FROM items_alive
                      WHERE project_id = $1 AND parent_id IS NOT DISTINCT FROM $2
                        AND name = $3 AND sha256 = $4 AND id <> $5 AND deleted_at IS NULL LIMIT 1")
                    .bind(pid).bind(parent).bind(&fname).bind(&sha).bind(iid)
                    .fetch_optional(&state.pool).await?;
                if let Some(exist) = dup {
                    // 完全重复:回滚这一行。★对象不能删★ —— 它就是那份已存在文件正引用着的 blob。
                    let _ = sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await;
                    done.push(serde_json::json!({
                        "id": exist, "name": fname, "sha256": sha, "size": total, "duplicate": true }));
                    continue;
                }
                // 同名不同内容 → 找一个没被占的序号。上限 999 是防呆:真到那一步说明有人在刷。
                let clash: Option<i64> = sqlx::query_scalar(
                    "SELECT id FROM items_alive WHERE project_id = $1 AND parent_id IS NOT DISTINCT FROM $2
                        AND name = $3 AND id <> $4 AND deleted_at IS NULL LIMIT 1")
                    .bind(pid).bind(parent).bind(&fname).bind(iid).fetch_optional(&state.pool).await?;
                let mut fname = fname.clone();
                if clash.is_some() {
                    for n in 2..1000u32 {
                        let cand = numbered_name(&fname, n);
                        let taken: Option<i64> = sqlx::query_scalar(
                            "SELECT id FROM items_alive WHERE project_id = $1 AND parent_id IS NOT DISTINCT FROM $2
                                AND name = $3 AND deleted_at IS NULL LIMIT 1")
                            .bind(pid).bind(parent).bind(&cand).fetch_optional(&state.pool).await?;
                        if taken.is_none() {
                            sqlx::query("UPDATE items SET name = $2 WHERE id = $1").bind(iid).bind(&cand)
                                .execute(&state.pool).await?;
                            fname = cand;
                            break;
                        }
                    }
                }

                // ★收尾复核配额★:开传前那次 used 是快照,同一空间并发上传各自都会读到它,
                // 两个 9GiB 能一起过 10GiB 的闸。按落地时的真实总量再判一次,超了回滚。
                let (q2, used2) = owner_quota_used(&state.pool, &owner).await?;
                if used2 + total > q2 {
                    // ⚠★2026-08-08 修:这里原来是 `storage.delete(&key)` —— 会打空别人的文件★
                    //   内容寻址之后 `blobs/<sha>` 是**全库共享**的:上面十行刚写着
                    //   「对象已存在就直接引用」,也就是说这个 key 很可能早就被别人的 items 行引用着。
                    //   配额回滚直接删它 → 那些行还在、点开是空的 —— 静默数据损坏。
                    //   这与 v0.4.38 修 `projects::remove` 的是**同一个洞**,当时漏了这一处。
                    //
                    // ★顺序要紧:先删自己这行,再数引用★。`delete_unreferenced` 按
                    //   items ∪ item_versions 数引用,本行还在的话它会把自己算成一个引用,于是永远删不掉。
                    let _ = sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await;
                    delete_unreferenced(&state, std::slice::from_ref(&key)).await;
                    return Err(AppError::BadRequest("空间配额已被并发上传占满,本次已回滚".into()));
                }
                sqlx::query("UPDATE items SET s3_key = $1, size = $2, sha256 = $3, sha_verified = true WHERE id = $4")
                    .bind(&key).bind(total).bind(&sha).bind(iid)
                    .execute(&state.pool)
                    .await?;
                // 录屏/录音传完即自动排队生成纪要(2026-08-05,与预签名直传那条路径一致)。
                crate::http::media::enqueue_analysis(&state, iid, actor).await;
                done.push(json!({ "id": iid, "sha256": sha, "size": total, "name": fname }));
            }
            Err(e) => {
                let _ = sqlx::query("DELETE FROM items WHERE id = $1").bind(iid).execute(&state.pool).await;
                return Err(e);
            }
        }
    }
    if let Some(first) = done.first().cloned() {
        let mut out = first;
        out["items"] = json!(done);
        return Ok(Json(out));
    }
    Err(AppError::BadRequest("没有收到文件".into()))
}

/// 把一个 multipart field 流进 S3:小于一个 part 直接 put,否则 S3 multipart。
/// 返回 (sha256, 总字节)。任何失败(含超配额)内部已 abort 半截 multipart,调用方只须删行。
async fn stream_field_to_s3(
    state: &AppState,
    field: &mut axum::extract::multipart::Field<'_>,
    key: &str,
    mime: &str,
    budget: i64,
) -> AppResult<(String, i64)> {
    let mut hasher = Sha256::new();
    let mut buf: Vec<u8> = Vec::with_capacity(PART_SIZE);
    let mut total: i64 = 0;
    let mut upload_id: Option<String> = None;
    let mut parts: Vec<aws_sdk_s3::types::CompletedPart> = Vec::new();
    let mut part_no: i32 = 1;

    // 统一的失败出口:半截 multipart 必 abort(不 abort 在 S3 里永久占存储)。
    macro_rules! fail {
        ($err:expr) => {{
            if let Some(uid) = &upload_id {
                state.storage.multipart_abort(key, uid).await;
            }
            return Err($err);
        }};
    }

    loop {
        let chunk = match field.chunk().await {
            Ok(c) => c,
            Err(e) => fail!(AppError::BadRequest(format!("读取上传流失败:{e}"))),
        };
        match chunk {
            Some(c) => {
                total += c.len() as i64;
                if total > budget {
                    fail!(AppError::BadRequest("超出空间配额(默认 10GiB),删些内容或找超管调配额".into()));
                }
                hasher.update(&c);
                buf.extend_from_slice(&c);
                if buf.len() >= PART_SIZE {
                    let uid = match &upload_id {
                        Some(u) => u.clone(),
                        None => match state.storage.multipart_begin(key, mime).await {
                            Ok(u) => { upload_id = Some(u.clone()); u }
                            Err(e) => fail!(AppError::Other(e)),
                        },
                    };
                    match state.storage.multipart_part(key, &uid, part_no, std::mem::take(&mut buf)).await {
                        Ok(p) => { parts.push(p); part_no += 1; buf.reserve(PART_SIZE); }
                        Err(e) => fail!(AppError::Other(e)),
                    }
                }
            }
            None => break,
        }
    }

    match &upload_id {
        // 走了 multipart:把尾巴(可小于 5MiB,末 part 豁免)传完再 complete。
        Some(uid) => {
            if !buf.is_empty() {
                match state.storage.multipart_part(key, uid, part_no, std::mem::take(&mut buf)).await {
                    Ok(p) => parts.push(p),
                    Err(e) => fail!(AppError::Other(e)),
                }
            }
            if let Err(e) = state.storage.multipart_complete(key, uid, parts).await {
                fail!(AppError::Other(e));
            }
        }
        // 整个文件不足一个 part:单发 put_object 最省事。
        None => {
            if let Err(e) = state.storage.put_bytes(key, std::mem::take(&mut buf), mime).await {
                return Err(AppError::Other(e));
            }
        }
    }
    Ok((hex::encode(hasher.finalize()), total))
}

/// GET /api/items/{id}/download —— 流式下载(≥viewer)。S3 → 客户端直转,不落内存。
#[derive(Deserialize)]
pub struct DownloadQuery {
    /// ?inline=1 → 浏览器内嵌渲染(PDF/图片/音视频/纯文本白名单内);缺省或非安全类型都下载。
    #[serde(default, deserialize_with = "empty_as_none_bool")]
    pub inline: Option<bool>,
}

fn empty_as_none_bool<'de, D>(de: D) -> Result<Option<bool>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s: Option<String> = Option::deserialize(de)?;
    Ok(match s.as_deref() {
        None | Some("") => None,
        Some("0") | Some("false") => Some(false),
        Some(_) => Some(true),
    })
}

pub async fn download(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(iid): Path<i64>,
    Query(q): Query<DownloadQuery>,
) -> AppResult<Response> {
    let pid = project_of(&state.pool, iid).await?;
    let role = require_role(&state.pool, &id, pid, Role::Viewer).await?;
    // D4 开关(迁移 0003):viewer 禁下载原件;editor/admin/超管不受限。阅读/播放不走这,不拦。
    if role == Role::Viewer {
        // ⚠★2026-08-08:这里原本查的是 `viewer_no_download`,而 projects 的列叫 `no_download`
        //   —— 列根本不存在,`fetch_one` 直接 Err → 500。也就是说 **D4「viewer 禁下载」从
        //   2026-08-03 落地那天(b47978a)起就没工作过,整整五天**,而它是一条「权」路径:
        //   本该「禁下载」的人拿到的是 500 不是 403,本该能下载的 viewer 则一律下不了。
        //   ★为什么 13 条安全网 + 70 条 E2E 全绿也没发现★:两个原因叠加 ——
        //   ① 这个分支只在 `role == Viewer` 时才走,而测试用的都是 owner/admin 身份;
        //   ② 现有的「禁下载」测试覆盖的全是**活动级** `activities.no_download`(0007 加的),
        //      项目级这条一条都没有。
        //   抓到它的是 `scripts/sql-prepare-check.py`(全量 SQL 对真库 PREPARE)第一次跑 ——
        //   这正是它存在的理由:**冷门路径的 SQL 错,靠测试覆盖是等不到的**。
        let blocked: bool = sqlx::query_scalar("SELECT no_download FROM projects WHERE id = $1")
            .bind(pid)
            .fetch_one(&state.pool)
            .await?;
        if blocked {
            return Err(AppError::BadRequest("本空间已设置 viewer 禁止下载原件(找空间 admin 提权或关闭该限制)".into()));
        }
    }
    // ★活动粒度的禁下载★(PRD 6.3.2,迁移 0007):「这次会涉及敏感内容,想让大家能看但不能下载」——
    // 说的是**这一次会**,不是把整个项目锁上(项目级那个太钝,会连带影响无关材料)。
    //
    // ⚠ 与项目级是**叠加不是覆盖**:两处任一禁了就禁。反过来做(活动放开能盖过项目)
    // 就成了「在活动上开个口子绕过项目策略」,那是权限模型里最容易被利用的缝。
    // ⚠ 这一条**对所有角色生效**,不像项目那条只拦 viewer —— 发起人说「这次不许下载」
    // 是对全体说的,把 editor 排除在外等于这个开关基本不起作用(活动材料多半是 editor 传的)。
    let activity_blocked: Option<bool> = sqlx::query_scalar(
        "SELECT m.no_download FROM items i JOIN activities m ON m.id = i.activity_id WHERE i.id = $1")
        .bind(iid).fetch_optional(&state.pool).await?;
    if activity_blocked == Some(true) {
        return Err(AppError::BadRequest("这场活动的材料已设为禁止下载原件(可在线预览/播放)".into()));
    }
    // ★deleted_at IS NULL★(v0.3.55 审计):删进回收站的东西,直链也不该再下得到。
    let row: Option<(Option<String>, String, Option<String>)> =
        sqlx::query_as("SELECT s3_key, name, mime FROM items_alive WHERE id = $1 AND deleted_at IS NULL")
            .bind(iid)
            .fetch_optional(&state.pool)
            .await?;
    let Some((Some(key), name, mime)) = row else { return Err(AppError::NotFound) };
    let (stream, len) = state.storage.get_stream(&key).await.map_err(AppError::Other)?;
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(stream.into_async_read()));
    // filename* 用 RFC5987 编码,中文文件名不炸 header(纯 ASCII 名两种写法等价)。
    // ★ inline 只对**安全类型**放行(PDF/图片/纯文本/音视频)★:同源 inline 渲染上传的
    // HTML/SVG 就是存储型 XSS——脚本能读会话 cookie(HttpOnly 挡不住同源 fetch 带 cookie 的操作)。
    // 白名单之外一律 attachment,浏览器只会下载不会执行。
    let mime_s = mime.clone().unwrap_or_default();
    let inline_ok = mime_s == "application/pdf"
        || (mime_s.starts_with("image/") && mime_s != "image/svg+xml")
        || mime_s.starts_with("video/")
        || mime_s.starts_with("audio/")
        || mime_s == "text/plain";
    let disp = if q.inline.unwrap_or(false) && inline_ok {
        format!("inline; filename*=UTF-8''{}", urlencode(&name))
    } else {
        format!("attachment; filename*=UTF-8''{}", urlencode(&name))
    };
    let mut resp = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime.unwrap_or_else(|| "application/octet-stream".into()))
        .header(header::CONTENT_DISPOSITION, disp);
    if let Some(l) = len {
        resp = resp.header(header::CONTENT_LENGTH, l);
    }
    resp.body(body).map_err(|e| AppError::Other(e.into()))
}

/// 最小 percent-encode(RFC5987 attr-char 之外全编),够 Content-Disposition 用,不引 crate。
pub(crate) fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// ★时区那一格★:活动文件夹名里的日期必须是**开会当地那天**,不是 UTC 那天。
    /// 8-09 07:00(北京)= 8-08 23:00 UTC —— 按 UTC 取日期,文件夹名会比会议早一天,
    /// 而且**不报任何错**,只是名字悄悄不对(与 notify.rs 里记的同一类坑)。
    #[test]
    fn 文件夹名按东八区取日期() {
        let t = chrono::Utc.with_ymd_and_hms(2026, 8, 8, 23, 0, 0).unwrap();  // = 北京 8-09 07:00
        assert_eq!(activity_folder_name(t, "组会", crate::tzutil::FALLBACK), "2026-08-09 组会");
    }

    /// 日期在前:按名字排序就等于按时间排序(一个项目开一年会之后,这条比什么都有用)。
    #[test]
    fn 按名字排序等于按时间排序() {
        let a = activity_folder_name(chrono::Utc.with_ymd_and_hms(2026, 8, 3, 2, 0, 0).unwrap(), "乙会", crate::tzutil::FALLBACK);
        let b = activity_folder_name(chrono::Utc.with_ymd_and_hms(2026, 8, 12, 2, 0, 0).unwrap(), "甲会", crate::tzutil::FALLBACK);
        assert!(a < b, "8-03 的应排在 8-12 之前,而不是被标题的字序左右:{a} / {b}");
    }

    /// 标题两头的空白不进名字(用户手滑粘进一个空格,文件夹就会长得很怪)。
    #[test]
    fn 标题两头空白被裁掉() {
        let t = chrono::Utc.with_ymd_and_hms(2026, 8, 9, 2, 0, 0).unwrap();
        assert_eq!(activity_folder_name(t, "  组会  ", crate::tzutil::FALLBACK), "2026-08-09 组会");
    }

    // ══════ 重名的两种情形(2026-08-09 liaoruili 选的方案 C)══════
    #[test]
    fn 重名加序号时扩展名留在最后() {
        // ★不能写成 `a.pdf (2)`★:那样按扩展名认类型会失手,人也认不出它还是个 PDF
        assert_eq!(numbered_name("Another day.pdf", 2), "Another day (2).pdf");
        assert_eq!(numbered_name("a.tar.gz", 3), "a.tar (3).gz", "只认最后一个点");
        assert_eq!(numbered_name("README", 2), "README (2)", "没有扩展名就直接缀");
        // 开头的点是隐藏文件,不是扩展名分隔符 —— 否则会得到 ` (2).gitignore`
        assert_eq!(numbered_name(".gitignore", 2), ".gitignore (2)");
    }
}
