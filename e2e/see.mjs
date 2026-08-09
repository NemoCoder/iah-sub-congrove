#!/usr/bin/env node
// ★让本地 VL 模型替我看截图★ —— `Qwen3.6-27B-FP8`,走平台的 LLM 网关(llm.ruciah.com)。
//
// ══════ 为什么要有这个 ══════
// 巡查 UI 有三条互补的通道,少哪条都会漏:
//   ① **DOM 断言**——精确(能说出「差了 37px」),但★只看得见我想到要查的东西★;
//   ② **VL 模型**——看得见我没想到的。实测第一次用它就抓到一处:我的选择器判定
//      「今天那一列没有高亮」(返回 null,其实是选择器写错了),而它一眼看出那列有淡青色背景;
//   ③ **人**——审美与「这样对不对」的判断,那是 liaoruili 的事,浏览器就开在他旁边。
//
// 顺带解决一个硬约束:Claude 一段会话里的图片是**累计**的(API 无状态,每轮重发整段对话),
// 撞上限之后还会陷进「图处理失败→每轮重试→烧额度」那个已知坑。把看图外包出去,这条路彻底绕开。
//
// ⚠ 提问要**只问看得见的事实**,别问「这样好不好看」——后者它会顺着你说。
//   ★而且必须留出足够的 max_tokens★:Qwen3.6 会把推理过程一并写出来,给 400 会在半句话处被截断。
//
// 用法:
//   node e2e/see.mjs /tmp/walk-01-schedule.png "顶部那条黄色横条上写的完整文字是什么?"
//   IAH_LLM_KEY=sk-iah-… node e2e/see.mjs <png> <问题>
import { readFileSync } from 'node:fs'
import https from 'node:https'

const KEY = process.env.IAH_LLM_KEY ?? readFileSync(process.env.IAH_LLM_KEY_FILE ?? `${process.env.HOME}/.config/iah/llm.key`, 'utf8').trim()
const CA = readFileSync(process.env.IAH_CA ?? `${process.env.HOME}/.config/iah/IAH-Internal-CA-new.crt`)
const [img, ...q] = process.argv.slice(2)
if (!img || !q.length) { console.error('用法: node e2e/see.mjs <图片> <问题>'); process.exit(2) }

/// ★为什么用 node:https 而不是 fetch★:llm.ruciah.com 是内网自签 CA,而 `NODE_EXTRA_CA_CERTS`
/// **必须在 node 启动前**就设好 —— 在脚本里 `process.env.X=…` 太晚了(TLS 上下文早建完了),
/// 实测就是这么撞的 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。
/// 换成显式传 `ca` 让这个脚本自足:调用者不必记得任何环境变量。
/// ★绝不用 rejectUnauthorized:false 兜底★ —— 那会让它连到任何地方都「能跑」,
/// 包括连错地方的时候。(CA 要用**重签后带 keyUsage** 的那张,旧的在新 OpenSSL 下会被拒。)
const post = (body) => new Promise((res, rej) => {
  const req = https.request('https://llm.ruciah.com/v1/chat/completions',
    { method: 'POST', ca: CA, timeout: 300_000, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' } },
    (r) => { let s = ''; r.on('data', (c) => (s += c)); r.on('end', () => res({ status: r.statusCode, body: s })) })
  req.on('error', rej); req.on('timeout', () => { req.destroy(new Error('超时')) })
  req.end(body)
})

const b64 = readFileSync(img).toString('base64')
const t0 = Date.now()
const r = await post(JSON.stringify({
  model: process.env.IAH_VL_MODEL ?? 'Qwen3.6-27B-FP8',
  max_tokens: 1500,
  // Qwen3 系是**思考型**模型:默认会把整段推理写进正文,答案埋在最后一段,
  // 而且很容易把 max_tokens 吃光在半句话处截断。vLLM 认这个开关,关掉直接出结论。
  chat_template_kwargs: { enable_thinking: false },
  messages: [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
      // ★「看不清就说看不清」不是客套★:VL 模型最贵的错误是**言之凿凿地编**一个界面上没有的元素,
      // 而那种答案读起来和真的一模一样。明写这一句能把一部分幻觉逼成「看不清」。
      { type: 'text', text: `${q.join(' ')}\n\n只回答你在图上**实际看到**的;看不清就直说看不清,不要推测、不要补全。先给结论,再给依据,总共不超过 200 字。` },
    ],
  }],
}))
if (r.status !== 200) { console.error(`HTTP ${r.status}`, r.body.slice(0, 400)); process.exit(1) }
const j = JSON.parse(r.body)
const out = j.choices?.[0]?.message?.content ?? r.body.slice(0, 400)
console.error(`[${((Date.now() - t0) / 1000).toFixed(1)}s · ${j.usage?.prompt_tokens ?? '?'}→${j.usage?.completion_tokens ?? '?'} tok]`)
console.log(out.trim())
