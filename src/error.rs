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

    /// 已认证但角色不够(空间角色不足 / 非超管)。
    #[error("forbidden")]
    Forbidden,

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden: 权限不足".to_string()),
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
