import type { ChannelLedgerEntry, ChannelOccupancy, EntryRow } from './types'

/**
 * 专用通道占用 —— 仲裁规则（全系统唯一事实源）
 *
 * 1. 通道占用不再单独存一份，完全由要客保障单状态派生：
 *    只有「保障中」「待确认」的保障单主张占用其登记的专用通道；
 *    「待准备」「已完成」不占用任何通道。撤回回到「待准备」即释放，
 *    确认完成进入「已完成」即释放——两个出口同源于状态，不允许再各存一份。
 * 2. 要客等级、接待单位、引导人员三处读到的通道占用，全部取本模块的派生结果，
 *    不允许各自维护。
 * 3. 通道占用与保障单状态冲突时，一律以保障单状态为准仲裁：
 *    通道台账/页面上若还挂着占用、但已没有在途保障单主张，则视为已释放；
 *    同一条通道被多张在途保障单主张（异常数据）时，按
 *      状态推进更靠后者优先 → 保障单 id 更小（更早登记）者优先
 *    的固定顺序裁定持单方，落败方标 conflict，页面给出冲突告警，不静默吞掉。
 * 4. 释放幂等：只有当前确由本单持占的通道才允许落「释放」，
 *    重复确认完成/重复撤回不会第二次释放，更不会误伤后来新占用该通道的保障单。
 * 5. 每次占用/释放都在停机位侧的专用通道占用台账落一条流水，
 *    停机位与廊桥靠接读到的通道占用与本模块同源。
 */

export const VIP_MODULE_KEY = 'vip'
export const CHANNEL_FIELD = '专用通道'
export const VIP_ORDER_FIELD = '保障编号'
export const VIP_FLIGHT_FIELD = '航班号'
export const VIP_LEVEL_FIELD = '要客等级'
export const VIP_RECEPT_UNIT_FIELD = '接待单位'
export const VIP_GUIDE_FIELD = '引导人员'

// 主张占用通道的在途状态：待准备不占（还没进通道），已完成不占（已释放）。
export const OCCUPYING_STATUSES = ['保障中', '待确认']
// 仲裁时状态推进的先后：越靠后越占先。
const STATUS_PRIORITY: Record<string, number> = { 保障中: 1, 待确认: 2 }

export type VipSnapshot = {
  orderId: number
  保障编号: string
  航班号: string
  要客等级: string
  接待单位: string
  引导人员: string
  通道: string
  status: string
}

export function readVipSnapshot(row: EntryRow): VipSnapshot {
  return {
    orderId: Number(row.id),
    保障编号: String(row[VIP_ORDER_FIELD] ?? ''),
    航班号: String(row[VIP_FLIGHT_FIELD] ?? ''),
    要客等级: String(row[VIP_LEVEL_FIELD] ?? ''),
    接待单位: String(row[VIP_RECEPT_UNIT_FIELD] ?? ''),
    引导人员: String(row[VIP_GUIDE_FIELD] ?? ''),
    通道: String(row[CHANNEL_FIELD] ?? ''),
    status: String(row.status ?? ''),
  }
}

function occupancyRank(status: string): number {
  return STATUS_PRIORITY[status] ?? -1
}

/**
 * 由保障单集合派生当前全部通道占用。
 * 无独立写入面：想改占用，只能改保障单状态。
 */
export function deriveChannelOccupancies(vipRows: EntryRow[]): ChannelOccupancy[] {
  const claimants = vipRows
    .map(readVipSnapshot)
    .filter((item) => item.通道.trim() !== '' && OCCUPYING_STATUSES.includes(item.status))

  const byChannel = new Map<string, VipSnapshot[]>()
  for (const item of claimants) {
    const list = byChannel.get(item.通道) ?? []
    list.push(item)
    byChannel.set(item.通道, list)
  }

  const result: ChannelOccupancy[] = []
  for (const [channel, list] of byChannel) {
    const sorted = [...list].sort((a, b) => {
      const gap = occupancyRank(b.status) - occupancyRank(a.status)
      return gap !== 0 ? gap : a.orderId - b.orderId
    })
    const winner = sorted[0]
    const losers = sorted.slice(1)
    result.push({
      channel,
      orderId: winner.orderId,
      保障编号: winner.保障编号,
      航班号: winner.航班号,
      要客等级: winner.要客等级,
      接待单位: winner.接待单位,
      引导人员: winner.引导人员,
      status: winner.status,
      conflict: losers.length > 0,
      conflictOrderIds: losers.map((item) => item.orderId),
    })
  }
  result.sort((a, b) => a.channel.localeCompare(b.channel, 'zh-Hans-CN'))
  return result
}

/** 通道 → 持占占用的索引，供状态流转时判占、防误伤使用。 */
export function occupancyIndex(occupancies: ChannelOccupancy[]): Map<string, ChannelOccupancy> {
  return new Map(occupancies.map((item) => [item.channel, item]))
}

/** 该通道当前是否可分配给指定保障单：完全空闲可分；自己已占也可继续推进。 */
export function channelAssignable(
  index: Map<string, ChannelOccupancy>,
  channel: string,
  selfOrderId: number,
): { assignable: boolean; holder?: ChannelOccupancy } {
  const holder = index.get(channel)
  if (!holder || holder.orderId === selfOrderId) {
    return { assignable: true }
  }
  return { assignable: false, holder }
}

/**
 * 释放前的幂等闸门：只有当前确由本单持占、且本单已不在在途状态时才放行。
 * 状态仍是持占依据——若本单已回退到在途以外而通道又被更新的保障单占用，
 * 这里返回 false，绝不把新占用误释放掉。
 */
export function releasableBy(
  index: Map<string, ChannelOccupancy>,
  channel: string,
  orderId: number,
): { releasable: boolean; reason?: 'not-held' | 'taken-over'; holder?: ChannelOccupancy } {
  const holder = index.get(channel)
  if (!holder) {
    return { releasable: false, reason: 'not-held' }
  }
  if (holder.orderId !== orderId) {
    return { releasable: false, reason: 'taken-over', holder }
  }
  return { releasable: true }
}
