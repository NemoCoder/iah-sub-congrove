#!/usr/bin/env python3
# 把 oasdiff 的 JSON 输出压成可比对的规范行（与 oasdiff --err-ignore 的匹配串同形）。
#
# ★拆成独立文件而不是内嵌进 shell★：内嵌那版因为 f-string 里的转义引号有语法错，
# python 直接崩、输出为空，于是门禁把「什么都没检查」判成了「无破坏性变更」——
# ★同一类假绿这是第三次★（前两次在 sql-prepare-check.py 和它的 psql 路上）。
import json, sys
d = json.load(sys.stdin) or []
for x in sorted(d, key=lambda x: (x.get('path', ''), x.get('operation', ''), x['id'])):
    print(f"in api {x.get('operation', '').lower()} {x.get('path', '')} {x['text']}")
