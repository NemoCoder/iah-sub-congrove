#!/usr/bin/env python3
"""对 dev 库跑一段 SQL —— ★走平台的 `db/sql` 接口,不直连★。

用法(输出**刻意做成与 `psql -At` 一致**:无表头、列间 TAB、行间换行):
    python3 scripts/dbq.py -c "SELECT 1"        # 一条语句
    python3 scripts/dbq.py -f 某个.sql          # 一个文件
    echo "SQL" | python3 scripts/dbq.py         # 标准输入
exit 0 = 成功;exit 2 = 连不上 / 令牌缺失 / SQL 报错(★「量不到」一律非零,绝不静默当空★)。

══ 为什么不直连 psql ══
2026-08-17:iah101 加入集群成为节点之后,它去 `data` 命名空间的 pod 改走 VXLAN overlay,
源 IP 变成 flannel.1 的 pod 网段地址,而 `data-tier-isolation` 这条 NetworkPolicy 只放行
**内网网段**(不含 pod 网段)+ 若干命名空间 —— 于是**从 iah101 直连 PG 全部超时**。

★我一开始的反应是去请平台改那条 NP,而 liaoruili 问了一句「你需要实现什么功能」★——
一查:没有任何**产品功能**需要它,只有这几道开发期门禁需要。
而平台早就有 `POST /api/subsystems/{slug}/db/sql`(dev-only,prod 403),
`sql-prepare-check.py` **本来就默认走它**。⇒ 请人改安全策略这件事是多余的,已在群里撤回。

★教训:遇到「连不上」先问「我到底需不需要这条路」,别直接跳到「怎么把这条路修通」。★

══ 换过来还有一个副作用是好的 ══
这几道门禁**进不了 CI 的唯一原因就是「要活库」**(平台待办 O2「CI 挂一个测试 PG」)。
走 HTTP 之后它们不再需要直连库,★有机会直接搬进 CI,不必等那个测试 PG★。
"""
import json, os, ssl, sys, urllib.request, pathlib


def 炸(msg: str):
    """★统一用 exit 2★——文件头注承诺的就是 2(「量不到」)。
    ⚠ 初版用了 `sys.exit("字符串")`,那退出码是 **1**,和头注写的 2 对不上;
      而调用方(all-gates)靠退出码分「红」和「未跑」,对不上就会把「量不到」显示成「红」。
      ★一个自己都不遵守的契约,比没有契约更坏。★"""
    sys.stderr.write(msg + '\n'); sys.exit(2)

REG = os.environ.get('IAH_DB_SQL_URL', 'https://registry.ruciah.com/api/subsystems/congrove/db/sql')
CA = os.environ.get('IAH_CA', str(pathlib.Path.home() / '.config/iah/IAH-Internal-CA-new.crt'))


def 取令牌() -> str:
    t = os.environ.get('IAH_TOKEN')
    if t: return t.strip()
    p = pathlib.Path.home() / '.config/iah/congrove-token'
    if p.exists(): return p.read_text().strip()
    炸('★缺 IAH_TOKEN★(门户「日志」页生成),或放到 ~/.config/iah/congrove-token')


def 跑(sql: str, channel: str = 'dev') -> list:
    ctx = ssl.create_default_context(cafile=CA) if pathlib.Path(CA).exists() else ssl.create_default_context()
    req = urllib.request.Request(REG, method='POST',
        data=json.dumps({'channel': channel, 'sql': sql}).encode(),
        headers={'Authorization': f'Bearer {取令牌()}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=180, context=ctx) as r:
            d = json.load(r)
    except Exception as e:
        # ★连不上不是「没有差异」★:一律非零退出,让调用方报「量不到」而不是「通过」
        炸(f'★连不上 db/sql 接口:{e}★')
    if not d.get('ok'):
        炸(f"★SQL 报错★:{d.get('error', d)}")
    if d.get('truncated'):
        # 结果被截断却当成全量比对 = 假绿。宁可炸。
        炸('★结果被服务端截断(truncated=true),不能当成完整结果★')
    return d.get('rows') or []


def 成psql格式(rows: list) -> str:
    # psql -At:无表头、列间 TAB、NULL 印成空串
    return '\n'.join('\t'.join('' if c is None else str(c) for c in row) for row in rows)


if __name__ == '__main__':
    a = sys.argv[1:]
    if a[:1] == ['-c']: sql = a[1]
    elif a[:1] == ['-f']: sql = pathlib.Path(a[1]).read_text()
    else: sql = sys.stdin.read()
    out = 成psql格式(跑(sql))
    if out: print(out)
