import type { EntryRow } from './types'

// ============================================================================
// 要客保障单 · 专用通道占用 —— 仲裁规则（冲突时按这一份裁决，全系统只此一处）
//
// 1. 专用通道占用【不单独存一份】，永远由要客保障单的状态派生：
//      保障单状态 ∈ {待准备, 保障中, 待确认} → 其登记的「专用通道」为占用中，持有人就是这张保障单；
//      保障单状态 ∈ {已完成, 已撤回}        → 通道空闲（确认完成、撤回保障都会走到这里）。
// 2. 通道占用与保障单状态冲突时，以【要客保障单状态】为准，占用侧无条件跟随保障单，
//    不允许拿任何占用记录反改保障单。
// 3. 停机位占用台账（STAND_CHANNEL_LEDGER_KEY）只是这份派生结果的落盘投影：
//    每次保障单状态变化后【整体重建】，不逐条增删。因此：
//      - 确认完成 / 撤回保障的释放结果必然落到台账；
//      - 重复确认完成第二次根本进不来（状态已终结，动作被拒绝），
//        即使重算台账也是整体重建，不会把通道的新一轮占用误放掉；
//      - 机位分配页与廊桥靠接页读台账、要客保障页读保障单，看到的是同一份占用。
// 4. 保障单状态只能顺着 待准备 → 保障中 → 待确认 → 已完成 逐格推进，不许跳步；
//    持有期间（待准备/保障中/待确认）可撤回为「已撤回」，撤回即释放通道。
// ============================================================================

export const VIP_FLOW = ['待准备', '保障中', '待确认', '已完成'] as const
export const VIP_WITHDRAWN = '已撤回'

/** 处于这些状态的保障单持有其登记的专用通道。 */
export const CHANNEL_HOLDING_STATUSES: readonly string[] = ['待准备', '保障中', '待确认']

/** 停机位占用台账在本地数据层里的键：机位分配与廊桥靠接都读这一份。 */
export const STAND_CHANNEL_LEDGER_KEY = 'standChannelLedger'

export function isHoldingStatus(status: string): boolean {
  return CHANNEL_HOLDING_STATUSES.includes(status)
}

/** 顺次推进的下一格；已到「已完成」或「已撤回」等终结态时返回 null。 */
export function nextVipStatus(current: string): string | null {
  const index = VIP_FLOW.indexOf(current as (typeof VIP_FLOW)[number])
  if (index < 0 || index === VIP_FLOW.length - 1) {
    return null
  }
  return VIP_FLOW[index + 1]
}

/** 只有还在持有通道的状态（待准备/保障中/待确认）允许撤回。 */
export function canWithdrawVip(current: string): boolean {
  return isHoldingStatus(current)
}

/**
 * 同一通道的当前持有人：状态仍在持有区间内的保障单；没有则为 null。
 * 这是判断「通道被谁占着」的唯一入口，列表、台账、冲突提示都从这里读。
 */
export function channelHolder(vipRows: EntryRow[], channel: string, excludeId?: number): EntryRow | null {
  const name = channel.trim()
  if (!name) {
    return null
  }
  const holders = vipRows
    .filter(
      (row) =>
        String(row['专用通道'] ?? '').trim() === name &&
        isHoldingStatus(String(row.status)) &&
        Number(row.id) !== excludeId,
    )
    .sort((a, b) => Number(a.id) - Number(b.id))
  return holders[0] ?? null
}

/**
 * 由要客保障单派生整张通道台账：一个通道一行，占用与释放都从这里出来。
 * 返回的是 EntryRow（status = 占用中/空闲），可直接落进本地数据层。
 */
export function deriveChannelLedger(vipRows: EntryRow[]): EntryRow[] {
  const byChannel = new Map<string, EntryRow[]>()
  for (const row of vipRows) {
    const channel = String(row['专用通道'] ?? '').trim()
    if (!channel) {
      continue
    }
    const list = byChannel.get(channel) ?? []
    list.push(row)
    byChannel.set(channel, list)
  }
  const ledger: EntryRow[] = []
  const sorted = [...byChannel.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [channel, orders] of sorted) {
    const holders = orders
      .filter((row) => isHoldingStatus(String(row.status)))
      .sort((a, b) => Number(a.id) - Number(b.id))
    const holder = holders[0] ?? null
    const released =
      orders
        .filter((row) => !isHoldingStatus(String(row.status)))
        .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null
    // 要客等级 / 接待单位 / 引导人员取自同一张源单：占用中取持有人，空闲取最近释放单。
    const source = holder ?? released
    ledger.push({
      id: ledger.length + 1,
      status: holder ? '占用中' : '空闲',
      pending: Boolean(holder),
      abnormal: holders.length > 1,
      通道: channel,
      占用保障单: holder ? String(holder['保障编号'] ?? '') : '',
      最近释放单: holder ? '' : String(released?.['保障编号'] ?? ''),
      要客等级: String(source?.['要客等级'] ?? ''),
      接待单位: String(source?.['接待单位'] ?? ''),
      引导人员: String(source?.['引导人员'] ?? ''),
      航班号: String(source?.['航班号'] ?? ''),
      仲裁依据: '要客保障单状态',
    })
  }
  return ledger
}
