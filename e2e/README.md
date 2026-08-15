# congrove 的端到端测试(Playwright)

★测试跟被测代码同仓★——改接口时同一个提交里改测试,不会漂移。
它与 `../tests/api_cases.rs` 是**一套**:那份表(153 条用例、每条带需求条款编号)是这里 spec 的来源,
表里标了 ★ 的规则优先翻成 spec。

## 怎么跑

```bash
cd e2e && npm i          # 首次
./run.sh                 # 全跑
./run.sh --grep 忙闲     # 只跑一组
npx playwright show-report .artifacts/report
```

| 前置 | 放哪 | 没有会怎样 |
|---|---|---|
| 内网 CA | `~/.config/iah/IAH-Internal-CA-new.crt` | TLS 直接失败(`*.ruciah.com` 是内网 CA 签的) |
| E2E key | `~/.config/iah/congrove-e2e-key`(600) | 只能跑「门禁」组,其余全被 302 拦 |
| chromium | `~/.cache/ms-playwright/` | `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install chromium` |
| ★浏览器信任内网 CA★ | Chromium 的 NSS 库 | **UI 测试全挂**(API 测试不受影响,见下) |
| emoji 字体(仅截图需要) | `~/.fonts` | 截图里 emoji 显示成豆腐块(产品本身没问题) |

### ★浏览器要单独装 CA★(踩过)

`NODE_EXTRA_CA_CERTS` **只对 Node 侧(APIRequestContext)生效,浏览器是独立进程、不读它** ——
所以 `request.get()` 能通而 `page.goto()` 直接失败。一次性配置:

```bash
sudo apt install libnss3-tools     # 或 apt-get download 后 dpkg-deb -x 解到用户目录
mkdir -p ~/.pki/nssdb
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n IAH-Internal-CA -i ~/.config/iah/IAH-Internal-CA-new.crt
certutil -d sql:$HOME/.pki/nssdb -L    # 应当列出 IAH-Internal-CA
```

★别改用 `ignoreHTTPSErrors: true` 图省事★:那会把「证书真的错了」和「证书是内网 CA 签的」
一起吞掉,以后证书出问题时测试还是绿的。

### ★装在**跑浏览器的那台机器**上,而不是跑 npx 的这台★(2026-08-13 踩到)

全套测试跑在**那台专用测试机**的有头浏览器上(端点见下面「配置」一节;★地址不入库★),
所以 CA 要装进**那台**的 NSS 库 —— 在 iah101 上装一百遍也没用,浏览器根本不在这儿。
那台机器(`lrlmac`, Ubuntu 24.04)上原本连 `certutil` 都没有,需要先 `apt install libnss3-tools`。

⚠★装完必须重启浏览器服务★:Chromium **只在启动时读 NSS**。
那台上的浏览器进程当时已经跑了三天多,装完 CA 照旧 `ERR_CERT_AUTHORITY_INVALID` ——
★我差点以为是装错了★。

```bash
ssh "$PW_SSH" 'systemctl --user restart pw-ui.service'   # PW_SSH 见下面「配置」一节
```

服务名 `pw-ui.service`(「Playwright headed browser server (congrove UI 巡查)」),
工作目录 `~/uiverify`,入口 `ws-server.mjs`,端口 9333。

截图脚本 `shot.mjs` 里另有 emoji 字体的说明(headless 容器默认没有,🔔 会变豆腐块)。

★凭证只从 `~/.config/iah/` 读,绝不入库★。

### 配置(★地址与凭证一律在仓库外★)

本仓三推 Gitea(内网)+ Gitee + GitHub,**后两个是外部仓** —— 内网地址写进仓库就等于发出内网。
2026-08-15 之前那台测试机的 `ws://…:9333/congrove` 在 11 个已跟踪文件里写死了 14 遍,
连 `ssh <用户名>@<地址>` 都在里面:地址 + 用户名 + 用途,一次给全。现在收进仓库外一个文件:

```bash
# ~/.config/iah/congrove-e2e.env   (chmod 600)
PW_WS=ws://<测试机地址>:9333/congrove
PW_SSH=<用户名>@<测试机地址>          # 只用于「浏览器挂了怎么重启」那句提示,可不配
```

读取只有一处实现:`e2e/pw-endpoint.mjs`(`playwright.config.ts` 与各 `.mjs` 脚本共用)。
★读不到就报错,不给默认值★ —— 默认值意味着「我以为连的是 A,其实连的是 B」,
而这类错的表现是测试**在错误的地方绿**。

同目录下还有:`IAH-Internal-CA-new.crt`(内网 CA)、`congrove-e2e-key`(E2E key)、
`congrove-dev.env`(dev 库 DSN)。

## 有什么

- `specs/gate.spec.ts` —— 平台 dev E2E 免登通道的**门禁行为**:不带 key 被拦、
  **伪造 key 被拦**、**congrove 的 key 进不了别的子系统**、`/healthz` 也在门禁后、
  带真 key 直达、身份是 `e2e` 且**非超管**。
- `specs/ui.spec.ts` —— **真浏览器**的界面测试:★记录员候选里必须有我自己★(那个「暂无数据
  导致建不了活动」的 bug 的复现测试)、关联项目有候选、日历 0–24 全展开(720px)、
  **重叠的活动必须都看得见**(盒子 left 互不相同)。
  ★这一组抓的是 API 测试抓不到的东西★:接口完全正常、前端把它用错了。
- `specs/activities.spec.ts` —— 活动模块那些**只能端到端验**的规则:
  忙闲按项目可见性分流(公开产生忙闲 / **私密完全隐形** / **响应里不含活动标题**)、
  多项目逐个验权、counter 必须带具体替代时间、取消不是删除、
  私聊只能发给发起人或记录员、看不见的活动回 404 而不是 403。

## 截图

```bash
NODE_EXTRA_CA_CERTS=~/.config/iah/IAH-Internal-CA-new.crt \
IAH_E2E_KEY=$(cat ~/.config/iah/congrove-e2e-key) node shot.mjs
```

★产物按版本号归档★:`unit_tests/congrove/screenshots/<线上版本>/`。

## `probe.mjs`:先看清楚,再写 spec

★别拿记忆当事实★——写 M1 验收那组 spec 时,我照「我以为的」文案写了一遍,几乎每个选择器都不对:

| 我以为 | 实际 |
|---|---|
| 按钮「新建」 | **「新 建」**(AntD 给两个汉字的按钮**自动插空格**) |
| `.ant-select-selector` | AntD 6 里不存在(那是 AntD 5 的) |
| Select 的 placeholder 能用 `getByPlaceholder` | 它是个 `<span>`,不是 input 属性 |

每一个的表现都是「超时 30 秒」,看起来像页面没加载 —— 最难查的那种失败。
所以先跑一次探查,把真实的按钮/占位符/tab 打出来,照着抄:

```bash
IAH_E2E_KEY=$(cat ~/.config/iah/congrove-e2e-key) \
  NODE_EXTRA_CA_CERTS=$HOME/.config/iah/IAH-Internal-CA-new.crt node probe.mjs
```

**定位优先级**:自己写的 `id`(最稳)> 可见文本/占位符 > role > ⛔ AntD 内部类名(跟着版本变)。

## 三种产物,三个去处(★都不许落在家目录或仓库里★)

| 产物 | 去处 | 留多久 |
|---|---|---|
| **成品截图**(`shot.mjs` 跑出来的各页面图) | `unit_tests/congrove/screenshots/<线上版本>/` | 留档,按版本对比用 |
| **失败截图 / trace**(测试红了自动存的) | `unit_tests/congrove/screenshots/_e2e-failures/` | 排查完就可以整个删 |
| **HTML 报告** | `unit_tests/congrove/screenshots/_e2e-report/` | 同上 |

配置在 `playwright.config.ts` 的 `outputDir` / `outputFolder`。
2026-08-07 之前失败截图落在 `e2e/.artifacts/`,用户指出后统一挪过来 ——
「截图不要都放到 ~ 以及很多脚本也放到 ~ 家目录,每次我都要清理」。
版本号**从线上页面实际抓**(页眉那个 `v0.4.x`),不读本地 `version.ts` ——
本地领先线上几个版本是常态,用本地号会把图归错档。设计稿截图另放 `_prototype/`。

⚠ **别用 `fullPage: true`**:整页常超 2000px,读图工具会拒收。
要看下半屏就滚动后再截一张(脚本里 `03-上` / `04-下` 就是这么来的)。

## 写这些测试时踩的坑(别再踩)

- ★别把「被拦住」断言成某个具体状态码★:平台修好路由前伪造 key 是 302(落回 SSO 路由),
  修好后是 403(走 E2E 路由被 forwardAuth 拒)。两者都是被拦住,写死状态码会把
  **安全行为变好**误报成回归。判「有没有进到应用」才稳。
- Playwright 的 `maxRedirects: 0` 遇重定向是**抛异常**,不是返回 302 响应对象。
- ★HTTP header 值必须 ASCII★:写中文 Node 直接抛 `Invalid character in header content`,
  请求根本发不出去,测试会以与安全无关的理由失败(curl 对同样的值放行,容易先入为主)。
- ★dev 通道下 `/healthz` 也在 SSO 门禁后★,整个域名都是,没有「开放端点」这回事。
  k8s 探针走 pod 内部直连不经网关,不受影响。
- 别用 `ignoreHTTPSErrors` 图省事:会把「证书真的错了」和「证书是内网 CA 签的」一起吞掉。
- ★E2E 通道只有 `e2e` 一个身份,测不了多人场景★(如「改时间后**别人**被清回 pending」)。
  这类规则留在 `../tests/api_cases.rs` 的表里,等有多身份手段再翻。
