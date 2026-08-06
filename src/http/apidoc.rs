//! 开发者页面的数据源:全部 API 的清单。
//!
//! ★为什么不手写一份 Markdown★:手写文档必然漂移——加了接口忘了写、改了权限忘了改,
//! 三个月后没人敢信它。这里的做法是:
//!   ① 清单是**代码里的常量**,`GET /api/_dev/apis` 直接吐它;
//!   ② ★底下那个测试把 `mod.rs` 的源码读进来,逐条比对「注册了的」与「写了文档的」★——
//!      **少写一条、多写一条、路径写错一个字,`cargo test` 就红**。
//! 这样文档漂移在 CI 阶段就被挡住,而不是等人去发现。
//!
//! ⚠ 加新路由时:`mod.rs` 注册 + 这里补一行,两处缺一个测试就不过。这是刻意的摩擦。

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::auth::Identity;
use crate::error::AppResult;
use crate::state::AppState;

#[derive(Serialize, Clone, Copy)]
pub struct Api {
    /// HTTP 方法。多方法同路径的写成多条(前端按方法分色)。
    pub method: &'static str,
    /// 路径。`{}` 占位与 axum 的写法一致,前端据此生成输入框。
    pub path: &'static str,
    /// 分组,前端左侧导航按它折叠。
    pub group: &'static str,
    /// 需要什么身份。★这一列是评审规范性时最该盯的★。
    pub auth: &'static str,
    /// 一句话说明它干什么。
    pub summary: &'static str,
    /// 入参说明(query / body 字段)。空串表示不需要。
    pub params: &'static str,
}

macro_rules! api {
    ($m:expr, $p:expr, $g:expr, $a:expr, $s:expr, $q:expr) => {
        Api { method: $m, path: $p, group: $g, auth: $a, summary: $s, params: $q }
    };
}

/// 全部 API。★改路由必须同步改这里,否则测试红★
pub const APIS: &[Api] = &[
    // ── 探针 / 认证 ──
    api!("GET", "/healthz", "探针", "开放", "存活探针:进程活着就返回 ok", ""),
    api!("GET", "/readyz", "探针", "开放", "就绪探针:PG SELECT 1 + S3 head_bucket 都通才 ready", ""),
    api!("GET", "/auth/login", "认证", "开放", "跳 Keycloak 登录", ""),
    api!("GET", "/auth/callback", "认证", "开放", "OIDC 回调,换码建会话", "code, state"),
    api!("GET", "/auth/logout", "认证", "开放", "退出并清会话 cookie", ""),
    api!("GET", "/api/me", "认证", "登录", "当前身份与超管位", ""),
    api!("GET", "/api/users", "认证", "登录", "平台用户候选(加成员时选人用)", "q 关键词"),

    // ── 项目 ──
    api!("GET", "/api/projects", "项目", "登录", "我参与的项目列表(含我的角色与已用容量)", ""),
    api!("POST", "/api/projects", "项目", "登录", "建项目;★建者自动成为主持人 + admin 成员★", "name, description, visibility"),
    api!("GET", "/api/projects/{id}", "项目", "≥viewer", "项目详情", ""),
    api!("PUT", "/api/projects/{id}", "项目", "admin;改 visibility 需 owner",
         "改名/描述/禁下载/术语表/可见性/禁分享。★开启禁分享会连带撤销已有公开链接★",
         "name, description, no_download, hotwords, visibility, no_share"),
    api!("DELETE", "/api/projects/{id}", "项目", "admin", "删项目", ""),
    api!("GET", "/api/projects/{id}/members", "项目", "≥viewer", "成员列表(只有人,没有组)", ""),
    api!("PUT", "/api/projects/{id}/members", "项目", "admin;给 admin 需 owner",
         "★批量★添加成员或改角色", "usernames[], role(viewer/editor/admin)"),
    api!("DELETE", "/api/projects/{id}/members", "项目", "admin",
         "移出成员。★连带撤销他创建的、指向本项目的公开链接★", "username"),
    api!("POST", "/api/projects/{id}/transfer", "项目", "owner", "转移主持人(只能转给本项目成员)", "to"),
    api!("GET", "/api/projects/{id}/diagnose", "项目", "admin",
         "权限诊断:他为什么能/不能看(超管? 成员表里什么角色?)", "username"),

    // ── 会议与日程(M1)──
    // ★这一组只管**会议元信息**,不管材料★:材料权限一律走上面项目那组(D3/D8/D9)。
    api!("GET", "/api/meetings", "会议", "登录",
         "我的会议(参会人 / 所在项目的会)。★public 会议不进这里★——列表是我的日程不是全平台公告板",
         "from, to, project_id"),
    api!("POST", "/api/meetings", "会议", "每个关联项目都要 ≥editor",
         "建会议。★必须关联至少一个项目★(材料权限来自项目成员身份)+ ★记录员必填★(D14)",
         "title, agenda, recorder, starts_at, ends_at, project_ids[], participants[], visibility"),
    api!("GET", "/api/meetings/{id}", "会议", "参会人/关联项目成员;public 会议任何人可旁听",
         "会议详情。★旁听者拿到的是裁剪版★:无参会名单、无材料入口(D9)", ""),
    api!("PUT", "/api/meetings/{id}", "会议", "发起人 / 记录员",
         "改会议。★改了时间就把所有人的答复清回 pending★(旧答复是对旧时间说的);改线上链接留痕",
         "title, agenda, recorder, starts_at, ends_at, location, online_url, visibility"),
    api!("DELETE", "/api/meetings/{id}", "会议", "发起人 / 记录员",
         "★取消不是删除★:置 canceled 留档(谁邀了谁、谁拒了是协作事实)", ""),
    api!("PUT", "/api/meetings/{id}/participants", "会议", "发起人 / 记录员",
         "★批量★邀请;kind=attendee/guest(临时参会人,看不到材料)/observer", "usernames[], kind"),
    api!("DELETE", "/api/meetings/{id}/participants", "会议", "发起人 / 记录员",
         "移出参会人。★发起人不能被移出★(移出就没人改得了这场会)", "username"),
    api!("POST", "/api/meetings/{id}/respond", "会议", "名单内的人(旁听者不能答复)",
         "答复邀请。★counter(建议改期)必须带具体的替代时间★——它是私事冲突唯一的结构化出口(D2)",
         "status, counter_starts_at, counter_ends_at, counter_reason"),
    api!("GET", "/api/meetings/{id}/messages", "会议", "参会人/关联项目成员(★旁听者不给★)",
         "会议讨论区(D13):public 频道参会人可见,private 仅双方", "channel, peer"),
    api!("POST", "/api/meetings/{id}/messages", "会议", "参会人/关联项目成员",
         "发言。★私聊只能发给发起人或记录员★(D13:不做任意点对点,否则长成 IM)", "body, channel, peer"),
    api!("GET", "/api/freebusy", "会议", "登录",
         "忙闲(D1)。★只回时间段不回内容★;★按项目可见性分流★——只关联私密项目的会完全隐形(别人看到「空闲」)",
         "users(逗号分隔), from, to"),

    // ── 内容 ──
    api!("GET", "/api/projects/{id}/items", "内容", "≥viewer", "内容树(扁平表,前端按 parent_id 组树)", ""),
    api!("POST", "/api/projects/{id}/items", "内容", "≥editor", "建文件夹或空文档", "name, kind, parent_id"),
    api!("POST", "/api/projects/{id}/precheck", "内容", "≥editor",
         "秒传预检。★命中且我本来就读得到同 sha 的内容才免传★(防「凭哈希认领他人文件」)",
         "sha256, size, name, mime, parent_id"),
    api!("GET", "/api/projects/{id}/trash", "内容", "≥editor", "回收站(只列删除动作的根)", ""),
    api!("GET", "/api/items/{id}", "内容", "≥viewer", "条目详情", ""),
    api!("PUT", "/api/items/{id}", "内容", "≥editor", "改名 / 移动", "name, parent_id"),
    api!("DELETE", "/api/items/{id}", "内容", "≥editor", "★软删除★:整棵子树打标记进回收站,S3 不动", ""),
    api!("POST", "/api/items/{id}/undelete", "内容", "≥editor",
         "从回收站还原。★只还原与它同一批被删的行★,并连带还原上级目录", ""),
    api!("DELETE", "/api/items/{id}/purge", "内容", "admin",
         "彻底删除(★只能对回收站里的东西★),对象按引用计数清", ""),
    api!("GET", "/api/items/{id}/content", "内容", "≥viewer", "文档正文(markdown)", ""),
    api!("PUT", "/api/items/{id}/content", "内容", "≥editor", "保存文档;同 sha 重复保存是 no-op", "text, label"),
    api!("GET", "/api/items/{id}/versions", "内容", "≥viewer", "版本历史", ""),
    api!("POST", "/api/items/{id}/restore/{version_id}", "内容", "≥editor", "恢复到某个历史版本(恢复前自动快照)", ""),
    api!("GET", "/api/items/{id}/progress", "内容", "≥viewer", "我上次看到哪", ""),
    api!("PUT", "/api/items/{id}/progress", "内容", "≥viewer", "记录播放进度", "position_sec, duration_sec"),
    api!("POST", "/api/projects/{id}/upload", "内容", "≥editor", "流式上传(单文件不限大小,闸是项目配额)", "multipart file"),
    api!("GET", "/api/items/{id}/download", "内容", "≥viewer", "下载原件;viewer 受项目禁下载开关约束", "inline"),

    // ── 大文件直传 ──
    api!("POST", "/api/projects/{id}/media/begin", "直传", "≥editor",
         "预签名直传开始;带指纹可认领 24h 内没传完的同一文件(断点续传)",
         "name, size, mime, parent_id, sha256, fp"),
    api!("PUT", "/api/items/{id}/media/part", "直传", "≥editor", "代理分片(预签名不可用时的回退)", "分片字节"),
    api!("POST", "/api/items/{id}/media/complete", "直传", "≥editor",
         "完成直传:ListParts 组装 + 申报大小对账 + 配额复核 + 后台核验 sha", "parts"),
    api!("POST", "/api/items/{id}/media/abort", "直传", "≥editor", "主动取消(★只有主动取消才 abort,失败不动断点★)", ""),
    api!("GET", "/api/items/{id}/play", "直传", "≥viewer", "播放地址:302 到预签名 GET。★只对 video 放行★", ""),

    // ── 转写与纪要 ──
    api!("POST", "/api/items/{id}/analyze", "转写", "≥editor", "排一个转写+纪要任务(幂等)", ""),
    api!("GET", "/api/items/{id}/analysis", "转写", "≥viewer", "转写结果与 AI 参考稿", ""),
    api!("GET", "/api/items/{id}/subtitles.vtt", "转写", "≥viewer", "WebVTT 字幕", ""),

    // ── 公开分享(管理面)──
    api!("GET", "/api/items/{id}/shares", "分享", "≥editor", "本项的分享链接列表", ""),
    api!("POST", "/api/items/{id}/shares", "分享", "≥editor",
         "建公开链接。★这是全系统唯一绕过项目成员身份的入口★",
         "code, expires_days, max_visits, allow_download, items[]"),
    api!("GET", "/api/shares/mine", "分享", "登录", "我发出去的全部分享(跨项目)", ""),
    api!("DELETE", "/api/shares/{token}", "分享", "创建者本人无条件 / 他人需 admin", "撤销分享链接", ""),

    // ── 公开分享(访客面,不需登录)──
    api!("GET", "/pub/share/{token}", "分享·访客", "开放",
         "只回「要不要提取码」。★不存在/过期/超次数/撤销一律 404 不区分★", ""),
    api!("POST", "/pub/share/{token}/open", "分享·访客", "开放",
         "校验提取码 → 计一次访问 → 发 2h 短命票。★失败 20 次/15 分钟即限速★", "code"),
    api!("GET", "/pub/share/{token}/list", "分享·访客", "票", "列子目录(逐项验是被分享项的后代)", "k 票, parent"),
    api!("GET", "/pub/share/{token}/file/{item_id}", "分享·访客", "票", "取内容(流式转发,不暴露对象存储)", "k 票, inline"),

    // ── 超管 ──
    api!("GET", "/api/admin/users", "超管", "超管", "全部用户", ""),
    api!("PUT", "/api/admin/users/{username}/super", "超管", "超管", "设/撤超管位", "is_super"),
    api!("PUT", "/api/admin/projects/{id}/quota", "超管", "超管", "调项目配额", "quota_bytes"),
    api!("GET", "/api/admin/audit", "超管", "超管", "全局审计日志", "limit, actor, action"),

    // ── 开发者 ──
    api!("GET", "/api/_dev/apis", "开发者", "超管", "本清单(开发者页面的数据源)", ""),
];

/// GET /api/_dev/apis —— 给开发者页面用。超管可见:清单本身暴露了系统结构。
pub async fn list(
    State(state): State<AppState>,
    axum::Extension(id): axum::Extension<Identity>,
) -> AppResult<Json<serde_json::Value>> {
    if !crate::perm::is_super_now(&state.pool, &id).await? {
        return Err(crate::error::AppError::Forbidden);
    }
    Ok(Json(serde_json::json!({ "count": APIS.len(), "apis": APIS })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// 从 mod.rs 源码里抠出所有实际注册的路径。
    /// 读源码而不是内省 Router:axum 没有公开的路由内省 API,而源码是编译期就能拿到的确定事实。
    fn registered() -> BTreeSet<String> {
        let src = include_str!("mod.rs");
        let mut out = BTreeSet::new();
        // ⚠ 不能按行扫:rustfmt 会把长路由拆成
        //     .route(
        //         "/items/{id}/media/part",
        //   —— `.route(` 与路径在两行上。所以在**整份源码**里找 `.route(`,再往后取第一个字符串。
        for (i, _) in src.match_indices(".route(") {
            let rest = &src[i + 7..];
            let Some(a) = rest.find('"') else { continue };
            let after = &rest[a + 1..];
            let Some(b) = after.find('"') else { continue };
            let p = &after[..b];
            // /healthz /readyz /auth/* 在根;其余按 nest 分:/pub/* 是分享访客面,剩下的都在 /api 下
            let full = if p.starts_with("/healthz") || p.starts_with("/readyz") || p.starts_with("/auth/") {
                p.to_string()
            } else if p.starts_with("/share/") {
                format!("/pub{p}")
            } else {
                format!("/api{p}")
            };
            out.insert(full);
        }
        out
    }

    /// ★文档漂移在这里被挡住★:注册了却没写文档、或写了文档却没注册,都会红。
    #[test]
    fn 每个路由都有文档且没有多余文档() {
        let actual = registered();
        let documented: BTreeSet<String> = APIS.iter().map(|a| a.path.to_string()).collect();

        let missing: Vec<_> = actual.difference(&documented).collect();
        let extra: Vec<_> = documented.difference(&actual).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "\n★API 文档与路由表不一致★\n  注册了但没写文档: {missing:?}\n  写了文档但没注册: {extra:?}\n\
             (加路由时 mod.rs 与 apidoc.rs 要同时改)"
        );
    }

    #[test]
    fn 文档字段不能留空() {
        for a in APIS {
            assert!(!a.summary.trim().is_empty(), "{} {} 缺 summary", a.method, a.path);
            assert!(!a.auth.trim().is_empty(), "{} {} 缺 auth", a.method, a.path);
            assert!(!a.group.trim().is_empty(), "{} {} 缺 group", a.method, a.path);
        }
    }

    #[test]
    fn 路径必须以斜杠开头且无尾斜杠() {
        for a in APIS {
            assert!(a.path.starts_with('/'), "{} 路径要以 / 开头", a.path);
            assert!(a.path.len() == 1 || !a.path.ends_with('/'), "{} 不要以 / 结尾", a.path);
        }
    }
}
