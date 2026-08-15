// ★浏览器端点的唯一来源:仓库**外**的配置★(2026-08-15)。
//
// ══ 为什么不能写在仓库里 ══
// 这个仓库三推 Gitea(内网)+ Gitee + GitHub。★后两个是外部仓,推上去就等于把内网地址发出内网★
// (全局约定:「仓库含内网 IP/拓扑时尤其注意 —— Gitee/GitHub 是外部仓,外推即出内网」)。
// 在此之前 `ws://<内网地址>:9333/congrove` 这一串在 11 个已跟踪文件里写死了 14 遍,
// 连一句 `ssh <用户名>@<内网地址>` 都进了仓库 —— 地址 + 用户名 + 用途,一次给全。
// ⚠ 顺带还有个纯工程上的好处:换网时那台机器的地址**变过一次**(整个网段改号),
//   14 处逐个改一遍;现在改一行配置。
//
// 配置放 `~/.config/iah/congrove-e2e.env`(与 CA、E2E key 同一个目录,那里本来就是放凭证的):
//   PW_WS=ws://<那台测试机>:9333/congrove
//   PW_SSH=<用户名>@<那台测试机>          # 只用于「浏览器挂了怎么重启」那句提示,可不配
//
// ★读不到就报错,不给默认值★:默认值意味着「我以为连的是 A,其实连的是 B」,
// 而这类错的表现是测试**在错误的地方绿**。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const 配置文件 = `${homedir()}/.config/iah/congrove-e2e.env`

function 读配置(键) {
  if (process.env[键]) return process.env[键]
  try {
    const m = readFileSync(配置文件, 'utf8').match(new RegExp(`^\\s*${键}\\s*=\\s*(.+)$`, 'm'))
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  } catch { /* 文件不在,落到调用方处理 */ }
  return null
}

/// 有头浏览器的 CDP/WS 端点。拿不到就**中止**,并说清怎么配。
export function pwWs() {
  const v = 读配置('PW_WS')
  if (!v) {
    throw new Error(
      `★拿不到浏览器端点★:环境变量 PW_WS 没设,${配置文件} 里也没有。\n` +
      `  写一行:PW_WS=ws://<测试机地址>:9333/congrove\n` +
      `  (地址不入库 —— 本仓外推 Gitee/GitHub,内网地址进仓库就等于发出内网。)`)
  }
  return v
}

/// 「浏览器没响应时怎么重启」那句提示里用的 ssh 目标;没配就返回 null(提示里省掉那一行)。
export function pwSsh() { return 读配置('PW_SSH') }
