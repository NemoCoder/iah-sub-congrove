//! 接口测试用例清单 —— 需求文档到测试的**可追溯映射**。
//!
//! ★为什么用例也做成一张表★:和 `apidoc.rs` 同一套思路,理由也一样——
//! 「每个接口都要有测试用例」这句话如果只写在文档里,三个月后必然有接口没有用例而没人知道。
//! 所以这里让它**可执行**:
//!   ① `CASES` 是用例清单,每条用例带 `rule` 指回需求条款(D0~D16 / PRD 章节);
//!   ② ★底下的测试逐条核对 `apidoc::APIS` 与 `CASES`★——
//!      **加了接口却没写用例、或用例指向一个不存在的接口,`cargo test` 就红**;
//!   ③ 更狠的一条:**需要权限的接口必须有「权限不够」的负面用例**——
//!      只测"能用"不测"不该能用"的接口,等于没测权限(权限 bug 全部藏在负面路径里)。
//!
//! ⚠ 这个文件本身**不发 HTTP 请求**。用例的执行需要一个真实 dev 环境(PG + S3 + OIDC),
//! 那条通道正在等平台开(免 OIDC 的 E2E 入口,群消息 #124)。★不要为了让用例跑起来
//! 就在 congrove 里自建测试身份旁路★——身份边界归平台(2026-08-07 用户明令)。
//! 通道到位后,`then` 一列直接就是 Playwright / HTTP runner 的断言脚本。

use congrove::http::apidoc::APIS;
use std::collections::BTreeSet;

/// 一条用例。given/when/then 写成**可直接照抄成脚本**的具体话,别写"验证功能正常"这种废话。
struct Case {
    /// 与 APIS 对应的方法与路径(错一个字符,底下的测试就红)。
    method: &'static str,
    path: &'static str,
    /// 用例名:一句话说清测什么。
    name: &'static str,
    /// 前置状态。
    given: &'static str,
    /// 动作。
    when: &'static str,
    /// 期望。★必须含具体状态码或可观测事实★。
    then: &'static str,
    /// 依据的需求条款(D0~D16),或事故复盘出处。空串 = 常规 CRUD,无专门条款。
    rule: &'static str,
    /// 是不是「权限不够」的负面用例。★需要权限的接口至少要有一条 true★。
    denial: bool,
}

macro_rules! c {
    ($m:expr, $p:expr, $n:expr, $g:expr, $w:expr, $t:expr, $r:expr) => {
        Case { method: $m, path: $p, name: $n, given: $g, when: $w, then: $t, rule: $r, denial: false }
    };
    (deny $m:expr, $p:expr, $n:expr, $g:expr, $w:expr, $t:expr, $r:expr) => {
        Case { method: $m, path: $p, name: $n, given: $g, when: $w, then: $t, rule: $r, denial: true }
    };
}

/// 全部用例。★新增接口必须在这里补用例,否则测试红★
const CASES: &[Case] = &[
    // ══════════ 探针 ══════════
    c!("GET", "/healthz", "存活探针不查依赖", "服务已启动", "GET /healthz",
       "200 且正文 ok;★即使 PG 断了也必须 200★(存活与就绪是两件事,混了会被 k8s 反复杀)", ""),
    c!("GET", "/readyz", "就绪探针要求依赖都通", "PG 与 S3 均可达", "GET /readyz",
       "200;断开 PG 后再调应返回非 200(k8s 据此摘流量)", ""),

    // ══════════ 认证 ══════════
    c!("GET", "/auth/login", "未登录跳 Keycloak", "无会话 cookie", "GET /auth/login?return_to=/projects",
       "302 到 OIDC_ISSUER 的 authorize;Set-Cookie 带短命 cg_oauth(含 state)", ""),
    c!("GET", "/auth/login", "return_to 只收站内路径", "无会话", "GET /auth/login?return_to=https://evil.com",
       "不得 302 到外站;回跳路径回落到 /(开放重定向防护,含 \\r\\n 控制字符也要拒)", "开放重定向"),
    c!("GET", "/auth/callback", "state 对不上就拒", "cg_oauth 里的 state 是 A", "GET /auth/callback?code=x&state=B",
       "拒绝换码(4xx),不得建会话(CSRF 防护)", "CSRF"),
    c!("GET", "/auth/logout", "退出清会话", "已登录", "GET /auth/logout",
       "Set-Cookie 把 cg_session 置空/过期;之后调 /api/me 得 401", ""),
    c!("GET", "/api/me", "回当前身份与超管位", "以 liaoruili 登录", "GET /api/me",
       "200,username=liaoruili,is_super 来自**库**而非 cookie 快照(撤超管后 8h 内会话应立即失效)", "2026-08-04 审计"),
    c!(deny "GET", "/api/me", "未登录取不到身份", "无 cookie 无 Bearer", "GET /api/me", "401", ""),
    c!("GET", "/api/users", "按关键词搜平台用户", "已登录", "GET /api/users?q=liao",
       "200,候选来自平台 Keycloak(registry 不可达时降级本地 app_user,不报错)", ""),

    // ══════════ 项目 ══════════
    c!("GET", "/api/projects", "只列我参与的项目", "我是 A 的成员,不是 B 的成员", "GET /api/projects",
       "200,含 A 不含 B;每项带我的角色与已用容量。★个人项目对他人完全隐形★", "D1"),
    c!("POST", "/api/projects", "建者自动成为主持人兼 admin", "已登录且在建项目白名单内", "POST /api/projects {name:'X'}",
       "201/200;★owner=我且 project_members 里我是 admin★(两者都要有,漏一个后续转移/授权会崩)", "D0"),
    c!(deny "POST", "/api/projects", "白名单外不能建项目", "CONGROVE_PROJECT_CREATORS 非空且不含我,我非超管",
       "POST /api/projects", "403", "D2"),
    c!("GET", "/api/projects/{id}", "成员可看项目详情", "我是 viewer", "GET /api/projects/{id}", "200", "D3"),
    c!(deny "GET", "/api/projects/{id}", "非成员看不到私密项目", "我不是成员,项目 visibility=private",
       "GET /api/projects/{id}", "★404 不是 403★(403 会泄露「这个项目存在」)", "D3"),
    c!("PUT", "/api/projects/{id}", "admin 可改名与描述", "我是 admin", "PUT {name:'新名'}", "200,库里已改", ""),
    c!(deny "PUT", "/api/projects/{id}", "admin 也不能改可见性", "我是 admin 但不是 owner",
       "PUT {visibility:'public'}", "403;★改 visibility 是 owner 专属★", "D0"),
    c!("PUT", "/api/projects/{id}", "开禁分享要连带撤销已有链接", "项目下已有 2 条有效公开链接,我是 admin",
       "PUT {no_share:true}", "200;★那 2 条链接立刻 404★(只改开关不撤旧链接 = 开关是假的)", "R1"),
    c!("PUT", "/api/projects/{id}", "禁下载只拦 viewer 的原件下载", "项目 no_download=true",
       "viewer 调 download / 调 content / 调 play", "download 403,content 与 play 仍 200(阅读播放不拦)", "P3"),
    c!("DELETE", "/api/projects/{id}", "owner 删项目", "我是 owner", "DELETE /api/projects/{id}", "200,项目进回收站", "D0"),
    c!("DELETE", "/api/projects/{id}", "★归档的项目也能直接删★", "项目已归档,我是 owner",
       "DELETE /api/projects/{id}",
       "200 —— 走 require_owner 不受归档写闸约束。否则「结题归档了,后来发现是废的想清理」\
        就得先恢复再删,反直觉", "D17"),
    c!(deny "DELETE", "/api/projects/{id}", "admin 不能删项目", "我是 admin 但不是 owner",
       "DELETE", "403;★删项目是主持人专属(D0)★——此前实现用的是 admin,与 perm.rs 头注不一致,\
        2026-08-07 做归档时发现并对齐", "D0"),
    c!("GET", "/api/projects/{id}/members", "成员列表只有人没有组", "项目有 3 个成员", "GET .../members",
       "200,3 条,每条是具体用户名;★响应里不得出现任何「组」字段★(D12 已删掉这个概念)", "D12"),
    c!("PUT", "/api/projects/{id}/members", "批量加成员", "我是 admin", "PUT {usernames:['a','b','c'],role:'viewer'}",
       "200,一次加 3 个;★批量是硬需求★(删组之后第一次拉 20 人不能点 20 次)", "D12"),
    c!("PUT", "/api/projects/{id}/members", "加人要过平台用户校验", "我是 admin", "PUT {usernames:['查无此人'],role:'viewer'}",
       "拒绝;用户名以平台 Keycloak 为准,可拉未登录过的真人", ""),
    c!(deny "PUT", "/api/projects/{id}/members", "admin 不能给出 admin", "我是 admin 但不是 owner",
       "PUT {usernames:['x'],role:'admin'}", "403;★发 admin 是 owner 专属★", "D0"),
    c!("DELETE", "/api/projects/{id}/members", "移出成员连带撤销他的公开链接", "被移出者创建过 2 条指向本项目的链接",
       "DELETE {username:'他'}", "200;★那 2 条立刻 404★——否则人走了链接还在 = R1 后门", "D3/R1"),
    c!("DELETE", "/api/projects/{id}/members", "离开即失去全部含他参与过的会议", "他参加过本项目 3 场会议",
       "移出后以他的身份查这 3 场", "全部不可见;★不得因「他当时参加过」而保留可见性★(那是历史累积模型)", "D3"),
    c!("POST", "/api/projects/{id}/transfer", "转移主持人", "我是 owner,目标是本项目成员", "POST {to:'他'}",
       "200,owner 变更;原 owner 保留 admin 成员位(否则转完自己就被踢出去了)", "D0"),
    c!(deny "POST", "/api/projects/{id}/transfer", "不能转给非成员", "我是 owner,目标不是成员",
       "POST {to:'外人'}", "400/422 拒绝且 owner 不变;★否则项目会落到一个看不见它的人手里★", "D0"),
    c!(deny "POST", "/api/projects/{id}/transfer", "admin 不能转移主持人", "我是 admin 非 owner", "POST {to:'x'}", "403", "D0"),
    c!("POST", "/api/projects/{id}/archive", "归档后变只读", "我是 owner,项目里有材料",
       "POST {} 归档,再试上传/建会议/改名",
       "归档 200;之后写操作一律 ★409★(不是 403)——语义是「项目结束了」不是「你没权限」,\
        同一个人换个项目就能做", "D17"),
    c!("POST", "/api/projects/{id}/archive", "★归档后仍能读和下载★", "项目已归档",
       "GET items / content / download",
       "全部 200 —— ★归档就是为了以后还能查★,查得到却拿不走等于没存", "D17"),
    c!("POST", "/api/projects/{id}/archive", "恢复为进行中", "项目已归档,我是 owner",
       "POST {archived:false}", "200,archived_at 置空;之后同一个上传请求由 409 变 200。\
        ★这条接口走 require_owner 不走 require_role★——后者对归档项目拒绝一切写操作,\
        那样归档之后就再也解不开了(自锁)", "D17"),
    c!("POST", "/api/projects/{id}/archive", "归档项目的会不进日历、不产生忙闲", "归档一个有会议的公开项目",
       "GET /api/meetings 与 /api/freebusy",
       "两者都不含它的会;★但项目页里仍查得到★——日历回答「接下来做什么」,历史归历史", "D17"),
    c!(deny "POST", "/api/projects/{id}/archive", "admin 不能归档", "我是 admin 但不是 owner",
       "POST {}", "403;归档影响所有成员能否继续写,与删项目同档", "D17"),
    c!("GET", "/api/projects/{id}/diagnose", "诊断判定链与 perm.rs 同源", "查某成员", "GET .../diagnose?username=x",
       "200,回「超管?」「成员表里什么角色?」两段;★结论必须与实际判权一致★(两处推导分家就是骗人)", "D12"),

    // ══════════ 会议与日程(M1)══════════
    // ★这一组的主线:会议参与 ≠ 资料权限★。每条负面用例都在钉这条线。
    c!("GET", "/api/meetings", "列我参与的与我项目的会", "我是 A 会参会人、B 会所属项目的成员",
       "GET /api/meetings", "200,含 A 与 B", "D7"),
    c!("GET", "/api/meetings", "public 会议不进我的列表", "存在一场与我无关的 public 会议",
       "GET /api/meetings", "★不含它★——列表是我的日程,不是全平台公告板(旁听靠拿 id 看详情)", "D9"),
    c!(deny "GET", "/api/meetings", "未登录取不到日程", "无会话", "GET /api/meetings", "401", ""),
    c!("POST", "/api/meetings", "建会议", "我在项目 P 是 editor",
       "POST {title,recorder,starts_at,ends_at,project_ids:[P]}",
       "200 回 id;★发起人自动 accepted、记录员自动进名单★(发起人不用对自己定的时间再答复一次)", "D14"),
    c!(deny "POST", "/api/meetings", "不关联项目就不让建", "我是某项目 editor",
       "POST {project_ids:[]}", "400;★材料权限来自项目成员身份,没有项目就没人管得了它的材料★", "D3"),
    c!(deny "POST", "/api/meetings", "不填记录员不让建", "参数其余齐全", "POST {recorder:''}",
       "400;纪要由记录员按模板整理,AI 转写只是原材料", "D14"),
    c!(deny "POST", "/api/meetings", "多项目关联要逐个验权", "P1 我是 editor,P2 我不是成员",
       "POST {project_ids:[P1,P2]}", "★拒绝★——只验第一个的话,漏验的那个就是越权入口", "D4"),
    c!("GET", "/api/meetings/{id}", "参会人看到完整详情", "我是参会人", "GET /api/meetings/{id}",
       "200,含参会名单与关联项目", ""),
    c!("GET", "/api/meetings/{id}", "旁听者只拿到裁剪版", "会议 public,我与它毫无关系",
       "GET /api/meetings/{id}",
       "200 但★只有标题/议程/时间/地点/链接★,无 participants、无 organizer/recorder,observer:true", "D9"),
    c!(deny "GET", "/api/meetings/{id}", "private 会议对无关的人不存在", "会议 private,我不是参会人也不是关联项目成员",
       "GET /api/meetings/{id}", "★404 不是 403★(private=仅被邀请者知道这个会存在)", "D9"),
    c!("PUT", "/api/meetings/{id}", "改时间要把答复清回 pending", "3 人已 accepted",
       "PUT {starts_at:新时间}", "200;★那 3 人变回 pending★——旧的「接受」是对旧时间说的,留着等于替人答应", ""),
    c!("PUT", "/api/meetings/{id}", "改线上链接留痕", "已有 online_url", "PUT {online_url:'新链接'}",
       "200 且 meeting_link_history 多一条(谁何时改成什么);开会前十分钟改链接是真实场景", ""),
    c!(deny "PUT", "/api/meetings/{id}", "参会人改不了别人的会", "我是参会人,不是发起人也不是记录员",
       "PUT {title:'篡改'}", "403;★也不是「关联项目的 admin 就能改」★——一场会可关联多个项目,那样太宽", ""),
    c!("DELETE", "/api/meetings/{id}", "取消不是删除", "我是发起人", "DELETE /api/meetings/{id}",
       "200;★status=canceled 留档而非真删★(谁邀了谁、谁拒了是协作事实);之后不再产生忙闲", ""),
    c!(deny "DELETE", "/api/meetings/{id}", "参会人不能取消会议", "我是参会人", "DELETE", "403", ""),
    c!("PUT", "/api/meetings/{id}/participants", "批量邀请", "我是发起人",
       "PUT {usernames:['a','b','c']}", "200 invited=3;用户名过平台校验", ""),
    c!("PUT", "/api/meetings/{id}/participants", "临时参会人看不到材料", "邀请 kind=guest",
       "以 guest 身份看会议详情、再取关联项目的材料",
       "详情 200(能看时间议程链接),★材料 404★——他不是项目成员", "D8"),
    c!(deny "PUT", "/api/meetings/{id}/participants", "参会人不能拉人", "我是普通参会人",
       "PUT {usernames:['x']}", "403", ""),
    c!(deny "DELETE", "/api/meetings/{id}/participants", "不能移出发起人", "我是记录员",
       "DELETE {username:发起人}", "400 拒绝;★移出他就没人改得了这场会★", ""),
    c!("POST", "/api/meetings/{id}/respond", "接受邀请", "我在名单里", "POST {status:'accepted'}",
       "200,responded_at 落库", ""),
    c!("POST", "/api/meetings/{id}/respond", "建议改期必须带替代时间", "我在名单里,该时段我有私事",
       "POST {status:'counter',counter_starts_at,counter_ends_at,counter_reason}",
       "200;★这是私事冲突唯一的结构化出口★——私密项目的日程对发起人完全隐形,他不知道我忙", "D2"),
    c!(deny "POST", "/api/meetings/{id}/respond", "counter 不给时间就拒绝", "我在名单里",
       "POST {status:'counter'}", "400;★只说「我不行」等于把问题丢回给发起人★", "D2"),
    c!(deny "POST", "/api/meetings/{id}/respond", "旁听者不能答复", "会议 public,我不在名单里",
       "POST {status:'accepted'}", "403;他看得见这场会,但不能给自己投一票", "D9"),
    c!("GET", "/api/meetings/{id}/messages", "读公开讨论", "我是参会人", "GET .../messages", "200", "D13"),
    c!("GET", "/api/meetings/{id}/messages", "私聊只看得到我这一对", "我与发起人私聊过,别人也各自私聊过",
       "GET .../messages?channel=private&peer=发起人", "只回我与他的往来,★看不到别人那对★", "D13"),
    c!(deny "GET", "/api/meetings/{id}/messages", "旁听者看不到讨论区", "会议 public,我不是参会人",
       "GET .../messages", "403;★D9 给旁听者的是「知道会议存在与议程」,不含听人聊天★", "D9"),
    c!("POST", "/api/meetings/{id}/messages", "公开发言", "我是参会人", "POST {body:'我晚十分钟'}", "200 回 id", "D13"),
    c!(deny "POST", "/api/meetings/{id}/messages", "私聊对象只限发起人与记录员", "我是参会人",
       "POST {channel:'private',peer:'另一个普通参会人'}",
       "400 拒绝;★不做任意点对点,否则这里会长成一个 IM★", "D13"),
    c!("GET", "/api/meetings/{id}/items", "会议材料与录制分开", "会议下有 2 份材料 1 个录屏",
       "GET .../items", "200,3 条;录屏的 is_recording=true —— ★只有它会被转写、并作为会议时长依据★", "D5"),
    c!(deny "GET", "/api/meetings/{id}/items", "★临时参会人看不到材料★", "我是 guest,不是任何关联项目的成员",
       "GET .../items", "403 —— 他看得见这场会(能参会),但材料按★项目成员身份★判权", "D8"),
    c!("GET", "/api/meetings/{id}/link-history", "线上链接改动可追溯", "链接改过 2 次",
       "GET .../link-history", "200,2 条,含 谁/何时/改成什么", ""),
    c!(deny "GET", "/api/meetings/{id}/link-history", "旁听者看不到改动历史", "会议 public,我不是参会人",
       "GET .../link-history", "403", "D9"),
    c!("POST", "/api/meetings/{id}/remind", "★只催还没答复的★", "3 人待答复、2 人已接受",
       "POST .../remind", "200 targets=3 —— 已接受/已拒绝的人不该再被打扰", ""),
    c!(deny "POST", "/api/meetings/{id}/remind", "参会人不能催办", "我是普通参会人", "POST .../remind", "403", ""),
    c!("POST", "/api/meetings/{id}/accept-counter", "采纳改期把时间改成他提议的",
       "某人 status=counter 且给了提议时间", "POST {username:'他'}",
       "200,会议时间变成提议时间;★所有人答复清回 pending,含提议者本人★——他提的是时间,不等于他一定能来", "D2"),
    c!(deny "POST", "/api/meetings/{id}/accept-counter", "没提改期的人不能被采纳", "他 status=accepted",
       "POST {username:'他'}", "400", "D2"),
    c!("POST", "/api/meetings/{id}/reject-counter", "★驳回后回 pending 不是 declined★",
       "某人 status=counter", "POST {username:'他'}",
       "200,他的 status 变回 pending、counter_* 清空 —— 发起人拒的是这个**时间提议**,\
        不代表替他决定「不来」;他还能接受原时间或另提一个", "D2"),
    c!(deny "POST", "/api/meetings/{id}/reject-counter", "没提改期的人不能被驳回", "他 status=accepted",
       "POST {username:'他'}", "400", "D2"),
    c!("GET", "/api/meetings/public", "★公开会议要有入口★", "存在一场与我无关的 public 会议",
       "GET /api/meetings/public?days=7",
       "200 且含它 —— 普通会议列表**刻意**不含它(那是我的日程),\
        所以没有这个广场的话「全平台可旁听」就是一句空话", "D9"),
    c!("GET", "/api/meetings/public", "只列还没结束的", "一场 public 会已经开完",
       "GET /api/meetings/public", "不含它 —— 旁听的意义是「我要去听」", "D9"),
    c!(deny "GET", "/api/meetings/public", "未登录看不到广场", "无会话", "GET /api/meetings/public", "401", ""),
    c!("POST", "/api/meetings/{id}/observe", "自助旁听后进我的日历", "一场与我无关的 public 会议",
       "POST {observe:true},再 GET /api/meetings",
       "200;该会出现在我的日历里(list 包含「我是参会人」的会)。★不需要发起人同意★", "D9"),
    c!("POST", "/api/meetings/{id}/observe", "★旁听拿不到材料★", "我旁听了某公开会议",
       "GET /api/meetings/{id}/items", "403 —— D9 与 D3 正交:元信息公开不等于资料公开", "D9/D3"),
    c!("POST", "/api/meetings/{id}/observe", "★已是正式参会人不会被降级★", "我是该会的 attendee 且已 accepted",
       "POST {observe:true}", "200 但我的 kind 仍是 attendee、答复状态不变(ON CONFLICT DO NOTHING)", "D9"),
    c!(deny "POST", "/api/meetings/{id}/observe", "私密会议不能旁听", "会议 visibility=private",
       "POST {observe:true}", "★404 不是 403★——私密会议对无关的人连「存在」都不该暴露", "D9"),
    c!("GET", "/api/freebusy", "公开项目的会产生忙闲", "他在公开项目 P 有一场会",
       "GET /api/freebusy?users=他&from&to", "200,含那个时间段;★只有 start/end,无标题无任何内容★", "D1"),
    c!("GET", "/api/freebusy", "私密项目的会完全隐形", "他在★私密★项目里有一场会,时间与查询窗重叠",
       "GET /api/freebusy?users=他", "★返回空数组(他显示「空闲」)★——私事连「我忙」都不该暴露。\
        这不是漏洞是刻意的,代价由「建议改期」与当事人侧的标红提醒兜住", "D1"),
    c!("GET", "/api/freebusy", "已拒绝的邀请不算忙", "他对该会 declined", "GET /api/freebusy?users=他",
       "不含该时段——他明确说了不来", "D1"),
    c!(deny "GET", "/api/freebusy", "未登录查不了忙闲", "无会话", "GET /api/freebusy?users=x", "401", ""),

    // 「我的投入」——这几条钉的全是**口径**。统计一旦口径漂了没人看得出来:
    // 数字照样长得很像那么回事,只是不对。
    // 未读:三条钉的是「什么算未读」和「标记已读会不会吞消息」。
    c!("GET", "/api/me/unread", "★公开讨论区的新消息不算未读★", "某会公开频道有 5 条我没看过的消息",
       "GET /api/me/unread", "空数组——那是「群里有人说话」不是「有人找我」;\
        混进来会让这张卡天天有红点,红点天天有就等于没有", "D13"),
    c!("GET", "/api/me/unread", "从没读过 = 全部未读", "有人私聊我 2 条,我从没打开过这场会(meeting_reads 无记录)",
       "GET /api/me/unread", "★返回该会 count=2★——没有记录当「一条都没读过」而不是「全读过」,\
        否则新人加入项目后的历史讨论会悄悄永远不提醒他", "D3"),
    c!("GET", "/api/me/unread", "自己发的不算未读", "我私聊了别人",
       "GET /api/me/unread", "不含——sender = 我的直接排除", ""),
    c!("POST", "/api/me/unread/read", "★全部标记已读不吞刚发来的消息★",
       "标记的同一瞬间对方又发了一条", "POST {} (不带 meeting_id)",
       "read_at = now() 而不是「最后一条消息的时间」;最坏是把刚发来的那条也算读了,\
        而它还在会议页里躺着不会丢", ""),
    c!(deny "POST", "/api/me/unread/read", "未登录标不了已读", "无会话", "POST /api/me/unread/read", "401", ""),
    c!(deny "GET", "/api/me/unread", "未登录看不了未读", "无会话", "GET /api/me/unread", "401", ""),

    c!("GET", "/api/me/stats", "★还没开的会不计入★", "本月有一场明天才开的会",
       "GET /api/me/stats?range=month", "totals.meetings 不含它——「投入」是回顾,\
        把未来的会算进去等于月初就看到一个虚高的数字", ""),
    c!("GET", "/api/me/stats", "★拒绝的会不计入★", "我对一场已开完的会 declined",
       "GET /api/me/stats", "不计次数也不计时长——人没去,不该算他的投入", ""),
    c!("GET", "/api/me/stats", "发起人不在参会名单里也算", "我发起了会但没把自己加进 participants",
       "GET /api/me/stats", "计入——他在开会,只是没给自己发邀请", ""),
    c!("GET", "/api/me/stats", "待写纪要按记录员算", "我是记录员,会已开完,纪要 status=draft",
       "GET /api/me/stats", "minutes_todo 含它;若纪要 done 则不含。★记录员是纪要的作者★", "D14"),
    c!("GET", "/api/me/stats", "一场会关联两个项目会在分项目表里各计一次",
       "会 M 同时关联 P1、P2", "GET /api/me/stats",
       "by_project 两行各 1 次,而 totals.meetings 只 +1 —— ★分项目之和 ≥ 总数是设计如此★,\
        前端别拿它反推总数", ""),
    c!(deny "GET", "/api/me/stats", "range 只认三个值", "登录", "GET /api/me/stats?range=drop",
       "400 —— 这个值要进 date_trunc 第一参,乱字符串会让 PG 直接报错 500", ""),
    c!(deny "GET", "/api/me/stats", "未登录看不了统计", "无会话", "GET /api/me/stats", "401", ""),

    c!("GET", "/api/meetings/{id}/minutes", "没有纪要时回空而不是 404", "会议刚建,还没写纪要",
       "GET .../minutes", "200,minutes=null,can_edit 按身份给;★前端不用为「还没写」判 404★", "D14"),
    c!(deny "GET", "/api/meetings/{id}/minutes", "旁听者看不到纪要", "会议 public,我不是参会人",
       "GET .../minutes", "403;纪要是会议内容,与讨论区同档(D9 给旁听者的只是「知道有这个会」)", "D9"),
    c!("PUT", "/api/meetings/{id}/minutes", "记录员按固定模板保存", "我是记录员",
       "PUT {attendees,agenda_text,content_md,resolutions,todos}", "200;字段对应表里的固定模板", "D14"),
    c!("PUT", "/api/meetings/{id}/minutes", "★定稿时间只记第一次★", "已 status=done 定稿过",
       "再 PUT 一次 {status:'done', attendees:'补录到场'}",
       "200 且 completed_at ★不变★——会后补录到场情况是常事,不该把「什么时候定的稿」冲掉", "D11"),
    c!(deny "PUT", "/api/meetings/{id}/minutes", "普通参会人改不了纪要", "我是参会人,不是记录员也不是发起人",
       "PUT {content_md:'我改的'}", "403;★纪要要有唯一作者★,否则「按模板整理」会变成谁都能覆盖的公共草稿", "D14"),

    // ══════════ 内容 ══════════
    c!("GET", "/api/projects/{id}/items", "内容树不含回收站", "项目里有 5 项,其中 2 项已删", "GET .../items",
       "200,只回 3 项;★deleted_at IS NULL★", "v0.3.55"),
    c!("POST", "/api/projects/{id}/items", "建文件夹", "我是 editor", "POST {name:'F',kind:'folder'}", "200", ""),
    c!(deny "POST", "/api/projects/{id}/items", "viewer 不能建", "我是 viewer", "POST {kind:'folder'}", "403", ""),
    c!("POST", "/api/projects/{id}/precheck", "秒传只对本来就读得到的内容生效",
       "别人项目里有 sha=S 的文件,我读不到它", "POST {sha256:S,size,name}",
       "★不得命中秒传★,要求真传;否则就是「凭哈希认领他人文件」", "v0.3.55"),
    c!("POST", "/api/projects/{id}/precheck", "同项目内秒传命中", "本项目已有 sha=S 且我可读", "POST {sha256:S,...}",
       "命中,免传,新建的行引用同一对象(引用计数 +1)", "v0.3.55"),
    c!("GET", "/api/projects/{id}/trash", "回收站只列删除动作的根", "删了一个含 3 个子项的文件夹", "GET .../trash",
       "200,只回那 1 个文件夹,不平铺出 4 条", "v0.3.55"),
    c!("GET", "/api/items/{id}", "条目详情", "我是 viewer", "GET /api/items/{id}", "200", ""),
    c!(deny "GET", "/api/items/{id}", "已删条目查不到", "该条目在回收站", "GET /api/items/{id}",
       "404;★deleted_at IS NULL★(v0.3.55 前这里漏了)", "v0.3.55"),
    c!("PUT", "/api/items/{id}", "改名与移动", "我是 editor", "PUT {name:'新名',parent_id:X}", "200", ""),
    c!(deny "PUT", "/api/items/{id}", "不能把子树挂到别的项目下", "目标 parent 属于另一个项目",
       "PUT {parent_id:他项目的目录}", "★拒绝★——这条防线曾因变量遮蔽被悄悄拆掉(check_parent 内层 pid 遮蔽外层项目 id)", "2026-08-06"),
    c!(deny "PUT", "/api/items/{id}", "不能把目录移进自己的子树", "A 是 B 的祖先", "PUT {parent_id:B}",
       "400 拒绝且树结构不变;★成环后整棵子树会从树里消失(遍历不到)且再也移不回来★", ""),
    c!("DELETE", "/api/items/{id}", "删除是软删除且整棵子树", "文件夹含 3 个子项", "DELETE",
       "200;4 行都打上**同一个** deleted_at;★S3 一个字节不动★", "v0.3.55"),
    c!("DELETE", "/api/items/{id}", "回收站仍占配额", "删掉 1GiB 文件后看项目已用容量", "GET /api/projects",
       "★已用容量不变★——占着地方就该算", "v0.3.55"),
    c!("POST", "/api/items/{id}/undelete", "还原只还原同一批", "先单独删了子项 X,后来删了整个父目录",
       "还原父目录", "父目录与随它一起删的项回来;★X 仍在回收站★(按 deleted_at 当批次号)", "v0.3.55"),
    c!("POST", "/api/items/{id}/undelete", "还原连带上级目录", "被删项的父目录也在回收站", "还原该项",
       "祖先链一起还原;★不是挪到项目根★(用户纠正过)", "v0.3.55"),
    c!(deny "DELETE", "/api/items/{id}/purge", "purge 不能跳过软删除", "目标**不在**回收站(deleted_at IS NULL)",
       "DELETE .../purge", "★拒绝★——否则 purge 成了绕过软删除的直删入口", "v0.3.55"),
    c!("DELETE", "/api/items/{id}/purge", "purge 按引用计数清对象", "两个条目引用同一 blob,purge 其中一个",
       "DELETE .../purge", "行没了,但 ★S3 对象还在★(另一个还引用着);两个都 purge 后对象才删", "v0.3.55"),
    c!(deny "DELETE", "/api/items/{id}/purge", "editor 不能 purge", "我是 editor", "DELETE .../purge", "403", ""),
    c!("GET", "/api/items/{id}/content", "取文档正文", "kind=doc", "GET .../content", "200,markdown 正文", ""),
    c!("PUT", "/api/items/{id}/content", "保存文档", "我是 editor", "PUT {text:'...',label:'改了标题'}",
       "200,版本历史多一条", ""),
    c!("PUT", "/api/items/{id}/content", "同内容重复保存是 no-op", "正文未变", "再 PUT 一次相同 text",
       "★不新增版本★(同 sha 判定),否则版本历史会被无意义快照淹没", ""),
    c!("GET", "/api/items/{id}/versions", "版本历史", "文档改过 3 次", "GET .../versions", "200,3 条", ""),
    c!("POST", "/api/items/{id}/restore/{version_id}", "恢复历史版本前先快照",
       "当前是 v3,恢复到 v1", "POST .../restore/{v1}", "正文变回 v1;★历史里多出一条 v3 的快照★(恢复不丢当前)", ""),
    c!("GET", "/api/items/{id}/progress", "读我的播放进度", "我看过一半", "GET .../progress", "200,position_sec", ""),
    c!("PUT", "/api/items/{id}/progress", "进度是每人一份", "我与他各看到不同位置", "各自 PUT 再各自 GET",
       "两人各自读回自己的 position_sec,互不覆盖(主键是 条目+用户,不是条目)", ""),
    c!("POST", "/api/projects/{id}/upload", "带 meeting_id 上传即会议材料", "会议关联本项目",
       "POST .../upload?meeting_id=M&is_recording=true",
       "200;该条目出现在 GET /api/meetings/M/items 的**录制** tab 里,不出现在材料 tab", "D5/D10"),
    c!("POST", "/api/projects/{id}/upload", "流式上传大文件", "我是 editor", "multipart 传 1GiB",
       "200;★内存占用不随文件大小增长★(流式,不落整文件到内存/磁盘)", "v0.3.0"),
    c!(deny "POST", "/api/projects/{id}/upload", "超配额拒绝", "项目配额 10GiB 已用 9.9GiB", "传 1GiB",
       "拒绝并给出可读原因(配额是真闸,单文件大小不设限)", "P1"),
    c!("GET", "/api/items/{id}/download", "下载原件", "我是 editor", "GET .../download", "200,字节与上传一致", ""),
    c!(deny "GET", "/api/items/{id}/download", "viewer 在禁下载项目里拿不到原件", "项目 no_download=true,我是 viewer",
       "GET .../download", "403", "P3"),

    // ══════════ 大文件直传 ══════════
    c!("POST", "/api/projects/{id}/media/begin", "开直传签全部分片", "我是 editor", "POST {name,size,mime,sha256}",
       "200,回 upload_id 与各 part 的预签名 URL;S3_PUBLIC_ENDPOINT 未配时回 501 让前端回退代理", "P2"),
    c!("POST", "/api/projects/{id}/media/begin", "带指纹认领断点", "我 1h 前传到一半同一个文件(fp 相同)",
       "POST {fp:相同指纹,...}", "★认领旧 upload_id★,只回缺失分片的 URL;\
        ★key 必须从 items.upload_key 读回★,别按 projects/{pid}/{iid}/blob 现拼(内容寻址后拼出来的对不上)", "v0.3.33/v0.3.55"),
    c!("PUT", "/api/items/{id}/media/part", "预签名不可用时代理分片", "S3_PUBLIC_ENDPOINT 未配", "PUT 分片字节",
       "200 回 ETag;这条是回退路径,平时不走", "P2"),
    c!("POST", "/api/items/{id}/media/complete", "完成直传要对账", "各分片已传完", "POST {parts}",
       "200;★分片清单以服务端 ListParts 为准★(续传时前端手里没有旧片的 ETag);\
        申报大小与实际不符要拒;完成后复核配额;后台异步核验 sha", "v0.3.33"),
    c!("POST", "/api/items/{id}/media/abort", "只有主动取消才 abort", "传了一半", "POST .../abort",
       "S3 multipart 被 abort,断点一并删除;★上传失败时前端不得调它★(会把断点删掉,续传就没了)", "v0.3.33"),
    c!("GET", "/api/items/{id}/play", "播放 302 到预签名", "kind=video,我是 viewer", "GET .../play",
       "302 到预签名 GET,支持 Range 拖动", "P2"),
    c!(deny "GET", "/api/items/{id}/play", "非视频不给播放地址", "kind=file(一个 zip)", "GET .../play",
       "★拒绝★——否则 play 成了绕过 download 禁令的取原件通道", "P2"),

    // ══════════ 转写与纪要 ══════════
    c!("POST", "/api/items/{id}/analyze", "排转写任务且幂等", "视频已传完", "连调两次 analyze",
       "只排一个任务,不重复跑", "VIDEO-SUMMARY P1"),
    c!("POST", "/api/items/{id}/analyze", "ASR 未配置时不排队", "环境未注入 ASR 端点", "POST .../analyze",
       "★不入队★并说明原因(排了就是攒一堆必败任务)", "VIDEO-SUMMARY P1"),
    c!("GET", "/api/items/{id}/analysis", "取转写与 AI 参考稿", "任务已完成", "GET .../analysis",
       "200,含转写文本与纪要草稿;★AI 产物只是原材料,不是最终纪要★", "D14"),
    c!("GET", "/api/items/{id}/subtitles.vtt", "字幕可被 video 直接吃", "转写完成", "GET .../subtitles.vtt",
       "200,合法 WebVTT;时间轴与音频对齐(realign 走字级时间戳)", "v0.3.57"),

    // ══════════ 公开分享(管理面)══════════
    c!("GET", "/api/items/{id}/shares", "列本项的分享链接", "我是 editor", "GET .../shares", "200", ""),
    c!("POST", "/api/items/{id}/shares", "建公开链接", "我是 editor",
       "POST {code:'1234',expires_days:7,max_visits:100,allow_download:true}",
       "200,回 token 与★仅此一次★的明文提取码(库里存加盐 sha256)", "v0.3.36"),
    c!(deny "POST", "/api/items/{id}/shares", "viewer 不能建分享", "我是 viewer", "POST .../shares",
       "403;★这是唯一绕过项目成员身份的入口,门槛必须 ≥editor★", "v0.3.36"),
    c!("GET", "/api/shares/mine", "只列我自己创建的", "我与他各建过链接", "GET /api/shares/mine",
       "只回我的;★看不到他的★", "v0.3.55"),
    c!("GET", "/api/shares/mine", "状态是算出来的", "一条已过期、一条内容进了回收站", "GET /api/shares/mine",
       "分别显示「已过期」「内容已删除」;★不能把已 404 的显示成「有效」★", "v0.3.55"),
    c!("DELETE", "/api/shares/{token}", "创建者撤销自己的链接", "我建的", "DELETE", "200,立刻 404", ""),
    c!(deny "DELETE", "/api/shares/{token}", "撤别人的要 admin", "他建的,我是 editor", "DELETE", "403", ""),

    // ══════════ 公开分享(访客面,不需登录)══════════
    c!("GET", "/pub/share/{token}", "只回要不要提取码", "链接有效", "GET /pub/share/{token}",
       "200 {needs_code};★不泄露内容名与项目名★(输码之前什么都不该知道)", "v0.3.36"),
    c!(deny "GET", "/pub/share/{token}", "四种失效一律 404 不区分", "分别构造:不存在/已过期/超次数/已撤销",
       "四次 GET", "★四次都是 404 且响应体一致★——区分原因就等于给探测工具发信号", "v0.3.36"),
    c!("POST", "/pub/share/{token}/open", "输对码发短命票", "有提取码的链接", "POST {code:'1234'}",
       "200,回 2h 票;访问计数 +1;★票的签名密钥与会话 cookie 域分隔★", "v0.3.36"),
    c!(deny "POST", "/pub/share/{token}/open", "错码 20 次即限速", "同一 IP 段连错 20 次", "第 21 次 POST",
       "★限速拒绝★,且前端要**原样透出**这句(改写成「提取码不对」会让人一直试)", "v0.3.55"),
    c!("GET", "/pub/share/{token}/list", "逛分享的子目录", "分享的是文件夹", "GET .../list?k=票&parent=X",
       "200;★逐项验「是被分享项之一或其后代」★,不能拿票列到分享范围外", "v0.3.36"),
    c!(deny "GET", "/pub/share/{token}/list", "无票或票过期", "不带 k / 带 2h 前签发的票", "GET .../list",
       "401/404,不回任何条目;★票过期后必须重新输提取码★(否则一张票等于永久通行证)", "v0.3.36"),
    c!("GET", "/pub/share/{token}/file/{item_id}", "取内容走服务端转发", "票有效", "GET .../file/{id}?k=票",
       "200;★流式转发,不把对象存储地址暴露给访客★", "v0.3.36"),
    c!(deny "GET", "/pub/share/{token}/file/{item_id}", "回收站里的内容下不到", "该内容已被软删除",
       "GET .../file/{id}?k=票", "★404★——「删进回收站的材料,墙外照样下得到」正是 v0.3.55 补的 11 处漏洞", "v0.3.55"),
    c!(deny "GET", "/pub/share/{token}/file/{item_id}", "禁下载的分享只能看不能取原件",
       "allow_download=false", "GET .../file/{id}(不带 inline)", "403;\
        但带 inline=1 的预览仍 200(禁的是取原件,不是禁看)——两者都要断言,只测一半会把开关做成一刀切", "v0.3.36"),

    // ══════════ 超管 ══════════
    c!("GET", "/api/admin/users", "超管看全部用户", "我是超管", "GET /api/admin/users", "200", ""),
    c!(deny "GET", "/api/admin/users", "非超管 403 不是 401", "我已登录但非超管", "GET /api/admin/users",
       "★403★(401 会让前端以为要重新登录)", ""),
    c!("PUT", "/api/admin/users/{username}/super", "设与撤超管位", "我是超管", "PUT {is_super:true}",
       "200;★撤销后对方的现存会话应立即失去超管能力★(以库为准,不信 cookie 快照)", "2026-08-04 审计"),
    c!("PUT", "/api/admin/projects/{id}/quota", "调项目配额", "我是超管", "PUT {quota_bytes:21474836480}",
       "200,新配额生效", "P1"),
    c!("GET", "/api/admin/audit", "全局审计可筛", "有多条审计", "GET /api/admin/audit?actor=x&limit=50",
       "200,按 actor 过滤;★敏感动作(建分享/移出成员/purge/改超管)都必须有记录★", ""),

    // ══════════ 开发者 ══════════
    c!("GET", "/api/_dev/apis", "开发者页面数据源", "我是超管", "GET /api/_dev/apis",
       "200,count 与 apis 一致;★与实际路由表逐条相符★(由 apidoc.rs 的测试保证)", ""),
    c!(deny "GET", "/api/_dev/apis", "非超管看不到接口清单", "我已登录但非超管", "GET /api/_dev/apis",
       "403;清单本身暴露系统结构", ""),
    c!("GET", "/api/_dev/openapi.json", "契约由 APIS 生成,不会漂", "我是超管", "GET /api/_dev/openapi.json",
       "200,openapi=3.1.0;★paths 数量与去重后的 APIS 路径数一致★——它是生成的不是手写的,\
        所以「契约落后于实现」这件事在结构上不可能发生", "IAH 规范相位4"),
    c!(deny "GET", "/api/_dev/openapi.json", "非超管拿不到契约", "我已登录但非超管",
       "GET /api/_dev/openapi.json", "403;契约等同系统结构图", ""),

    // ══════════ 越权用例(档位不够)══════════
    // 上面各组里的 deny 用例测的是**业务规则**(purge 不在回收站、play 只对 video、移人连带撤链接…);
    // 这一块测的是**权限档位**,机械但不能省——perm.rs 是唯一推导,可某个 handler 忘了调它就是个洞。
    //
    // ★两种拒绝码的语义必须分清★(perm.rs 的既定性质,用例要把它钉住):
    //   · **完全没有授权** → ★404★:连"这个项目/条目存在"都不该让他知道(403 会变成存在性探测器);
    //   · **有授权但档位不够**(viewer 想写)→ ★403★:他本来就知道它存在,给 404 反而误导。
    c!(deny "GET", "/api/users", "未登录搜不了用户", "无 cookie 无 Bearer", "GET /api/users?q=a", "401", ""),
    c!(deny "GET", "/api/projects", "未登录取不到项目列表", "无会话", "GET /api/projects", "401", ""),
    c!(deny "GET", "/api/projects/{id}/members", "非成员看不到成员名单", "我不是该项目成员",
       "GET .../members", "★404 不是 403★;成员名单本身就是敏感信息", "D3"),
    c!(deny "DELETE", "/api/projects/{id}/members", "editor 不能移出成员", "我是 editor",
       "DELETE {username:'x'}", "403", ""),
    c!(deny "GET", "/api/projects/{id}/diagnose", "viewer 不能做权限诊断", "我是 viewer",
       "GET .../diagnose?username=x", "403;诊断会吐出别人的授权情况", ""),
    c!(deny "GET", "/api/projects/{id}/items", "非成员看不到内容树", "我不是成员", "GET .../items", "404", "D3"),
    c!(deny "POST", "/api/projects/{id}/precheck", "viewer 不能预检秒传", "我是 viewer",
       "POST {sha256:S}", "403;★否则 viewer 可拿它当「某内容存不存在」的探测器★", "v0.3.55"),
    c!(deny "GET", "/api/projects/{id}/trash", "viewer 看不到回收站", "我是 viewer", "GET .../trash", "403", ""),
    c!(deny "DELETE", "/api/items/{id}", "viewer 不能删", "我是 viewer", "DELETE /api/items/{id}", "403", ""),
    c!(deny "POST", "/api/items/{id}/undelete", "viewer 不能还原", "我是 viewer", "POST .../undelete", "403", ""),
    c!(deny "GET", "/api/items/{id}/content", "非成员读不到正文", "我不是该项目成员", "GET .../content", "404", "D3"),
    c!(deny "PUT", "/api/items/{id}/content", "viewer 不能改正文", "我是 viewer", "PUT {text:'篡改'}", "403", ""),
    c!(deny "GET", "/api/items/{id}/versions", "非成员看不到版本历史", "我不是成员", "GET .../versions", "404", "D3"),
    c!(deny "POST", "/api/items/{id}/restore/{version_id}", "viewer 不能恢复版本", "我是 viewer",
       "POST .../restore/{vid}", "403", ""),
    c!(deny "GET", "/api/items/{id}/progress", "非成员读不到进度", "我不是成员", "GET .../progress", "404", "D3"),
    c!(deny "PUT", "/api/items/{id}/progress", "非成员写不了进度", "我不是成员", "PUT {position_sec:10}", "404", "D3"),
    c!(deny "POST", "/api/projects/{id}/media/begin", "viewer 不能开直传", "我是 viewer",
       "POST {name,size}", "403;★这里漏了等于绕开上传权限★(直传不经 /upload)", "P2"),
    c!(deny "PUT", "/api/items/{id}/media/part", "viewer 不能传分片", "我是 viewer", "PUT 分片字节", "403", "P2"),
    c!(deny "POST", "/api/items/{id}/media/complete", "不能完成别人的上传", "该上传由他发起,我是本项目 editor",
       "POST {parts}", "拒绝;★发起者之外不得 complete★,否则可劫持他人半截上传", "P2"),
    c!(deny "POST", "/api/items/{id}/media/abort", "viewer 不能中止上传", "我是 viewer", "POST .../abort", "403", "P2"),
    c!(deny "POST", "/api/items/{id}/analyze", "viewer 不能排转写任务", "我是 viewer", "POST .../analyze",
       "403;转写要烧 GPU,不能让只读的人排队", ""),
    c!(deny "GET", "/api/items/{id}/analysis", "非成员看不到转写", "我不是成员", "GET .../analysis",
       "404;★转写正文等同会议内容★", "D3"),
    c!(deny "GET", "/api/items/{id}/subtitles.vtt", "非成员拿不到字幕", "我不是成员", "GET .../subtitles.vtt",
       "404;字幕就是全文,不能比正文松", "D3"),
    c!(deny "GET", "/api/items/{id}/shares", "viewer 看不到分享链接列表", "我是 viewer", "GET .../shares",
       "403;链接列表里的 token 等同凭据", "v0.3.36"),
    c!(deny "GET", "/api/shares/mine", "未登录取不到我的分享", "无会话", "GET /api/shares/mine", "401", ""),
    c!(deny "PUT", "/api/admin/users/{username}/super", "非超管不能提超管", "我已登录但非超管",
       "PUT {is_super:true}", "403;★这条是提权路径,最该盯★", ""),
    c!(deny "PUT", "/api/admin/projects/{id}/quota", "项目 admin 也不能自己调配额", "我是项目 admin 但非超管",
       "PUT {quota_bytes:大数}", "403;配额是平台资源,不能自助", "P1"),
    c!(deny "GET", "/api/admin/audit", "非超管读不了全局审计", "我已登录但非超管", "GET /api/admin/audit",
       "403;审计日志跨项目,含他人动作", ""),
];

/// 用例覆盖到的 (方法, 路径) 集合。
fn covered() -> BTreeSet<(&'static str, &'static str)> {
    CASES.iter().map(|c| (c.method, c.path)).collect()
}

/// ★每个接口都必须有用例★——用户 2026-08-06 明确要求「每个接口都要有测试用例,根据需求文档来」。
/// 加了接口忘了写用例,在这里红。
#[test]
fn 每个接口都有测试用例() {
    let cov = covered();
    let missing: Vec<String> = APIS
        .iter()
        .filter(|a| !cov.contains(&(a.method, a.path)))
        .map(|a| format!("{} {}", a.method, a.path))
        .collect();
    assert!(missing.is_empty(), "这些接口还没有测试用例(每个接口至少一条):\n  {}", missing.join("\n  "));
}

/// 反向:用例不能指向一个不存在的接口(改路径时忘了同步改用例,或者手抖打错)。
#[test]
fn 用例指向的接口必须存在() {
    let known: BTreeSet<(&str, &str)> = APIS.iter().map(|a| (a.method, a.path)).collect();
    let ghosts: Vec<String> = CASES
        .iter()
        .filter(|c| !known.contains(&(c.method, c.path)))
        .map(|c| format!("{} {} —— 用例「{}」", c.method, c.path, c.name))
        .collect();
    assert!(ghosts.is_empty(), "这些用例指向不存在的接口:\n  {}", ghosts.join("\n  "));
}

/// ★只测「能用」不测「不该能用」等于没测权限★。
/// 需要身份的接口(auth 不是「开放」)必须至少有一条 denial 用例——权限 bug 全藏在负面路径里。
#[test]
fn 需要权限的接口必须有越权用例() {
    let denied: BTreeSet<(&str, &str)> =
        CASES.iter().filter(|c| c.denial).map(|c| (c.method, c.path)).collect();
    let naked: Vec<String> = APIS
        .iter()
        .filter(|a| a.auth != "开放")
        .filter(|a| !denied.contains(&(a.method, a.path)))
        .map(|a| format!("{} {}(需要:{})", a.method, a.path, a.auth))
        .collect();
    assert!(naked.is_empty(), "这些接口只有正面用例,缺「权限不够时应被拒」的用例:\n  {}", naked.join("\n  "));
}

/// 用例本身要写得能照抄成脚本:期望必须具体(带状态码或可观测事实),不许写"验证正常"这类废话。
/// ⚠ 判据别用长度:`"403"` 只有三个字符却**足够具体**(第一版拿 len<6 筛,把一堆纯状态码用例误判了)。
/// 真正的判据是:**要么给出三位状态码,要么把可观测的事实说出来**。
#[test]
fn 用例的期望必须具体() {
    let has_code = |s: &str| {
        s.as_bytes()
            .windows(3)
            .any(|w| w[0].is_ascii_digit() && (b'1'..=b'5').contains(&w[0]) && w[1].is_ascii_digit() && w[2].is_ascii_digit())
    };
    let vague: Vec<&str> = CASES
        .iter()
        .filter(|c| {
            let t = c.then.trim();
            t.is_empty()
                || t.contains("正常")
                || t.contains("符合预期")
                || (!has_code(t) && t.chars().count() < 8)
        })
        .map(|c| c.name)
        .collect();
    assert!(vague.is_empty(), "这些用例的期望写得太虚,照着写不出断言:{vague:?}");
}

/// 字段不能留空(除 rule:常规 CRUD 允许没有专门条款)。
#[test]
fn 用例字段不能留空() {
    for c in CASES {
        assert!(!c.name.trim().is_empty(), "用例缺名字:{} {}", c.method, c.path);
        assert!(!c.given.trim().is_empty(), "用例「{}」缺前置状态", c.name);
        assert!(!c.when.trim().is_empty(), "用例「{}」缺动作", c.name);
    }
}

/// rule 条款号写了就得写对格式——顺带**读一下 `rule` 字段**(否则它是死代码,clippy 门禁会红)。
/// 只校验格式(`D` 后必须跟数字,可带 `/R1` 这类附注),★不校验范围★:决策条数随 PRD 会增(现已到 D17),
/// 「D 到几」交给 PRD 评审,这里只挡「D」后没跟数字的手抖,别拿测试替产品负责人拍范围。
#[test]
fn 条款号格式写对() {
    let bad: Vec<&str> = CASES.iter().map(|c| c.rule)
        .filter(|r| r.starts_with('D') && !r.trim_start_matches('D').chars().next().is_some_and(|ch| ch.is_ascii_digit()))
        .collect();
    assert!(bad.is_empty(), "这些 rule 条款号格式不对(应为 D<数字>):{bad:?}");
}
