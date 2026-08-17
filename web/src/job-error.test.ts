import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { 判阶段, 失败人话 } from './job-error.ts'

/// ★2026-08-17 prod 事故的复现用例★:这一条就是当时那串错误的原文。
/// 上一版把它翻成「语音识别服务暂时连不上」—— 而语音识别当时**是好的**,
/// Loki 里同一时段有四条 `ASR 响应自检 char_ts:3327`。
const 线上那条LLM错 =
  '生成 brief: LLM 返回 502 Bad Gateway:{"error":{"code":null,"message":"上游连接失败:ConnectError","type":"upstream_error"}}'
const 线上那条ASR错 =
  '转写第 1 段: ASR 返回 502 Bad Gateway:{"error":{"code":null,"message":"ASR 上游连接失败:ConnectError","type":"upstream_error"}}'

test('★LLM 的 502 不许冒充语音识别★（2026-08-17 prod 事故的复现）', () => {
  assert.equal(判阶段(线上那条LLM错), 'llm')
  const 话 = 失败人话(线上那条LLM错)
  assert.ok(!话.includes('语音识别服务'), `★又把 LLM 的故障说成语音识别了★: ${话}`)
  // ★必须说出「转写已完成」★:它决定用户接下来做什么(逐字稿其实已经有了)
  assert.ok(话.includes('转写已完成'), `没告诉用户逐字稿已经有了: ${话}`)
})

test('（正向对照）ASR 真的挂了时，还是要说语音识别', () => {
  // 没有这条，上面那条在「所有 502 都说成 AI 服务」时也会绿 —— 那等于把分类砍了而不是修对
  assert.equal(判阶段(线上那条ASR错), 'asr')
  assert.ok(失败人话(线上那条ASR错).includes('语音识别服务'))
})

test('★分不清哪一步时,别冒充任何一个具体服务★', () => {
  const 话 = 失败人话('502 Bad Gateway')
  assert.equal(判阶段('502 Bad Gateway'), '未知')
  assert.ok(话.includes('AI 服务'), 话)
  assert.ok(!话.includes('语音识别服务'), `★这正是上一版犯的错★: ${话}`)
})

test('★「压缩长转写」属于 LLM 不属于 ASR★——它带着「转写」二字,顺序写反就会判错', () => {
  assert.equal(判阶段('压缩长转写: LLM 返回 502 Bad Gateway'), 'llm')
})

test('其余几类各归各的', () => {
  assert.equal(判阶段('ffmpeg 抽音轨: 退出码 1'), '抽音轨')
  assert.ok(失败人话('ffmpeg 抽音轨: 退出码 1').includes('音轨提取失败'))
  assert.equal(判阶段('从对象存储取录屏: timeout'), '取文件')
  assert.ok(失败人话('从对象存储取录屏: 连不上').includes('取不到这个录制文件'))
  assert.ok(失败人话('转写结果为空(录屏可能没有人声)').includes('没识别出人声'))
})

test('超时也分阶段:LLM 超时要说逐字稿已经有了', () => {
  assert.ok(失败人话('生成 outline: 请求 LLM 网关: timeout').includes('转写已完成'))
  assert.ok(失败人话('请求 ASR 服务: timeout').includes('转写超时'))
})

test('空 / 认不出来的:不糊一整坨给用户', () => {
  assert.equal(失败人话(null), '未知原因')
  assert.equal(失败人话(''), '未知原因')
  const 长 = 'x'.repeat(200)
  assert.ok(失败人话(长).length <= 81, '认不出来的要截短')
})
