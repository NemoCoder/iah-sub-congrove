//! 权限判定 —— 本项目的核心(DESIGN.md §5 / §7.3)。
//! 有效角色 = 直接 user 授权 ∪ 所有所属组的 group 授权取 max,超管短路 Admin。
//! **这里是唯一推导**,别在任何 handler 里重写角色比较/合并逻辑(反漂移原则)。
//! 真判权只在后端:每个 space 作用域的 handler 第一行调 require_role;
//! 前端按角色藏按钮只是体验,不是安全边界。

use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::auth::Identity;
use crate::error::{AppError, AppResult};

/// 三档空间级角色,偏序 viewer < editor < admin(derive Ord 按变体声明序)。
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

/// 算 user 对 space 的有效角色。超管短路 Admin;否则直接授权 ∪ 组授权取 max。
///
/// ★超管位查库,不信会话 cookie 里那份快照★(2026-08-04 审计):cookie 有 8 小时寿命,
/// 撤销超管后那 8 小时里他仍是超管。**没有额外往返**——超管位和授权行在同一条 SQL 里一起取
/// (UNION 一行 'super' 伪角色),所以这条修复是零成本的。
pub async fn effective_role(pool: &PgPool, id: &Identity, space_id: i64) -> AppResult<Option<Role>> {
    let username = id.require_username()?;
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT 'admin'::text FROM app_user WHERE username = $2 AND is_super
         UNION ALL
         SELECT role FROM space_grants
          WHERE space_id = $1
            AND ( (grantee_type = 'user'  AND grantee_id = $2)
               OR (grantee_type = 'group' AND grantee_id IN
                     (SELECT group_id::text FROM group_members WHERE username = $2)) )",
    )
    .bind(space_id)
    .bind(username)
    .fetch_all(pool)
    .await?;
    Ok(merge(rows.iter().map(|r| Role::parse(r))))
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

/// 守门:不够 `need` 就 403(未登录早在 require_auth 就 401 了)。
/// 返回实际角色,handler 可用于响应里回显。
pub async fn require_role(pool: &PgPool, id: &Identity, space_id: i64, need: Role) -> AppResult<Role> {
    match effective_role(pool, id, space_id).await? {
        Some(r) if r >= need => Ok(r),
        _ => Err(AppError::Forbidden),
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
