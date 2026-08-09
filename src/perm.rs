//! 权限判定 —— 本项目的核心。
//!
//! ★有效角色 = 我在这个项目成员表里的角色,超管短路 Admin。就这一条★
//! 2026-08-06 重构(D3/D12)前是 `max(直接 user 授权, 所有所属组的 group 授权)`,
//! 现在**删掉了「组」这一层**,权限只到具体的人:
//!   · 少一次 JOIN、少一处分支;
//!   · 「他为什么能看到这个」永远只有一个答案:**他在成员名单里**;
//!   · 移出成员立刻生效 —— 旧模型里他可能还从某个组继承着权限,
//!     那正是 R1「离开即失去全部」最容易失守的地方。
//!
//! ★权限是「当前状态的函数」,不是「历史事件的累积」(R1)★:
//! 此刻是成员 ⟺ 看得到本项目全部资料(含他加入之前的历史);移出即失去全部
//! (**含他本人参与过的活动**)。⚠ 因此**绝不要**引入「授权生效时间」之类的字段。
//!
//! **这里是唯一推导**,别在任何 handler 里重写角色比较/合并逻辑(反漂移原则)。
//! 真判权只在后端:每个项目作用域的 handler 第一行调 require_role;
//! 前端按角色藏按钮只是体验,不是安全边界。

use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::auth::Identity;
use crate::error::{AppError, AppResult};

/// 三档项目级角色,偏序 viewer < editor < admin(derive Ord 按变体声明序)。
/// 展示名:admin=管理员(副手) / editor=成员 / viewer=只读成员。
/// ★主持人(owner)不在这个枚举里★——它是 projects.owner 上的一个字段,与角色正交,
/// 判定走 require_owner。少一个枚举值 = 少一处要同步的 CHECK 约束与迁移。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    Editor,
    Admin,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "viewer" => Some(Role::Viewer),
            "editor" => Some(Role::Editor),
            "admin" => Some(Role::Admin),
            _ => None,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Editor => "editor",
            Role::Admin => "admin",
        }
    }
}

/// 多条授权取最强(纯函数,单测覆盖)。DB 里 CHECK 约束保证值合法,
/// 万一出现非法值按「无授权」处理而不是 panic。
/// SQL 吐出来的授权行 → 有效角色。★纯函数,所以 hermetic 的 `cargo test` 够得着★。
///
/// 判定藏在 SQL 或 async 函数里的话,`cargo test` 永远测不到它 —— 上一次修
/// 「旁听者提权」时就是把判定从 SQL 里挪出来才拿到回归测试的(v0.4.39)。
pub fn decide_role(rows: &[String]) -> Option<Role> {
    // ⚠★否决必须在 merge **之前**单独判★:`merge` 是 `.flatten().max()`,
    // 它设计上就**忽略未知值**(`Role::parse("BLOCK")` 是 None),混进去会被静静吃掉。
    if rows.iter().any(|r| r == BLOCK) {
        return None;
    }
    merge(rows.iter().map(|r| Role::parse(r)))
}

/// `require_owner` 的判定,拆成纯函数。★超管那一问是**懒**的★——
/// 只有在「不是 owner 且不是材料区」时才值得去查库,所以这里返回三态而不是 bool。
#[derive(Debug, PartialEq, Eq)]
pub enum OwnerVerdict {
    /// 直接放行(他就是 owner)
    Allow,
    /// 直接拒绝,★不必再问超管★(材料区)
    Deny,
    /// 还要看他是不是超管
    AskSuper,
}

pub fn decide_owner(kind: &str, owner: &str, me: Option<&str>) -> OwnerVerdict {
    let is_owner = Some(owner) == me;
    // ★材料区:**谁都不行**,连它自己的主人也不行★(ADR-0005 + PRD §J1,2026-08-09 收严)。
    //
    // 原来是 `kind == "materials" && !is_owner` —— 别人拦住了,主人放行。
    // 可 require_owner 管的是**改名 / 拉成员 / 转移主持人 / 归档 / 删项目**这一组,
    // 而 PRD §J1 那张表里这些对材料区**全是 ❌**:它是系统建的存档区,不是第二个工作区。
    // 「主人可以把自己的材料区转让给别人」这种事根本不该存在(转移会把配额一起带走)。
    // 顺序要紧 —— 放在超管之后等于没挂,那正是评审抓到的坑。
    if kind == "materials" {
        return OwnerVerdict::Deny;
    }
    if is_owner { OwnerVerdict::Allow } else { OwnerVerdict::AskSuper }
}

pub fn merge(grants: impl IntoIterator<Item = Option<Role>>) -> Option<Role> {
    grants.into_iter().flatten().max()
}

/// 算 user 对项目的有效角色。超管短路 Admin;否则就是成员表里那一行。
///
/// ★超管位查库,不信会话 cookie 里那份快照★(2026-08-04 审计):cookie 有 8 小时寿命,
/// 撤销超管后那 8 小时里他仍是超管。**没有额外往返**——超管位和成员行在同一条 SQL 里一起取
/// (UNION 一行伪角色),所以这条修复是零成本的。
pub async fn effective_role(pool: &PgPool, id: &Identity, project_id: i64) -> AppResult<Option<Role>> {
    let username = id.require_username()?;
    let rows: Vec<String> = sqlx::query_scalar(
        // ★材料区的隔离在这里单点否决★(ADR-0005):materials 项目**只有 owner 有角色**,
        // 别人(含超管)一律无角色。放在这一层而不是逐个入口设防的理由:
        //   ① `require_role` 的签名里没有 `op`,而要放行的「回收站还原」与要拦的「上传/删除」
        //      在 `need` 上完全一样(都是 Editor),用现有签名区分不了;
        //   ② ★7 个项目写入口根本不经 `require_role`★(走 require_owner),其中 transfer
        //      会把材料区连同配额转给别人。
        // 单点否决则**新增入口自动被覆盖** —— 这是它相对白名单的全部价值。
        "SELECT 'BLOCK'::text FROM projects
          WHERE id = $1 AND kind = 'materials' AND owner <> $2 AND deleted_at IS NULL
         UNION ALL
         -- ★超管**特权**只认 super_now 视图,不认 is_super 那一列★(超管模式,
         --   docs/TECH-DESIGN-admin-mode.md):关着模式时他就是个普通用户。
         SELECT 'admin'::text FROM super_now WHERE username = $2
         UNION ALL
         SELECT role FROM project_members WHERE project_id = $1 AND username = $2",
    )
    .bind(project_id)
    .bind(username)
    .fetch_all(pool)
    .await?;
    // ⚠★否决必须在 merge **之前**单独判★(评审抓到的坑):`merge` 是
    // `.flatten().max()` —— 它设计上就**忽略未知值**,`Role::parse("BLOCK")` 返回 None,
    // 于是「BLOCK」会被静静吃掉,这道闸等于没挂。
    Ok(decide_role(&rows))
}

/// 主持人判定(D0)。只有他能:指定/撤销管理员、转移主持人、改可见性、删项目。
/// 超管同样放行(收拾无主项目时不必等对方点头)。
///
/// ★与 require_role 分开★:主持人不是「比 admin 更高一档的角色」,而是项目上的一个**字段**。
/// 混进 Role 枚举会让「有几个 admin」这种查询变得别扭,也会多一次数据迁移。
pub async fn require_owner(pool: &PgPool, id: &Identity, project_id: i64) -> AppResult<()> {
    // ⚠★超管短路必须在**查完 kind 之后**★(评审抓到的坑,与上面 merge 那条是同一类):
    // 原来是先 `is_super_now` 直接 return,再去查 owner —— 那样材料区的判据挂在后面等于没挂,
    // 超管照样能改别人的材料区、甚至把它连同配额 transfer 走。
    // 所以:**无条件先 SELECT kind, owner**,materials 的判据排在超管之前。
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT kind, owner FROM projects WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    // 项目根本不存在 → 404,与 require_role 的口径一致
    let Some((kind, owner)) = row else { return Err(AppError::NotFound) };
    match decide_owner(&kind, &owner, id.username.as_deref()) {
        OwnerVerdict::Allow => Ok(()),
        // 材料区:不必再问超管
        OwnerVerdict::Deny => Err(AppError::Forbidden),
        OwnerVerdict::AskSuper => {
            if is_super_now(pool, id).await? { Ok(()) }
            // 不是主持人但确实看得见这个项目 → 403(回 404 只会让人以为项目没了)
            else { Err(AppError::Forbidden) }
        }
    }
}

/// 当前是不是超管——**以库为准**(同上,cookie 里的 is_super 只是登录时快照)。
pub async fn is_super_now(pool: &PgPool, id: &Identity) -> AppResult<bool> {
    let Some(username) = id.username.as_deref() else { return Ok(false) };
    // ★这里查的是「此刻有没有超管**特权**」,不是「有没有资格」★ —— 见 super_now 视图的头注。
    // 名字里的 `now` 原本只指「以库为准不信 cookie 快照」,现在它还多了一层意思:
    // **超管模式关着的时候,这个函数对超管本人也返回 false**。
    Ok(sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM super_now WHERE username = $1)")
        .bind(username)
        .fetch_optional(pool)
        .await?
        .unwrap_or(false))
}

/// 守门:不够 `need` 就挡(未登录早在 require_auth 就 401 了)。返回实际角色,handler 可回显。
///
/// ★两档区别对待(2026-08-05,分享链接用数字 id 引出的存在性泄露)★:
/// - **完全没授权 → 404**,不是 403。id 是自增数字,按 id 爬一遍时,
///   403(存在但你不能看)和 404(不存在)可区分 = 一个**存在性预言机**:
///   内容拿不到,但「这个所里有多少东西、id 分布到哪」就漏出去了。统一回 404,爬到的全是一个样。
/// - **有授权但档位不够 → 403**(如 viewer 想删):这种情况下他本来就在列表里看得见这个东西,
///   回 404 只会让人以为「文件没了」,反而误导。
pub async fn require_role(pool: &PgPool, id: &Identity, project_id: i64, need: Role) -> AppResult<Role> {
    let role = match effective_role(pool, id, project_id).await? {
        Some(r) if r >= need => r,
        Some(_) => return Err(AppError::Forbidden),
        None => return Err(AppError::NotFound),
    };
    // ★归档项目只读:写闸收口在这一处★(D17,2026-08-07)
    //
    // 判据是 `need >= Editor` —— 本系统里**所有写操作都要求 ≥editor**,读只要 viewer,
    // 所以这一个判断就覆盖了全部写入路径:上传、建文档、建活动、改名、删除、建分享…
    //
    // ★为什么不在每个写 handler 里各加一句★:软删除那次就是这么漏的 ——
    // `deleted_at IS NULL` 当初只在两处补了,结果 download/content/play/整个公开分享面
    // 全漏,「删进回收站的材料墙外照样下得到」(v0.3.55 一次补齐 11 处)。
    // 同一个教训不该踩第二次:**能收口的闸就别散开**。
    //
    // ⚠ 不受这道闸约束的三条,都是刻意的:
    //   · `require_owner`(取消归档、删项目、转移主持人)—— 否则归档后就再也解不开了;
    //   · `require_super`(超管面:配额等)—— 平台资源治理不该被项目状态挡住;
    //   · 一切只读路径(need = Viewer)—— 归档就是为了以后还能查。
    if need >= Role::Editor {
        let row: Option<(bool, String)> = sqlx::query_as(
            "SELECT archived_at IS NOT NULL, kind FROM projects WHERE id = $1 AND deleted_at IS NULL",
        )
        .bind(project_id)
        .fetch_optional(pool)
        .await?;
        if let Some((archived, kind)) = row {
            if archived {
                return Err(AppError::Archived(
                    "这个项目已归档,是只读的。要继续往里加东西,先让主持人把它恢复为进行中。".into(),
                ));
            }
            // ★材料区对所有写路径一律只读★(PRD §J1,2026-08-09 liaoruili:「只读的」)。
            //
            // ★挂在这一句上,而不是逐个 handler 加判断★ —— 与上面归档那道闸同一个理由,
            // 也正是 ADR-0005 说的「判据必须是白名单不是清单」:以项目为作用域的入口有
            // 12 个 /projects/{id}* + 16 个 /items/{id}*,逐条打勾一定会漏一条,
            // 而收口在这里,**以后新增的任何写接口都自动被挡住**。
            //
            // 唯一的两个例外(活动材料的上传与删除)不走这里,走 `require_material_write`
            // —— 例外是**显式的两处**,而不是「默认放行、逐个去堵」。
            if kind == "materials" {
                return Err(AppError::Forbidden);
            }
        }
    }
    Ok(role)
}

/// 活动材料的写入(上传 / 删除)—— ★材料区里唯一放行的写路径★。
///
/// 普通项目照常要 ≥editor;而「我的活动材料」在 `require_role` 那道闸上是**全只读**的,
/// 所以那两条正当路径必须从这里过:判据是「这是我自己的材料区」,不是角色档位。
///
/// ⚠★为什么不给材料区一个更高的角色了事★:那样 12+16 个项目作用域入口就又全开了。
/// 宁可在这里写死两个调用点 —— 例外看得见、数得清,而漏掉的清单项看不见。
pub async fn require_material_write(pool: &PgPool, id: &Identity, project_id: i64) -> AppResult<()> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT kind, owner FROM projects WHERE id = $1 AND deleted_at IS NULL")
        .bind(project_id).fetch_optional(pool).await?;
    let Some((kind, owner)) = row else { return Err(AppError::NotFound) };
    if kind != "materials" {
        require_role(pool, id, project_id, Role::Editor).await?;
        return Ok(());
    }
    // 材料区:只认主人。别人连「这个项目存在」都不该知道(与 effective_role 的 BLOCK 同口径 → 404)
    if id.username.as_deref() == Some(owner.as_str()) { Ok(()) } else { Err(AppError::NotFound) }
}

/// 我能以什么身份看这场活动。★这是活动模块的唯一推导★,别在 handler 里各自拼 SQL。
///
/// ⚠ **它只管「活动元信息」,不管材料**。材料权限一律走 [`require_role`](项目成员身份,D3),
/// 与「是不是参会人」完全无关 —— 这正是 D8(临时参会人能参会、看不到材料)与
/// D9(公开活动旁听者能看议程、材料一律 404)成立的原因。把两者混在一起,
/// 「参会即获得资料权限」就会把权限模型退回历史累积,而 R1 要的是**当前状态的函数**。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityView {
    /// 参会人 / 关联项目的成员 / 超管:元信息 + 参与者名单 + 讨论区。
    Inside,
    /// 旁听者:仅因为这场会 `visibility='public'` 而看得见。
    /// ★只给标题/议程/时间/地点/线上链接★——名单与讨论区都不给(D9)。
    Observer,
}

/// 我与这场活动的一条关系。SQL 只负责**把关系查出来**,判档位交给 [`decide_view`]。
///
/// ★2026-08-08 为什么要拆成两步★(修一个真实的越权缺陷):
/// 原来 SQL 直接吐 `'inside'`/`'observer'`,第一条分支写的是
/// `SELECT 'inside' FROM activity_participants WHERE activity_id=$1 AND username=$2`
/// —— **不区分 kind**。而 `observe`(自助旁听)插的正是一行 `kind='observer'`。
/// 于是「点一下旁听」就把自己从 Observer 提权成 Inside,拿到了参与者名单与讨论区,
/// 而 D9 与上面 `ActivityView::Observer` 的文档注释都写着「名单与讨论区都不给」。
///
/// 光在 WHERE 里补一句 `AND kind <> 'observer'` 能修好这一次,但**修不好下一次**:
/// 那样一来「旁听算不算 Inside」这个安全判断仍然藏在一句 SQL 里,
/// 而 CI 的 `cargo test` 是 hermetic 的(不连 PG),够不着它 ——
/// 这正是它错了整整一个版本没人发现的原因。
/// ★所以把判档位挪成纯函数★:关系由 SQL 查,结论由 Rust 定,结论就能被单测钉死。
/// `effective_role` 的否决标记。★不是角色★——混进 `Role::parse` 会被静静吃掉,所以单独判。
const BLOCK: &str = "BLOCK";
const LINK_MEMBER: &str = "member";
const LINK_SUPER: &str = "super";
const LINK_PUBLIC: &str = "public";
const LINK_PART_PREFIX: &str = "participant:";

/// 由「我与这场会的全部关系」判出可见档位。看不到 → None(调用方转 404)。
///
/// ★fail-closed★:参会人只认 `kind='attendee'` 给 Inside。
/// 将来若给 `activity_participants.kind` 加了新取值而忘了改这里,
/// 新 kind 会**落到谁都不匹配 → None → 404**,而不是默认放行。
/// 宁可新功能上线时报「看不到」,也不要悄悄多给一档权限。
fn decide_view(links: &[String]) -> Option<ActivityView> {
    /// 参会人关系里的 kind;不是参会人关系则 None。
    fn kind(l: &str) -> Option<&str> { l.strip_prefix(LINK_PART_PREFIX) }
    let inside = links
        .iter()
        .any(|l| l == LINK_MEMBER || l == LINK_SUPER || kind(l) == Some("attendee"));
    if inside { return Some(ActivityView::Inside) }
    // ★旁听者与「这场会是 public」是同一档★:两者都只看得到元信息。
    //   旁听行的存在只表示「他点过旁听」(用于取消旁听、以及公开广场里把他排除),
    //   **不提升任何权限**。
    let observer = links.iter().any(|l| l == LINK_PUBLIC || kind(l) == Some("observer"));
    if observer { return Some(ActivityView::Observer) }
    None
}

/// 判我对这场活动的可见档位。看不到 → 404(与 require_role 同口径:不泄露存在性)。
///
/// 四条来源一次查完(与 effective_role 同样的 UNION 手法,零额外往返):
/// 参会人(带 kind)/ 关联项目成员 / 超管 / 活动本身是 public。
pub async fn activity_view(pool: &PgPool, id: &Identity, activity_id: i64) -> AppResult<ActivityView> {
    let username = id.require_username()?;
    let links: Vec<String> = sqlx::query_scalar(
        // ★把 kind 原样带出来★,别在 SQL 里就把它压成 inside/observer(见 decide_view 头注)
        "SELECT 'participant:' || kind FROM activity_participants
           WHERE activity_id = $1 AND username = $2
         UNION ALL
         -- ⚠★JOIN projects 判 deleted_at★(2026-08-07):项目软删除**不动成员表**,
         --   所以少了这一句,项目删进回收站之后成员照样能看到它的活动。
         --   这是 CLAUDE.md 那条硬纪律(「凡是读内容的路径 SQL 都要带 deleted_at IS NULL」)
         --   在活动模块的又一处遗漏 —— 上一次是 v0.3.55 一口气补了 11 处。
         SELECT 'member' FROM activity_projects mp
           JOIN project_members pm ON pm.project_id = mp.project_id
           JOIN projects p ON p.id = mp.project_id AND p.deleted_at IS NULL
           WHERE mp.activity_id = $1 AND pm.username = $2
         UNION ALL
         -- 同上:关着超管模式时,别人的活动他一样看不见
         SELECT 'super' FROM super_now WHERE username = $2
         UNION ALL
         SELECT 'public' FROM activities WHERE id = $1 AND visibility = 'public'",
    )
    .bind(activity_id)
    .bind(username)
    .fetch_all(pool)
    .await?;
    decide_view(&links).ok_or(AppError::NotFound)
}

/// 谁能改这场会:发起人、记录员(要整理纪要)、超管。
/// ★不是「关联项目的 admin」★——一场会可关联多个项目,让任一项目的管理员都能改别人的会太宽。
pub async fn require_activity_host(pool: &PgPool, id: &Identity, activity_id: i64) -> AppResult<()> {
    if is_super_now(pool, id).await? { return Ok(()) }
    let username = id.require_username()?;
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT organizer, recorder FROM activities WHERE id = $1",
    )
    .bind(activity_id)
    .fetch_optional(pool)
    .await?;
    match row {
        Some((org, rec)) if org == username || rec == username => Ok(()),
        // 看得见但不是主人 → 403;完全看不见 → 404(同 require_role 的两档口径)
        Some(_) => match activity_view(pool, id, activity_id).await {
            Ok(_) => Err(AppError::Forbidden),
            Err(e) => Err(e),
        },
        None => Err(AppError::NotFound),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_order_is_viewer_lt_editor_lt_admin() {
        assert!(Role::Viewer < Role::Editor);
        assert!(Role::Editor < Role::Admin);
        assert!(Role::Admin >= Role::Admin);
    }

    #[test]
    fn parse_roundtrip_and_reject_garbage() {
        for r in [Role::Viewer, Role::Editor, Role::Admin] {
            assert_eq!(Role::parse(r.as_str()), Some(r));
        }
        assert_eq!(Role::parse("owner"), None);
        assert_eq!(Role::parse(""), None);
    }

    #[test]
    fn merge_takes_max_and_ignores_none() {
        assert_eq!(merge([Some(Role::Viewer), Some(Role::Editor)]), Some(Role::Editor));
        assert_eq!(merge([None, Some(Role::Admin), Some(Role::Viewer)]), Some(Role::Admin));
        assert_eq!(merge([None, None]), None);
        let empty: [Option<Role>; 0] = [];
        assert_eq!(merge(empty), None);
    }

    // ── decide_view:活动可见档位 ──────────────────────────────────────
    //
    // ★这一组是 2026-08-08 那个越权缺陷的复现测试★(先写它,再改的代码)。
    // 缺陷:`observe`(自助旁听)往 activity_participants 插一行 kind='observer',
    // 而档位判定的第一条 SQL 分支不看 kind → 旁听者被判成 Inside →
    // 拿到参与者名单与讨论区,而 D9 明写这两样都不给。
    //
    // 缺陷发现于 v0.4.38,存在了整整一个版本 —— 因为判定藏在 SQL 里,
    // 而 CI 的 cargo test 是 hermetic 的够不着。现在判定是纯函数,这组测试每次 CI 都跑。
    fn l(s: &str) -> String { s.to_string() }

    #[test]
    fn 旁听者只给_observer_不给_inside() {
        // ★这就是缺陷本身★:改之前这里拿到的是 Inside
        assert_eq!(decide_view(&[l("participant:observer")]), Some(ActivityView::Observer));
        // 自助旁听的真实形态:公开活动 + 自己那行 observer,两条同时在
        assert_eq!(
            decide_view(&[l("participant:observer"), l("public")]),
            Some(ActivityView::Observer),
        );
    }

    #[test]
    fn 正式参会人_项目成员_超管都是_inside() {
        assert_eq!(decide_view(&[l("participant:attendee")]), Some(ActivityView::Inside));
        assert_eq!(decide_view(&[l("member")]), Some(ActivityView::Inside));
        assert_eq!(decide_view(&[l("super")]), Some(ActivityView::Inside));
    }

    #[test]
    fn 旁听者若同时是项目成员_仍然是_inside() {
        // 档位取**最高**的那条来源:他本来就能看名单,点没点旁听都一样。
        // (反过来说明上一条测的不是「有 observer 行就降级」,而是「observer 行本身不提权」)
        assert_eq!(
            decide_view(&[l("participant:observer"), l("member")]),
            Some(ActivityView::Inside),
        );
    }

    #[test]
    fn 公开活动对无关的人只给_observer() {
        assert_eq!(decide_view(&[l("public")]), Some(ActivityView::Observer));
    }

    #[test]
    fn 没有任何关系就是看不见() {
        assert_eq!(decide_view(&[]), None);
    }

    #[test]
    fn 未知的_kind_一律不给_inside() {
        // ★fail-closed★:将来给 kind 加了新取值却忘了改 decide_view,
        // 应当落到「看不见」而不是默认放行。'guest' 是 0005 迁移删掉的历史取值,
        // 拿它当「一个这里没认的 kind」来测最贴切。
        assert_eq!(decide_view(&[l("participant:guest")]), None);
        assert_eq!(decide_view(&[l("participant:未来某个新档位")]), None);
        // 但公开活动那条独立来源仍然照常给 Observer
        assert_eq!(decide_view(&[l("participant:guest"), l("public")]), Some(ActivityView::Observer));
    }

    // ══════ ADR-0005:材料区隔离 ══════
    //
    // ★这两组各对应一处**评审抓到的**坑★。实测(不是声称)的反向验证结果:
    //   · 去掉 `decide_role` 里的 BLOCK 分支      → `材料区对别人零角色…` 红 ✅
    //   · materials 从 `Deny` 改成 `AskSuper`     → `材料区的判据排在超管之前` 红 ✅
    //
    // ⚠★有一条我一开始写错了,记下来★:我原本声称「把 materials 判据挪到 `is_owner` 之后
    //   → 测试变红」。**实测不红,因为那两种写法是等价的**(`is_owner` 为真时 materials
    //   分支本来就不触发)。真正的顺序 bug 在 `require_owner` 里「超管短路排在查 kind 之前」,
    //   而把判定抽成 `decide_owner` 之后,★那个 bug 结构上不可能再发生★ ——
    //   纯函数根本不知道「超管」这回事,它只会返回 `AskSuper` 交给调用方去问。
    //   **把缺陷变成不可表达,比给它加一条测试更强。**

    #[test]
    fn 材料区对别人零角色_哪怕他是超管() {
        // SQL 会同时吐出 BLOCK 与 admin(超管那一行) —— ★BLOCK 必须赢★
        assert_eq!(decide_role(&["BLOCK".into(), "admin".into()]), None);
        // 也可能同时是成员表里的 editor:一样零角色
        assert_eq!(decide_role(&["BLOCK".into(), "editor".into()]), None);
    }

    #[test]
    fn 没有否决标记时照常取最高角色() {
        assert_eq!(decide_role(&["viewer".into(), "admin".into()]), Some(Role::Admin));
        assert_eq!(decide_role(&[]), None);
        // ⚠ 未知值仍然按老规矩忽略(BLOCK 之外的脏数据不应把人锁死)
        assert_eq!(decide_role(&["viewer".into(), "陌生角色".into()]), Some(Role::Viewer));
    }

    #[test]
    fn 材料区的判据排在超管之前() {
        // 别人的材料区 → ★Deny,而且**不必再问超管**★
        assert_eq!(decide_owner("materials", "alice", Some("bob")), OwnerVerdict::Deny);
        // ★自己的材料区也 Deny★(2026-08-09 收严):require_owner 管的是改名/拉成员/
        // 转移主持人/归档/删项目,PRD §J1 里这些对材料区全是 ❌ —— 它是系统建的存档区。
        assert_eq!(decide_owner("materials", "alice", Some("alice")), OwnerVerdict::Deny);
    }

    #[test]
    fn 普通项目仍然给超管留口子() {
        assert_eq!(decide_owner("team", "alice", Some("bob")), OwnerVerdict::AskSuper);
        assert_eq!(decide_owner("team", "alice", Some("alice")), OwnerVerdict::Allow);
        // 未登录(没有用户名)不是 owner
        assert_eq!(decide_owner("team", "alice", None), OwnerVerdict::AskSuper);
        assert_eq!(decide_owner("materials", "alice", None), OwnerVerdict::Deny);
    }
}
