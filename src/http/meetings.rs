//! 会议与日程(M1)—— 需求见 `docs/PRD-meetings.md`,判权全走 `perm.rs`,handler 里不重写。
//!
//! ★贯穿本模块的一条线:**会议参与 ≠ 资料权限**★(D3/D8/D9)。
//! 这里的每个接口只管**会议元信息**(标题/议程/时间/地点/链接/名单/讨论);
//! 材料一律走项目那套(`require_role` + 项目成员身份),与「是不是参会人」无关。
//! 把两者混起来 = 「参会即获得资料权限」= 权限退回历史累积,而 R1 要的是当前状态的函数。
//!
//! 三个容易写错的地方,都在下面各自的注释里标了 ★:
//!   · 忙闲按**项目可见性**分流(D1),不是按会议;
//!   · 「建议改期」是私事冲突**唯一的结构化出口**(D2),不是可选的便利功能;
//!   · 改线上链接要留痕(开会前十分钟改链接是真实场景)。

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::perm::{meeting_view, require_meeting_host, MeetingView};
use crate::state::AppState;
use crate::{audit, perm};

type Ts = chrono::DateTime<chrono::Utc>;

#[derive(Serialize, sqlx::FromRow)]
pub struct MeetingRow {
    pub id: i64,
    pub title: String,
    pub agenda: String,
    pub organizer: String,
    pub recorder: String,
    pub starts_at: Ts,
    pub ends_at: Ts,
    pub timezone: String,
    pub location: String,
    pub online_url: String,
    pub visibility: String,
    pub status: String,
    pub created_at: Ts,
    /// 我的答复(不在参会名单里则 None)。列表页据此显示「待你答复」。
    #[sqlx(default)]
    pub my_status: Option<String>,
    /// 关联项目(id+名字),会议列表要显示项目标签(原型 meets 视图)。
    /// ★列表里一并带出,不让前端为每场会再打一次详情★(23 场会 = 23 个请求)。
    #[sqlx(default)]
    pub projects: Option<serde_json::Value>,
    /// 参会人数,列表显示「8 人」。
    #[sqlx(default)]
    pub participant_count: i64,
    /// 纪要状态:null=还没建 / draft=待整理 / done=已完成。
    /// 列表右侧「我负责的纪要」与状态标签靠它,否则前端要逐场会查一次。
    #[sqlx(default)]
    pub minutes_status: Option<String>,
    /// 这场会**只**关联私密项目吗?日历按它上色(私密=紫色虚框,公开=青色实框)。
    ///
    /// ★判据与忙闲分流保持一致★(D1):只要关联了**任一**公开项目就算「公开的会」——
    /// 它已经是公开协作的一部分,会产生忙闲、别人看得到你在忙。
    /// 两处若各写各的,就会出现「日历显示私密、别人却看到你忙」这种自相矛盾的展示。
    #[sqlx(default)]
    pub is_private: bool,
}

#[derive(Deserialize)]
pub struct MeetingIn {
    pub title: String,
    #[serde(default)] pub agenda: String,
    /// ★记录员必填(D14)★:正式纪要由他按固定模板整理,AI 转写只是原材料。
    pub recorder: String,
    pub starts_at: Ts,
    pub ends_at: Ts,
    #[serde(default)] pub timezone: Option<String>,
    #[serde(default)] pub location: String,
    #[serde(default)] pub online_url: String,
    #[serde(default)] pub visibility: Option<String>,
    /// ★至少一个★:材料权限来自项目成员身份,没有项目就没人管得了它的材料。
    pub project_ids: Vec<i64>,
    /// 一并邀请的人(可空,之后再加)。
    #[serde(default)] pub participants: Vec<String>,
}

/// GET /api/meetings —— 时间线入口(D7):我参与的 + 我所在项目的会议,按时间排。
/// `from`/`to` 不给则默认「今天起 60 天」——日历页一次拉一屏,不要全量。
#[derive(Deserialize)]
pub struct RangeQ {
    pub from: Option<Ts>,
    pub to: Option<Ts>,
    /// 只看某个项目的(项目入口,D7 的另一半)。
    pub project_id: Option<i64>,
}

pub async fn list(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Query(q): Query<RangeQ>,
) -> AppResult<Json<Vec<MeetingRow>>> {
    let username = id.require_username()?;
    let from = q.from.unwrap_or_else(|| chrono::Utc::now() - chrono::Duration::days(1));
    let to = q.to.unwrap_or_else(|| chrono::Utc::now() + chrono::Duration::days(60));
    // 可见性三条来源与 meeting_view 同源(参会人 / 关联项目成员 / 超管),这里是它的**集合版**。
    // ⚠ public 会议**不进这个列表**:列表是「我的日程」,不是全平台公告板;
    //    旁听要靠拿到具体会议 id 去看详情(D9 给的是「可访问」,不是「推给你」)。
    let rows: Vec<MeetingRow> = sqlx::query_as(
        // ★is_private 必须由 SQL 算★:字段声明了却不算,#[sqlx(default)] 会静静给 false,
        // 于是私密项目的会在日历上显示成公开色 —— D1 的隐私提示当场失效且不报错。
        "SELECT m.*, mp.status AS my_status,
                NOT EXISTS (SELECT 1 FROM meeting_projects mpj
                              JOIN projects p ON p.id = mpj.project_id
                             WHERE mpj.meeting_id = m.id
                               AND p.visibility = 'public' AND p.deleted_at IS NULL) AS is_private,
                -- 列表要显示的三样,都在这条 SQL 里一次取全:
                -- ★不让前端为每场会再打一次详情★(23 场会 = 23 个请求 = 列表页卡住)
                (SELECT coalesce(json_agg(json_build_object('id', p2.id, 'name', p2.name)), '[]'::json)
                   FROM meeting_projects mp2 JOIN projects p2 ON p2.id = mp2.project_id
                  WHERE mp2.meeting_id = m.id AND p2.deleted_at IS NULL) AS projects,
                (SELECT count(*) FROM meeting_participants x WHERE x.meeting_id = m.id) AS participant_count,
                (SELECT mm.status FROM meeting_minutes mm WHERE mm.meeting_id = m.id) AS minutes_status
           FROM meetings m
           LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.username = $1
          WHERE m.status = 'active' AND m.starts_at < $3 AND m.ends_at > $2
            AND ($4::bigint IS NULL OR EXISTS (
                  SELECT 1 FROM meeting_projects x WHERE x.meeting_id = m.id AND x.project_id = $4))
            -- 可见性:参会人 / 关联项目成员 / 超管,三选一
            -- ⚠★这三条必须包在同一对括号里★(2026-08-07 事故):加归档过滤时我把括号提前闭合了,
            --   超管那条掉进了下面 NOT EXISTS 的子查询里 → 对超管而言子查询 WHERE 恒真
            --   → 只要会议关联了任何项目就被 NOT EXISTS 滤掉 → ★超管一场会都看不到★。
            --   非超管完全不受影响,所以 24 条 E2E 全绿而用户(超管)的界面是空的。
            AND (mp.username IS NOT NULL
                 OR EXISTS (SELECT 1 FROM meeting_projects mpj
                              JOIN project_members pm ON pm.project_id = mpj.project_id
                             WHERE mpj.meeting_id = m.id AND pm.username = $1)
                 OR EXISTS (SELECT 1 FROM app_user WHERE username = $1 AND is_super))
            -- ★归档项目的会不进日历★(D17):日历回答「我接下来要做什么」,
            -- 塞满已结题项目的历史会议会变成考古现场。历史仍可在项目页里查、搜索也搜得到。
            -- 判据:关联的项目**全部**归档才滤掉;只要还有一个在进行中就留下。
            AND NOT (EXISTS (SELECT 1 FROM meeting_projects mpj
                               JOIN projects p ON p.id = mpj.project_id
                              WHERE mpj.meeting_id = m.id AND p.archived_at IS NOT NULL)
                     AND NOT EXISTS (SELECT 1 FROM meeting_projects m2
                                       JOIN projects p2 ON p2.id = m2.project_id
                                      WHERE m2.meeting_id = m.id AND p2.archived_at IS NULL))
          ORDER BY m.starts_at",
    )
    .bind(username).bind(from).bind(to).bind(q.project_id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

pub async fn create(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Json(input): Json<MeetingIn>,
) -> AppResult<Json<serde_json::Value>> {
    let username = id.require_username()?;
    let title = input.title.trim();
    if title.is_empty() { return Err(AppError::BadRequest("会议标题不能为空".into())) }
    if input.recorder.trim().is_empty() { return Err(AppError::BadRequest("必须指定记录员(D14:纪要由他整理)".into())) }
    if input.ends_at <= input.starts_at { return Err(AppError::BadRequest("结束时间必须晚于开始时间".into())) }
    // ★不能发起已经过去的会★(2026-08-07 用户)。
    // ⚠ 留 5 分钟容差:填表本身要花时间,选了「最近的整点」再慢慢填完议程,提交时那个点可能刚过 ——
    // 卡死到秒会让人白填一轮。容差只对**创建**放,改期(update)不限,那是修正历史记录的正当场景。
    if input.starts_at < chrono::Utc::now() - chrono::Duration::minutes(5) {
        return Err(AppError::BadRequest("会议开始时间不能早于现在".into()));
    }
    if input.project_ids.is_empty() {
        return Err(AppError::BadRequest("会议必须关联至少一个项目(材料权限来自项目成员身份)".into()));
    }
    // ★每个关联项目都要 ≥editor★:把会议挂到一个项目上等于往那个项目里塞东西(纪要/材料最终落在那)。
    // 逐个校验而不是只验第一个——多项目关联时,漏验的那个就是越权入口(D4)。
    for pid in &input.project_ids {
        perm::require_role(&state.pool, &id, *pid, perm::Role::Editor).await?;
    }
    let vis = match input.visibility.as_deref() { Some("public") => "public", _ => "private" };

    let mut tx = state.pool.begin().await?;
    let mid: i64 = sqlx::query_scalar(
        "INSERT INTO meetings (title, agenda, organizer, recorder, starts_at, ends_at, timezone,
                               location, online_url, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'Asia/Shanghai'),$8,$9,$10) RETURNING id")
        .bind(title).bind(&input.agenda).bind(username).bind(input.recorder.trim())
        .bind(input.starts_at).bind(input.ends_at).bind(input.timezone.as_deref())
        .bind(&input.location).bind(&input.online_url).bind(vis)
        .fetch_one(&mut *tx).await?;
    for pid in &input.project_ids {
        sqlx::query("INSERT INTO meeting_projects (meeting_id, project_id) VALUES ($1,$2)")
            .bind(mid).bind(pid).execute(&mut *tx).await?;
    }
    // 发起人与记录员自动进名单(发起人 accepted:他自己定的时间,不用再答复一次)。
    sqlx::query("INSERT INTO meeting_participants (meeting_id, username, status, responded_at)
                 VALUES ($1,$2,'accepted',now()) ON CONFLICT DO NOTHING")
        .bind(mid).bind(username).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO meeting_participants (meeting_id, username) VALUES ($1,$2) ON CONFLICT DO NOTHING")
        .bind(mid).bind(input.recorder.trim()).execute(&mut *tx).await?;
    for u in &input.participants {
        let u = u.trim();
        if u.is_empty() { continue }
        sqlx::query("INSERT INTO meeting_participants (meeting_id, username) VALUES ($1,$2) ON CONFLICT DO NOTHING")
            .bind(mid).bind(u).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    audit::record(&state.pool, username, "meeting.create", &mid.to_string(), title).await;
    Ok(Json(json!({ "id": mid })))
}

/// GET /api/meetings/{id} —— 详情。★旁听者拿到的是**裁剪版**★(D9):
/// 只有标题/议程/时间/地点/链接,没有参会名单,更没有材料入口。
pub async fn detail(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let view = meeting_view(&state.pool, &id, mid).await?;
    let m: MeetingRow = sqlx::query_as(
        "SELECT m.*, mp.status AS my_status,
                NOT EXISTS (SELECT 1 FROM meeting_projects mpj
                              JOIN projects p ON p.id = mpj.project_id
                             WHERE mpj.meeting_id = m.id
                               AND p.visibility = 'public' AND p.deleted_at IS NULL) AS is_private
           FROM meetings m
           LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.username = $2
          WHERE m.id = $1")
        .bind(mid).bind(id.require_username()?)
        .fetch_optional(&state.pool).await?
        .ok_or(AppError::NotFound)?;
    if view == MeetingView::Observer {
        // ★逐字段挑出来给★,不是把 MeetingRow 塞进去删两个键——后者在加字段时会**默认泄露**。
        return Ok(Json(json!({
            "id": m.id, "title": m.title, "agenda": m.agenda,
            "starts_at": m.starts_at, "ends_at": m.ends_at, "timezone": m.timezone,
            "location": m.location, "online_url": m.online_url,
            "visibility": m.visibility, "status": m.status,
            "observer": true,
        })));
    }
    let parts: Vec<Participant> = sqlx::query_as(
        "SELECT p.username, u.name, p.kind, p.status, p.counter_starts_at, p.counter_ends_at,
                p.counter_reason, p.responded_at
           FROM meeting_participants p LEFT JOIN app_user u ON u.username = p.username
          WHERE p.meeting_id = $1 ORDER BY p.invited_at")
        .bind(mid).fetch_all(&state.pool).await?;
    let projects: Vec<(i64, String)> = sqlx::query_as(
        "SELECT p.id, p.name FROM meeting_projects mp JOIN projects p ON p.id = mp.project_id
          WHERE mp.meeting_id = $1 AND p.deleted_at IS NULL")
        .bind(mid).fetch_all(&state.pool).await?;
    Ok(Json(json!({
        "meeting": m, "participants": parts,
        "projects": projects.into_iter().map(|(i, n)| json!({"id": i, "name": n})).collect::<Vec<_>>(),
        "can_edit": require_meeting_host(&state.pool, &id, mid).await.is_ok(),
    })))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Participant {
    pub username: String,
    /// 真实姓名;没登录过则为空
    #[sqlx(default)]
    pub name: Option<String>,
    pub kind: String,
    pub status: String,
    pub counter_starts_at: Option<Ts>,
    pub counter_ends_at: Option<Ts>,
    pub counter_reason: Option<String>,
    pub responded_at: Option<Ts>,
}

#[derive(Deserialize)]
pub struct MeetingPatch {
    pub title: Option<String>,
    pub agenda: Option<String>,
    pub recorder: Option<String>,
    pub starts_at: Option<Ts>,
    pub ends_at: Option<Ts>,
    pub location: Option<String>,
    pub online_url: Option<String>,
    pub visibility: Option<String>,
}

pub async fn update(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(p): Json<MeetingPatch>,
) -> AppResult<Json<serde_json::Value>> {
    require_meeting_host(&state.pool, &id, mid).await?;
    let cur: (Ts, Ts, String) = sqlx::query_as("SELECT starts_at, ends_at, online_url FROM meetings WHERE id=$1")
        .bind(mid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    let (s, e) = (p.starts_at.unwrap_or(cur.0), p.ends_at.unwrap_or(cur.1));
    if e <= s { return Err(AppError::BadRequest("结束时间必须晚于开始时间".into())) }

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE meetings SET title=COALESCE($2,title), agenda=COALESCE($3,agenda),
                recorder=COALESCE($4,recorder), starts_at=$5, ends_at=$6,
                location=COALESCE($7,location), online_url=COALESCE($8,online_url),
                visibility=COALESCE($9,visibility), updated_at=now()
          WHERE id=$1")
        .bind(mid).bind(p.title.as_deref()).bind(p.agenda.as_deref()).bind(p.recorder.as_deref())
        .bind(s).bind(e).bind(p.location.as_deref()).bind(p.online_url.as_deref())
        .bind(p.visibility.as_deref())
        .execute(&mut *tx).await?;
    // ★改线上链接留痕★:开会前十分钟换链接是真实场景,事后要能追溯「谁何时改成什么」。
    if let Some(new) = p.online_url.as_deref() {
        if new != cur.2 {
            sqlx::query("INSERT INTO meeting_link_history (meeting_id, old_url, new_url, changed_by)
                         VALUES ($1,$2,$3,$4)")
                .bind(mid).bind(&cur.2).bind(new).bind(id.require_username()?)
                .execute(&mut *tx).await?;
        }
    }
    // ★改了时间就把所有人的答复清回 pending★:上次的「接受」是对**旧时间**说的,
    // 留着它等于替人答应了一个他没看过的时间。发起人与记录员除外(改的人自己知道)。
    if (p.starts_at.is_some() || p.ends_at.is_some()) && (s != cur.0 || e != cur.1) {
        sqlx::query(
            "UPDATE meeting_participants SET status='pending', responded_at=NULL,
                    counter_starts_at=NULL, counter_ends_at=NULL, counter_reason=NULL
              WHERE meeting_id=$1 AND username <> $2")
            .bind(mid).bind(id.require_username()?).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    audit::record(&state.pool, id.require_username()?, "meeting.update", &mid.to_string(), "").await;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/meetings/{id} —— ★取消不是删除★:置 status='canceled' 留档。
/// 会议是协作事实(谁邀了谁、谁拒了),真删掉之后没人说得清当时发生过什么。
pub async fn cancel(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    require_meeting_host(&state.pool, &id, mid).await?;
    sqlx::query("UPDATE meetings SET status='canceled', updated_at=now() WHERE id=$1")
        .bind(mid).execute(&state.pool).await?;
    audit::record(&state.pool, id.require_username()?, "meeting.cancel", &mid.to_string(), "").await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct InviteIn {
    pub usernames: Vec<String>,
    /// attendee(默认)/ guest(临时参会人,D8:能参会看不到材料)/ observer。
    #[serde(default)] pub kind: Option<String>,
}

/// PUT /api/meetings/{id}/participants —— ★批量★邀请(删组之后,一场会拉 20 人不能点 20 次)。
pub async fn invite(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(input): Json<InviteIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_meeting_host(&state.pool, &id, mid).await?;
    let kind = match input.kind.as_deref() {
        Some("guest") => "guest", Some("observer") => "observer", _ => "attendee",
    };
    let mut n = 0;
    for u in &input.usernames {
        let u = u.trim();
        if u.is_empty() { continue }
        // 与拉项目成员同一条校验:用户名以平台 Keycloak 为准(registry 不可达时降级本地表)。
        crate::http::projects::ensure_platform_user(&state, u).await?;
        sqlx::query("INSERT INTO meeting_participants (meeting_id, username, kind) VALUES ($1,$2,$3)
                     ON CONFLICT (meeting_id, username) DO UPDATE SET kind=EXCLUDED.kind")
            .bind(mid).bind(u).bind(kind).execute(&state.pool).await?;
        n += 1;
    }
    audit::record(&state.pool, id.require_username()?, "meeting.invite", &mid.to_string(), &format!("{n} 人 kind={kind}")).await;
    Ok(Json(json!({ "ok": true, "invited": n })))
}

/// DELETE /api/meetings/{id}/participants —— 移出参会人。
pub async fn uninvite(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<serde_json::Value>> {
    require_meeting_host(&state.pool, &id, mid).await?;
    let u = body.get("username").and_then(|v| v.as_str()).unwrap_or("").trim();
    if u.is_empty() { return Err(AppError::BadRequest("缺 username".into())) }
    // 发起人不能被移出——他被移出就没人能改这场会了(记录员可以,他还在)。
    let org: String = sqlx::query_scalar("SELECT organizer FROM meetings WHERE id=$1")
        .bind(mid).fetch_optional(&state.pool).await?.ok_or(AppError::NotFound)?;
    if org == u { return Err(AppError::BadRequest("不能移出发起人".into())) }
    sqlx::query("DELETE FROM meeting_participants WHERE meeting_id=$1 AND username=$2")
        .bind(mid).bind(u).execute(&state.pool).await?;
    audit::record(&state.pool, id.require_username()?, "meeting.uninvite", &mid.to_string(), u).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct RespondIn {
    /// accepted / declined / tentative / counter(建议改期)。
    pub status: String,
    /// status=counter 时的提议时间与理由。
    #[serde(default)] pub counter_starts_at: Option<Ts>,
    #[serde(default)] pub counter_ends_at: Option<Ts>,
    #[serde(default)] pub counter_reason: Option<String>,
}

/// POST /api/meetings/{id}/respond —— 答复邀请。
///
/// ★「建议改期」(counter)不是便利功能,是私事冲突**唯一的结构化出口**(D2)★:
/// 私密项目的日程对发起人完全隐形,他根本不知道我忙,只能由我主动提。
/// 所以 counter 必须带**具体的替代时间**——只说「我不行」等于把问题丢回去。
pub async fn respond(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(r): Json<RespondIn>,
) -> AppResult<Json<serde_json::Value>> {
    let username = id.require_username()?;
    // ★只有名单里的人能答复★:旁听者(public 会议路人)看得见这场会,但不能给自己投一票。
    let listed: Option<String> = sqlx::query_scalar(
        "SELECT username FROM meeting_participants WHERE meeting_id=$1 AND username=$2")
        .bind(mid).bind(username).fetch_optional(&state.pool).await?;
    if listed.is_none() {
        // 会议存在但我不在名单 → 403;会议根本看不见 → meeting_view 会给 404
        meeting_view(&state.pool, &id, mid).await?;
        return Err(AppError::Forbidden);
    }
    let st = match r.status.as_str() {
        s @ ("accepted" | "declined" | "tentative" | "counter") => s,
        _ => return Err(AppError::BadRequest("答复须为 accepted/declined/tentative/counter".into())),
    };
    if st == "counter" {
        let (Some(s), Some(e)) = (r.counter_starts_at, r.counter_ends_at) else {
            return Err(AppError::BadRequest("建议改期必须给出提议的起止时间(只说不行等于把问题丢回去)".into()));
        };
        if e <= s { return Err(AppError::BadRequest("提议的结束时间必须晚于开始时间".into())) }
    }
    sqlx::query(
        "UPDATE meeting_participants
            SET status=$3, responded_at=now(),
                counter_starts_at=$4, counter_ends_at=$5, counter_reason=$6
          WHERE meeting_id=$1 AND username=$2")
        .bind(mid).bind(username).bind(st)
        .bind(r.counter_starts_at).bind(r.counter_ends_at).bind(r.counter_reason.as_deref())
        .execute(&state.pool).await?;
    Ok(Json(json!({ "ok": true, "status": st })))
}

#[derive(Deserialize)]
pub struct FreeBusyQ {
    /// 逗号分隔的用户名。
    pub users: String,
    pub from: Ts,
    pub to: Ts,
}

/// GET /api/freebusy —— 忙闲查询(D1)。★只回时间段,不回任何内容★。
///
/// ★分流按**项目可见性**,不是按会议★:
///   · 关联了任一**公开**项目的会 → 产生忙闲(别人看到「忙」,但看不到标题);
///   · 只关联**私密**项目的会 → ★完全隐形★,别人看到的是「空闲」。
/// 这是刻意的:私事连「我忙」这件事都不该暴露。代价是发起人可能排到你头上,
/// 所以前端必须在**当事人自己**收到邀请时标红提醒 + 把「建议改期」放在旁边(D1 的三条硬要求之一)。
///
/// ⚠ 已拒绝(declined)的邀请不算忙——他明确说了不来。
pub async fn freebusy(
    State(state): State<AppState>,
    Extension(_id): Extension<Identity>,
    Query(q): Query<FreeBusyQ>,
) -> AppResult<Json<serde_json::Value>> {
    if q.to <= q.from { return Err(AppError::BadRequest("to 必须晚于 from".into())) }
    let users: Vec<String> = q.users.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if users.is_empty() { return Err(AppError::BadRequest("users 不能为空".into())) }
    if users.len() > 200 { return Err(AppError::BadRequest("一次最多查 200 人".into())) }
    let rows: Vec<(String, Ts, Ts)> = sqlx::query_as(
        "SELECT mp.username, m.starts_at, m.ends_at
           FROM meeting_participants mp
           JOIN meetings m ON m.id = mp.meeting_id
          WHERE mp.username = ANY($1) AND m.status='active'
            AND mp.status <> 'declined'
            AND m.starts_at < $3 AND m.ends_at > $2
            AND EXISTS (SELECT 1 FROM meeting_projects mpj
                          JOIN projects p ON p.id = mpj.project_id
                         WHERE mpj.meeting_id = m.id
                           AND p.visibility = 'public' AND p.deleted_at IS NULL
                           -- ★归档项目不再产生忙闲★(D17):项目结题了,它的历史会议
                           -- 不该继续把人显示成「忙」——那会让别人永远约不到你。
                           AND p.archived_at IS NULL)
          ORDER BY mp.username, m.starts_at")
        .bind(&users).bind(q.from).bind(q.to)
        .fetch_all(&state.pool).await?;
    let mut out = serde_json::Map::new();
    for u in &users { out.insert(u.clone(), json!([])); }
    for (u, s, e) in rows {
        if let Some(v) = out.get_mut(&u).and_then(|v| v.as_array_mut()) {
            v.push(json!({ "start": s, "end": e }));
        }
    }
    Ok(Json(json!({ "busy": out })))
}

#[derive(Deserialize)]
pub struct MsgQ { pub channel: Option<String>, pub peer: Option<String> }

#[derive(Serialize, sqlx::FromRow)]
pub struct MessageRow {
    pub id: i64, pub sender: String, pub channel: String,
    pub peer: Option<String>, pub body: String, pub created_at: Ts,
}

/// GET /api/meetings/{id}/messages —— 会议讨论区(D13)。
/// public 频道:参会人可见;private:仅双方可见。★旁听者一律不给★。
pub async fn messages(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Query(q): Query<MsgQ>,
) -> AppResult<Json<Vec<MessageRow>>> {
    // ★讨论区是 Inside 专属★:D9 给旁听者的是「知道会议存在与议程」,不含听人聊天。
    if meeting_view(&state.pool, &id, mid).await? != MeetingView::Inside {
        return Err(AppError::Forbidden);
    }
    let username = id.require_username()?;
    let rows: Vec<MessageRow> = match q.channel.as_deref() {
        Some("private") => {
            let peer = q.peer.as_deref().unwrap_or("").trim().to_string();
            if peer.is_empty() { return Err(AppError::BadRequest("私聊须指定 peer".into())) }
            // 只取「我与他」这一对的,两个方向都要。
            sqlx::query_as(
                "SELECT id, sender, channel, peer, body, created_at FROM meeting_messages
                  WHERE meeting_id=$1 AND channel='private'
                    AND ((sender=$2 AND peer=$3) OR (sender=$3 AND peer=$2))
                  ORDER BY created_at")
                .bind(mid).bind(username).bind(&peer).fetch_all(&state.pool).await?
        }
        _ => sqlx::query_as(
                "SELECT id, sender, channel, peer, body, created_at FROM meeting_messages
                  WHERE meeting_id=$1 AND channel='public' ORDER BY created_at")
                .bind(mid).fetch_all(&state.pool).await?,
    };
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct MsgIn { pub body: String, #[serde(default)] pub channel: Option<String>, #[serde(default)] pub peer: Option<String> }

/// POST /api/meetings/{id}/messages —— 发言。
/// ★私聊对象只限发起人与记录员★(D13):不做任意点对点,否则这里会长成一个 IM。
pub async fn send_message(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(m): Json<MsgIn>,
) -> AppResult<Json<serde_json::Value>> {
    if meeting_view(&state.pool, &id, mid).await? != MeetingView::Inside {
        return Err(AppError::Forbidden);
    }
    let username = id.require_username()?;
    let body = m.body.trim();
    if body.is_empty() { return Err(AppError::BadRequest("内容不能为空".into())) }
    if body.chars().count() > 4000 { return Err(AppError::BadRequest("单条最多 4000 字".into())) }
    let (channel, peer) = match m.channel.as_deref() {
        Some("private") => {
            let peer = m.peer.as_deref().unwrap_or("").trim().to_string();
            if peer.is_empty() { return Err(AppError::BadRequest("私聊须指定 peer".into())) }
            let hosts: Vec<String> = sqlx::query_scalar(
                "SELECT organizer FROM meetings WHERE id=$1
                 UNION SELECT recorder FROM meetings WHERE id=$1")
                .bind(mid).fetch_all(&state.pool).await?;
            if !hosts.iter().any(|h| h == &peer) {
                return Err(AppError::BadRequest("私聊只能发给发起人或记录员(D13:不做任意点对点)".into()));
            }
            ("private", Some(peer))
        }
        _ => ("public", None),
    };
    let id_: i64 = sqlx::query_scalar(
        "INSERT INTO meeting_messages (meeting_id, sender, channel, peer, body) VALUES ($1,$2,$3,$4,$5) RETURNING id")
        .bind(mid).bind(username).bind(channel).bind(peer.as_deref()).bind(body)
        .fetch_one(&state.pool).await?;
    Ok(Json(json!({ "id": id_ })))
}

// ── 会议纪要(D14)────────────────────────────────────────────────────────
// ★AI 只是原材料,记录员才是作者★:`/api/items/{id}/analysis` 出的转写与摘要是**给他看的**,
// 这里存的是**他整理过的正式纪要**。两者刻意不打通——一键把 AI 稿写进纪要,
// 等于让「记录员按模板整理」这条决策名存实亡(D14 反复确认过)。

#[derive(Serialize, sqlx::FromRow)]
pub struct Minutes {
    pub meeting_id: i64,
    pub status: String,
    /// 到场/列席/缺席:★会后补录的**事实**★(D11),不是邀请时的名单——
    /// 谁接受了邀请和谁真的来了是两件事,统计口径按这个。
    pub attendees: String,
    pub observers: String,
    pub absentees: String,
    pub agenda_text: String,
    /// 正文 Markdown。出 PDF 时转 LaTeX(走平台共享 latex-svc,congrove 镜像不装 TeX)。
    pub content_md: String,
    pub resolutions: String,
    pub todos: String,
    pub pdf_item_id: Option<i64>,
    pub completed_at: Option<Ts>,
    pub updated_at: Ts,
}

/// GET /api/meetings/{id}/minutes —— 取纪要(没有则回一份空的,前端不用判 404)。
pub async fn minutes_get(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    // ★纪要是会议内容,旁听者不给★(与讨论区同档):D9 给旁听者的是「知道有这个会」。
    if meeting_view(&state.pool, &id, mid).await? != MeetingView::Inside {
        return Err(AppError::Forbidden);
    }
    let m: Option<Minutes> = sqlx::query_as("SELECT * FROM meeting_minutes WHERE meeting_id = $1")
        .bind(mid).fetch_optional(&state.pool).await?;
    // 谁能编辑:记录员(本职)或发起人。★不是「参会人都能改」★——纪要要有唯一作者,
    // 否则「按固定模板整理」会变成谁都能覆盖一遍的公共草稿。
    let can_edit = require_meeting_host(&state.pool, &id, mid).await.is_ok();
    Ok(Json(json!({ "minutes": m, "can_edit": can_edit })))
}

#[derive(Deserialize)]
pub struct MinutesIn {
    pub attendees: Option<String>,
    pub observers: Option<String>,
    pub absentees: Option<String>,
    pub agenda_text: Option<String>,
    pub content_md: Option<String>,
    pub resolutions: Option<String>,
    pub todos: Option<String>,
    /// 置 done = 定稿。★定稿后仍可改★(会后补录到场情况是常事),只是记一个 completed_at。
    pub status: Option<String>,
}

/// PUT /api/meetings/{id}/minutes —— 记录员保存纪要(upsert)。
pub async fn minutes_put(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(p): Json<MinutesIn>,
) -> AppResult<Json<serde_json::Value>> {
    require_meeting_host(&state.pool, &id, mid).await?;
    let status = match p.status.as_deref() {
        Some("done") => "done",
        Some("draft") | None => "draft",
        _ => return Err(AppError::BadRequest("状态须为 draft/done".into())),
    };
    sqlx::query(
        "INSERT INTO meeting_minutes
           (meeting_id, status, attendees, observers, absentees, agenda_text, content_md, resolutions, todos,
            completed_at, updated_at)
         VALUES ($1,$2,COALESCE($3,''),COALESCE($4,''),COALESCE($5,''),COALESCE($6,''),
                 COALESCE($7,''),COALESCE($8,''),COALESCE($9,''),
                 CASE WHEN $2='done' THEN now() END, now())
         ON CONFLICT (meeting_id) DO UPDATE SET
           status=EXCLUDED.status,
           attendees=COALESCE($3, meeting_minutes.attendees),
           observers=COALESCE($4, meeting_minutes.observers),
           absentees=COALESCE($5, meeting_minutes.absentees),
           agenda_text=COALESCE($6, meeting_minutes.agenda_text),
           content_md=COALESCE($7, meeting_minutes.content_md),
           resolutions=COALESCE($8, meeting_minutes.resolutions),
           todos=COALESCE($9, meeting_minutes.todos),
           -- ★定稿时间只记第一次★:之后补录到场情况不该把「什么时候定的稿」冲掉
           completed_at=CASE WHEN $2='done' THEN COALESCE(meeting_minutes.completed_at, now()) ELSE NULL END,
           updated_at=now()")
        .bind(mid).bind(status)
        .bind(p.attendees.as_deref()).bind(p.observers.as_deref()).bind(p.absentees.as_deref())
        .bind(p.agenda_text.as_deref()).bind(p.content_md.as_deref())
        .bind(p.resolutions.as_deref()).bind(p.todos.as_deref())
        .execute(&state.pool).await?;
    audit::record(&state.pool, id.require_username()?, "minutes.save", &mid.to_string(), status).await;
    Ok(Json(json!({ "ok": true, "status": status })))
}

// ── 会议材料 / 改动历史 / 催办 / 采纳改期 ──────────────────────────────────
// 对应原型 meet 视图右侧与中部的几块(docs/UI-GAP.md)。

#[derive(Serialize, sqlx::FromRow)]
pub struct MeetingItem {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub size: Option<i64>,
    pub mime: Option<String>,
    /// ★录制 ≠ 材料★(D5):只有 is_recording 的文件会被转写、并作为会议时长依据。
    pub is_recording: bool,
    pub created_by: String,
    pub created_at: Ts,
}

/// GET /api/meetings/{id}/items —— 会议的材料与录制。
/// 前端分两个 tab 显示;★这是会议的「只读区」★(D10):唯一写入口是会议详情页,
/// 在项目树里不允许对它改名/移动/删除。
pub async fn meeting_items(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<Vec<MeetingItem>>> {
    // ★材料按项目成员身份判权,不是按参会身份★(D8):临时参会人看得到会议,看不到材料。
    // 所以这里不能只用 meeting_view —— 要求他在**任一关联项目**里至少是 viewer。
    let username = id.require_username()?;
    let ok: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM meeting_projects mp
           JOIN project_members pm ON pm.project_id = mp.project_id
          WHERE mp.meeting_id = $1 AND pm.username = $2
          UNION ALL SELECT 1 FROM app_user WHERE username = $2 AND is_super
          LIMIT 1")
        .bind(mid).bind(username).fetch_optional(&state.pool).await?;
    if ok.is_none() {
        // 看得见会议但不是项目成员 → 403(他知道有这场会,只是拿不到材料);完全看不见 → 404
        meeting_view(&state.pool, &id, mid).await?;
        return Err(AppError::Forbidden);
    }
    let rows: Vec<MeetingItem> = sqlx::query_as(
        "SELECT id, name, kind, size, mime, coalesce(is_recording,false) AS is_recording, created_by, created_at
           FROM items WHERE meeting_id = $1 AND deleted_at IS NULL AND kind <> 'folder'
          ORDER BY is_recording, created_at")
        .bind(mid).fetch_all(&state.pool).await?;
    Ok(Json(rows))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct LinkChange {
    pub old_url: String,
    pub new_url: String,
    pub changed_by: String,
    pub changed_at: Ts,
}

/// GET /api/meetings/{id}/link-history —— 线上会议链接的改动历史。
/// 开会前十分钟改链接是真实场景,事后要能追溯「谁何时改成什么」。
pub async fn link_history(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
) -> AppResult<Json<Vec<LinkChange>>> {
    if meeting_view(&state.pool, &id, mid).await? != MeetingView::Inside {
        return Err(AppError::Forbidden);
    }
    let rows: Vec<LinkChange> = sqlx::query_as(
        "SELECT old_url, new_url, changed_by, changed_at FROM meeting_link_history
          WHERE meeting_id = $1 ORDER BY changed_at DESC")
        .bind(mid).fetch_all(&state.pool).await?;
    Ok(Json(rows))
}

/// POST /api/meetings/{id}/remind —— 催办未应答的人(发起人/记录员)。
/// ★只催「还没答复」的★:已接受/已拒绝的人不该再被打扰。
pub async fn remind(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<serde_json::Value>> {
    require_meeting_host(&state.pool, &id, mid).await?;
    let only = body.get("username").and_then(|v| v.as_str()).map(str::to_string);
    let targets: Vec<String> = sqlx::query_scalar(
        "SELECT username FROM meeting_participants
          WHERE meeting_id = $1 AND status = 'pending' AND ($2::text IS NULL OR username = $2)")
        .bind(mid).bind(only.as_deref()).fetch_all(&state.pool).await?;
    if targets.is_empty() {
        return Err(AppError::BadRequest("没有需要催的人(都已答复)".into()));
    }
    let (title, starts): (String, Ts) = sqlx::query_as("SELECT title, starts_at FROM meetings WHERE id=$1")
        .bind(mid).fetch_one(&state.pool).await?;
    // 站内信走平台 registry;不可达时降级为「只记审计不发信」——催办失败不该让接口报错。
    let mut sent = 0;
    if let Some(reg) = &state.registry {
        for u in &targets {
            let body = format!("「{title}」将于 {} 开始,你还没有答复。", starts.format("%m-%d %H:%M"));
            // notify 是 best-effort(不返回 Result):站内信发不出去不该让催办接口失败
            reg.notify(u, "会议待你答复", &body, None, Some(&format!("meeting:{mid}"))).await;
            sent += 1;
        }
    }
    audit::record(&state.pool, id.require_username()?, "meeting.remind", &mid.to_string(),
                  &format!("{} 人", targets.len())).await;
    Ok(Json(json!({ "ok": true, "targets": targets.len(), "sent": sent })))
}

/// POST /api/meetings/{id}/accept-counter —— 采纳某人的改期建议。
/// ★采纳 = 把会议时间改成他提议的时间★,随后所有人的答复清回 pending(与改时间同一套语义)。
pub async fn accept_counter(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(mid): Path<i64>,
    Json(body): Json<serde_json::Value>,
) -> AppResult<Json<serde_json::Value>> {
    require_meeting_host(&state.pool, &id, mid).await?;
    let who = body.get("username").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if who.is_empty() { return Err(AppError::BadRequest("缺 username".into())) }
    let row: Option<(Option<Ts>, Option<Ts>)> = sqlx::query_as(
        "SELECT counter_starts_at, counter_ends_at FROM meeting_participants
          WHERE meeting_id=$1 AND username=$2 AND status='counter'")
        .bind(mid).bind(&who).fetch_optional(&state.pool).await?;
    let Some((Some(s), Some(e))) = row else {
        return Err(AppError::BadRequest("这个人没有提出改期建议".into()));
    };
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE meetings SET starts_at=$2, ends_at=$3, updated_at=now() WHERE id=$1")
        .bind(mid).bind(s).bind(e).execute(&mut *tx).await?;
    // 时间变了,所有人的答复都得重来 —— 包括提议者本人:他提的是时间,不等于他一定能来。
    sqlx::query(
        "UPDATE meeting_participants SET status='pending', responded_at=NULL,
                counter_starts_at=NULL, counter_ends_at=NULL, counter_reason=NULL
          WHERE meeting_id=$1 AND username <> $2")
        .bind(mid).bind(id.require_username()?).execute(&mut *tx).await?;
    tx.commit().await?;
    audit::record(&state.pool, id.require_username()?, "meeting.accept-counter", &mid.to_string(), &who).await;
    Ok(Json(json!({ "ok": true, "starts_at": s, "ends_at": e })))
}
