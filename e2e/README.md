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

★凭证只从 `~/.config/iah/` 读,绝不入库★。

## 有什么

- `specs/gate.spec.ts` —— 平台 dev E2E 免登通道的**门禁行为**:不带 key 被拦、
  **伪造 key 被拦**、**congrove 的 key 进不了别的子系统**、`/healthz` 也在门禁后、
  带真 key 直达、身份是 `e2e` 且**非超管**。
- `specs/meetings.spec.ts` —— 会议模块那些**只能端到端验**的规则:
  忙闲按项目可见性分流(公开产生忙闲 / **私密完全隐形** / **响应里不含会议标题**)、
  多项目逐个验权、counter 必须带具体替代时间、取消不是删除、
  私聊只能发给发起人或记录员、看不见的会议回 404 而不是 403。

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
