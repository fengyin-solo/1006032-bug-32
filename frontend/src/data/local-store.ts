import { SEED_CHANNEL_LEDGER, SEED_ROWS } from './seed'
import type { ChannelLedgerEntry, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'
// 停机位侧的专用通道占用台账：占用/释放流水，刷新不丢。
const CHANNEL_LEDGER_KEY = 'airport-ground-ops:channel-ledger'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ── 专用通道占用台账（停机位侧留痕，当前占用仍由要客保障单状态实时派生，不读这份做判定）──

let ledgerCache: ChannelLedgerEntry[] | null = null

export function listChannelLedger(): ChannelLedgerEntry[] {
  if (ledgerCache !== null) {
    return ledgerCache
  }
  const fallback = clone(SEED_CHANNEL_LEDGER)
  if (typeof window === 'undefined' || !window.localStorage) {
    ledgerCache = fallback
    return fallback
  }
  const raw = window.localStorage.getItem(CHANNEL_LEDGER_KEY)
  if (!raw) {
    window.localStorage.setItem(CHANNEL_LEDGER_KEY, JSON.stringify(fallback))
    ledgerCache = fallback
    return fallback
  }
  try {
    ledgerCache = JSON.parse(raw) as ChannelLedgerEntry[]
  } catch {
    window.localStorage.setItem(CHANNEL_LEDGER_KEY, JSON.stringify(fallback))
    ledgerCache = fallback
  }
  return ledgerCache
}

export function appendChannelLedger(entry: Omit<ChannelLedgerEntry, 'id'>): ChannelLedgerEntry {
  const rows = listChannelLedger()
  const stored: ChannelLedgerEntry = { ...entry, id: rows.length ? rows[rows.length - 1].id + 1 : 1 }
  const next = [...rows, stored]
  ledgerCache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CHANNEL_LEDGER_KEY, JSON.stringify(next))
  }
  return stored
}

export function resetChannelLedger(): ChannelLedgerEntry[] {
  const rows = clone(SEED_CHANNEL_LEDGER)
  ledgerCache = rows
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CHANNEL_LEDGER_KEY, JSON.stringify(rows))
  }
  return rows
}
