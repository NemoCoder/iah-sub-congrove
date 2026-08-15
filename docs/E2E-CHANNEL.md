# dev E2E 免登通道 —— 规格与「第二层怎么接」的决策

> 平台侧 2026-08-07 上线(registry v1.3.80/81,群消息 #128/#131)。
> **第二层已于 2026-08-07 由用户拍板走「选项 A + 双重门闩」并实现**(v0.3.60),
> 落点:`config.rs::is_dev_channel()` + `auth.rs::require_auth` 的第三条分支 + 启动 WARN。
> 下面的权衡记录保留,**推翻这个决定前先把它读完**。

## 为什么会有这份文档

自动化测试(Playwright)要能走完整条 UI 流程,可整条路上有**两道**身份关卡:

```
浏览器 ──① 平台网关 SSO 门禁(dev 邀请制,未登录 302 跳 Keycloak)
       └─② congrove 自己的 OIDC / HS256 会话 cookie(auth.rs)
```

★两道都得过,只过一道等于没过★。这一点上我原先的设想是错的,是平台指出来的:
我本来以为声明 `machine_paths` 就够——那只让**声明的那条路径**跳过第一层,
E2E 端点换到 cookie 之后,浏览器接着访问的 UI 路径不在 machine_paths 里,照样被 302,
结果是「拿到了 cookie 却进不了界面」。

★还有一条纪律要记住★:2026-08-07 我卡在这里时,曾打算在 congrove 里加一个
「只在 dev 生效的测试身份」自己绕过 OIDC,被用户当场制止——**身份边界归平台**,
子系统自建旁路等于这个洞对每个子系统都开着。等平台做,是对的:
平台一次做好,所有子系统通用,而且边界由平台统一守。

## 第一层:平台已做好(照做即可)

| 步骤 | 做什么 |
|---|---|
| 开通 | 仓库根 `iah.yaml` 加 `e2e: true`,重新 deploy 即生效(**已加**) |
| 取 key | `GET https://registry.ruciah.com/api/subsystems/congrove/e2e-key`(带 `iahk_` 个人令牌)<br>→ `{ enabled, key, header:"X-IAH-E2E-Key", host }` |
| 用 key | Playwright:`use: { extraHTTPHeaders: { "X-IAH-E2E-Key": process.env.IAH_E2E_KEY } }` |

带了这个头,dev 网关**跳过 SSO 三道**,整条会话都不走浏览器 OIDC。

平台侧的边界(平台已实测):**仅 dev**(prod 没有这条路由)· **per-子系统 key**(别的 slug 借用 403)
· prod host 拒 · 常量时间比较 · key 待遇同 OIDC secret。

★key 是凭证★:不进仓库、不进前端、不进日志。放 `~/.config/iah/congrove-e2e-key`(600)
或 CI secret,用 env `IAH_E2E_KEY` 递给 Playwright。

## 第二层:两个选项,需要拍板

平台在跳过 SSO 的同时,给下游**注入了身份头**:

```
X-Forwarded-Preferred-Username: e2e
```

### 选项 A(平台建议,最省):congrove 信任这个注入头

进来就是用户 `e2e`,**不用写任何 test-login 端点**,直接就是登录态。
这是「IAH 标准做法」——平台自己的 registry-svc 就是这么认身份的(`store.py` 的 `_caller()`)。

⚠ **但这与 congrove 的架构决策①直接冲突**:DESIGN.md §3 写的是
「身份自建 OIDC 客户端…**平台不注入身份头**」。开始信任它 = 推翻一条已定案的决策,
按纪律要先找到新证据。新证据确实有(平台现在**确实**注入了),但要问清楚两件事:

1. **prod 上这个头会怎样?** 依赖的前提是「网关会剥掉客户端伪造的同名头」+
   NetworkPolicy 保证流量只能从网关来。这两条对 registry-svc 成立,
   ★对 congrove 是否同样成立,要跟平台确认后才能依赖★——不能假定。
2. **同一个镜像 promote 到 prod 会不会跟着信任?** 这是我踩过的那类坑
   (版本号 `.dev` 后缀就这么跟到 prod 去过)。

### 选项 B:加一个 test-login 端点,信任注入头去 mint 自己的 cookie

多写一个端点,但**信任范围收得住**:只有那一个端点认这个头,其余路径的身份判定一个字不改。

## 我的建议:选 A,但加**双重门闩**

信任注入头,同时满足两个条件才生效:

1. **本进程跑在 dev 通道** —— 判据用平台注入的 `PUBLIC_URL`
   (`https://congrove-dev.sub.ruciah.com` vs `https://congrove.sub.ruciah.com`);
2. 请求确实带着平台注入的那个身份头。

★为什么这个判据能真正堵住「跟到 prod」★:`PUBLIC_URL` 是**平台按通道注入的 env**,
promote 复用同一个镜像时它**会跟着变**——所以它不是编译进去的常量,
不会像 `.dev` 后缀那样被原样带到 prod。这是这个方案成立的关键,
★别改成读 `APP_ENV` 或任何写死在 `iah.yaml` 里的值★(那些两个通道是同一份)。

落地时:判据收在 `config.rs` 一处推导(`is_dev_channel()`),
`auth.rs` 只问它,不各自解析域名——与全仓「唯一推导」的纪律一致。

启动时若判定为 dev 且 e2e 已开,**打一条 WARN**:这条通道是真实的身份旁路,
日志里必须看得见它开着。

## 落地记录(2026-08-07)

- [x] 用户拍板:**选 A + 双重门闩**
- [x] 实现:`config.rs::is_dev_channel()`(唯一推导,纯函数 `is_dev_url` + 3 条单测)、
      `auth.rs::require_auth` 第三条分支(**排在 cookie 与 Bearer 之后**——真人带着自己会话来测时,
      身份应当是他本人而不是 `e2e`)、`lib.rs` 启动 WARN。
- [x] 平台侧两个 bug 已修(registry v1.3.81):取 key 端点不认令牌(#129)、
      ★Traefik v3 规则名写成了 v2 的 `HeadersRegexp`,导致整条 E2E 路由被丢弃★(#130)。
- [x] 网关行为已被 `unit_tests/congrove/e2e/gate.spec.ts` 钉死(6 条):
      不带 key 被拦 / 伪造 key 被拦 / **congrove 的 key 进不了别的子系统** /
      `/healthz` 也在门禁后 / 带真 key 直达 / 第二层现状。
- [ ] ⏳ **等平台答复一个安全前提**(群消息 #133):prod 的网关是否会剥掉客户端伪造的
      `X-Forwarded-Preferred-Username`,以及 subsystems ns 的 NetworkPolicy 是否保证流量只能从网关来。
      ★这两条对 registry-svc 成立,对子系统是否同样成立没有确认过★。
      **当前实现不依赖它们**(`is_dev_channel()` 已经把 prod 完全排除在外),
      但如果将来有人想把这条分支放宽到 prod,**必须先拿到这两条的确认**。
- [ ] 把 `tests/api_cases.rs` 里那 153 条用例翻成 Playwright spec
