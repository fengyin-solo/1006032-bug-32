<template>
  <section class="page" data-module="stand">
    <header class="page-head">
      <div>
        <h2>机位分配管理</h2>
        <p class="page-desc">维护停机位，围绕机位编号、机位类型、适用机型、廊桥配置做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记停机位</button>
        <button class="btn" type="button" @click="exportRows">导出机位分配清单</button>
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

    <!-- 专用通道占用：与要客保障、廊桥靠接同源，由要客保障单状态派生，本页只读不写 -->
    <section class="channel-panel">
      <header class="channel-panel-head">
        <h3>专用通道实时占用</h3>
        <p class="channel-note">
          占用情况派生自要客保障单状态（保障中/待确认占用，撤回、确认完成释放），本台账不单独判定占用；
          与廊桥靠接页读到的是同一份结果。冲突一律以保障单状态仲裁。
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
            <td v-if="item.conflict" class="error-text">多单同占，已按仲裁规则裁定，请人工核对</td>
            <td v-else>—</td>
          </tr>
          <tr v-if="!channelOccupancies.length">
            <td colspan="8" class="empty-state">当前无专用通道占用</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 专用通道占用台账：占用/释放流水，要客保障的释放结果落到这里 -->
    <section class="channel-panel">
      <header class="channel-panel-head">
        <h3>专用通道占用台账</h3>
        <p class="channel-note">每次分配占用、撤回释放、确认完成释放各落一条；最新记录在前。</p>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>专用通道</th>
            <th>动作</th>
            <th>保障编号</th>
            <th>航班号</th>
            <th>要客等级</th>
            <th>接待单位</th>
            <th>引导人员</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in ledgerRows" :key="entry.id">
            <td>{{ entry.time }}</td>
            <td>{{ entry.channel }}</td>
            <td>
              <span class="ledger-tag" :class="entry.action === '占用' ? 'tag-held' : 'tag-released'">{{ entry.action }}</span>
            </td>
            <td>{{ entry.保障编号 }}</td>
            <td>{{ entry.航班号 }}</td>
            <td>{{ entry.要客等级 }}</td>
            <td>{{ entry.接待单位 }}</td>
            <td>{{ entry.引导人员 }}</td>
            <td>{{ entry.note }}</td>
          </tr>
          <tr v-if="!ledgerRows.length">
            <td colspan="9" class="empty-state">暂无专用通道占用台账记录</td>
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
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无机位分配数据，可先登记停机位</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条机位分配记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listChannelOccupancies,
  listChannelOccupancyLedger,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { ChannelLedgerEntry, ChannelOccupancy, EntryRow } from '@/data/types'

const meta = moduleMeta('stand')
const columns = ["机位编号", "机位类型", "适用机型", "廊桥配置", "近远机位", "占用时段", "当前航班", "机位状态"]
const actions = ["分配机位", "释放机位", "封闭机位"]
const statuses = ["空闲", "占用中", "维护中", "已封闭"]
const stats = [{"label": "可用机位", "value": 0}, {"label": "占用中机位", "value": 0}, {"label": "封闭机位", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
// 专用通道占用与台账：占用为派生结果（只读），台账为落地流水，两处与廊桥靠接同源。
const channelOccupancies = ref<ChannelOccupancy[]>([])
const ledgerRows = ref<ChannelLedgerEntry[]>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '停机位登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 通道占用读取面与要客保障、廊桥靠接完全同源；台账只做留痕。
    channelOccupancies.value = listChannelOccupancies()
    ledgerRows.value = listChannelOccupancyLedger()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '机位分配列表读取失败'
  }
}

onMounted(reload)
</script>
