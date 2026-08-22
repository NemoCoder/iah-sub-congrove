//! 超管面:用户列表 / 提拔·撤销超管 / 全局审计查询。整层挂 require_super(mod.rs)。

use axum::extract::{Path, Query, State};
use axum::{Extension, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::audit;
use crate::auth::Identity;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize, sqlx::FromRow)]
pub struct UserRow {
    pub username: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub is_super: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub last_login: Option<chrono::DateTime<chrono::Utc>>,
    /// 生效额度:单独设过就是他自己的,没设过就是全站默认。
    pub quota_bytes: i64,
    /// ★true = 没有 `user_quota` 行,跟着全站默认走★。
    ///
    /// ⚠ 这一列**不是冗余**:只给 `quota_bytes` 的话,「50 GiB 是他自己的,
    ///   还是全站默认正好是 50 GiB」在界面上**分不出来** ——
    ///   而这恰恰决定了「改全站默认会不会影响他」。
    ///   2026-08-16 实测 dev:108 个用户里 **0 个**设过,全都是 true。
    pub quota_is_default: bool,
    /// ★已用量★(2026-08-22 liaoruili 要的「已用」列):没有它,超管在这一页上
    /// 只看得见「给了多少」看不见「用了多少」—— 而他要做的判断(该不该调额度)
    /// 恰恰要两个数一起看。与 `/api/me/quota` **同一套去重规则**(items::owners_used_bulk)。
    pub used_bytes: i64,
}

/// GET /api/admin/users —— 登录过的全部用户(含生效配额与它是不是默认值)。
pub async fn users(State(state): State<AppState>) -> AppResult<Json<Vec<UserRow>>> {
    // 全站默认只读一次,不在 SQL 里 join 常量:它的唯一推导在 settings.rs(库 > 常量)。
    let (默认额度, _) = crate::settings::effective_default_quota(&state.pool).await;
    let mut rows: Vec<UserRow> = sqlx::query_as(
        "SELECT u.username, u.name, u.email, u.is_super, u.created_at, u.last_login,
                COALESCE(q.quota_bytes, $1)::bigint AS quota_bytes,
                (q.username IS NULL)              AS quota_is_default,
                0::bigint                         AS used_bytes
           FROM app_user u
           LEFT JOIN user_quota q ON q.username = u.username
          ORDER BY u.username",
    )
    .bind(默认额度)
    .fetch_all(&state.pool)
    .await?;
    // ★一次查完所有人的用量,别逐行调 owner_quota_used★——那是每人一次多表 JOIN,
    // 一屏 111 个用户就是 111 次查询(N+1)。没有项目的人不在结果里,用量就是 0。
    let 用量 = crate::http::items::owners_used_bulk(&state.pool).await?;
    for r in &mut rows { r.used_bytes = 用量.get(&r.username).copied().unwrap_or(0) }
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct ImpactQuery { pub bytes: i64 }

/// GET /api/admin/settings/default-quota/impact?bytes=N —— ★改全站默认之前,先算清楚会影响谁★。
///
/// 为什么这是个独立接口而不是前端自己算:`would_exceed` 要跨 `items` / `item_versions`
/// 求和(就是 `owner_quota_used` 那段 SQL),前端拿不到也不该拿。
/// ★而没有它,「一键把全站配额调小」就是一个**无法预估后果**的按钮★ ——
/// 点下去之后有人立刻传不了东西,而超管完全不知道自己做了这件事。
pub async fn default_quota_impact(
    State(state): State<AppState>, Query(q): Query<ImpactQuery>,
) -> AppResult<Json<serde_json::Value>> {
    if q.bytes <= 0 { return Err(AppError::BadRequest("配额要大于 0".into())) }
    // 跟随默认的人 = 没有 user_quota 行的
    let 跟随: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM app_user u LEFT JOIN user_quota q ON q.username = u.username
          WHERE q.username IS NULL")
        .fetch_one(&state.pool).await?;
    // 这些人里,谁的已用量会超过新额度。★只算跟随默认的人★——设过配额的人不受这次改动影响。
    // ★用量走唯一那份推导★(2026-08-22 改):这里原先自己写了一段
    //   `JOIN LATERAL … GROUP BY k` —— 按**单个项目**去重再把各项目相加,
    //   而 `owner_quota_used` 是**跨这个人的全部项目**去重。
    //   ⇒ 同一个 blob 落在同一人的两个项目里就会被算两次,两处给出的「已用」对不上。
    //   ★dev 上两者碰巧相等(那些项目之间没有共享 blob),所以一直没暴露★——
    //   而秒传/去重(内容寻址)正是让「同一 blob 出现在多处」变成常态的那个功能。
    let 跟随默认: std::collections::HashSet<String> = sqlx::query_scalar::<_, String>(
        "SELECT u.username FROM app_user u LEFT JOIN user_quota q ON q.username = u.username
          WHERE q.username IS NULL")
        .fetch_all(&state.pool).await?.into_iter().collect();
    let mut 超额: Vec<(String, i64)> = crate::http::items::owners_used_bulk(&state.pool).await?
        .into_iter()
        // ★只算跟随默认的人★——设过配额的人不受这次改动影响
        .filter(|(owner, used)| *used > q.bytes && 跟随默认.contains(owner))
        .collect();
    超额.sort_by_key(|(_, used)| std::cmp::Reverse(*used));
    // 只是给界面举例「有哪些人」,总数用上面的 count;20 条够看
    超额.truncate(20);
    Ok(Json(json!({
        "following_default": 跟随,
        "would_exceed": 超额.len(),
        "exceeding": 超额.iter().map(|(u, n)| json!({ "username": u, "used_bytes": n })).collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct SuperIn {
    pub is_super: bool,
}

/// PUT /api/admin/users/{username}/super —— 提拔/撤销超管。
/// 防锁死:不能撤掉最后一个超管;白名单用户(env 种子)由登录逻辑重新置回,撤了也会复活——UI 提示即可。
pub async fn set_super(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(username): Path<String>,
    Json(input): Json<SuperIn>,
) -> AppResult<Json<serde_json::Value>> {
    if !input.is_super {
        let supers: i64 = sqlx::query_scalar("SELECT count(*) FROM app_user WHERE is_super").fetch_one(&state.pool).await?;
        let victim: Option<bool> = sqlx::query_scalar("SELECT is_super FROM app_user WHERE username = $1")
            .bind(&username)
            .fetch_optional(&state.pool)
            .await?;
        if victim == Some(true) && supers <= 1 {
            return Err(AppError::BadRequest("不能撤掉最后一个超管".into()));
        }
    }
    let n = sqlx::query("UPDATE app_user SET is_super = $1 WHERE username = $2")
        .bind(input.is_super)
        .bind(&username)
        .execute(&state.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound);
    }
    audit::record(&state.pool, id.require_username()?, "admin.super", &username,
        if input.is_super { "grant" } else { "revoke" }).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct UserQuery {
    /// 前缀(用户名或显示名)。**必填**,见下。
    pub q: Option<String>,
}

/// GET /api/users?q=… —— 选人下拉的数据源(**不在** admin 闸内,任何登录用户可用)。
///
/// ★两条口径,合起来才是「能选到人,但看不到名册」★
/// (2026-08-15 对抗检查提出,liaoruili 拍板:「只能通过完整账号搜索,
///  然后同一个项目的人是可以直接列举出来的 —— 你可以看到所有项目里面的人,
///  但是你看不到整个系统的人」):
///
///   ① **陌生人:只认完整账号**。`username = q`,一个字都不能少。
///      这是一个 **oracle**(问「有没有这个人」),不是 **dump**(要「有哪些人」)——
///      前者是拉人所必需的,后者就是目录枚举。
///   ② **同项目的人:随便搜,前缀就行**。你们已经在同一个项目里共事,
///      他的名字对你本来就不是秘密(成员页上就列着)。
///
/// ⚠★为什么把前缀搜索砍掉★:此前是「username 或 name 前缀 ILIKE,回 20 条」。
///   `q=a` 就能拿到 20 个人,`q=b` 再 20 个 —— 敲 26 个字母基本就把全所名册抄走了,
///   带真名。★限 20 条限的是**每次**的量,不是**总共**能拿到的量★,
///   而枚举攻击从来不介意多打几次请求。这与平台「不做用户 list/search 接口」
///   (2026-08-07 liaoruili 拍板)是同一条线。
///
/// 仍不回邮箱。口径仍是「登录过汇流的人」(平台名录真相在 Keycloak,拉人时 users/exists 兜底)。
pub async fn user_options(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Query(q): Query<UserQuery>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let 输入 = q.q.unwrap_or_default().trim().to_string();
    if 输入.is_empty() {
        return Ok(Json(vec![]));
    }
    let me = id.require_username()?;
    let like = format!("{}%", 输入.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT u.username, u.name FROM app_user u
          WHERE
            -- ① 完整账号精确命中:问得出「有没有这个人」,问不出「有哪些人」
            u.username = $1
            -- ② 与我**现在**共着项目的人:名字对我本来就不是秘密,允许前缀搜
            -- ⚠★必须排掉已删的项目★(2026-08-16 全量 E2E 抓到,是**真 bug** 不是用例抖):
            --   项目是软删除,删掉之后 `project_members` 那两行**照旧存在** ——
            --   于是「我们曾经共过一个项目」永久成立,他的名字对我永远可搜。
            --   这跟本系统自己的「离开即失去」正相反(member_delete 连他建的公开链接都撤,
            --   就是为了不留后门),而删项目比移出成员**更彻底**,却反而什么都没收回。
            --   ★判据要的是「现在」,而软删除让「曾经」看起来像「现在」★——
            --   这与 v0.3.55 那次「删进回收站的东西公开链接照样下得到」是同一类:
            --   软删除是后加的,凡是拿 `WHERE …` 判权/判可见的地方都要重问一遍这句加了没有。
            OR ((u.username ILIKE $2 ESCAPE '\\' OR u.name ILIKE $2 ESCAPE '\\')
                AND EXISTS (SELECT 1 FROM project_members 我 JOIN project_members 他
                                     ON 他.project_id = 我.project_id
                                   JOIN projects pr ON pr.id = 我.project_id AND pr.deleted_at IS NULL
                                  WHERE 我.username = $3 AND 他.username = u.username))
          ORDER BY u.username -- limit-ok: 输入即搜的候选 —— typeahead 取前 20 个,人再敲一个字就换一批;
              --   ★它不是「用户列表」★:平台明令不做用户 list/search(会变成目录枚举)。
              LIMIT 20",
    )
    .bind(&输入)
    .bind(&like)
    .bind(me)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows.into_iter().map(|(u, n)| serde_json::json!({ "username": u, "name": n })).collect()))
}

#[derive(Deserialize)]
pub struct QuotaIn {
    pub quota_bytes: i64,
}

/// PUT /api/admin/users/{username}/quota —— ★调**某个人**的配额★（ADR-0004，超管专属）。
///
/// 从「按项目」改成「按人」：额度是给人的资源，挂在项目上意味着建一个新项目就白得 10GiB。
/// ★upsert★：没有行 = 用系统默认（不是 0），所以第一次调额度要插行。
pub async fn set_quota(
    State(state): State<AppState>,
    Extension(id): Extension<Identity>,
    Path(username): Path<String>,
    Json(input): Json<QuotaIn>,
) -> AppResult<Json<serde_json::Value>> {
    if input.quota_bytes < 0 {
        return Err(AppError::BadRequest("配额不能为负".into()));
    }
    let who = username.trim();
    if who.is_empty() {
        return Err(AppError::BadRequest("用户名不能为空".into()));
    }
    let actor = id.require_username()?;
    sqlx::query(
        "INSERT INTO user_quota (username, quota_bytes, updated_by) VALUES ($1,$2,$3)
         ON CONFLICT (username) DO UPDATE SET quota_bytes = EXCLUDED.quota_bytes,
                                              updated_by = EXCLUDED.updated_by, updated_at = now()",
    )
    .bind(who).bind(input.quota_bytes).bind(actor)
    .execute(&state.pool)
    .await?;
    audit::record(&state.pool, actor, "admin.quota", who, &input.quota_bytes.to_string()).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct AuditQuery {
    pub limit: Option<i64>,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct AuditRow {
    pub id: i64,
    pub ts: chrono::DateTime<chrono::Utc>,
    pub actor: String,
    pub action: String,
    pub target: String,
    pub detail: String,
}

/// GET /api/admin/audit —— 全局审计(最近 N 条,默认 200 封顶 2000)。
pub async fn audit_list(State(state): State<AppState>, Query(q): Query<AuditQuery>) -> AppResult<Json<Vec<AuditRow>>> {
    let limit = q.limit.unwrap_or(200).clamp(1, 2000);
    let rows: Vec<AuditRow> =
        sqlx::query_as("SELECT id, ts, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT $1")
            .bind(limit)
            .fetch_all(&state.pool)
            .await?;
    Ok(Json(rows))
}

// ══════ ★AI 模型:超管在后台选,不再写死在 env 里★(2026-08-16 热修)══════
//
// 起因是 prod 上的一次真实故障:平台换了模型,congrove 还在调 `Qwen3.6-35B-A3B`,
// 于是 `LLM 返回 403:无权调用模型 Qwen3.6-35B-A3B` —— ★纪要功能整个哑掉,
// 而子系统这边没有任何自助恢复的办法★,只能等人去改平台的环境变量再重启。
// ⇒ 配置项该由超管在界面上选。env 仍然是**兜底默认值**,库里有值就以库为准。

/// 「现在该用哪个模型」——★唯一推导★:库里的设置 > env(`CONGROVE_LLM_MODEL`)> 编译期默认。
/// ⚠ 别在别处直接读 `state.config.llm_model` —— 那样超管改了也不生效,
///   而它**不报错**,只是继续用老模型(这正是「安静地不工作」那一类)。
pub async fn effective_llm_model(state: &AppState) -> String {
    sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key = 'llm_model'")
        .fetch_optional(&state.pool).await.ok().flatten()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| state.config.llm_model.clone())
}

/// GET /api/admin/llm/models —— 列出网关当前可用的模型 + 现在选的是哪个(超管)。
///
/// ⚠★网关的 `/v1/models` 只列常驻模型★:按需(scale-to-zero)的模型**不在列表里,但能调**。
///   所以界面上必须**同时允许手输**一个不在列表里的名字 —— 只给下拉等于把按需模型全挡了。
///   (这条是平台侧的既有事实,不是 bug;我在别处踩过,记在这儿免得下次又当成列表坏了。)
/// ⚠ 网关不可达时**不编造空列表**:如实回 `error`,让界面说「列不出来,但你仍可手输」。
pub async fn llm_models(State(state): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    let current = effective_llm_model(&state).await;
    let (base, key) = (state.config.llm_base_url.clone(), state.config.llm_api_key.clone());
    let Some(base) = base else {
        return Ok(Json(json!({ "current": current, "models": [], "error": "未注入 IAH_BASE_URL,列不出模型" })));
    };
    let cli = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build()
        .map_err(|e| AppError::Other(e.into()))?;
    let mut req = cli.get(format!("{base}/models"));
    if let Some(k) = key { req = req.bearer_auth(k) }
    match req.send().await {
        Ok(r) if r.status().is_success() => {
            let v: serde_json::Value = r.json().await.unwrap_or_else(|_| json!({}));
            let models: Vec<String> = v["data"].as_array().map(|a| a.iter()
                .filter_map(|m| m["id"].as_str().map(str::to_string)).collect()).unwrap_or_default();
            Ok(Json(json!({ "current": current, "models": models })))
        }
        Ok(r) => Ok(Json(json!({ "current": current, "models": [],
            "error": format!("网关返回 {}", r.status()) }))),
        Err(e) => Ok(Json(json!({ "current": current, "models": [],
            "error": format!("连不上网关:{e}") }))),
    }
}

#[derive(Deserialize)]
pub struct ModelIn { pub model: String }

/// PUT /api/admin/llm/model —— 选一个模型(超管)。
/// ★不校验它在不在列表里★:按需模型本来就不在列表里(见上)。写错的代价是下一次生成纪要报 403,
/// 那条错误现在会原样显示给用户,改回来只要再选一次 —— 比「拦住一个其实可用的模型」好。
pub async fn set_llm_model(
    State(state): State<AppState>, Extension(id): Extension<Identity>, Json(input): Json<ModelIn>,
) -> AppResult<Json<serde_json::Value>> {
    let m = input.model.trim();
    if m.is_empty() { return Err(AppError::BadRequest("模型名不能为空".into())) }
    if m.chars().count() > 200 { return Err(AppError::BadRequest("模型名过长".into())) }
    let who = id.require_username()?;
    sqlx::query(
        "INSERT INTO app_setting (key, value, updated_by, updated_at) VALUES ('llm_model',$1,$2,now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()")
        .bind(m).bind(who).execute(&state.pool).await?;
    audit::record(&state.pool, who, "admin.llm_model", "llm_model", m).await;
    Ok(Json(json!({ "ok": true, "model": m })))
}

// ══════ ★治理配置:超管在后台改,不再是一次部署★(2026-08-16,docs/TECH-DESIGN-admin-console.md)══════
//
// 取值一律走 `crate::settings::effective_*`(那里有唯一推导与「为什么不加缓存」的说明)。
// 这里只负责 HTTP:读出来带上「值是从哪来的」、写进去之前过校验与白名单。

/// GET /api/admin/settings —— 三项治理配置的**当前生效值 + 它从哪来**。
///
/// ★`source` 不是调试信息★:超管看到「10 GiB」得知道它是「有人设成了 10」
/// 还是「没人设过,恰好默认是 10」—— 这两种状态在他改 env 或升级版本时表现完全不同。
pub async fn settings_get(State(state): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    let (creators, c_src) = crate::settings::effective_project_creators(&state.pool, &state.config).await;
    let (quota, q_src) = crate::settings::effective_default_quota(&state.pool).await;
    let (remind, r_src) = crate::settings::effective_default_remind(&state.pool).await;
    Ok(Json(json!({
        "project_creators":       { "value": creators, "source": c_src },
        "default_quota_bytes":    { "value": quota,    "source": q_src },
        "default_remind_minutes": { "value": remind,   "source": r_src },
    })))
}

#[derive(Deserialize)]
pub struct SettingIn { pub value: String }

/// PUT /api/admin/settings/{key} —— 改一项(超管)。值一律用字符串传,语义由 key 决定
/// (和 `app_setting` 的存法一致 —— 存的和传的是同一种东西,少一层需要对齐的表示)。
pub async fn settings_put(
    State(state): State<AppState>, Extension(id): Extension<Identity>,
    Path(key): Path<String>, Json(input): Json<SettingIn>,
) -> AppResult<Json<serde_json::Value>> {
    // ★白名单在最前面★:不在名单里的 key 连校验都不该走到(见 settings.rs 上那段「权限自动扩大」)
    if !crate::settings::可写的键.contains(&key.as_str()) {
        return Err(AppError::BadRequest(format!("不认识的设置项:{key}")));
    }
    let 规范值 = crate::settings::校验(&state.pool, &key, &input.value).await
        .map_err(AppError::BadRequest)?;
    let who = id.require_username()?;
    sqlx::query(
        "INSERT INTO app_setting (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()")
        .bind(&key).bind(&规范值).bind(who).execute(&state.pool).await?;
    audit::record(&state.pool, who, "admin.setting", &key, &规范值).await;
    Ok(Json(json!({ "ok": true, "value": 规范值 })))
}

/// DELETE /api/admin/users/{username}/quota —— ★把这个人放回「跟随全站默认」★。
///
/// 为什么必须有这条(2026-08-16 liaoruili:「可以修改默认,也可以单独给每个人配额」):
/// `set_quota` 只有 upsert 没有删除 ⇒ ★一旦给某人单独设过配额,他就永久脱离了全站默认值,
/// 再也回不去★ —— 以后全站默认从 10 GiB 抬到 50 GiB,他还卡在当初随手设的那个数上,
/// 而界面上看不出他为什么没跟上。两套机制要并存,就必须有一条退回默认的路。
///
/// 幂等:本来就没有行也回 204(「让他跟随默认」这个**结果**已经成立)。
pub async fn reset_quota(
    State(state): State<AppState>, Extension(id): Extension<Identity>, Path(username): Path<String>,
) -> AppResult<axum::http::StatusCode> {
    let who = username.trim();
    if who.is_empty() { return Err(AppError::BadRequest("用户名不能为空".into())) }
    let actor = id.require_username()?;
    sqlx::query("DELETE FROM user_quota WHERE username = $1").bind(who).execute(&state.pool).await?;
    audit::record(&state.pool, actor, "admin.quota_reset", who, "").await;
    Ok(axum::http::StatusCode::NO_CONTENT)
}
