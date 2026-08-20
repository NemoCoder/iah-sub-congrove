import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { showUser, showUserWithAccount } from './api.ts'

// ★2026-08-19 liaoruili:「记录员和参会人都使用中文,不要用账号」★
// 这两个函数的分工是产品要求,不是风格偏好 —— 所以钉在这里。

test('陈述事实处只显示姓名,不带账号', () => {
  assert.equal(showUser('liaoruili', '廖睿力'), '廖睿力')
  // ★反向对照★:判据要真能把「带了账号」判出来,否则这条测试是空的
  assert.ok(!showUser('liaoruili', '廖睿力').includes('liaoruili'))
})

test('没有姓名时退回账号 —— 一个人总得有个称呼', () => {
  assert.equal(showUser('liaoruili', null), 'liaoruili')
  assert.equal(showUser('liaoruili', undefined), 'liaoruili')
  // 平台/OIDC 拿不到真名时会把账号当名字灌进来,那等于没有姓名
  assert.equal(showUser('liaoruili', 'liaoruili'), 'liaoruili')
})

test('选人与管理操作处姓名在前、账号在括号里', () => {
  // ★账号在这里是**操作凭据**不是称呼★:搜人按账号搜,授撤超管/改配额要能唯一定位。
  assert.equal(showUserWithAccount('liaoruili', '廖睿力'), '廖睿力（liaoruili）')
  assert.equal(showUserWithAccount('liaoruili', null), 'liaoruili')
  assert.equal(showUserWithAccount('liaoruili', 'liaoruili'), 'liaoruili')
})
