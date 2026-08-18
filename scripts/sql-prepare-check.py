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


def via_psql(dsn, sqls, pre=None):
    """给 CI 用：一次 psql 会话跑完全部 PREPARE，最快，且不需要平台令牌。

    ★`--pre <file>` 是这道闸最有用的用法★：先施加一段 schema 变更（DROP COLUMN /
    RENAME TABLE …），再跑全量 PREPARE，**最后 ROLLBACK**。于是「这个 schema 改动会打断哪些 SQL」
    由数据库**穷举**出来 —— 而不是由人去 grep 一张清单。
    PG 的 DDL 是事务性的，所以整段在 BEGIN…ROLLBACK 里跑，对库零影响（已实测）。

    这条正是相位 4 卡八轮的解药：`projects.visibility` 的引用面我先后写错三版
    （「没有语义」→「10 处」→「11+7」），三版都通不过评审。★清单不该由人写。★
    """
    # ⚠★两个 bug，都是第一次跑 --pre 时暴露的，而症状是**假绿**（报「207/207 通过」而其实什么都没测）★
    #
    # ① ★一条语句出错，整个事务就被中止★，后续全部 `current transaction is aborted`
    #    —— 穷举根本进行不下去。所以每条 PREPARE 各套一个 SAVEPOINT，错了只回滚到自己那一格。
    # ② stdout / stderr **分开捕获再拼接，交错顺序就丢了**：所有 `\echo` 标记排在前、
    #    所有错误排在后，于是错误全被记到最后一个下标上。必须 `stderr=STDOUT` 合流。
    #
    # ★教训：一道门禁的**失败路径**必须单独验过。★ 这条 psql 路此前只在「全通过」时跑过，
    # 于是坏了也看不出来；真正抓到 D4 那个 bug 的是另一条（registry）路。
    head = 'BEGIN;\n' + (pre + '\n' if pre else '')
    body = '\n'.join(f"\\echo ___{i}___\nSAVEPOINT sp;\nPREPARE _c{i} AS {s};\nROLLBACK TO SAVEPOINT sp;"
                     for i, s in enumerate(sqls))
    p = subprocess.run(['psql', dsn, '-v', 'ON_ERROR_STOP=0', '-q', '-f', '-'],
                       input=head + body + '\nROLLBACK;', text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    fails, cur, seen = {}, None, 0
    for line in p.stdout.split('\n'):
        if m := re.match(r'___(\d+)___', line): cur = int(m.group(1)); seen += 1
        # ⚠★psql 的错误行带前缀★:`psql:<stdin>:5: ERROR:  relation … does not exist`
        #   —— 判 `startswith('ERROR:')` 一条都匹配不上,于是**每次都报全过**。
        elif (m := re.search(r'\bERROR:\s+(.*)', line)) and cur is not None:
            fails.setdefault(cur, m.group(1))
    # ★没跑 ≠ 全过★:这是本脚本最重要的一条自检。
    # 之前 psql 路整条不工作(错误全没匹配上)时,它照样打印「207/207 通过」——
    # 而我拿 `DROP TABLE projects CASCADE` 当输入,它**还是**说通过。
    # 一道会把「什么都没检查」报成绿的门禁,比没有门禁更糟。
    if seen != len(sqls):
        print(f'★检查没有真正跑起来:预期 {len(sqls)} 个标记,只看到 {seen} 个★', file=sys.stderr)
        print(p.stdout[:1500], file=sys.stderr); sys.exit(2)
    return fails


def via_registry(sqls):
    """本地用：走平台的 dev-only db/sql 端点，一条一个请求（并发 8）。"""
    # ★令牌兜底读文件★(2026-08-17):此前只认环境变量,忘了 export 就直接 exit 2 ——
    #   而 all-gates 会把它显示成一道**红闸**,读的人会去查代码里哪条 SQL 错了,
    #   ★而真相只是「我没 export 一个变量」★。这类假红比不红更浪费时间。
    #   与 scripts/dbq.py 用同一个兜底路径,两处别分叉。
    tok = os.environ.get('IAH_TOKEN')
    if not tok:
        _p = pathlib.Path.home() / '.config/iah/congrove-token'
        if _p.exists(): tok = _p.read_text().strip()
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
    dsn = os.environ.get('CONGROVE_DEV_DSN')
    if '--dsn' in sys.argv: dsn = sys.argv[sys.argv.index('--dsn') + 1]
    pre = None
    if '--pre' in sys.argv:
        pre = pathlib.Path(sys.argv[sys.argv.index('--pre') + 1]).read_text()
        if not dsn:
            print('--pre 需要 --dsn / CONGROVE_DEV_DSN（要在一条事务里施加变更再回滚）', file=sys.stderr); sys.exit(2)
        print(f'★先施加 schema 变更再检查，最后 ROLLBACK★\n{pre.strip()}\n{"─" * 60}')
    fails = via_psql(dsn, sqls, pre) if dsn else via_registry(sqls)
    for i in sorted(fails):
        it = items[i]
        print(f"✗ {it['file']}:{it['line']}\n    {' '.join(it['sql'].split())[:150]}\n    → {fails[i]}")
    n = len(items)
    if fails:
        print(f'\n★{len(fails)}/{n} 条 SQL 对不上 schema —— 门禁不通过★', file=sys.stderr); sys.exit(1)
    print(f'\n★{n}/{n} 条 SQL 全部通过 PREPARE —— 门禁通过★')


if __name__ == '__main__':
    main()
