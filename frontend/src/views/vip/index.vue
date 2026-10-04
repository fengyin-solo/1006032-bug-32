<template>
  <section class="page" data-module="vip">
    <header class="page-head">
      <div>
        <h2>要客保障管理</h2>
        <p class="page-desc">
          维护要客保障单，围绕保障编号、航班号、要客等级、接待单位做登记、筛选与状态流转。
          专用通道占用由保障单状态唯一派生：保障中/待确认占用，撤回或确认完成即释放，不再各存一份。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记要客保障单</button>
        <button class="btn" type="button" @click="exportRows">导出要客保障清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 专用通道占用（派生自要客保障单状态，与停机位、廊桥靠接同源） -->
    <section class="channel-panel">
      <header class="channel-panel-head">
        <h3>专用通道实时占用</h3>
        <p class="channel-note">
          仲裁口径：通道占用以要客保障单状态为准，不另存占用表；待准备不占、保障中/待确认占用、已完成已释放；
          撤回回到待准备即释放。同通道被多单主张时，状态更靠后、更早登记的单持占，其余标冲突。
        </p>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>专用通道</th>
            <th>持占保障单</th>
            <th>航班号</th>
            <th>要客等级</th>
            <th>接待单位</th>
            <th>引导人员</th>
            <th>占用来源状态</th>
            <th>冲突告警</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in channelOccupancies" :key="item.channel" :class="{ 'conflict-row': item.conflict }">
            <td>{{ item.channel }}</td>
            <td>{{ item.保障编号 }}</td>
            <td>{{ item.航班号 }}</td>
            <td>{{ item.要客等级 }}</td>
            <td>{{ item.接待单位 }}</td>
            <td>{{ item.引导人员 }}</td>
            <td>{{ item.status }}</td>
            <td v-if="item.conflict" class="error-text">
              与保障单 id {{ item.conflictOrderIds.join('、') }} 同时主张，按仲裁规则由本单持占，请人工核对
            </td>
            <td v-else>—</td>
          </tr>
          <tr v-if="!channelOccupancies.length">
            <td colspan="8" class="empty-state">当前无专用通道占用（均由要客保障单状态实时派生）</td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in displayColumns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'conflict-row': loserOf(row) }">
          <td v-for="column in displayColumns" :key="column">
            <template v-if="column === '专用通道'">
              <span>{{ row[column] || '—' }}</span>
              <span class="channel-tag" :class="channelTagClass(row)">{{ channelTagText(row) }}</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="busyOrderId === String(row.id)"
              @click="runAction(action, row)"
            >
              {{ busyOrderId === String(row.id) ? '处理中…' : action }}
            </button>
            <span v-if="!availableActions(row).length" class="muted-text">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="displayColumns.length + 2" class="empty-state">暂无要客保障数据，可先登记要客保障单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条要客保障记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  channelOccupancyByOrder,
  downloadEntries,
  listChannelOccupancies,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { ChannelOccupancy, EntryRow } from '@/data/types'

const meta = moduleMeta('vip')
// 「保障状态」字段与末列「当前状态」是同一份状态，不重复展示，避免同单信息双写误导。
const displayColumns = ["保障编号", "航班号", "要客等级", "接待单位", "引导人员", "专用通道", "车辆安排"]
const statuses = ["待准备", "保障中", "待确认", "已完成"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["保障编号", "航班号", "要客等级"]
// 外层防重复点击：同一保障单的动作在落库完成前只受理一次。
const busyOrderId = ref<string>('')

const channelOccupancies = ref<ChannelOccupancy[]>([])
const occupancyMap = ref<Map<number, ChannelOccupancy>>(new Map())
// 仲裁落败方索引：落败单要在列表上直接亮出冲突，而不是静默占着通道。
const loserMap = computed<Map<number, ChannelOccupancy>>(() => {
  const map = new Map<number, ChannelOccupancy>()
  for (const item of channelOccupancies.value) {
    for (const loserId of item.conflictOrderIds) {
      map.set(loserId, item)
    }
  }
  return map
})

const stats = computed(() => [
  { label: '今日要客保障', value: rows.value.length },
  { label: '保障中单数', value: rows.value.filter((row) => String(row.status) === '保障中').length },
  { label: '待确认单数', value: rows.value.filter((row) => String(row.status) === '待确认').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 状态机映射到按钮：只暴露当前状态允许的下一步；撤回仅保障中/待确认可用。
const NEXT_ACTION: Record<string, string> = {
  待准备: '开始准备',
  保障中: '提交确认',
  待确认: '确认完成',
}

function availableActions(row: EntryRow): string[] {
  const status = String(row.status)
  const next = NEXT_ACTION[status]
  const actions = next ? [next] : []
  if (status === '保障中' || status === '待确认') {
    actions.push('撤回')
  }
  return actions
}

function channelTagText(row: EntryRow): string {
  const status = String(row.status)
  if (status === '已完成') {
    return '已释放'
  }
  if (status === '待准备') {
    return '待分配'
  }
  const held = occupancyMap.value.get(Number(row.id))
  if (!held) {
    // 保障中/待确认却没派生到持占：通道号为空，或仲裁落败。
    return loserOf(row) ? '仲裁落败·未持占' : '未登记通道'
  }
  return held.conflict ? '占用中·通道冲突' : '占用中'
}

function channelTagClass(row: EntryRow): string {
  const status = String(row.status)
  const text = channelTagText(row)
  if (text.includes('冲突') || text.includes('落败')) {
    return 'tag-danger'
  }
  if (status === '已完成') {
    return 'tag-released'
  }
  if (status === '待准备') {
    return 'tag-idle'
  }
  return 'tag-held'
}

function loserOf(row: EntryRow): ChannelOccupancy | undefined {
  return loserMap.value.get(Number(row.id))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '要客保障单登记入口尚未接入审批流'
}

async function runAction(action: string, row: EntryRow) {
  const orderKey = String(row.id)
  if (busyOrderId.value === orderKey) {
    // 双重点击直接吞掉，配合内层状态守卫，保证确认完成只释放一次通道。
    return
  }
  errorMessage.value = ''
  successMessage.value = ''
  busyOrderId.value = orderKey
  try {
    // 让出一帧给「处理中…」渲染，内层写入仍是同一同步事务，不会插进第二次动作。
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    successMessage.value = result.message
    reload()
  } finally {
    busyOrderId.value = ''
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 三处读到的通道（要客等级/接待单位/引导人员同一张表）与面板取同一份派生结果。
    channelOccupancies.value = listChannelOccupancies()
    occupancyMap.value = channelOccupancyByOrder()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '要客保障列表读取失败'
  }
}

onMounted(reload)
</script>
