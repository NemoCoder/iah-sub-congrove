#!/usr/bin/env python3
# ★门禁一：全部 SQL 对**真库** PREPARE★（2026-08-08）
#
# 用法：
#   python3 scripts/sql-prepare-check.py                       # 打 dev 通道（走 registry db/sql）
#   python3 scripts/sql-prepare-check.py --dsn postgres://…    # 打任意库（走 psql，给 CI 的临时库用）
# exit 0 = 全部通过；exit 1 = 有 SQL 对不上 schema；exit 2 = 抽取前提被打破（见 sql-inventory.py）。
#
# ══════ 这道闸解决什么 ══════
#
# 我们全用 sqlx 的 runtime 查询（没有 `sqlx::query!` 宏），所以**改 SQL 编译器不报错，
# 只在运行时 500**。改名 / 删列这类重构的典型失败模式就是：
# ★某个冷门端点的 SQL 漏改了，没人访问，所以没人发现★ —— 直到用户撞上。
#
# `PREPARE` 会做**完整语义分析但不执行**（PG 文档原话：parsed, analyzed, and rewritten；
# 真正 plan + execute 要等 EXECUTE）。表不存在、列不存在、类型不匹配，全在这一步炸。
# 于是覆盖率是 **208/208**，且**完全不依赖测试覆盖到哪些路径** —— 这是任何 E2E 都给不了的性质。
#
# ══════ 判定力边界（写清楚，别当万能）══════
#
# 抓得到：表名/列名/函数名错、类型不兼容、语法错、聚合/GROUP BY 违规。
# ★抓不到★：Rust 侧解码类型与列类型不匹配 —— `query_as::<_, (String, String)>` 拿到 int8
# 仍会在运行时炸。那一层要么靠具名测试，要么把 `PREPARE` 返回的列类型也快照下来（未做，记在这）。
# ★也抓不到★：`$N` 参数的类型推断分歧 —— sqlx 在 Parse 时会把 Rust 侧绑定的类型 OID 报给 PG，
# 而我们这里不报，所以极少数「PG 自己推不出参数类型」的查询会假红。真遇到就在 SQL 里补 `::type`
# 转换（那本来也是更好的写法），别加豁免名单。
import json, os, re, subprocess, sys, urllib.request, ssl, concurrent.futures as cf, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
REG = 'https://registry.ruciah.com/api/subsystems/congrove/db/sql'


def inventory():
    r = subprocess.run([sys.executable, str(ROOT / 'scripts/sql-inventory.py'), '--json'],
                       capture_output=True, text=True)
    if r.returncode: sys.stderr.write(r.stderr); sys.exit(2)
    return json.loads(r.stdout)


def via_psql(dsn, sqls):
    """给 CI 用：一次 psql 会话跑完全部 PREPARE，最快，且不需要平台令牌。"""
    # 每条前后加一个 \echo 标记，好把错误对回条目
    script = '\n'.join(f"\\echo ___{i}___\nPREPARE _c{i} AS {s};" for i, s in enumerate(sqls))
    p = subprocess.run(['psql', dsn, '-v', 'ON_ERROR_STOP=0', '-q', '-f', '-'],
                       input=script, capture_output=True, text=True)
    fails, cur = {}, None
    for line in (p.stdout + p.stderr).split('\n'):
        if m := re.match(r'___(\d+)___', line): cur = int(m.group(1))
        elif line.startswith('ERROR:') and cur is not None: fails.setdefault(cur, line)
    return fails


def via_registry(sqls):
    """本地用：走平台的 dev-only db/sql 端点，一条一个请求（并发 8）。"""
    tok = os.environ.get('IAH_TOKEN')
    if not tok:
        print('缺 IAH_TOKEN（门户「日志」页生成的个人令牌）；或改用 --dsn', file=sys.stderr); sys.exit(2)
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

    def one(i_s):
        i, s = i_s
        body = json.dumps({'channel': 'dev', 'sql': f'PREPARE _c{i} AS {s}'}).encode()
        req = urllib.request.Request(REG, body, {'Authorization': 'Bearer ' + tok,
                                                 'Content-Type': 'application/json'})
        try:
            d = json.loads(urllib.request.urlopen(req, context=ctx, timeout=60).read())
        except urllib.error.HTTPError as e:
            # ★SQL 出错时端点回 400,而真正的报错在 **body** 里★——只报 `HTTP Error 400`
            # 等于把这道闸最有用的东西(哪一列不存在)扔了。第一次跑就踩到,记在这。
            try: d = json.loads(e.read())
            except Exception: return i, f'HTTP {e.code}'
        except Exception as e:
            return i, f'请求失败: {e}'
        return (i, None) if d.get('ok') else (i, (d.get('error') or '').split('\n')[0])

    with cf.ThreadPoolExecutor(8) as ex:
        return {i: e for i, e in ex.map(one, enumerate(sqls)) if e}


def main():
    items = inventory()
    sqls = [it['sql'] for it in items]
    dsn = None
    if '--dsn' in sys.argv: dsn = sys.argv[sys.argv.index('--dsn') + 1]
    fails = via_psql(dsn, sqls) if dsn else via_registry(sqls)
    for i in sorted(fails):
        it = items[i]
        print(f"✗ {it['file']}:{it['line']}\n    {' '.join(it['sql'].split())[:150]}\n    → {fails[i]}")
    n = len(items)
    if fails:
        print(f'\n★{len(fails)}/{n} 条 SQL 对不上 schema —— 门禁不通过★', file=sys.stderr); sys.exit(1)
    print(f'\n★{n}/{n} 条 SQL 全部通过 PREPARE —— 门禁通过★')


if __name__ == '__main__':
    main()
