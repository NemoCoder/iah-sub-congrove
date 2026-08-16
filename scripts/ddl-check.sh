#!/usr/bin/env bash
# ADR-0001 的 DDL 纪律 —— ★写成闸,不写成一句话★。
#
# ⚠★2026-08-09 全量审计 A7★:ADR-0001 第 52 行白纸黑字写着
#   「新的 0001_init.sql **不许用** CREATE TABLE IF NOT EXISTS,一律裸 CREATE TABLE」,
# 而实际 24 个建表里 **19 个**还是 IF NOT EXISTS —— 只有 ADR 之后新加的 5 张是裸写。
# 规则被理解过,只是没回头改存量,而且**没有任何东西会发现这件事**。
#
# 为什么这条规则是承重的:清库五条只要漏一条(首次部署就漏过一次),
# IF NOT EXISTS 会让**老结构活下来**,迁移照样报成功、pod 照样起得来,而 schema 是错的;
# 裸 CREATE TABLE 则**响亮失败**。这道保险此前 19/24 是关着的。
#
# ★这就是「发现即门禁」★:人工审计发现一次,以后由脚本免费重跑。
set -euo pipefail
cd "$(dirname "$0")/.."

bad=$(grep -n "CREATE TABLE IF NOT EXISTS" migrations/*.sql || true)
if [ -n "$bad" ]; then
  echo "★DDL 门禁不通过★:ADR-0001 要求裸 CREATE TABLE(库没清干净时要**响亮失败**),下面这些是 IF NOT EXISTS:"
  echo "$bad"
  exit 1
fi

# ⚠★「migrations/ 里只该有一个文件」这一半已删★(2026-08-16)
#   —— 它是 ADR-0001 的另一半,而 ADR-0001 在 prod 通道开出来的那一刻就失效了。
#   这个脚本自己的注释当时写着「prod 通道开出来之后这条失效,那时请连同本脚本一起改」,
#   ★而没人真去改的话,它会在第一个 0002 出现时把**正当的改动**拦下来★ ——
#   本次热修(0002_app_setting.sql)当场撞上了它。
#   一道编码着过期规则的门禁,拦的不再是错误,而是正确的做法。

echo "★DDL 门禁通过★:$(grep -c '^CREATE TABLE' migrations/*.sql | awk -F: '{s+=$2} END{print s}') 个建表全是裸 CREATE TABLE,$(ls migrations/*.sql | wc -l) 个迁移文件"
