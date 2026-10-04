/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 为 true 时，正向动作只能沿 statuses 相邻顺次推进，不许跳步；回退动作另见 rollbackActions。
  ordered?: boolean
  // 特许的回退动作清单（如撤回），不受顺次推进限制，但仍受各模块自己的回退规则约束。
  rollbackActions?: string[]
}

// 专用通道占用：不单独持久化，完全由要客保障单状态派生，保障单状态是唯一事实源。
export type ChannelOccupancy = {
  channel: string
  orderId: number
  保障编号: string
  航班号: string
  要客等级: string
  接待单位: string
  引导人员: string
  status: string
  // 持占通道的保障单在仲裁中胜出时为 false；同通道还挂着别的在途单时为 true（数据异常告警）。
  conflict: boolean
  // 同通道同时主张占用、但在仲裁中落败的保障单 id。
  conflictOrderIds: number[]
}

// 停机位侧的专用通道占用台账流水：占用/释放各落一条，释放结果以此为准留痕。
export type ChannelLedgerEntry = {
  id: number
  time: string
  channel: string
  action: '占用' | '释放'
  orderId: number
  保障编号: string
  航班号: string
  要客等级: string
  接待单位: string
  引导人员: string
  note: string
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
