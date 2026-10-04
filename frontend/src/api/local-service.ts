import {
  VIP_FLIGHT_FIELD,
  VIP_GUIDE_FIELD,
  VIP_LEVEL_FIELD,
  VIP_MODULE_KEY,
  VIP_ORDER_FIELD,
  VIP_RECEPT_UNIT_FIELD,
  channelAssignable,
  deriveChannelOccupancies,
  occupancyIndex,
  readVipSnapshot,
  releasableBy,
} from '@/data/channel'
import {
  appendChannelLedger,
  listChannelLedger,
  listRows,
  resetRows,
  saveRows,
  allRows,
} from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type {
  ActionResult,
  ChannelLedgerEntry,
  ChannelOccupancy,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

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

// 按业务编号去重：同一保障单在底层只允许读出一条，杜绝「同一条保障单重复显示」。
function dedupeById(rows: EntryRow[]): EntryRow[] {
  const seen = new Set<number>()
  const result: EntryRow[] = []
  for (const row of rows) {
    const id = Number(row.id)
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    result.push(row)
  }
  return result
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(dedupeById(listRows(key)), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
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

  // 要客保障单走专用状态机：顺次推进 + 通道占用由状态派生 + 撤回/完成释放台账。
  if (key === VIP_MODULE_KEY) {
    return runVipAction(meta, rows, index, action, target, current)
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

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

// 要客保障单专属流转：状态是唯一事实源，通道占用、台账都按状态派生落账。
function runVipAction(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  action: string,
  target: string,
  current: string,
): ActionResult {
  const isRollback = meta.rollbackActions?.includes(action) ?? false

  if (isRollback) {
    // 撤回是特许回退：仅「保障中」「待确认」可撤回；待准备无需撤，已完成不许翻案。
    if (action === '撤回' && current !== '保障中' && current !== '待确认') {
      return {
        ok: false,
        message: `只有「保障中」「待确认」的保障单可以撤回，当前状态「${current}」`,
      }
    }
  } else {
    // 顺次推进守卫：待准备→保障中→待确认→已完成，只许走相邻一步，不许跳步。
    const fromIndex = meta.statuses.indexOf(current)
    const toIndex = meta.statuses.indexOf(target)
    if (fromIndex < 0 || toIndex !== fromIndex + 1) {
      const nextStatus = fromIndex >= 0 ? meta.statuses[fromIndex + 1] : undefined
      return nextStatus
        ? {
            ok: false,
            message: `保障单状态只能顺次推进，当前「${current}」的下一步是「${nextStatus}」，不能直接${action}到「${target}」`,
          }
        : { ok: false, message: `保障单已到终态「${current}」，不能再执行「${action}」` }
    }
  }

  const snapshot = readVipSnapshot(rows[index])
  // 通道占用一律从「动作前」的保障单状态实时派生，不读任何历史占用标记。
  const occupancies = deriveChannelOccupancies(rows)
  const occupied = occupancyIndex(occupancies)

  // 开始准备＝分配专用通道：通道被别的在途保障单占着就拒绝，并把占用人亮出来。
  if (action === '开始准备' && snapshot.通道.trim() !== '') {
    const check = channelAssignable(occupied, snapshot.通道, snapshot.orderId)
    if (!check.assignable && check.holder) {
      const holder = check.holder
      return {
        ok: false,
        message: `专用通道「${snapshot.通道}」仍被保障单 ${holder.保障编号} 占用（航班 ${holder.航班号}，${holder.status}）——要客等级：${holder.要客等级}；接待单位：${holder.接待单位}；引导人员：${holder.引导人员}。需等其确认完成或撤回释放后再分配。`,
      }
    }
  }

  // 先落保障单状态：这是唯一可写的事实源。
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: isRollback ? true : target !== lastStatus,
    // 撤回是正常调度回退，不是异常；不沿用通用负向动作的异常标记。
    abnormal: false,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows(VIP_MODULE_KEY, nextRows)

  // 再按状态派生结果补停机位侧占用台账；提交确认（保障中→待确认）通道持占不变，不落账。
  let ledgerHint = ''
  const channel = snapshot.通道.trim()
  if (channel !== '') {
    const baseLedger = {
      time: nowText(),
      channel,
      orderId: snapshot.orderId,
      [VIP_ORDER_FIELD]: snapshot.保障编号,
      [VIP_FLIGHT_FIELD]: snapshot.航班号,
      [VIP_LEVEL_FIELD]: snapshot.要客等级,
      [VIP_RECEPT_UNIT_FIELD]: snapshot.接待单位,
      [VIP_GUIDE_FIELD]: snapshot.引导人员,
    }
    if (action === '开始准备') {
      appendChannelLedger({ ...baseLedger, action: '占用', note: '保障单进入保障中，专用通道占用' })
      ledgerHint = `，专用通道「${channel}」已占用并记入停机位占用台账`
    } else if (action === '确认完成' || action === '撤回') {
      // 幂等释放闸门：只释放当前确由本单持占的通道。
      const gate = releasableBy(occupied, channel, snapshot.orderId)
      if (gate.releasable) {
        const note = action === '确认完成' ? '保障单确认完成，专用通道释放' : '保障单撤回，专用通道释放'
        appendChannelLedger({ ...baseLedger, action: '释放', note })
        ledgerHint = `，专用通道「${channel}」已释放并记入停机位占用台账`
      } else if (gate.reason === 'taken-over' && gate.holder) {
        // 通道已被更新的保障单占用：绝不二次释放、误伤新占用。
        ledgerHint = `；检测到通道「${channel}」已转由保障单 ${gate.holder.保障编号} 占用，本次未重复释放`
      }
    }
  }

  return {
    ok: true,
    message: `要客保障单已${action}，当前状态「${target}」${ledgerHint}`,
  }
}

// ── 专用通道占用的唯一读取面：要客页、停机位、廊桥靠接都从这里取数，三处同源 ──

export function listChannelOccupancies(): ChannelOccupancy[] {
  return deriveChannelOccupancies(listRows(VIP_MODULE_KEY))
}

export function channelOccupancyByOrder(): Map<number, ChannelOccupancy> {
  const map = new Map<number, ChannelOccupancy>()
  for (const item of listChannelOccupancies()) {
    map.set(item.orderId, item)
  }
  return map
}

export function listChannelOccupancyLedger(): ChannelLedgerEntry[] {
  // 台账只做留痕；当前占用仍以保障单状态派生为准（冲突时以保障单状态仲裁）。
  return [...listChannelLedger()].sort((a, b) => b.id - a.id)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

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
