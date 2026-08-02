//! 审计写入 helper。纪律:权限变更 / 删除类操作**必录**(建空间/组这类创建动作也录,便宜)。
//! 写失败只 warn 不阻断业务——审计是事后追责,不是事前闸门。

use sqlx::PgPool;

pub async fn record(pool: &PgPool, actor: &str, action: &str, target: &str, detail: &str) {
    if let Err(e) = sqlx::query("INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)")
        .bind(actor)
        .bind(action)
        .bind(target)
        .bind(detail)
        .execute(pool)
        .await
    {
        tracing::warn!(error = %e, actor, action, target, "audit write failed");
    }
}
