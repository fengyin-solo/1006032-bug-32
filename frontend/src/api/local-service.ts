import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  STAND_CHANNEL_LEDGER_KEY,
  VIP_WITHDRAWN,
  canWithdrawVip,
  channelHolder,
  deriveChannelLedger,
  isHoldingStatus,
  nextVipStatus,
} from '@/data/vip-channel'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '撤回', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  const items = key === 'vip' ? enrichVipRows(matched) : matched
  return { items, total: items.length, page: 1, size: items.length }
}

/**
 * 给要客保障单挂上派生的「通道占用」列：不占存储、不落库，每次读取现算。
 * 不管按要客等级、接待单位还是引导人员哪一处查，读到的通道占用都是这同一份。
 */
function enrichVipRows(rows: EntryRow[]): EntryRow[] {
  const all = listRows('vip')
  return rows.map((row) => {
    const channel = String(row['专用通道'] ?? '').trim()
    let occupancy = '—'
    if (channel) {
      if (isHoldingStatus(String(row.status))) {
        occupancy = '占用中（本单持有）'
      } else {
        const holder = channelHolder(all, channel, Number(row.id))
        occupancy = holder ? `被 ${String(holder['保障编号'] ?? '')} 占用` : '空闲（已释放）'
      }
    }
    return { ...row, 通道占用: occupancy }
  })
}

/**
 * 把通道占用的派生结果整体重建并落到停机位占用台账。
 * 台账只是要客保障单状态的投影：每次保障单状态变化后整体重算、整份覆盖，
 * 不逐条增删，所以确认完成 / 撤回保障的释放一定落账，也绝不会把通道的新一轮占用误放掉。
 */
export function refreshStandChannelLedger(): EntryRow[] {
  const ledger = deriveChannelLedger(listRows('vip'))
  saveRows(STAND_CHANNEL_LEDGER_KEY, ledger)
  return ledger
}

/**
 * 停机位（机位分配页）与廊桥靠接页读通道占用的唯一入口：
 * 每次都先从要客保障单重算再落台账，两处读到的必然是同一份。
 */
export function listStandChannelLedger(): EntryRow[] {
  return refreshStandChannelLedger()
}

/**
 * 这条记录当前可执行的动作，页面只渲染、不自己判断。
 * 要客保障单按顺次推进算：只给下一格的动作，持有通道期间另给「撤回保障」，
 * 终结态（已完成 / 已撤回）没有动作可点——点确认没反应的毛病从根上消掉。
 */
export function availableActions(key: string, row: EntryRow): string[] {
  const meta = moduleMeta(key)
  if (key !== 'vip') {
    return meta.actions
  }
  const current = String(row.status)
  const actions: string[] = []
  const next = nextVipStatus(current)
  if (next !== null) {
    const forward = Object.entries(meta.actionTargets).find(([, target]) => target === next)
    if (forward) {
      actions.push(forward[0])
    }
  }
  if (canWithdrawVip(current)) {
    actions.push('撤回保障')
  }
  return actions
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === 'vip') {
    return runVipAction(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 要客保障单专用流转：顺次推进 + 通道占用派生 + 台账落盘，三件事在同一笔写里完成。
 * 通道占用由保障单状态派生（仲裁规则见 data/vip-channel.ts 头部），这里只改保障单状态，
 * 改完整体重建停机位占用台账——通道那一份永远跟着保障单走，不存在两套各存一份。
 */
function runVipAction(id: number, action: string): ActionResult {
  const meta = moduleMeta('vip')
  const rows = listRows('vip')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的要客保障单` }
  }
  const row = rows[index]
  const current = String(row.status)
  const channel = String(row['专用通道'] ?? '').trim()

  // 撤回：持有通道期间（待准备/保障中/待确认）可撤回；状态改成「已撤回」，
  // 派生层面通道即空出，台账随下面的整体重建落账，调度不用再干等。
  if (action === '撤回保障') {
    if (current === VIP_WITHDRAWN) {
      return { ok: false, message: '要客保障单已经是「已撤回」，不用重复操作' }
    }
    if (!canWithdrawVip(current)) {
      return { ok: false, message: `要客保障单已「${current}」，流程已终结，不能撤回` }
    }
    const next = [...rows]
    next[index] = { ...row, status: VIP_WITHDRAWN, pending: false, abnormal: true }
    saveRows('vip', next)
    refreshStandChannelLedger()
    return { ok: true, message: `要客保障单已撤回，专用通道「${channel}」已释放并记入停机位占用台账` }
  }

  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `要客保障单没有登记「${action}」这个动作` }
  }

  // 重复确认完成在这里被拦下：通道只随第一次推进释放一次，
  // 第二次确认直接拒绝，不会误伤这条通道上新登记的要客保障。
  if (current === target) {
    return { ok: false, message: `要客保障单已经是「${target}」，不用重复操作；通道只释放一次，不会影响后续占用` }
  }

  // 顺次推进，不许跳步：目标必须是当前状态的下一格（待准备→保障中→待确认→已完成）。
  const expected = nextVipStatus(current)
  if (expected === null) {
    return { ok: false, message: `要客保障单已「${current}」，流程已终结，不能再${action}` }
  }
  if (target !== expected) {
    return { ok: false, message: `要客保障单只能顺次推进：当前「${current}」，下一步只能到「${expected}」，不许跳到「${target}」` }
  }

  // 进入持有区间前查通道冲突：被占时点名是谁占的，列表与台账里也能查到同一张单。
  if (isHoldingStatus(target) && channel) {
    const holder = channelHolder(rows, channel, id)
    if (holder) {
      return {
        ok: false,
        message: `专用通道「${channel}」正被保障单 ${String(holder['保障编号'] ?? '')}（${String(holder['航班号'] ?? '')}，当前「${String(holder.status)}」）占用，等它完成或撤回后再分配`,
      }
    }
  }

  const next = [...rows]
  next[index] = { ...row, status: target, pending: isHoldingStatus(target), abnormal: false }
  saveRows('vip', next)
  refreshStandChannelLedger()
  const released = target === '已完成' && channel ? `，专用通道「${channel}」已释放并记入停机位占用台账` : ''
  return { ok: true, message: `要客保障单已${action}，当前状态「${target}」${released}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === 'vip') {
    // 保障单回到示例数据后，通道台账跟着整体重建，两份永远不岔开。
    refreshStandChannelLedger()
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
