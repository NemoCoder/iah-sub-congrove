//! 纪要导出 PDF —— 把纪要拼成 Markdown,交给平台共享的 latex-svc 编译。
//!
//! ══ 为什么由**后端**拼这份 Markdown ══
//! ★同一份纪要,从任何入口导出都必须是同一份文件★。放前端拼的话,
//! 将来多一个入口(批量导出、定时归档、别人调 API)就多一份**长得不一样**的纪要,
//! 而它们看起来都像"正式件"。
//!
//! ══ 平台服务(2026-08-17 实测) ══
//! `POST http://latex-svc.platform.svc:8000/compile-md`(multipart)。
//! ⚠★契约坑★:服务自己的用法串写的是 `files[]=…`,**而实际字段名是 `files`**
//!   (那个 `[]` 是说明不是字面量)。我照抄第一次就 400 —— 记在这儿别再踩。
//! ⚠ 它 **egress 全禁**(D15 的安全边界),所以别指望它去网上拉图/拉字体。

use crate::error::{AppError, AppResult};

/// latex-svc 的地址。★不注入 env、写死服务名★:它是平台的**集群内固定服务**,
/// 而 congrove 的 pod 与它同集群;做成 env 只会多一个「没配就静默不可用」的失败面。
/// ⚠ 真要换地址时改这一行 —— 而不是在四个地方各写一遍。
const LATEX_SVC: &str = "http://latex-svc.platform.svc:8000/compile-md";

/// 拼给 latex-svc 的 Markdown。★纯函数★——两个命门都在这里,能被单测钉死。
///
/// ⚠★空段落不出标题★:一个只有「决议事项」四个字、底下什么都没有的段落,
///   读的人会以为内容丢了 —— 而事实是本来就没有。**没有内容时整段不出现。**
///
/// ⚠★草稿要在文件里自报身份★(2026-08-17 liaoruili 选「随时可导出」之后的配套):
///   `0001_init.sql` 原设计是「点完成时才生成」,理由是防「未定稿被当正式件发出去」。
///   改成随时可导出之后,那个顾虑不会消失 —— ★解法不是拒绝需求,是让那份文件自己说明身份★。
///   靠人记得「这份是草稿」不可靠;靠文件自己带标记可靠。
#[allow(clippy::too_many_arguments)]
pub fn 拼纪要markdown(
    标题: &str, 是草稿: bool,
    时间: &str, 地点: &str, 线上: &str,
    记录员: &str, 到场: &str, 旁听: &str, 缺席: &str,
    议程: &str, 正文: &str, 决议: &str, 待办: &str,
) -> String {
    let mut s = String::new();
    if 是草稿 {
        s.push_str("# 【草稿 · 尚未定稿】");
    } else {
        s.push('#');
        s.push(' ');
    }
    s.push_str(标题.trim());
    s.push_str("\n\n");

    // 元信息:逐项只在非空时出现(一行里用两个全角空格分隔,和界面上的读法一致)
    let mut 元 = Vec::new();
    for (名, 值) in [("时间", 时间), ("地点", 地点), ("线上", 线上), ("记录员", 记录员)] {
        if !值.trim().is_empty() { 元.push(format!("**{名}**：{}", 值.trim())) }
    }
    if !元.is_empty() { s.push_str(&元.join("　")); s.push_str("\n\n") }
    let mut 人 = Vec::new();
    for (名, 值) in [("到场", 到场), ("旁听", 旁听), ("缺席", 缺席)] {
        if !值.trim().is_empty() { 人.push(format!("**{名}**：{}", 值.trim())) }
    }
    if !人.is_empty() { s.push_str(&人.join("　")); s.push_str("\n\n") }

    for (标题名, 内容) in [("议程", 议程), ("主要内容", 正文), ("决议事项", 决议), ("待办事项", 待办)] {
        if 内容.trim().is_empty() { continue }   // ★空段落不出标题★
        s.push_str("## ");
        s.push_str(标题名);
        s.push_str("\n\n");
        s.push_str(内容.trim());
        s.push_str("\n\n");
    }
    s
}

/// 打 latex-svc,回 PDF 字节。
///
/// ⚠★失败要说人话★(沿用 2026-08-17 那次 prod 事故的教训:上游的原始 JSON/日志
///   不许整坨糊给用户)。这里把上游日志**截断**后放进错误里,由前端再翻一层。
pub async fn 编译(md: &str, 文件名: &str) -> AppResult<Vec<u8>> {
    let cli = reqwest::Client::builder()
        // ★120s★:实测一份小纪要 3.2s;留足余量,但**必须有上限** —— LaTeX 可以写死循环,
        //   而平台侧虽然自己也有 wall-clock 闸,我们这边不设上限就等于把一个连接挂死在那儿。
        .timeout(std::time::Duration::from_secs(120))
        .build().map_err(|e| AppError::Other(e.into()))?;
    let 表单 = reqwest::multipart::Form::new()
        // ⚠★字段名是 `files` 不是 `files[]`★——见本文件头注那个契约坑
        .part("files", reqwest::multipart::Part::text(md.to_string()).file_name(文件名.to_string()))
        .text("main", 文件名.to_string())
        .text("engine", "xelatex");
    let r = cli.post(LATEX_SVC).multipart(表单).send().await
        .map_err(|e| AppError::BadRequest(format!("排版服务连不上:{e}")))?;
    if !r.status().is_success() {
        let code = r.status();
        let 日志 = r.text().await.unwrap_or_default();
        // 只带回前 800 字:带行号的日志片段对排错有用,整坨糊上去没人读
        return Err(AppError::BadRequest(format!(
            "排版失败({code}):{}", 日志.chars().take(800).collect::<String>())));
    }
    Ok(r.bytes().await.map_err(|e| AppError::Other(e.into()))?.to_vec())
}

#[cfg(test)]
mod tests {
    use super::拼纪要markdown;

    fn 拼(草稿: bool, 决议: &str, 待办: &str) -> String {
        拼纪要markdown("八月第二次组会", 草稿, "2026-08-12 04:00", "3 号楼 401", "",
                       "liaoruili", "liaoruili", "", "", "", "正文若干", 决议, 待办)
    }

    #[test]
    fn 草稿要在文件里自报身份() {
        // ★D-1 的命门★:liaoruili 选了「随时可导出」,而原设计「点完成才生成」防的正是
        //   「未定稿被当正式件发出去」。文件必须自己说明身份。
        assert!(拼(true, "甲", "乙").starts_with("# 【草稿 · 尚未定稿】八月第二次组会"));
        // ★正向对照★:定稿的不能带 —— 否则「都带」等于「都没带」
        let 定稿 = 拼(false, "甲", "乙");
        assert!(定稿.starts_with("# 八月第二次组会"), "{定稿}");
        assert!(!定稿.contains("草稿"));
    }

    #[test]
    fn 空段落不出标题() {
        let s = 拼(false, "", "");
        assert!(!s.contains("## 决议事项"), "★一个只有标题没内容的段落,读的人会以为内容丢了★\n{s}");
        assert!(!s.contains("## 待办事项"));
        assert!(s.contains("## 主要内容"), "非空的还是要出");
        // 只有空白也算空
        assert!(!拼(false, "   \n  ", "\t").contains("## 决议事项"));
    }

    #[test]
    fn 元信息逐项只在非空时出现() {
        let s = 拼(false, "甲", "乙");
        assert!(s.contains("**地点**：3 号楼 401"));
        assert!(!s.contains("**线上**"), "线上为空就不该出现这一项");
        assert!(!s.contains("**旁听**"), "旁听为空同理");
        assert!(s.contains("**到场**：liaoruili"));
    }

    #[test]
    fn 正文原样嵌入不做转义() {
        // 记录员写的就是 Markdown,★别在这里"帮他"转义★——那会把他的表格和粗体弄坏。
        let s = 拼纪要markdown("t", false, "", "", "", "", "", "", "", "",
                               "| a | b |\n| :--- | :--- |\n| 1 | 2 |", "", "");
        assert!(s.contains("| :--- | :--- |"), "表格必须原样带过去\n{s}");
    }
}
