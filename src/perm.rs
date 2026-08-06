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
//! (**含他本人参与过的会议**)。⚠ 因此**绝不要**引入「授权生效时间」之类的字段。
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
        "SELECT 'admin'::text FROM app_user WHERE username = $2 AND is_super
         UNION ALL
         SELECT role FROM project_members WHERE project_id = $1 AND username = $2",
    )
    .bind(project_id)
    .bind(username)
    .fetch_all(pool)
    .await?;
    Ok(merge(rows.iter().map(|r| Role::parse(r))))
}

/// 主持人判定(D0)。只有他能:指定/撤销管理员、转移主持人、改可见性、删项目。
/// 超管同样放行(收拾无主项目时不必等对方点头)。
///
/// ★与 require_role 分开★:主持人不是「比 admin 更高一档的角色」,而是项目上的一个**字段**。
/// 混进 Role 枚举会让「有几个 admin」这种查询变得别扭,也会多一次数据迁移。
pub async fn require_owner(pool: &PgPool, id: &Identity, project_id: i64) -> AppResult<()> {
    if is_super_now(pool, id).await? {
        return Ok(());
    }
    let owner: Option<String> = sqlx::query_scalar(
        "SELECT owner FROM projects WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    match owner {
        // 不是主持人但确实是成员 → 403(他看得见这个项目,回 404 只会让人以为项目没了)
        Some(o) if Some(o.as_str()) == id.username.as_deref() => Ok(()),
        Some(_) => Err(AppError::Forbidden),
        // 项目根本不存在 → 404,与 require_role 的口径一致
        None => Err(AppError::NotFound),
    }
}

/// 当前是不是超管——**以库为准**(同上,cookie 里的 is_super 只是登录时快照)。
pub async fn is_super_now(pool: &PgPool, id: &Identity) -> AppResult<bool> {
    let Some(username) = id.username.as_deref() else { return Ok(false) };
    Ok(sqlx::query_scalar::<_, bool>("SELECT is_super FROM app_user WHERE username = $1")
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
    match effective_role(pool, id, project_id).await? {
        Some(r) if r >= need => Ok(r),
        Some(_) => Err(AppError::Forbidden),
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
}
