<template>
  <section class="page" data-module="vip">
    <header class="page-head">
      <div>
        <h2>要客保障管理</h2>
        <p class="page-desc">维护要客保障单，围绕保障编号、航班号、要客等级、接待单位做登记、筛选与状态流转；专用通道占用由保障单状态派生，不另存副本。</p>
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

    <p class="flow-hint">
      状态只能顺次推进：待准备 → 保障中 → 待确认 → 已完成，不许跳步；持有通道期间可撤回。
      专用通道占用由保障单状态派生（待准备 / 保障中 / 待确认 = 占用中，已完成 / 已撤回 = 已释放），
      与停机位占用台账、廊桥靠接页读到的是同一份；冲突时以要客保障单状态为准。
    </p>

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
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!rowActions(row).length" class="muted-text">已终结</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无要客保障数据，可先登记要客保障单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条要客保障记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  availableActions,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('vip')
// 「通道占用」不是存储字段，是列表读出来时每行挂上的派生列，与台账同源。
const columns = ["保障编号", "航班号", "要客等级", "接待单位", "引导人员", "专用通道", "车辆安排", "保障状态", "通道占用"]
const statuses = ["待准备", "保障中", "待确认", "已完成", "已撤回"]
const stats = [{"label": "今日要客保障", "value": 0}, {"label": "保障中单数", "value": 0}, {"label": "待确认单数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
// 要客等级、接待单位、引导人员三处都能查，读到的通道占用是同一份派生结果。
const filterFields = ["保障编号", "航班号", "要客等级", "接待单位", "引导人员"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function rowActions(row: EntryRow): string[] {
  return availableActions(meta.key, row)
}

function resetFilters() {
  filters.value = {}
  errorMessage.value = ''
  noticeMessage.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '要客保障单登记入口尚未接入审批流'
  noticeMessage.value = ''
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  // 确认完成 / 撤回保障的释放结果要让人看见，不能点了没反应。
  noticeMessage.value = result.message
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '要客保障列表读取失败'
  }
}

onMounted(reload)
</script>
