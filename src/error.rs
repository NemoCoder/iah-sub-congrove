//! 应用错误类型,IntoResponse 输出 JSON。403 与 401 分明:未登录 401,登录了但角色不够 403。

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error")]
    Db(#[from] sqlx::Error),

    #[error("not found")]
    NotFound,

    #[error("{0}")]
    BadRequest(String),

    /// 无 token / token 无效或过期。
    #[error("unauthorized")]
    Unauthorized,

    /// 已认证但角色不够(项目角色不足 / 非超管)。
    #[error("forbidden")]
    Forbidden,

    /// ★项目已归档,禁止写入★(2026-08-07 D17)。
    /// 与 Forbidden 分开是因为**语义完全不同**:不是「你没权限」,而是「这个项目结束了」——
    /// 同一个人换个项目就能做。前端据此显示「恢复为进行中」而不是「找管理员要权限」。
    /// 用 409 Conflict:请求本身合法,只是与资源当前状态冲突。
    #[error("{0}")]
    Archived(String),

    /// ★客户端要了一段不存在的字节★(2026-08-16):这不是服务端坏了,别混进 500。
    /// 混进去的代价今晚刚付过:为一个查不出来的 500 折腾很久,而 500 这个桶里
    /// 本来就不该装「客户端参数越界」这种东西。
    #[error("range not satisfiable")]
    RangeNotSatisfiable,

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::Archived(m) => (StatusCode::CONFLICT, m.clone()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden: 权限不足".to_string()),
            AppError::RangeNotSatisfiable =>
                (StatusCode::RANGE_NOT_SATISFIABLE, "请求的字节范围超出文件大小".to_string()),
            AppError::Db(e) => {
                tracing::error!(error = %e, "database error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
            AppError::Other(e) => {
                tracing::error!(error = %e, "unexpected error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
