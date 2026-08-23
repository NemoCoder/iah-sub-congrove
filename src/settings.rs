//! 系统级设置(超管在后台改的东西)的**唯一推导**。
//!
//! ══ 这个模块只解决一件事:让「现在这个值是多少」只有一个答案 ══
//! 三项治理配置此前分别住在 env(`CONGROVE_PROJECT_CREATORS`)和编译期常量
//! (`DEFAULT_QUOTA_BYTES` / `DEFAULT_REMIND_MIN`)里,改一次要改部署。
//! 搬进 `app_setting` 之后,取值顺序一律是 ★库 > env > 编译期默认★。
//!
//! ⚠★别在别处直接读那三个常量/`state.config.project_creators`★——
//!   那样超管在界面上改了**也不生效**,而且它**不报错**,只是安静地继续用老值。
//!   (`effective_llm_model` 的头注 2026-08-16 就写过这句;这三项照抄同一形状。
//!    区别是这次配了一道门禁 `scripts/no-bypass-effective.sh`,把这句注释变成会红的规则 ——
//!    ★注释拦不住下一个人★。)
//!
//! ══ 为什么不加缓存 ══
//! 每次取值多一次 `SELECT`,其中 `default_quota` 走在**每次配额检查**(= 每次上传)上。
//! 仍然不加,理由是:`app_setting` 只有几行、按主键查,PG 常驻内存;
//! 而★一层缓存意味着「超管改了、有些进程还在用老值」,那正是这套设计要消灭的东西★。
//! 真到了要缓存那天,带着实测数字再谈。
//!
//! ══ 库里存的是垃圾怎么办 ══
//! `app_setting` 是人能手改的表。解析失败一律**回落到兜底值**,不 panic、不 500 ——
//! 一个配置项写坏了不该让整个服务不可用(T3 有测试钉住)。

use crate::config::{Config, DEFAULT_QUOTA_BYTES};
use sqlx::PgPool;

/// 全站默认提醒提前量(分钟)——★`remind.rs` 里那个常量的新家★(2026-08-16 搬来)。
/// 下面这段是它在 `remind.rs` 时就带着的注释,原样搬过来:
///
/// > 个人默认也没设时的兜底（PRD F3 + 2026-08-11 liaoruili 拍板）。
/// >
/// > ⚠★这个常量改变了一条无声的系统行为★：没有偏好行的人本来一条提醒都收不到
/// > （功能上线等于没上线），现在他们默认会收到。所以设置页必须写明「默认 15 分钟、可以关」。
///
/// ⚠ 搬家之后它多了一层:★超管可以改它★,所以「设置页要写明默认是多少」这条
///   现在有两处要顾 —— 个人设置页,和后台治理页(那里显示的必须是**生效值**不是这个常量)。
pub const DEFAULT_REMIND_MIN: i32 = 15;

/// 这三个 key 是**允许超管写入**的全部。
///
/// ★白名单是安全边界,不是校验便利★:`app_setting` 是通用 kv,
/// 不设白名单的话,`PUT /admin/settings/{key}` 就是「超管可以写任意配置键」——
/// 将来任何一个新 key(哪怕是内部用的、根本没打算给人改的)都会**自动**变成可被外部写入。
/// ⚠ 权限随新功能自动扩大,是最难发现的一类越权:没有人改过权限代码,它自己就变宽了。
pub const 可写的键: [&str; 3] = ["project_creators", "default_quota_bytes", "default_remind_minutes"];

/// 值是从哪来的 —— ★这不是调试信息,是界面要显示的东西★。
/// 超管看到「10 GiB」,得知道它是「有人设成了 10」还是「没人设过,恰好默认是 10」:
/// 这两种状态在他改 env 或升级版本时表现完全不同。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
// ★契约里的类型名用 ASCII★:JSON 里中文 key 合法,但 OpenAPI 契约要喂给
// 生成客户端代码的工具(oasdiff / openapi-generator),中文类型名在那边会变成
// 奇怪的标识符。★代码里照旧叫「来源」——中文命名是本仓风格,只在对外契约上换名。★
#[schemars(rename = "SettingSource")]
pub enum 来源 { Db, Env, Default }

/// 读一项设置的原始值。`Ok(None)` = 确实没设过;`Err` = **没查成**。
///
/// ⚠★这两件事以前是同一个返回值★(2026-08-23 全量审计发现,阻塞级):
///   原来是 `.ok().flatten()` —— DB 出错被吞成 `None`,而 `None` 在
///   `effective_project_creators` 里的兜底是**空名单 = 人人可建**。
///   ⇒ ★数据库抖一下,「谁能建项目」这道治理闸就静默失效,而且没有任何日志。★
///   同一个吞法也让全站默认配额悄悄回落到编译期常量 —— 所有没单独设过配额的人当场跟着变。
///
/// ★「查不到」和「没查成」必须分开★ —— 这是本仓反复吃亏的同一条:
///   把「我没查」当成「查了没问题」,在**权限**路径上就是 fail-open。
async fn 读原始值(pool: &PgPool, key: &str) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>("SELECT value FROM app_setting WHERE key = $1")
        .bind(key).fetch_optional(pool).await
}

/// 逗号分隔的用户名 → 去空、去重后的列表。
/// ★库里和 env 里用同一种格式,所以只有这一段解析★ —— 两种格式迟早会在边界情况上分叉
/// (空串、前后空格、尾逗号),而分叉出来的差异没有任何地方会报错。
pub fn 解析名单(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in s.split(',') {
        let t = t.trim();
        if !t.is_empty() && !out.iter().any(|x| x == t) { out.push(t.to_string()) }
    }
    out
}

/// 谁能建项目。★唯一推导★:库 > env > 空(= 人人可建)。
/// ⚠ 「空 = 人人可建」是 2026-08-16 liaoruili 拍板维持的现状 ——
///   改成「空 = 只有超管」是一次**静默的权限收紧**:升级部署的同一刻,
///   现在能建项目的人全部失去这个能力,而没有人会收到通知。
/// ⚠★返回 Result,错误必须往上抛★(2026-08-23 审计):这是**权限闸**的取值 ——
///   查不成时唯一安全的行为是让请求失败(500),而不是当作「没设过」放行。
pub async fn effective_project_creators(pool: &PgPool, config: &Config)
    -> Result<(Vec<String>, 来源), sqlx::Error> {
    Ok(match 读原始值(pool, "project_creators").await? {
        // ⚠★空串是一个**有效的值**,不是「没设过」★:超管把名单清空,意思是「改回人人可建」,
        //   而不是「退回去用 env 里那份」。这一条必须在 `filter(非空)` 之前判掉 ——
        //   写成 `.filter(|v| !v.is_empty())` 会让「清空」这个动作**看起来成功、实际无效**。
        Some(v) => (解析名单(&v), 来源::Db),
        None if !config.project_creators.is_empty() => (config.project_creators.clone(), 来源::Env),
        None => (Vec::new(), 来源::Default),
    })
}

/// 全站默认配额(字节)。★唯一推导★:库 > 编译期常量。
///
/// ⚠★这是「全站默认」不是「新用户默认」★(2026-08-16 更正,详见 docs/PRD-admin-console.md §7):
///   它是 `owner_quota_used` 里 `COALESCE(user_quota.quota_bytes, $2)` 的那个 `$2` ——
///   **没有 `user_quota` 行的人每次都现算**,而实测 dev 上 108 个用户里 0 个设过。
///   ⇒ 改它会立刻改变几乎所有人的额度,加也是、减也是。界面必须先算影响面再让人确认。
/// ⚠★返回 Result★(2026-08-23 审计):它是**几乎所有人的额度**的来源
///   (`owner_quota_used` 的 COALESCE 兜底)。查不成时静默回落到编译期常量,
///   等于全站配额在无人知晓的情况下换了一个值 —— 加也糟、减也糟(有人当场传不了东西)。
pub async fn effective_default_quota(pool: &PgPool) -> Result<(i64, 来源), sqlx::Error> {
    Ok(match 读原始值(pool, "default_quota_bytes").await?.and_then(|v| v.trim().parse::<i64>().ok()) {
        Some(n) if n > 0 => (n, 来源::Db),
        // ★「值写坏了」仍然回落,不 500★:那是**查到了但内容不合法**,与「没查成」是两回事。
        //   配置写坏不该让服务不可用;而查不成必须让请求失败。
        _ => (DEFAULT_QUOTA_BYTES, 来源::Default),
    })
}

/// 全站默认提醒提前量(分钟)。★唯一推导★:库 > 编译期常量。
/// 个人默认(`user_prefs.default_remind_minutes`)和单场设置仍然覆盖它 —— 这一项只是最后那层兜底。
pub async fn effective_default_remind(pool: &PgPool) -> Result<(i32, 来源), sqlx::Error> {
    Ok(match 读原始值(pool, "default_remind_minutes").await?.and_then(|v| v.trim().parse::<i32>().ok()) {
        Some(n) if (1..=10080).contains(&n) => (n, 来源::Db),
        _ => (DEFAULT_REMIND_MIN, 来源::Default),
    })
}

/// 写入一个设置项。★校验在这里做,不在 handler 里★ —— handler 只管 HTTP,
/// 「什么样的值是合法的」是这三项自己的性质,和它从哪个接口进来无关。
///
/// 回 `Err(说明)` 表示不合法。调用方转成 400。
pub async fn 校验(pool: &PgPool, key: &str, value: &str) -> Result<String, String> {
    match key {
        "project_creators" => {
            let 名单 = 解析名单(value);
            if 名单.len() > 200 { return Err("名单太长(上限 200 人)".into()) }
            // ★每个用户名必须真的存在★(2026-08-16 liaoruili 选「从用户列表里勾」的同一条理由):
            //   白名单是字符串比对,名字对不上就是不在名单里 —— 系统**不会**说「你填的这个人不存在」。
            //   打错一个字母的后果是「这个人从此建不了项目」,而**没有任何地方会报错**,
            //   还要等那个人某天想建项目才暴露。⇒ 在写入这一刻就拦住。
            for u in &名单 {
                // ⚠★别写 `SELECT 1` 再当 i64 收★(2026-08-16 上线后被 E2E 抓到):
                //   PG 里字面量 `1` 是 **INT4**,而 Rust 侧要 `i64`(INT8)—— 解码当场报
                //   「mismatched types」。后果不是「消息不好看」,是★这一项**永远存不进去**★:
                //   任何值(哪怕名单里全是真实用户)都 400。
                //   ⚠ 为什么一路没人拦住它,值得记:
                //     · `cargo test` 是纯的,我那条单测用永不连接的 pool,恰好跳过了这个分支;
                //     · ★「SQL 对真库 PREPARE」那道门禁也看不见★ —— `SELECT 1 FROM app_user`
                //       PREPARE 完全合法,错发生在 **Rust 解码**阶段,不在 SQL 阶段;
                //     · 界面上没点到(白名单没改动时「保存」是禁用的)。
                //   ★唯一抓到它的是一条断言**错误消息内容**的 E2E★:只断言「回 400」的话,
                //     这个 400 会因为一个完全错误的理由而"通过"。
                //   直接选 username(text)最稳:不引入任何整数字面量的类型问题。
                let 有: Option<String> = sqlx::query_scalar("SELECT username FROM app_user WHERE username = $1")
                    .bind(u).fetch_optional(pool).await.map_err(|e| e.to_string())?;
                if 有.is_none() { return Err(format!("没有这个用户:{u}(只能从登录过的用户里选)")) }
            }
            Ok(名单.join(","))
        }
        "default_quota_bytes" => {
            let n: i64 = value.trim().parse().map_err(|_| "要一个整数(字节)".to_string())?;
            if n <= 0 { return Err("配额要大于 0".into()) }
            // 1 PiB 上限:纯粹防手滑多打几个 0(没有任何真实场景需要给单人 1 PiB)
            if n > 1 << 50 { return Err("配额上限 1 PiB —— 是不是多打了几个 0?".into()) }
            Ok(n.to_string())
        }
        "default_remind_minutes" => {
            let n: i32 = value.trim().parse().map_err(|_| "要一个整数(分钟)".to_string())?;
            if !(1..=10080).contains(&n) { return Err("提前量要在 1 分钟 ~ 7 天之间".into()) }
            Ok(n.to_string())
        }
        _ => Err(format!("不认识的设置项:{key}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ★名单解析只有这一段★(库和 env 同格式)——所以它的边界必须钉死:
    /// 尾逗号、多余空格、重复项,三样都是人在界面/env 里真会打出来的。
    #[test]
    fn 名单解析吃掉空白与重复() {
        assert_eq!(解析名单("liaoruili, lichaoyue ,liaoruili,"), vec!["liaoruili", "lichaoyue"]);
        assert_eq!(解析名单(""), Vec::<String>::new());
        assert_eq!(解析名单("  ,, "), Vec::<String>::new());
    }

    /// ★白名单外的 key 一个都不许过★ —— 这条是安全边界不是校验便利:
    /// `app_setting` 是通用 kv,漏一个口子就等于「超管可以写任意配置键」。
    /// ⚠ 特意把 `llm_model` 也钉进来:它**确实是** app_setting 里的一个 key,
    ///   但它有自己的接口(要校验的东西不一样),★不能从这条通用路径写进去★。
    #[tokio::test]
    async fn 白名单外的键一律拒() {
        for k in ["llm_model", "", "../etc", "DEFAULT_QUOTA_BYTES", "project_creators "] {
            assert!(!可写的键.contains(&k), "★{k} 不该在白名单里★");
        }
        for k in 可写的键 { assert!(!k.is_empty()) }
    }

    /// 配额与提醒的边界。★不连库的两个分支单独测★(project_creators 要查 app_user,归 E2E)。
    #[tokio::test]
    async fn 配额与提醒的边界() {
        // 这两个分支不碰 pool —— 用一个永远连不上的 pool 也走得到,
        // 正好顺带证明它们**真的不查库**(查了就会挂在这儿)。
        let pool = sqlx::PgPool::connect_lazy("postgres://x:x@127.0.0.1:1/x").unwrap();
        for 坏 in ["0", "-1", "abc", "", "1125899906842625"] {   // 最后一个 = 1 PiB + 1
            assert!(校验(&pool, "default_quota_bytes", 坏).await.is_err(), "★配额 {坏} 该被拒★");
        }
        assert_eq!(校验(&pool, "default_quota_bytes", " 5368709120 ").await.unwrap(), "5368709120");
        for 坏 in ["0", "-5", "10081", "x"] {
            assert!(校验(&pool, "default_remind_minutes", 坏).await.is_err(), "★提前量 {坏} 该被拒★");
        }
        assert_eq!(校验(&pool, "default_remind_minutes", "30").await.unwrap(), "30");
        assert!(校验(&pool, "随便一个键", "1").await.is_err());
    }
}
