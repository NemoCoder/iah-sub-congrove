//! 后端时区（PRD E0/E1/E2，设计 docs/TECH-DESIGN-M3-timezone.md 步骤 5）。
//!
//! ══════ 为什么需要它 ══════
//! 盘点发现后端**四处写死东八区**（`notify.rs` / `remind.rs` / `projects.rs` / `items.rs`），
//! 站内信正文与报错文案里的时间一律按北京时间渲染。
//! ★后果比 E1/E2 更直接★：纽约用户收到的提醒会说「将于 15 分钟后开始（08-12 07:00）」，
//! 而那是北京时间 —— 他照着这个数字安排，就会错过会。
//!
//! ⚠ `chrono` 自己**只会固定偏移**，算不了 `Asia/Shanghai` 这种带夏令时和历史变更的真时区，
//!   所以引了 `chrono-tz`。前端不引第三方库是因为浏览器有 `Intl`，后端没有等价物。

use chrono_tz::Tz;

/// 兜底时区。★不是「默认北京」这个产品决定★（PRD E0 明确不设默认北京）——
/// 这是**数据缺失时的技术兜底**：老数据的 `activities.timezone` 是空字符串，
/// 而在那之前这四处本来就按东八区渲染，兜到这里等于「保持原样」。
pub const FALLBACK: Tz = chrono_tz::Asia::Shanghai;

/// 解析 IANA 名；解析不出（空串、脏数据、被删掉的时区名）一律兜底。
/// ★不 panic、不返回 Result★：一个时区名解析失败不该让「发一条站内信」这件事失败。
pub fn parse(name: &str) -> Tz { name.parse::<Tz>().unwrap_or(FALLBACK) }

/// 查某个人的时区偏好。没设过 → 兜底。
///
/// ⚠★查不到不等于出错★：`user_prefs` 里没有这个人的行是常态（大多数人没进过设置页）。
pub async fn of_user(pool: &sqlx::PgPool, username: &str) -> Tz {
    let s: Option<Option<String>> = sqlx::query_scalar(
        "SELECT timezone FROM user_prefs WHERE username = $1")
        .bind(username).fetch_optional(pool).await.ok().flatten();
    s.flatten().map(|x| parse(&x)).unwrap_or(FALLBACK)
}

/// 批量查。★提醒循环一轮最多 200 条，逐个查库是 200 次往返★（设计 §3 步骤 5 的告警）。
pub async fn of_users(pool: &sqlx::PgPool, names: &[String]) -> std::collections::HashMap<String, Tz> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT username, timezone FROM user_prefs WHERE username = ANY($1)")
        .bind(names).fetch_all(pool).await.unwrap_or_default();
    rows.into_iter().map(|(u, t)| (u, t.map(|x| parse(&x)).unwrap_or(FALLBACK))).collect()
}

/// 「08-13 周三 10:00」——与原来 `notify::fmt_when` 的格式**逐字一致**，只是时区可指定。
/// ★带星期★：纯数字日期读起来要在脑子里换算一次，而「周三」是人真正安排生活用的单位。
pub fn when(t: chrono::DateTime<chrono::Utc>, tz: Tz) -> String {
    use chrono::Datelike;
    const WD: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    let l = t.with_timezone(&tz);
    format!("{} {} {}", l.format("%m-%d"),
        WD[l.weekday().number_from_monday() as usize - 1], l.format("%H:%M"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn 同一瞬时在不同时区是不同的钟点() {
        let t = chrono::Utc.with_ymd_and_hms(2026, 8, 12, 7, 0, 0).unwrap();
        assert_eq!(when(t, chrono_tz::Asia::Shanghai), "08-12 周三 15:00");
        assert_eq!(when(t, chrono_tz::America::New_York), "08-12 周三 03:00");
    }

    #[test]
    fn 跨日时日期和星期要一起跳() {
        // UTC 23:00 → 北京已经是次日 07:00,星期也得跟着走
        let t = chrono::Utc.with_ymd_and_hms(2026, 8, 12, 23, 0, 0).unwrap();
        assert_eq!(when(t, chrono_tz::Asia::Shanghai), "08-13 周四 07:00");
        assert_eq!(when(t, chrono_tz::America::New_York), "08-12 周三 19:00");
    }

    #[test]
    /// ★这条钉死「没有把偏移写死」★
    fn 夏令时不是写死的偏移() {
        // 纽约 7 月 UTC-4、1 月 UTC-5 —— 这条钉死「没有把偏移写死成 -5」
        let 夏 = chrono::Utc.with_ymd_and_hms(2026, 7, 15, 16, 0, 0).unwrap();
        let 冬 = chrono::Utc.with_ymd_and_hms(2026, 1, 15, 16, 0, 0).unwrap();
        assert_eq!(when(夏, chrono_tz::America::New_York), "07-15 周三 12:00");
        assert_eq!(when(冬, chrono_tz::America::New_York), "01-15 周四 11:00");
    }

    #[test]
    fn 脏数据一律兜底而不是炸() {
        assert_eq!(parse("Asia/Shanghai"), chrono_tz::Asia::Shanghai);
        assert_eq!(parse(""), FALLBACK);              // ★老数据里就是空串★
        assert_eq!(parse("Mars/Olympus"), FALLBACK);  // 打错的名字
    }

    #[test]
    fn 与旧实现逐字一致() {
        // ★这条是「行为不变」的锚★:兜底时区下,新函数的输出必须和写死东八区的老实现一样。
        let t = chrono::Utc.with_ymd_and_hms(2026, 8, 13, 2, 0, 0).unwrap();
        let 老 = {
            let l = t.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap());
            const WD: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
            let wd = WD[l.format("%u").to_string().parse::<usize>().unwrap_or(1) - 1];
            format!("{} {wd} {}", l.format("%m-%d"), l.format("%H:%M"))
        };
        assert_eq!(when(t, FALLBACK), 老);
    }
}
