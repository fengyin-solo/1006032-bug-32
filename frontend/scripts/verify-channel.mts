import { strict as assert } from 'node:assert'
import {
  listEntries,
  runAction,
  listChannelOccupancies,
  listChannelOccupancyLedger,
} from '../src/api/local-service.ts'
import { saveRows, resetChannelLedger } from '../src/data/local-store.ts'
import { deriveChannelOccupancies, releasableBy, occupancyIndex } from '../src/data/channel.ts'
import type { EntryRow } from '../src/data/types.ts'

resetChannelLedger()

let pass = 0
function ok(name: string) {
  pass++
  console.log('  ✓', name)
}

function vipRows(): EntryRow[] {
  return listEntries('vip').items
}
function statusOf(id: number) {
  return String(vipRows().find((r) => Number(r.id) === id)!.status)
}
function heldChannels() {
  return listChannelOccupancies().map((o) => o.channel)
}
function ledgerKinds(channel: string) {
  return listChannelOccupancyLedger()
    .filter((e) => e.channel === channel)
    .map((e) => e.action)
}
function ledgerKindsFor(channel: string, orderId: number) {
  return listChannelOccupancyLedger()
    .filter((e) => e.channel === channel && e.orderId === orderId)
    .map((e) => e.action)
}

console.log('初始派生：id2 保障中占 V2、id3 待确认占 V3，id1 待准备不占 V1')
assert.deepEqual(heldChannels().sort(), ['V2', 'V3'])
ok('待准备不占通道；在途两单各自占用，占用由状态派生')

console.log('\n场景一：完成后通道仍被占、他人分配被占却查不到占用人')
let r = runAction('vip', 1, '开始准备') // id1 待准备→保障中，占 V1
assert.equal(r.ok, true, r.message)
ok('开始准备：待准备→保障中，占用 V1 落台账')
assert.ok(ledgerKindsFor('V1', 1).includes('占用'))

// 新保障单 id4 也要 V1
const rows4 = vipRows()
const seed4: EntryRow = {
  id: 4, status: '待准备', pending: true, abnormal: false,
  保障编号: 'VIP-20261004-004', 航班号: 'HU7801', 要客等级: '厅局级',
  接待单位: '市交通委', 引导人员: '孙岩', 专用通道: 'V1', 车辆安排: '轿车', 保障状态: '待准备',
}
saveRows('vip', [...rows4, seed4])
r = runAction('vip', 4, '开始准备')
assert.equal(r.ok, false)
assert.match(r.message, /VIP-20261004-001/)
assert.match(r.message, /省政府接待办/)
assert.match(r.message, /王立群/)
ok('V1 被占时新单分配被拒，且明确亮出占用单号、接待单位、引导人员')

// id1 走完：提交确认→待确认（仍占），确认完成→已完成（释放）
r = runAction('vip', 1, '提交确认')
assert.equal(r.ok, true, r.message)
assert.equal(statusOf(1), '待确认')
assert.ok(heldChannels().includes('V1'))
ok('提交确认：保障中→待确认，通道保持占用（不重复落占用账）')
assert.deepEqual(ledgerKindsFor('V1', 1).filter((k) => k === '占用'), ['占用'])

r = runAction('vip', 1, '确认完成')
assert.equal(r.ok, true, r.message)
assert.equal(statusOf(1), '已完成')
assert.ok(!heldChannels().includes('V1'))
ok('确认完成：待确认→已完成，V1 立即释放，占用列表可查（无幽灵占用）')
assert.deepEqual(ledgerKindsFor('V1', 1), ['释放', '占用'])

// 重复确认完成：只释放一次
r = runAction('vip', 1, '确认完成')
assert.equal(r.ok, false)
assert.deepEqual(ledgerKindsFor('V1', 1), ['释放', '占用'])
ok('重复确认完成被拒，通道只释放一次')

// V1 空出后 id4 可以分配
r = runAction('vip', 4, '开始准备')
assert.equal(r.ok, true, r.message)
assert.ok(heldChannels().includes('V1'))
assert.equal(listChannelOccupancies().find((o) => o.channel === 'V1')!.orderId, 4)
ok('释放后下一趟要客保障可立即分配 V1，占用人可查')

console.log('\n场景二：撤回后通道实际已空，系统仍按占用、调度干等')
r = runAction('vip', 2, '撤回') // id2 保障中→待准备
assert.equal(r.ok, true, r.message)
assert.equal(statusOf(2), '待准备')
assert.ok(!heldChannels().includes('V2'))
assert.deepEqual(ledgerKindsFor('V2', 2), ['释放', '占用'])
ok('撤回：保障中→待准备，V2 立即释放并落释放台账')

r = runAction('vip', 2, '撤回')
assert.equal(r.ok, false)
assert.deepEqual(ledgerKindsFor('V2', 2), ['释放', '占用'])
ok('重复撤回被拒，不重复释放')

// 已完成不许撤回（不能借撤回翻案）
r = runAction('vip', 1, '撤回')
assert.equal(r.ok, false)
ok('已完成的保障单不可撤回')

// 待确认撤回路径（id3）
r = runAction('vip', 3, '撤回')
assert.equal(r.ok, true, r.message)
assert.ok(!heldChannels().includes('V3'))
ok('待确认撤回同样立即释放 V3')

console.log('\n状态机：只能 待准备→保障中→待确认→已完成，不许跳步')
r = runAction('vip', 2, '确认完成') // id2 现在待准备，直接完成
assert.equal(r.ok, false)
assert.match(r.message, /顺次推进/)
r = runAction('vip', 2, '提交确认') // 待准备直接到待确认
assert.equal(r.ok, false)
ok('跳步动作被拒并提示下一步')

console.log('\n幂等不误伤：通道易主后旧单的释放闸门锁死')
// id4 保障中占 V1；构造"旧单 id1 视角"的释放检查（id1 已完成，V1 现在是 id4）
const idx = occupancyIndex(listChannelOccupancies())
const gate = releasableBy(idx, 'V1', 1)
assert.equal(gate.releasable, false)
assert.equal(gate.reason, 'taken-over')
assert.equal(gate.holder!.orderId, 4)
ok('旧单确认完成的释放若晚于新单占用，闸门判定 taken-over，绝不二次释放')

console.log('\n仲裁：同通道多单主张时，状态更靠后→更早登记（id小）者持占')
const conflict: EntryRow[] = [
  { id: 10, status: '保障中', pending: true, abnormal: false, 保障编号: 'A', 航班号: 'f1', 要客等级: 'x', 接待单位: 'x', 引导人员: 'x', 专用通道: 'VX', 车辆安排: '', 保障状态: '保障中' },
  { id: 11, status: '待确认', pending: true, abnormal: false, 保障编号: 'B', 航班号: 'f2', 要客等级: 'x', 接待单位: 'x', 引导人员: 'x', 专用通道: 'VX', 车辆安排: '', 保障状态: '待确认' },
]
let occ = deriveChannelOccupancies(conflict)
assert.equal(occ[0].orderId, 11)
assert.deepEqual(occ[0].conflictOrderIds, [10])
assert.equal(occ[0].conflict, true)
const sameStage: EntryRow[] = [
  { id: 12, status: '保障中', pending: true, abnormal: false, 保障编号: 'C', 航班号: 'f3', 要客等级: 'x', 接待单位: 'x', 引导人员: 'x', 专用通道: 'VY', 车辆安排: '', 保障状态: '保障中' },
  { id: 13, status: '保障中', pending: true, abnormal: false, 保障编号: 'D', 航班号: 'f4', 要客等级: 'x', 接待单位: 'x', 引导人员: 'x', 专用通道: 'VY', 车辆安排: '', 保障状态: '保障中' },
]
occ = deriveChannelOccupancies(sameStage)
assert.equal(occ[0].orderId, 12)
ok('同阶段时 id 更小（更早登记）的单持占，落败方标冲突')

console.log('\n列表去重：同一条保障单不重复显示')
const dup = vipRows()
saveRows('vip', [...dup, { ...dup[0] }])
assert.equal(listEntries('vip').total, dup.length)
ok('底层出现重复 id 时读取面按 id 去重')

console.log(`\n全部 ${pass} 项内层断言通过`)
