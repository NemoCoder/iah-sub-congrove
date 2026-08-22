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
    c!("GET", "/version", "后端自报版本", "服务已启动", "GET /version",
       "200 且 {\"version\":\"x.y.z\"} 等于 Cargo.toml 的 version;★免鉴权★——\
        不带任何 token 也要能拿到(要 token 才能量的闸,在 CI 里会退化成「没配就跳过」= 假绿)", ""),

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
    // ── 我的配额与偏好（ADR-0004）──────────────────────────────────────────
    c!("GET", "/api/me/quota", "看自己的额度与已用量", "已登录", "GET /api/me/quota",
       "200;★used 是**我名下所有项目**之和★,不是我上传的东西(材料归项目、额度归主持人)", "L3"),
    c!(deny "GET", "/api/me/quota", "未登录看不到", "没有会话", "GET /api/me/quota", "401", "L3"),
    c!("GET", "/api/me/prefs", "没设过偏好时回 null", "user_prefs 里没有我的行",
       "GET /api/me/prefs", "200 且 timezone=null;★不回默认值★(E0:服务端不猜时区)", "E0"),
    c!(deny "GET", "/api/me/prefs", "未登录看不到", "没有会话", "GET /api/me/prefs", "401", "E0"),
    c!("PUT", "/api/me/prefs", "改自己的偏好(upsert)", "已登录",
       "PUT /api/me/prefs {timezone:'Asia/Shanghai'}", "200;★没传的字段保留★,PUT 半个对象不清空另一半", "E0"),
    c!(deny "PUT", "/api/me/prefs", "未登录改不了", "没有会话", "PUT /api/me/prefs", "401", "E0"),
    // ── 活动类型（ADR-0002）────────────────────────────────────────────────
    c!("GET", "/api/activity-types", "看得到预置的 + 我自建的", "已登录",
       "GET /api/activity-types", "200;★含预置「会议」「个人日程」★;不含别人自建的", "A2"),
    c!(deny "GET", "/api/activity-types", "未登录看不到", "没有会话",
       "GET /api/activity-types", "401", "A2"),
    c!("POST", "/api/activity-types", "自建一个类型", "已登录",
       "POST /api/activity-types {name:'读书会',busy_default:false}",
       "200;★has_minutes/needs_project 恒 false★(系统语义不给用户改,A3)", "A2"),
    c!(deny "POST", "/api/activity-types", "重名建不了", "已存在同名(预置的也算)",
       "POST /api/activity-types {name:'会议'}", "400 且是人话,不是数据库错误", "A2"),
    c!("PUT", "/api/activity-types/{id}", "改自己建的", "我是 owner",
       "PUT /api/activity-types/{id} {name:'读书分享'}", "200", "A2"),
    c!(deny "PUT", "/api/activity-types/{id}", "★预置的不能改★", "id 是预置行(owner IS NULL)",
       "PUT /api/activity-types/{id}", "400;★超管也不行★(它是全平台活动的语义底座)", "A2"),
    c!(deny "PUT", "/api/activity-types/{id}", "改不了别人建的", "owner 是别人",
       "PUT /api/activity-types/{id}", "403", "A2"),
    c!("DELETE", "/api/activity-types/{id}", "★软删★", "我是 owner",
       "DELETE /api/activity-types/{id}",
       "200;★新建活动挑不到它,但历史活动照常显示类型名★(type_id 是 NOT NULL 外键,硬删=历史失名)", "L1"),
    c!(deny "DELETE", "/api/activity-types/{id}", "预置的不能删", "id 是预置行",
       "DELETE /api/activity-types/{id}", "400", "L1"),
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
    c!("DELETE", "/api/projects/{id}/members", "离开即失去全部含他参与过的活动", "他参加过本项目 3 场活动",
       "移出后以他的身份查这 3 场", "全部不可见;★不得因「他当时参加过」而保留可见性★(那是历史累积模型)", "D3"),
    // 转移主持人:★发起 ≠ 生效★(PRD ⑨.5,docs/TECH-DESIGN-M1-owner-transfer.md)。
    // 这一组钉的是「什么时候 owner 才真的变」——早一步变,项目在空档期无主;晚一步变,交接不算数。
    c!("POST", "/api/projects/{id}/transfer", "★发起后 owner 先不变★", "我是 owner,目标是本项目成员",
       "POST {to:'他'}", "200 + transfer_id;★projects.owner 仍是我★(T1)——发起即卸任会让项目在\
        「对方还没点」的整段时间里没人能加人、没人能改设置,而他可能永远不点", ""),
    c!("POST", "/api/projects/{id}/transfer", "同一项目只能有一条 pending", "已经发起过一条还没答复",
       "POST {to:'另一个人'}", "400「已有一条待答复的转移」——★由库里的部分唯一索引堵死★,\
        不是先查后插(那中间有窗口);并发两条会造成两个人都以为自己接手了", ""),
    c!(deny "POST", "/api/projects/{id}/transfer", "归档项目不能发起转移", "项目已归档",
       "POST {to:'他'}", "400——归档 = 只读存档(D17)", "D17"),
    c!("POST", "/api/projects/{id}/transfer/respond", "★接受这一刻 owner 才变★", "我是被转让人",
       "POST {accept:true}", "200,owner=我;★原主持人保留 admin★(T4:交棒不是逐出,他通常还要继续参与)", ""),
    c!("POST", "/api/projects/{id}/transfer/respond", "拒绝则 owner 不变且原主持人收到信", "我是被转让人",
       "POST {accept:false}", "200,owner 不变;发起人收到「转移主持人被拒绝」——\
        ★不说他不会知道★,请求会静静躺在那里", ""),
    c!(deny "POST", "/api/projects/{id}/transfer/respond", "★接受前离开项目则接不了★",
       "转移发起后我被移出了项目", "POST {accept:true}",
       "400 且 owner 不变 —— 权限是「当前成员身份的函数」(D3),不信发起那一刻的快照(T5)", "D3"),
    c!(deny "POST", "/api/projects/{id}/transfer/respond", "别人替我答复不行", "我不是被转让人",
       "POST {accept:true}", "403 —— 接受主持人是本人才能做的决定", ""),
    c!("POST", "/api/projects/{id}/transfer/respond", "归档项目的 pending 仍可接受", "转移发起后项目被归档",
       "POST {accept:true}", "200 —— ★否则归档会把请求永久卡死★:发起人已不能撤回(归档只读),\
        被转让人也接不了(T6)", "D17"),
    c!("DELETE", "/api/projects/{id}/transfer", "撤回", "我是发起人,对方还没答复",
       "DELETE .../transfer", "200,该条转为 canceled;对方收到「已撤回」——\
        ★不通知的话他点进去发现按钮没了,会以为是坏了★", ""),
    c!(deny "DELETE", "/api/projects/{id}/transfer", "没有待撤回的转移", "从没发起过",
       "DELETE .../transfer", "400", ""),
    c!(deny "POST", "/api/projects/{id}/transfer", "不能转给非成员", "我是 owner,目标不是成员",
       "POST {to:'外人'}", "400/422 拒绝;★否则他接受的瞬间成了一个自己都进不去的项目的主持人★(T3)", "D0"),
    c!(deny "POST", "/api/projects/{id}/transfer", "admin 不能转移主持人", "我是 admin 非 owner", "POST {to:'x'}", "403", "D0"),
    // ★谁挡着归档★(2026-08-14):liaoruili「你要直接弹出来要取消的项目列表,然后一键取消」——
    // 界面靠这条接口把挡路的活动全列出来,再一键取消并归档。
    c!("GET", "/api/projects/{id}/archive-blockers", "列出挡着归档的活动,并标出我能不能取消",
       "项目里有 2 场未开始的活动:一场我发起、一场别人发起",
       "GET .../archive-blockers",
       "200,total=2,两条都在 items 里;★我发起的那条 can_cancel=true、别人那条 false★ ——\
        界面靠它把「我取消不了的」标灰,不然批量取消会默不作声地跳过它们", "D17"),
    c!("GET", "/api/projects/{id}/archive-blockers", "★判据必须和 archive 完全一致★",
       "项目里只有**已开始**的活动",
       "GET .../archive-blockers,再 POST .../archive",
       "blockers 回 total=0,archive 回 200 —— ★两处 WHERE 一旦漂移,就会出现\
        「清单说没有挡路的、点下去照样被拒」这种最难查的错★", "D17"),
    c!(deny "GET", "/api/projects/{id}/archive-blockers", "不是主持人就不给看",
       "我是这个项目的 editor,不是主持人", "GET .../archive-blockers", "403", "D17"),
    c!("POST", "/api/projects/{id}/archive", "归档后变只读", "我是 owner,项目里有材料",
       "POST {} 归档,再试上传/建活动/改名",
       "归档 200;之后写操作一律 ★409★(不是 403)——语义是「项目结束了」不是「你没权限」,\
        同一个人换个项目就能做", "D17"),
    c!("POST", "/api/projects/{id}/archive", "★归档后仍能读和下载★", "项目已归档",
       "GET items / content / download",
       "全部 200 —— ★归档就是为了以后还能查★,查得到却拿不走等于没存", "D17"),
    c!("POST", "/api/projects/{id}/archive", "恢复为进行中", "项目已归档,我是 owner",
       "POST {archived:false}", "200,archived_at 置空;之后同一个上传请求由 409 变 200。\
        ★这条接口走 require_owner 不走 require_role★——后者对归档项目拒绝一切写操作,\
        那样归档之后就再也解不开了(自锁)", "D17"),
    c!("POST", "/api/projects/{id}/archive", "归档项目的会不进日历、不产生忙闲", "归档一个有活动的公开项目",
       "GET /api/activities 与 /api/freebusy",
       "两者都不含它的会;★但项目页里仍查得到★——日历回答「接下来做什么」,历史归历史", "D17"),
    c!(deny "POST", "/api/projects/{id}/archive", "admin 不能归档", "我是 admin 但不是 owner",
       "POST {}", "403;归档影响所有成员能否继续写,与删项目同档", "D17"),
    c!("GET", "/api/projects/{id}/diagnose", "诊断判定链与 perm.rs 同源", "查某成员", "GET .../diagnose?username=x",
       "200,回「超管?」「成员表里什么角色?」两段;★结论必须与实际判权一致★(两处推导分家就是骗人)", "D12"),

    // ══════════ 活动与日程(M1)══════════
    // ★这一组的主线:活动参与 ≠ 资料权限★。每条负面用例都在钉这条线。
    c!("GET", "/api/activities", "列我参与的与我项目的会", "我是 A 会参会人、B 会所属项目的成员",
       "GET /api/activities", "200,含 A 与 B", "D7"),
    c!("GET", "/api/activities", "public 活动不进我的列表", "存在一场与我无关的 public 活动",
       "GET /api/activities", "★不含它★——列表是我的日程,不是全平台公告板(旁听靠拿 id 看详情)", "D9"),
    c!(deny "GET", "/api/activities", "未登录取不到日程", "无会话", "GET /api/activities", "401", ""),
    c!("POST", "/api/activities", "建活动", "我在项目 P 是 editor",
       "POST {title,recorder,starts_at,ends_at,project_ids:[P]}",
       "200 回 id;★发起人自动 accepted、记录员自动进名单★(发起人不用对自己定的时间再答复一次)", "D14"),
    c!(deny "POST", "/api/activities", "不关联项目就不让建", "类型是「会议」(needs_project=true),我是某项目 editor",
       "POST {project_ids:[]}", "400;材料权限来自项目成员身份(D3)。\
        ⚠★只对 needs_project 的类型★(ADR-0002):「个人日程」本来就是零关联项目,\
        它的材料落发起人的材料区(J0)", "D3"),
    c!(deny "POST", "/api/activities", "★会议只能排未来★", "类型是「会议」(allow_past=false)",
       "POST {starts_at: 昨天}", "400 —— 判据是**类型的能力位**不是全局规则(F0,2026-08-09 liaoruili:\
        「会议类型的活动只能发起未来的会议,其他类型可以后面补录」);留 5 分钟容差,\
        免得填完议程提交时那个整点刚过就白填一轮", "F0"),
    c!("POST", "/api/activities", "★其他类型可以补录★", "类型是「个人日程」(allow_past=true)",
       "POST {starts_at: 上个月}", "200 —— 「昨天下午改论文改了 3 小时」是正当的补录;\
        在此之前「不能排过去」是写死的全局规则,这种活动根本建不出来", "F0"),
    c!(deny "POST", "/api/activities", "不填记录员不让建", "参数其余齐全", "POST {recorder:''}",
       "400;纪要由记录员按模板整理,AI 转写只是原材料", "D14"),
    c!(deny "POST", "/api/activities", "多项目关联要逐个验权", "P1 我是 editor,P2 我不是成员",
       "POST {project_ids:[P1,P2]}", "★拒绝★——只验第一个的话,漏验的那个就是越权入口", "D4"),
    c!("GET", "/api/activities/{id}", "参会人看到完整详情", "我是参会人", "GET /api/activities/{id}",
       "200,含参会名单与关联项目", ""),
    c!("GET", "/api/activities/{id}", "旁听者只拿到裁剪版", "活动 public,我与它毫无关系",
       "GET /api/activities/{id}",
       "200 但★只有标题/议程/时间/地点/链接★,无 participants、无 organizer/recorder,observer:true", "D9"),
    c!(deny "GET", "/api/activities/{id}", "private 活动对无关的人不存在", "活动 private,我不是参会人也不是关联项目成员",
       "GET /api/activities/{id}", "★404 不是 403★(private=仅被邀请者知道这个会存在)", "D9"),
    c!("PUT", "/api/activities/{id}", "改时间要把答复清回 pending", "3 人已 accepted",
       "PUT {starts_at:新时间}", "200;★那 3 人变回 pending★——旧的「接受」是对旧时间说的,留着等于替人答应", ""),
    c!("PUT", "/api/activities/{id}", "改线上链接留痕", "已有 online_url", "PUT {online_url:'新链接'}",
       "200 且 activity_link_history 多一条(谁何时改成什么);开会前十分钟改链接是真实场景", ""),
    c!(deny "PUT", "/api/activities/{id}", "参会人改不了别人的会", "我是参会人,不是发起人也不是记录员",
       "PUT {title:'篡改'}", "403;★也不是「关联项目的 admin 就能改」★——一场会可关联多个项目,那样太宽", ""),
    c!("DELETE", "/api/activities/{id}", "取消不是删除", "我是发起人", "DELETE /api/activities/{id}",
       "200;★status=canceled 留档而非真删★(谁邀了谁、谁拒了是协作事实);之后不再产生忙闲", ""),
    c!(deny "DELETE", "/api/activities/{id}", "参会人不能取消活动", "我是参会人", "DELETE", "403", ""),
    c!("PUT", "/api/activities/{id}/participants", "批量邀请", "我是发起人",
       "PUT {usernames:['a','b','c']}", "200 invited=3;用户名过平台校验", ""),
    c!("PUT", "/api/activities/{id}/participants", "★邀请恒为 attendee★", "请求里带 kind=guest(老前端)",
       "PUT {usernames:['x'], kind:'guest'}", "200 且他的 kind=**attendee** —— 2026-08-07 推翻 D8 删掉了\
        「临时参会人」:不拿材料的人只剩旁听者,而旁听是**自助**的(走 observe),不从邀请这条路进。\
        ★老前端传上来的 kind 一律忽略而不是报错★:语义上确实只有这一种,报错只会让老页面白挂", ""),
    c!("PUT", "/api/activities/{id}/participants", "非项目成员被邀请照样看不到材料", "邀请一个不在关联项目里的人",
       "以他的身份取材料", "★材料 403/404★——材料按**项目成员身份**判权(D3),\
        「被邀请参会」从来就不给资料权限。这条是 D8 作废后仍然成立的那一半", "D3"),
    c!(deny "PUT", "/api/activities/{id}/participants", "参会人不能拉人", "我是普通参会人",
       "PUT {usernames:['x']}", "403", ""),
    c!(deny "DELETE", "/api/activities/{id}/participants", "不能移出发起人", "我是记录员",
       "DELETE {username:发起人}", "400 拒绝;★移出他就没人改得了这场会★", ""),
    c!("POST", "/api/activities/{id}/respond", "接受邀请", "我在名单里", "POST {status:'accepted'}",
       "200,responded_at 落库", ""),
    c!("POST", "/api/activities/{id}/respond", "建议改期必须带替代时间", "我在名单里,该时段我有私事",
       "POST {status:'counter',counter_starts_at,counter_ends_at,counter_reason}",
       "200;★这是私事冲突唯一的结构化出口★——私密项目的日程对发起人完全隐形,他不知道我忙", "D2"),
    c!(deny "POST", "/api/activities/{id}/respond", "counter 不给时间就拒绝", "我在名单里",
       "POST {status:'counter'}", "400;★只说「我不行」等于把问题丢回给发起人★", "D2"),
    c!(deny "POST", "/api/activities/{id}/respond", "旁听者不能答复", "活动 public,我不在名单里",
       "POST {status:'accepted'}", "403;他看得见这场会,但不能给自己投一票", "D9"),
    c!("GET", "/api/activities/{id}/messages", "读公开讨论", "我是参会人", "GET .../messages", "200", "D13"),
    c!("GET", "/api/activities/{id}/messages", "私聊只看得到我这一对", "我与发起人私聊过,别人也各自私聊过",
       "GET .../messages?channel=private&peer=发起人", "只回我与他的往来,★看不到别人那对★", "D13"),
    c!(deny "GET", "/api/activities/{id}/messages", "旁听者看不到讨论区", "活动 public,我不是参会人",
       "GET .../messages", "403;★D9 给旁听者的是「知道活动存在与议程」,不含听人聊天★", "D9"),
    c!("POST", "/api/activities/{id}/messages", "公开发言", "我是参会人", "POST {body:'我晚十分钟'}", "200 回 id", "D13"),
    c!(deny "POST", "/api/activities/{id}/messages", "私聊对象只限发起人与记录员", "我是参会人",
       "POST {channel:'private',peer:'另一个普通参会人'}",
       "400 拒绝;★不做任意点对点,否则这里会长成一个 IM★", "D13"),
    c!("GET", "/api/activities/{id}/items", "活动材料与录制分开", "活动下有 2 份材料 1 个录屏",
       "GET .../items", "200,3 条;录屏的 is_recording=true —— ★只有它会被转写、并作为活动时长依据★", "D5"),
    // ── 活动粒度的材料策略(PRD 6.3.2)──★与项目级叠加不是覆盖★
    c!(deny "GET", "/api/items/{id}/download", "★活动设了禁下载,连 editor 也下不了★",
       "活动 no_download=true,我是项目 editor", "GET /api/items/{id}/download",
       "400 —— 这一条**对所有角色生效**,不像项目那条只拦 viewer:\
        发起人说「这次不许下载」是对全体说的,把 editor 排除在外这开关基本不起作用\
        (活动材料多半就是 editor 传的)。★在线预览/播放不拦★", ""),
    // ── 两个 2026-08-08 修掉的现存缺陷,各钉一条 ──
    c!(deny "POST", "/api/items/{id}/shares", "★项目级禁分享也要在建链接时拒★",
       "项目 no_share=true,我是 editor", "POST /api/items/{id}/shares",
       "400 —— 此前这道闸**从来没判过**:no_share 只在打开开关那一刻撤销存量链接,\
        之后照样能建新的。★一个开着的开关实际只做了一次性清理★,而设置它的人以为内容出不去了", ""),
    c!("DELETE", "/api/projects/{id}", "★删项目不能删掉别人还在引用的对象★",
       "我和别人各传过同一份文件(内容寻址 → 同一个 blob),我删掉我的项目",
       "DELETE /api/projects/{id} 后,别人那份仍可下载",
       "★内容寻址之后 blobs/<sha> 是全库共享的★:直接 storage.delete 会把别人的文件打空\
        (items 行还在、点开是空的)。走引用计数,refs=0 才删;查不出引用数则**不删**(fail-closed)", ""),

    c!(deny "POST", "/api/items/{id}/shares", "★活动设了禁分享,后端拒绝★",
       "活动 no_share=true,我是 editor", "POST /api/items/{id}/shares",
       "400 —— PRD 6.3.2 验收标准原话「前端隐藏不是安全边界」。\
        分享是全系统**唯一绕过项目授权**的出口,这道闸尤其不能只画在界面上", ""),
    c!("PUT", "/api/activities/{id}", "活动策略与项目策略叠加", "项目禁下载、活动放开",
       "PUT {no_download:false}", "★仍然下不了★——取两者的严格值。反过来做就成了\
        「在活动上开个口子绕过项目策略」,那是权限模型里最容易被利用的缝", ""),
    c!("PUT", "/api/activities/{id}/participants", "标为选参", "邀请时 required=false",
       "PUT {usernames:['x'], required:false}", "200;他的冲突不计入「N 人时间冲突」的红色提示", ""),

    c!(deny "GET", "/api/activities/{id}/items", "★参会但不是项目成员 → 拿不到材料★",
       "我被邀请参会,但不是任何关联项目的成员",
       "GET .../items", "403 —— 他看得见这场会(能参会),但材料按★项目成员身份★判权(D3)。\
        D8 作废后这条不变:变的只是「不拿材料的人」不再单独分一类", "D3"),
    // ── 活动材料的删除(2026-08-09):★只能从活动页删,项目树里是只读区★(D10)──
    c!("DELETE", "/api/activities/{mid}/items/{iid}", "在活动页删掉一份材料",
       "活动下有 1 份材料,我是关联项目的 editor",
       "DELETE /api/activities/{mid}/items/{iid}",
       "200;该材料 deleted_at 非空、进回收站;活动的 items 列表少一条;★活动文件夹本身还在★", "D10"),
    c!(deny "DELETE", "/api/items/{id}", "★活动材料在项目树里删不掉★",
       "项目根下有活动文件夹,里面一份录屏;我是项目 editor",
       "DELETE /api/items/{那份录屏}",
       "400「活动材料请到活动页里删除」——★这条规则以前只写在注释里,handler 里一个判断都没有★\
        (2026-08-09 补);挡在后端而不是靠前端藏按钮,因为后端看不见调用方是哪个页面", "D10"),
    c!(deny "DELETE", "/api/activities/{mid}/items/{iid}", "★不能借 A 活动删 B 活动的材料★",
       "我是 A 活动关联项目的 editor;iid 属于 B 活动",
       "DELETE /api/activities/{A}/items/{B 的材料}",
       "404 —— SQL 里 activity_id 必须同时匹配路径上的 mid;\
        少这一条就是「换个 mid 就能删别人的」这类典型越权", "D10"),
    c!("POST", "/api/projects/{id}/media/begin", "★直传永远不落在规范 key 上★",
       "我申报 sha=H,而 blobs/H 尚不存在", "POST {sha256:H, size, name}",
       "200,但 items.upload_key 是 `uploads/<iid>-<rand>` ——★不是 blobs/H★。\
        原来这里直接拿申报值当 key:占住 blobs/H 塞垃圾,真正拥有那份文件的人后来上传时\
        会被「对象已存在就直接引用」静默引用到垃圾、还打上 sha_verified 继续当秒传源扩散(审计 A2)", "A2"),
    c!("POST", "/api/items/{id}/media/complete", "★归位只在服务端算完真实哈希之后★",
       "直传完成,服务端算出真实哈希 R", "complete 后台 verify_and_promote",
       "s3_key 变成 blobs/<R>、临时对象删掉、sha_verified=true。\
        ★归位失败则停在临时 key 且 sha_verified 保持 false★ —— 文件照常下得到,\
        但不能当秒传源(fail-closed)。大对象走 UploadPartCopy(2026-08-09 实测 Garage 支持)", "A2"),
    c!("POST", "/api/items/{id}/media/complete", "★申报值≠真值要留痕,不能改写成「已核验」★",
       "传输中损坏但字节数没变(complete 只对大小)", "complete 后台核验",
       "sha_declared_mismatch=true,前端提示「建议重传」。\
        原来只 warn 一句然后照样置 sha_verified=true —— ★把强信号改写成了「已核验」★(审计 A2/D3)", "A2"),
    c!(deny "POST", "/api/activities", "★跨度超过 30 天就拒★", "起止差 205 天(月份打错)",
       "POST {starts_at:'8-08', ends_at:'次年 3-01'}",
       "400 带可读文案 —— ★必须在应用层拒★:只靠数据库 CHECK 的话 error.rs 会把它映射成 500\
        「服务器出错了」,而问题其实出在他填的日期上。上界取 30 天不是 365:\
        最常见的手滑是**输错月份**,365 挡不住它(F4)", "F4"),
    c!(deny "PUT", "/api/activities/{id}", "★实际时长不能比跨度还长★", "一小时的会",
       "PUT {actual_minutes: 7200}",
       "400;上界★按这场活动的跨度算★不写死 1440 —— 写死一天的话三天的出差就填不了实际时长(F4)", "F4"),
    c!(deny "POST", "/api/projects/{id}/archive", "★有没开始的活动就不许归档★",
       "项目下有两场未来的活动(未取消)", "POST {archived:true}",
       "400 且★把是哪几场列出来★ —— 跨项目的活动不能静默跳过:\
        A 想归档却卡在一场同时关联 A 和 B 的会上,得让他自己决定(取消它,或把 A 从关联里去掉);\
        静默跳过等于允许「项目归档了、名下还有未来的会」。已取消的不算(B2)", "B2"),
    c!("GET", "/api/activities", "★归档项目的活动照常进日历,只是标出来★",
       "我有一个已归档项目,里面有历史活动", "GET /api/activities?from&to",
       "200 且含那些活动,archived=true → 前端淡化 + 打「已归档 · 只读」。\
        ★这里原来是滤掉的,执行的是一条已被 PRD B0 推翻的决定★(liaoruili:「日程也是我做过什么的记录,\
        看看满日程的很有成就感」);标记是为了让「只读」在点进去之前就可见(B1)", "B0"),
    c!("DELETE", "/api/activities/{id}", "★取消活动时材料区里的材料跟着走★",
       "不关联项目的个人活动,材料在我的材料区", "DELETE /api/activities/{id}",
       "200,材料软删进回收站。★只对材料区成立★:普通项目里的材料是**项目的资产**,\
        不该被一次活动的取消带走;而材料区里每份材料都有主人(某条活动),\
        活动没了还留着的话在 §J0b 的虚拟分组里根本渲染不出来 —— 看不见、删不掉、还占配额(J1b)", "J1b"),
    c!("POST", "/api/activities/{id}/materials-project", "★个人活动也能传材料★",
       "我是发起人,活动零关联项目(类型 needs_project=false)", "POST .../materials-project",
       "200 回 project_id —— 我的「我的活动材料」(没有就现建,kind='materials');\
        ★这条以前只写在 PRD §J0 里,代码里一个字都没有★:于是整类「个人日程」传不了任何东西\
        (2026-08-09 liaoruili 报)", "J0"),
    c!(deny "POST", "/api/activities/{id}/materials-project", "有关联项目就不该走材料区",
       "活动关联了 P1", "POST .../materials-project",
       "400 —— 材料该落项目里(D4);放行的话同一场会的材料会散成两处:\
        一半在项目树、一半在只有发起人看得见的材料区", "D4"),
    c!(deny "POST", "/api/activities/{id}/materials-project", "别人的个人活动不给落点",
       "我是参会人,不是发起人", "POST .../materials-project",
       "403 —— 材料区只有 owner 有角色(ADR-0005 单点否决),这里先说清楚,\
        免得他拿着 pid 去 upload 时收到一个费解的 403", "ADR-0005"),
    c!("PUT", "/api/activities/{mid}/items/{iid}", "活动材料能在活动页改名",
       "我是关联项目的 editor,iid 是这场活动的一份材料", "PUT {name:'第一次组会录屏.mp4'}",
       "200 —— D10 说的是「在**项目树里**只读」,不是永远不可改;\
        改名这个动作发生在活动页,和删除同一条路(2026-08-09 liaoruili)", "D10"),
    c!(deny "PUT", "/api/activities/{mid}/items/{iid}", "★改不了活动文件夹的名字★",
       "iid 是这场活动的材料文件夹本身", "PUT {name:'我想叫这个'}",
       "404(SQL 带 kind <> 'folder')—— 它的名字从活动的日期+标题派生,\
        手改了下次改活动标题又会被覆盖回去,是个假功能", "D10"),
    c!(deny "PUT", "/api/activities/{mid}/items/{iid}", "★不能借 A 活动改 B 活动材料的名★",
       "我是 A 活动关联项目的 editor;iid 属于 B 活动", "PUT /api/activities/{A}/items/{B 的材料}",
       "404 —— activity_id 必须同时匹配路径上的 mid,与删除那条同一个越权形状", "D10"),
    c!("POST", "/api/projects/{id}/upload", "★同名+同哈希=误传两次,不建新行★",
       "同一文件夹里已经有一份同名同内容的", "POST /upload 传同一个文件",
       "200 且响应里 duplicate=true、★items 不多一行★;前端提示「已经在这里了」。\
        盘上本来就只有一份(内容寻址),所以这不是空间问题 —— 是**人分不清哪个是哪个**,\
        「删哪个」变成猜谜(2026-08-09 liaoruili 选的方案 C)", "C"),
    c!("POST", "/api/projects/{id}/upload", "★同名但内容不同=新版本,自动缀序号★",
       "同名文件已存在,内容不一样", "POST /upload",
       "200,落成 `xxx (2).pdf` 两份都留着。★扩展名必须留在最后★:\
        `a.pdf (2)` 会让按扩展名认类型失手,人也认不出它还是个 PDF。判据是纯函数 numbered_name,带单测", "C"),
    c!(deny "POST", "/api/projects/{id}/upload", "★不能往别人的活动里注入材料★",
       "我在自己的项目 P 里是 admin;activity_id 指向一场与 P 无关的活动",
       "POST /api/projects/P/upload?activity_id=<别人的会>",
       "404 —— ★判权判的是路径上的 pid,写的却是参数里的 activity_id,两者必须对账★。\
        少这一句就是:文件出现在别人活动的材料里、署我的名,而对方删不掉也改不了\
        (那两条接口判的是 item 所属项目);带 is_recording 还能改写对方的时长统计。\
        2026-08-09 全量审计 A1", "D10"),
    c!(deny "POST", "/api/projects/{id}/items", "★不能往活动文件夹里塞东西★",
       "parent_id 是某场活动的材料文件夹", "POST {kind:'file',parent_id:<活动文件夹>}",
       "400「这是活动的材料文件夹,只读」—— D10 的**写入方向**。\
        ★守卫只看『被操作项自己』是不够的,父节点那一侧同样是入口★:\
        2026-08-09 先修的是『把材料拿出去』(改名/移动/删除),这条是没修完的另一半(审计 A6)", "D10"),
    c!(deny "PUT", "/api/items/{id}", "★不能把文件移进活动文件夹★",
       "parent_id 是某场活动的材料文件夹", "PUT {parent_id:<活动文件夹>}",
       "400;同上,check_parent 现在会拒绝带 activity_id 的父节点", "D10"),
    c!("PUT", "/api/activity-types/{id}", "★只改占忙闲、不带 name★",
       "预置的「个人日程」或我自建的类型", "PUT {busy_default:false}",
       "200 —— name 必须是 Option。原来它是裸 String,axum 在**进 handler 之前**就 422,\
        于是 A3 说的『自建类型唯一的开关』★从来没工作过★(审计 A4)", "A3"),
    c!("GET", "/api/activities/{id}", "★旁听者拿到的是裁剪版,但外层形状一样★",
       "活动 public,我与它毫无关系", "GET /api/activities/{id}",
       "200 且仍是 {activity:{…}, participants:null, projects:[], can_edit:false, observer:true}。\
        ★裁剪的是内容不是结构★:原来直接吐扁平对象,前端 `d.activity.status` 当场白屏,\
        而 E2E 恰好把契约钉成了扁平、tsc 又认定 activity 必存在 —— 两道闸互相抵消(审计 A3)", "D9"),
    c!(deny "POST", "/api/projects/{id}/upload", "★材料区不收散文件★",
       "pid 是我的「我的活动材料」", "POST /upload(不带 activity_id)",
       "403 —— 材料区在 require_role 的写闸上一律只读(PRD §J1);\
        带 activity_id 的才走 require_material_write 放行。★这条不是清单里的一项,\
        是收口在 require_role 的一道闸★:以后新增的写接口自动被挡", "J1"),
    c!(deny "POST", "/api/projects/{id}/items", "材料区里不能建文件夹/文档",
       "pid 是我的「我的活动材料」", "POST {kind:'folder',name:'x'}",
       "403;§J0b 的那些「文件夹」是活动自己带的,不是人建的", "J1"),
    c!("DELETE", "/api/projects/{id}", "★删项目是软删除,不是硬删★", "我是主持人",
       "DELETE /api/projects/{id}",
       "200 restorable_days=30;projects.deleted_at 置位、★S3 一个字节都不动★、公开链接连带撤销。\
        2026-08-09 之前这里是 `DELETE FROM projects` 一条硬删(FK CASCADE 连录屏一起没),\
        而契约、CLAUDE.md、20+ 处 SQL 过滤都在声称软删 —— ★那一列从没被写过一次★(审计 A5)", "A5"),
    c!(deny "GET", "/api/projects/{id}/items", "★软删的项目对成员也立刻失效★",
       "项目已删进回收站,我还在成员表里", "GET /api/projects/{id}/items",
       "404 —— effective_role 现在对 deleted_at 非空的项目发 BLOCK。\
        ★这条与 A5 必须同一个提交★:原来两条**授权**支都不判 deleted_at(fail-open),\
        单补软删会变成「删进回收站后成员照常读写」+「材料区 BLOCK 消失 → 超管读得到别人的材料区」", "A5b"),
    c!("POST", "/api/projects/{id}/undelete", "主持人能把项目还回来", "项目在回收站里,我是 owner",
       "POST .../undelete", "200,项目回到列表;公开链接不随还原恢复(撤销是终态)", "A5"),
    c!(deny "POST", "/api/projects/{id}/undelete", "不是主持人还不了", "项目在回收站,我只是成员",
       "POST .../undelete", "404(不是 403 —— 不给存在性预言机)", "A5"),
    c!("GET", "/api/projects/trash", "回收站列出我删的项目与剩余天数", "我删过两个项目",
       "GET /api/projects/trash", "200,两条,带 days_left", "A5"),
    c!(deny "GET", "/api/projects/trash", "★别人删的项目不进我的回收站★",
       "别的主持人删了他的项目,我曾是那个项目的 admin", "GET /api/projects/trash",
       "200 但**不含**那一条 —— 判据是 owner(删项目本来就是主持人专属 D0,还原自然也是);\
        成员看得到别人回收站里的项目名 = 又一个存在性泄露", "A5"),
    c!(deny "PUT", "/api/projects/{id}", "★材料区连主人也改不了名★",
       "pid 是我的「我的活动材料」", "PUT {name:'随便'}",
       "403 —— decide_owner 对 kind='materials' 一律 Deny(2026-08-09 收严:原来主人放行)。\
        改名/拉成员/转移主持人/归档/删项目在 PRD §J1 那张表里全是 ❌", "J1"),
    c!(deny "GET", "/api/activities/{id}/items", "★超管读不到别人材料区里的东西★",
       "我是超管;活动零关联项目,材料在发起人的材料区", "GET .../items",
       "403 —— 超管短路这一条限定在「有关联项目」的活动上(PRD §J1c):\
        材料区里是体检报告、私人录音这类东西,救火走留痕的影子账户,不走超管直读", "J1c"),
    c!("GET", "/api/activities/{id}/link-history", "线上链接改动可追溯", "链接改过 2 次",
       "GET .../link-history", "200,2 条,含 谁/何时/改成什么", ""),
    c!(deny "GET", "/api/activities/{id}/link-history", "旁听者看不到改动历史", "活动 public,我不是参会人",
       "GET .../link-history", "403", "D9"),
    c!("POST", "/api/activities/{id}/remind", "★只催还没答复的★", "3 人待答复、2 人已接受",
       "POST .../remind", "200 targets=3 —— 已接受/已拒绝的人不该再被打扰", ""),
    c!(deny "POST", "/api/activities/{id}/remind", "参会人不能催办", "我是普通参会人", "POST .../remind", "403", ""),
    c!("POST", "/api/activities/{id}/accept-counter", "采纳改期把时间改成他提议的",
       "某人 status=counter 且给了提议时间", "POST {username:'他'}",
       "200,活动时间变成提议时间;★所有人答复清回 pending,含提议者本人★——他提的是时间,不等于他一定能来", "D2"),
    c!(deny "POST", "/api/activities/{id}/accept-counter", "没提改期的人不能被采纳", "他 status=accepted",
       "POST {username:'他'}", "400", "D2"),
    c!("POST", "/api/activities/{id}/reject-counter", "★驳回后回 pending 不是 declined★",
       "某人 status=counter", "POST {username:'他'}",
       "200,他的 status 变回 pending、counter_* 清空 —— 发起人拒的是这个**时间提议**,\
        不代表替他决定「不来」;他还能接受原时间或另提一个", "D2"),
    c!(deny "POST", "/api/activities/{id}/reject-counter", "没提改期的人不能被驳回", "他 status=accepted",
       "POST {username:'他'}", "400", "D2"),
    c!("GET", "/api/activities/public", "★公开活动要有入口★", "存在一场与我无关的 public 活动",
       "GET /api/activities/public?days=7",
       "200 且含它 —— 普通活动列表**刻意**不含它(那是我的日程),\
        所以没有这个广场的话「全平台可旁听」就是一句空话", "D9"),
    c!("GET", "/api/activities/public", "只列还没结束的", "一场 public 会已经开完",
       "GET /api/activities/public", "不含它 —— 旁听的意义是「我要去听」", "D9"),
    c!(deny "GET", "/api/activities/public", "未登录看不到广场", "无会话", "GET /api/activities/public", "401", ""),
    c!("POST", "/api/activities/{id}/observe", "自助旁听后进我的日历", "一场与我无关的 public 活动",
       "POST {observe:true},再 GET /api/activities",
       "200;该会出现在我的日历里(list 包含「我是参会人」的会)。★不需要发起人同意★", "D9"),
    c!("POST", "/api/activities/{id}/observe", "★旁听拿不到材料★", "我旁听了某公开活动",
       "GET /api/activities/{id}/items", "403 —— D9 与 D3 正交:元信息公开不等于资料公开", "D9/D3"),
    c!("POST", "/api/activities/{id}/observe", "★已是正式参会人不会被降级★", "我是该会的 attendee 且已 accepted",
       "POST {observe:true}", "200 但我的 kind 仍是 attendee、答复状态不变(ON CONFLICT DO NOTHING)", "D9"),
    c!(deny "POST", "/api/activities/{id}/observe", "私密活动不能旁听", "活动 visibility=private",
       "POST {observe:true}", "★404 不是 403★——私密活动对无关的人连「存在」都不该暴露", "D9"),
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
    // ── ★项目软删除后,它的活动要跟着消失★(2026-08-07 Playwright 截图里肉眼发现)──
    // 项目软删除**不动 activity_projects 也不动成员表**,所以少了这道过滤,
    // 删掉的项目的会照样躺在日历上,还因为「找不到未删的公开项目」被误标成私密(紫色虚框)。
    // 这是 CLAUDE.md 那条硬纪律在活动模块的又一处遗漏(上次 v0.3.55 一口气补了 11 处)。
    c!("GET", "/api/activities", "★删掉项目后它的会不再进日历★", "项目 P 被删进回收站,它有一场未来的会",
       "GET /api/activities", "不含那场会——活动必须关联至少一个项目(硬约束),项目全没了它就是个孤儿。\
        ★判据是「关联项目**全部**被删」★:多项目关联时只要还有一个活着就留下", ""),
    c!("GET", "/api/activities/public", "★只列我还没有关系的会★", "有三场公开会:我发起的 / 我已旁听的 / 与我无关的",
       "GET /api/activities/public", "只回第三场。广场是**发现**的入口——我参与或已旁听的会\
        ★早就在我的日历里了★,右边再提醒一遍是纯噪音;更荒谬的是自己发起的会出现在这里,\
        还配一个「取消旁听」按钮(我从来就不是旁听)。2026-08-07 用户指出", "D9"),
    c!("GET", "/api/activities/public", "删掉项目后它的公开会不进广场", "公开活动的关联项目被删",
       "GET /api/activities/public", "不含——与日历同一条口径", "D9"),
    c!(deny "GET", "/api/activities/{id}/items", "★项目删了,原项目成员就拿不到材料了★",
       "我不是参会人,只是被删项目的成员", "GET .../items",
       "403/404 —— 材料权限来自**项目成员身份**(D3),项目进了回收站这个身份就不该再兑现", "D3"),
    c!(deny "GET", "/api/activities/{id}", "项目删了,原项目成员也看不到活动详情",
       "我不是参会人,只是被删项目的成员", "GET /api/activities/{id}",
       "404 —— activity_view 的「项目成员」那条要 JOIN projects 判 deleted_at", "D3"),

    c!("GET", "/api/me/transfers", "只列等我答复的", "有一条转给我的 pending、一条转给别人的",
       "GET /api/me/transfers", "只回转给我那条;已 accepted/declined/canceled 的都不回", ""),
    c!("GET", "/api/me/transfers", "项目被删则不回", "转移还 pending 但项目已软删除",
       "GET /api/me/transfers", "不回 —— 让人去接手一个已经不存在的项目是纯粹的噪音", ""),
    c!(deny "GET", "/api/me/transfers", "未登录看不了", "无会话", "GET /api/me/transfers", "401", ""),

    // ── 等我整理的纪要(2026-08-10)──────────────────────────────────────
    // 判据在 activities_owing_minutes 视图里,这几条用例正好把它的四个条件各钉一遍。
    c!("GET", "/api/me/minutes-todo", "只列我当记录员的", "两场都开完了、纪要都没写:一场我是记录员、一场别人是",
       "GET /api/me/minutes-todo", "只回我当记录员那场 —— 别人欠的账不进我的待办", ""),
    c!("GET", "/api/me/minutes-todo", "★没有纪要这回事的类型不算★",
       "我用自建类型(A3:has_minutes 恒 false)开了一场、已结束、关联了项目",
       "GET /api/me/minutes-todo", "不回。这一条正是收进视图前 /api/me/stats 漏掉的判据:\
        自建类型是「我自己的日程分类」,催它交纪要是纯噪声", ""),
    c!("GET", "/api/me/minutes-todo", "会还没开完不催", "我是记录员,活动在未来",
       "GET /api/me/minutes-todo", "不回 —— 会没开就催纪要,那时候根本无从写起", ""),
    c!("GET", "/api/me/minutes-todo", "连草稿都没有也算欠,并标出来",
       "我是记录员、已结束、activity_minutes 一行都没有",
       "GET /api/me/minutes-todo", "回这一条且 has_draft=false —— 「连草稿都没建」比\
        「草稿没写完」更该提醒,文案要能区分「去整理」与「接着写」", ""),
    c!("GET", "/api/me/minutes-todo", "写完了(done)就退出待办", "我是记录员、已结束、纪要 status=done",
       "GET /api/me/minutes-todo", "空数组 —— 待办要能被「做完」清掉,\
        否则这张卡上永远挂着同一条,红点天天有就等于没有", ""),
    c!("GET", "/api/me/minutes-todo", "取消掉的活动不算", "我是记录员、时间已过、活动 status=canceled",
       "GET /api/me/minutes-todo", "不回 —— 没开的会没有纪要", ""),
    c!(deny "GET", "/api/me/minutes-todo", "未登录看不了", "无会话", "GET /api/me/minutes-todo", "401", ""),

    // ── 提醒(PRD F2/F3,2026-08-12)────────────────────────────────────────
    // ★这几条钉的全是「不该弹却弹了」★:漏弹一条是遗憾,重复弹或弹早已开完的会是事故 ——
    // 前者用户不会注意到,后者用户当场就看见了。
    c!("GET", "/api/me/reminders", "★不带 since 回空,只用来对时★", "我有一条刚发出的提醒",
       "GET /api/me/reminders", "items=[] 且带 now。首次进页面就回一批历史提醒的话,\
        用户一打开就被几条「XX 将于 15 分钟后开始」糊脸,而那些会**早就开完了**", ""),
    c!("GET", "/api/me/reminders", "回 since 之后投递的", "上轮拿到 now=T,之后循环给我发了一条",
       "GET /api/me/reminders?since=T", "回那一条 —— 判据是 reminded_at > since(**投递时刻**),\
        不是 starts_at:翻页去重靠前者,文案里说的「还有几分钟」才算后者", ""),
    c!("GET", "/api/me/reminders", "now 必须是**服务端**时间", "任意",
       "GET /api/me/reminders", "响应带 now,前端下次原样送回。★不能让前端用 Date.now()★——\
        浏览器时钟快几秒则 since 一直在未来、永远查不到刚发的提醒;慢几秒则每轮重弹同一条。\
        两种偏差都无声无息,用户只会觉得「提醒时灵时不灵」而我们查不出为什么", ""),
    c!("GET", "/api/me/reminders", "取消掉的活动不回", "提醒已发出,之后活动被取消",
       "GET /api/me/reminders?since=T", "不回 —— 已经作废的会不该再冒出来", ""),
    c!(deny "GET", "/api/me/reminders", "未登录看不了", "无会话", "GET /api/me/reminders", "401", ""),

    // ── 跨项目复制(PRD J2,2026-08-12)──────────────────────────────────────
    // ★这几条钉的全是「不该复制却复制了」★:复制**不走下载路径**,
    // 于是下载上的每一道检查它都绕过了 —— 判据必须在这个 handler 里自己写一遍。
    c!("POST", "/api/items/{id}/copy", "★源要能读★", "我不是源项目的成员",
       "POST /api/items/{别人的文件}/copy {project_id:我的项目}", "403 —— 否则就是\
        「凭一个 id 把别人的文件搬进自己项目」,而内容寻址让这件事**零成本**", ""),
    c!("POST", "/api/items/{id}/copy", "目标要 editor", "我在目标项目只是 viewer",
       "POST /api/items/{id}/copy", "403", ""),
    c!("POST", "/api/items/{id}/copy", "★同一 owner 内复制不占新配额★",
       "我名下项目 A 有个 1GB 文件,额度快满了",
       "复制到我名下项目 B", "成功 —— 用量按 blob 去重(GROUP BY s3_key,不带 project_id),\
        物理上盘里就一份。★为自己的同一份文件收两次费,用户解释不通★(2026-08-08 拍板推翻 PRD 原文)", ""),
    c!("POST", "/api/items/{id}/copy", "跨 owner 复制算目标 owner 的额度", "目标项目主持人额度已满",
       "复制过去", "400「目标项目主持人的配额不够」—— 额度归主持人(L3)", ""),
    c!("POST", "/api/items/{id}/copy", "★副本独立★", "复制完之后改副本的名字 / 删掉副本",
       "PUT/DELETE 副本", "源不受影响;blob 靠引用计数不被误删", ""),
    c!("POST", "/api/items/{id}/copy", "回收站里的不给复制", "源已被软删",
       "POST /api/items/{id}/copy", "404 —— 与改名/移动同一条纪律,要动它先还原。\
        ★「删了但还能复制出来」等于软删除形同虚设★", ""),
    c!("POST", "/api/items/{id}/copy", "材料区不能当目标", "target 是「我的活动材料」",
       "POST /api/items/{id}/copy", "400 —— 它是系统存档区、整块只读,\
        往里塞东西会绕过「材料归活动」这个结构。★反方向(材料区→项目)是允许的★,\
        PRD J2 的原话就是「把那个 PDF 复制进课题组的项目」", ""),
    c!("POST", "/api/items/{id}/copy", "文件夹明确拒绝,不悄悄只复制一层", "源是文件夹",
       "POST /api/items/{id}/copy", "400 并说清原因 —— 递归复制要处理层级/重名/部分失败回滚,\
        是另一件事;★悄悄只复制一层比拒绝更糟★,人会以为复制完了", ""),
    c!(deny "POST", "/api/items/{id}/copy", "未登录", "无会话", "POST /api/items/{id}/copy", "401", ""),

    // ★复现测试:双层 Option★(2026-08-12 实现前端下拉时发现的存量 bug,规范要求修 bug 先写测试)
    c!("PUT", "/api/activities/{id}", "★remind_minutes 传 null = 改回「跟随个人默认」★",
       "这场已经设了 remind_minutes=30",
       "PUT {remind_minutes: null}", "库里变成 NULL。★原来是静默无效★:字段声明成 Option<i32> +\
        SQL COALESCE($n, remind_minutes),于是「传了 null」和「压根没传」长得一模一样 ——\
        用户在界面上选「跟随个人默认」,请求 200、界面照常刷新,而数据库一个字节都没变。\
        静默失败是最贵的那种:没有报错可查,只有过一阵子有人问「我明明关过」", ""),
    c!("PUT", "/api/activities/{id}", "不传 remind_minutes 则不动它", "这场已设 remind_minutes=30",
       "PATCH {title: \"新标题\"}", "remind_minutes 仍是 30 —— 双层 Option 的另一半:\
        `None`=没传要保持原样,`Some(None)`=显式清空。两者行为必须不同", ""),
    c!("PUT", "/api/activities/{id}", "★actual_minutes 传 null 也要能清空★", "这场已填实际时长 90",
       "PUT {actual_minutes: null}", "库里变成 NULL,且 actual_by 保持原样不被覆盖。\
        ★同一行 SQL 上的同一个存量 bug★:清空「实际时长」此前一直静默无效", ""),
    c!("PUT", "/api/activities/{id}", "remind_minutes=0 是「这场不提醒」不是「立刻提醒」",
       "任意", "PUT {remind_minutes: 0}", "存 0;提醒循环的 `COALESCE(...) > 0` 把它排除。\
        ★0 当哨兵★:「提前 0 分钟提醒」本来就无意义,不会和真实值撞(设计 §7①)", ""),

    // ── 站内信(M1 收口)──★钉的是「谁该收到、谁不该收到」★:
    // 该收没收 = 人不知道有会;不该收却收 = 收件箱被淹,真正要紧的那条被埋掉。两种错都致命。
    c!("POST", "/api/activities", "★建会即通知被约的人★", "我约了 A、B",
       "POST /api/activities", "A、B 收到「有人约你开会」站内信,★发起人自己不收★——\
        他知道自己干了什么,「你约了自己」只会让人觉得系统啰嗦", ""),
    c!("POST", "/api/activities", "registry 不可达不影响建会", "平台 registry 挂了",
       "POST /api/activities", "★200,会照建★——发不出信是通知的事故,不是约会的事故;只 warn 一行日志", ""),
    c!("PUT", "/api/activities/{id}", "★改时间发「请重新答复」★", "把会从周三挪到周四",
       "PUT {starts_at,ends_at}", "全员收到「活动时间已改」且正文点明答复已作废——\
        库里确实把 status 清回了 pending,不说他们不会知道自己又欠一次答复", ""),
    c!("PUT", "/api/activities/{id}", "改链接通知但不清答复", "只改 online_url",
       "PUT {online_url}", "发「线上活动链接已改」;★答复不清★——换个链接不影响「我来不来」。\
        ★改标题/议程/地点不发信★:够不上打扰所有人,他们打开活动页就看得到", ""),
    c!("DELETE", "/api/activities/{id}", "★取消最需要通知★", "发起人取消活动",
       "DELETE /api/activities/{id}", "全员收到「活动已取消」——不通知的后果是有人按原计划去了,而会不存在了", ""),
    c!("PUT", "/api/activities/{id}/participants", "只通知新加的这批", "会上已有 5 人,再加 2 人",
       "PUT {usernames:[2人]}", "★只有这 2 人收到★:原来 5 个人什么都没变,不该被打扰;\
        kind=observer 不发信(自助加进来的,他自己知道)", "D9"),
    c!("POST", "/api/activities/{id}/respond", "★建议改期必须通知发起人★", "我提了 counter",
       "POST {status:'counter',...}", "发起人收到「有人建议改期」含提议时间与理由——\
        私密项目的日程对他完全隐形,这是他能收到的**唯一**信号;躺在库里没人看 = 这个出口不存在", "D2"),
    c!(deny "POST", "/api/activities/{id}/respond", "★活动开始后不能再建议改期★", "会已经在开了",
       "POST {status:'counter'}", "400 —— 会都开了,改期这个动作没有意义:要么是误点,\
        要么是想说「我没去」而那该用拒绝。⚠ **其余三态照常允许**:会后补一个「我其实没去」是正当的", ""),
    c!("POST", "/api/activities/{id}/respond", "接受/拒绝/待定不发信", "我点了接受",
       "POST {status:'accepted'}", "★不发★——发起人在活动页看得到答复进度,一人一条信只会淹掉真正要紧的改期建议", ""),

    // 未读:三条钉的是「什么算未读」和「标记已读会不会吞消息」。
    c!("GET", "/api/me/unread", "★公开讨论区的新消息不算未读★", "某会公开频道有 5 条我没看过的消息",
       "GET /api/me/unread", "空数组——那是「群里有人说话」不是「有人找我」;\
        混进来会让这张卡天天有红点,红点天天有就等于没有", "D13"),
    c!("GET", "/api/me/unread", "从没读过 = 全部未读", "有人私聊我 2 条,我从没打开过这场会(activity_reads 无记录)",
       "GET /api/me/unread", "★返回该会 count=2★——没有记录当「一条都没读过」而不是「全读过」,\
        否则新人加入项目后的历史讨论会悄悄永远不提醒他", "D3"),
    c!("GET", "/api/me/unread", "自己发的不算未读", "我私聊了别人",
       "GET /api/me/unread", "不含——sender = 我的直接排除", ""),
    c!("POST", "/api/me/unread/read", "★全部标记已读不吞刚发来的消息★",
       "标记的同一瞬间对方又发了一条", "POST {} (不带 activity_id)",
       "read_at = now() 而不是「最后一条消息的时间」;最坏是把刚发来的那条也算读了,\
        而它还在活动页里躺着不会丢", ""),
    c!(deny "POST", "/api/me/unread/read", "未登录标不了已读", "无会话", "POST /api/me/unread/read", "401", ""),
    c!(deny "GET", "/api/me/unread", "未登录看不了未读", "无会话", "GET /api/me/unread", "401", ""),

    // ── 项目统计(6.5.2 + D6)──
    c!("GET", "/api/projects/{id}/stats", "★分组展开:一个会挂两个项目,两边各算 1 次★",
       "会 M 同时关联 P1、P2", "分别 GET 两个项目的 stats",
       "P1 与 P2 的 activities 各为 1 —— ★这是 D6 的「分组展开」★;\
        跨项目求总数必须按活动去重(响应里的 dedup_note 就是提醒这一句)", "D6"),
    c!("GET", "/api/projects/{id}/stats", "取消的场次不计入", "项目里有一场 canceled 的会",
       "GET .../stats", "不计 —— 它没发生过", ""),
    c!("GET", "/api/projects/{id}/stats", "参会率分母不含旁听者", "5 人受邀 3 人接受,另有 4 个旁听者",
       "GET .../stats", "accept_rate=0.6 —— ★旁听者不是被邀请的★,计进分母会把这个比例稀释成 0.33", "D9"),
    c!("GET", "/api/projects/{id}/stats", "时长口径与个人统计一致", "会有录制 1.2h,排程 2h",
       "GET .../stats", "算 1.2h(D5 三级回退)——★两处口径若各写一套,同一场会在个人页和项目页\
        会显示不同时长,而没人说得清该信哪个★", "D5"),
    c!(deny "GET", "/api/projects/{id}/stats", "非成员看不到项目统计", "我不是本项目成员",
       "GET .../stats", "403/404 —— 活动次数与时长本身也是信息(D3)", "D3"),

    // ── D5 时长口径:★三级回退,不是三选一★ ──
    // 这几条钉的是「哪个数字被采信」。错了不会报错,只会让季度汇报的数字悄悄偏高。
    c!("GET", "/api/me/stats", "★有录制就用录制时长★", "会排了 2h,录屏实际 1.2h",
       "GET /api/me/stats", "算 1.2h 且 hours_by_source.recording=1.2 —— 录制是真测出来的,最可信", "D5"),
    c!("GET", "/api/me/stats", "多份录制取 max 不是 sum", "两个人各录了一份 1.2h",
       "GET /api/me/stats", "★算 1.2h 不是 2.4h★——两份是同一场会,累加会翻倍", "D5"),
    c!("GET", "/api/me/stats", "没录制则用手工补录", "没录屏,发起人填了 actual_minutes=40",
       "GET /api/me/stats", "算 0.7h 且计入 hours_by_source.manual", "D5"),
    c!("GET", "/api/me/stats", "都没有才退到排程时长", "既没录制也没手工",
       "GET /api/me/stats", "按 ends_at-starts_at 算,计入 hours_by_source.scheduled ——\
        ★这部分最不可信★(排 2 小时、20 分钟散会是常事),前端单独标黄", "D5"),
    c!("PUT", "/api/activities/{id}", "补录实际时长", "会已结束,我是发起人",
       "PUT {actual_minutes:40}", "200;统计随即改用这个数。★超过 24 小时或 ≤0 被库里的 CHECK 挡★", "D5"),

    c!("GET", "/api/me/stats", "★还没开的会不计入★", "本月有一场明天才开的会",
       "GET /api/me/stats?range=month", "totals.activities 不含它——「投入」是回顾,\
        把未来的会算进去等于月初就看到一个虚高的数字", ""),
    c!("GET", "/api/me/stats", "★拒绝的会不计入★", "我对一场已开完的会 declined",
       "GET /api/me/stats", "不计次数也不计时长——人没去,不该算他的投入", ""),
    c!("GET", "/api/me/stats", "发起人不在参会名单里也算", "我发起了会但没把自己加进 participants",
       "GET /api/me/stats", "计入——他在开会,只是没给自己发邀请", ""),
    c!("GET", "/api/me/stats", "待写纪要按记录员算", "我是记录员,会已开完,纪要 status=draft",
       "GET /api/me/stats", "minutes_todo 含它;若纪要 done 则不含。★记录员是纪要的作者★", "D14"),
    c!("GET", "/api/me/stats", "一场会关联两个项目会在分项目表里各计一次",
       "会 M 同时关联 P1、P2", "GET /api/me/stats",
       "by_project 两行各 1 次,而 totals.activities 只 +1 —— ★分项目之和 ≥ 总数是设计如此★,\
        前端别拿它反推总数", ""),
    c!(deny "GET", "/api/me/stats", "range 只认三个值", "登录", "GET /api/me/stats?range=drop",
       "400 —— 这个值要进 date_trunc 第一参,乱字符串会让 PG 直接报错 500", ""),
    c!(deny "GET", "/api/me/stats", "未登录看不了统计", "无会话", "GET /api/me/stats", "401", ""),

    c!("GET", "/api/activities/{id}/minutes", "没有纪要时回空而不是 404", "活动刚建,还没写纪要",
       "GET .../minutes", "200,minutes=null,can_edit 按身份给;★前端不用为「还没写」判 404★", "D14"),
    c!(deny "GET", "/api/activities/{id}/minutes", "旁听者看不到纪要", "活动 public,我不是参会人",
       "GET .../minutes", "403;纪要是活动内容,与讨论区同档(D9 给旁听者的只是「知道有这个会」)", "D9"),
    c!("PUT", "/api/activities/{id}/minutes", "记录员按固定模板保存", "我是记录员",
       "PUT {attendees,agenda_text,content_md,resolutions,todos}", "200;字段对应表里的固定模板", "D14"),
    c!("PUT", "/api/activities/{id}/minutes", "★定稿时间只记第一次★", "已 status=done 定稿过",
       "再 PUT 一次 {status:'done', attendees:'补录到场'}",
       "200 且 completed_at ★不变★——会后补录到场情况是常事,不该把「什么时候定的稿」冲掉", "D11"),
    c!(deny "PUT", "/api/activities/{id}/minutes", "普通参会人改不了纪要", "我是参会人,不是记录员也不是发起人",
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
    c!("POST", "/api/projects/{id}/upload", "带 activity_id 上传即活动材料", "活动关联本项目",
       "POST .../upload?activity_id=M&is_recording=true",
       "200;该条目出现在 GET /api/activities/M/items 的**录制** tab 里,不出现在材料 tab", "D5/D10"),
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
    c!(deny "PUT", "/api/admin/users/{username}/quota", "非超管改不了别人的额度", "我不是超管",
       "PUT /api/admin/users/{username}/quota", "403;★这是「钱」路径,必须 fail-closed★", "L3"),
    c!("PUT", "/api/admin/users/{username}/quota", "调项目配额", "我是超管", "PUT {quota_bytes:21474836480}",
       "200,新配额生效", "P1"),
    // ══ 治理配置(2026-08-16,docs/TECH-DESIGN-admin-console.md)══
    c!(deny "GET", "/api/admin/settings", "非超管读不到治理配置", "我已登录但非超管",
       "GET /api/admin/settings", "403", "admin-console"),
    c!("GET", "/api/admin/settings", "三项配置带 source 一起回", "库里只设过 default_remind_minutes",
       "GET /api/admin/settings",
       "200;remind.source=db,quota.source=default,creators.source=env 或 default —— ★source 分得出「设过」和「恰好等于默认」★", "admin-console"),
    c!(deny "PUT", "/api/admin/settings/{key}", "非超管改不了治理配置", "我已登录但非超管",
       "PUT /api/admin/settings/default_quota_bytes", "403;★这是「权/供给」路径,fail-closed★", "admin-console"),
    c!("PUT", "/api/admin/settings/{key}", "★白名单外的 key 一律 400★", "我是超管",
       "PUT /api/admin/settings/llm_model {value:'x'} 或任意别的 key",
       "400「不认识的设置项」;★白名单是安全边界:没有它,将来任何新 key 都自动变成可被外部写入★", "admin-console"),
    c!("PUT", "/api/admin/settings/{key}", "建项目白名单里有不存在的用户 → 400", "我是超管,库里没有 nosuchguy",
       "PUT /api/admin/settings/project_creators {value:'liaoruili,nosuchguy'}",
       "400「没有这个用户」;★打错一个字母的后果是那个人从此建不了项目,而没有任何地方会报错★", "admin-console/Q2"),
    c!("PUT", "/api/admin/settings/{key}", "配额 0/负数/超 1PiB → 400", "我是超管",
       "PUT /api/admin/settings/default_quota_bytes {value:'0'}", "400;上限 1 PiB 防手滑多打几个 0", "admin-console"),
    c!("PUT", "/api/admin/settings/{key}", "提醒提前量越界 → 400", "我是超管",
       "PUT /api/admin/settings/default_remind_minutes {value:'0'} 或 '10081'", "400;范围 1 分钟 ~ 7 天", "admin-console"),
    c!(deny "GET", "/api/admin/settings/default-quota/impact", "非超管算不了影响面", "我已登录但非超管",
       "GET /api/admin/settings/default-quota/impact?bytes=1", "403", "admin-console"),
    c!("GET", "/api/admin/settings/default-quota/impact", "★影响面必须等于真实影响面★", "108 人跟随默认,其中 2 人已用超过 5GiB",
       "GET /api/admin/settings/default-quota/impact?bytes=5368709120",
       "200 {following_default:108, would_exceed:2};★算出来的人必须就是改完真的传不了东西的那些人,否则这个确认框在骗人★", "admin-console"),
    c!(deny "DELETE", "/api/admin/users/{username}/quota", "非超管不能把别人放回默认", "我已登录但非超管",
       "DELETE /api/admin/users/x/quota", "403;★这是「钱」路径★", "admin-console"),
    c!("DELETE", "/api/admin/users/{username}/quota", "恢复为默认,且幂等", "某人单独设过 50GiB",
       "DELETE 一次,再 DELETE 一次",
       "两次都 204;之后 /admin/users 里他 quota_is_default=true 且额度跟着全站默认变", "admin-console"),
    // ══ 纪要导出 PDF(2026-08-17,docs/TECH-DESIGN-minutes-pdf.md)══
    c!(deny "POST", "/api/activities/{id}/minutes/pdf", "普通参会人导不了纪要 PDF", "我是参会人但不是发起人/记录员",
       "POST /api/activities/1/minutes/pdf",
       "403;★导出是**产出正式文件**不是读,权限与写纪要同一判据★", "minutes-pdf"),
    c!("POST", "/api/activities/{id}/minutes/pdf", "★正向对照:记录员能导★", "我是记录员,纪要有内容",
       "POST /api/activities/1/minutes/pdf",
       "200 {item_id,draft};★没有这条,上面那条 403 在「谁都导不了」时也会绿★", "minutes-pdf"),
    c!("POST", "/api/activities/{id}/minutes/pdf", "★再导一次:同一个 item_id、版本 +1★", "已经导过一次",
       "再 POST 一次",
       "item_id **不变**;item_versions 多一行。★一条稳定的 id 意味着分享链接不会因为重新导出而失效★", "minutes-pdf"),
    c!("POST", "/api/activities/{id}/minutes/pdf", "空纪要不给导", "纪要三段全空",
       "POST …/minutes/pdf", "400「纪要还是空的」;★导出一份什么都没有的 PDF 比报错更让人困惑★", "minutes-pdf"),
    c!("GET", "/api/admin/audit", "全局审计可筛", "有多条审计", "GET /api/admin/audit?actor=x&limit=50",
       "200,按 actor 过滤;★敏感动作(建分享/移出成员/purge/改超管)都必须有记录★", ""),

    // ★AI 模型:超管可配★(2026-08-16 热修)。它存在的理由本身就是一次事故:
    // 平台换了模型 → congrove 还调老的 → `403 无权调用模型` → 纪要功能整个哑掉,
    // 而子系统这边**没有自助恢复的办法**,只能等人改 env 再重启。
    c!("GET", "/api/admin/llm/models", "列可用模型", "网关可达", "GET /api/admin/llm/models",
       "200,{current, models[]};★网关不可达时不编造空列表★,回 error 字段让界面说「列不出来但仍可手输」", ""),
    c!("PUT", "/api/admin/llm/model", "选模型", "我是超管", "PUT /api/admin/llm/model {model:'X'}",
       "200 且立即生效(存库,不用改 env/重启);★不校验它在不在列表里★——按需模型本就不在列表里", ""),

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

    // ══════════ 超管模式(docs/TECH-DESIGN-admin-mode.md)══════════
    c!("POST", "/api/me/admin-mode", "超管刻意开一下才拿到特权", "我有超管资格,模式关着",
       "POST {on:true}", "200,until = 2 小时后;审计里多一条 admin_mode.enter —— \
        ★在此之前「超管读了什么」一点痕迹都没有★", "AdminMode"),
    c!(deny "POST", "/api/me/admin-mode", "没资格的人开不了", "我是普通用户",
       "POST {on:true}", "403", "AdminMode"),
    c!(deny "GET", "/api/projects/{id}", "★超管模式关着时,超管看不到别人的项目★",
       "我有超管资格但模式没开;这个项目我不是成员", "GET /api/projects/{id}",
       "404(与普通人完全一样,连存在性都不给)—— 这正是这个功能的目的:\
        2026-08-09 liaoruili「我默认能看到所有人的内容,这对日常使用带来困扰」", "AdminMode"),
    c!(deny "GET", "/api/_dev/apis", "模式关着时超管面也进不去", "我有超管资格但模式没开",
       "GET /api/_dev/apis", "403;前端据此提示「进入超管模式」而不是把入口藏掉 —— \
        入口凭空消失会让人以为超管被撤了", "AdminMode"),
    c!("GET", "/api/me", "资格与特权分开回", "我有超管资格,模式关着",
       "GET /api/me", "is_super=false(此刻没特权)、can_super=true(有资格)、admin_mode_until=null。\
        ★is_super 的语义刻意不改★:它散在前端多处,改语义会让「显示」和「能力」错配", "AdminMode"),

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
       "404;★转写正文等同活动内容★", "D3"),
    c!(deny "GET", "/api/items/{id}/subtitles.vtt", "非成员拿不到字幕", "我不是成员", "GET .../subtitles.vtt",
       "404;字幕就是全文,不能比正文松", "D3"),
    c!(deny "GET", "/api/items/{id}/shares", "viewer 看不到分享链接列表", "我是 viewer", "GET .../shares",
       "403;链接列表里的 token 等同凭据", "v0.3.36"),
    c!(deny "GET", "/api/shares/mine", "未登录取不到我的分享", "无会话", "GET /api/shares/mine", "401", ""),
    c!(deny "PUT", "/api/admin/users/{username}/super", "非超管不能提超管", "我已登录但非超管",
       "PUT {is_super:true}", "403;★这条是提权路径,最该盯★", ""),
    c!(deny "PUT", "/api/admin/users/{username}/quota", "项目 admin 也不能自己调配额", "我是项目 admin 但非超管",
       "PUT {quota_bytes:大数}", "403;配额是平台资源,不能自助", "P1"),
    c!(deny "GET", "/api/admin/llm/models", "非超管列不了模型", "我已登录但非超管", "GET /api/admin/llm/models",
       "403;模型清单属于系统配置面,不该对普通用户开放", ""),
    c!(deny "PUT", "/api/admin/llm/model", "非超管改不了模型", "我已登录但非超管", "PUT /api/admin/llm/model",
       "403;★这是全系统级设置★——一个人改,所有人的纪要都换模型", ""),

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
