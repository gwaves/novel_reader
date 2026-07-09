import type { GatewayConfig } from './config.js'
import type { GatewayBookCatalog } from './data-store.js'
import { listStructuredLogFiles, readStructuredLogRecords, type StructuredLogRecord } from './log-store.js'

const dayMs = 24 * 60 * 60 * 1000
const analyticsWindowDays = 7

export async function buildGatewayAnalytics(config: GatewayConfig, catalog: GatewayBookCatalog) {
  const now = new Date()
  const since = new Date(now.getTime() - analyticsWindowDays * dayMs)
  const records = await readStructuredLogRecords(config, { since, maxRecords: 50_000 })
  const logFiles = await listStructuredLogFiles(config)
  const titleByBookId = new Map(catalog.books.map((book) => [book.id, book.title]))
  const mobileEvents = records.filter((record) => record.kind === 'mobile.event')
  const requestLogs = records.filter((record) => record.kind === 'gateway.request')
  const last24Cutoff = now.getTime() - dayMs
  const mobileEventsLast24Hours = mobileEvents.filter((record) => recordTime(record) >= last24Cutoff)
  const requestLogsLast24Hours = requestLogs.filter((record) => recordTime(record) >= last24Cutoff)
  const diagnosticEventsLast24Hours = mobileEventsLast24Hours.filter((record) => readString(record.source) !== 'behavior')
  const errorEventsLast24Hours = mobileEventsLast24Hours.filter((record) => readString(record.level) === 'error')
  const requestErrorsLast24Hours = requestLogsLast24Hours.filter((record) => readNumber(record.statusCode) >= 400)
  const requestDownloadsLast24Hours = requestLogsLast24Hours.filter((record) => readString(record.downloadKind) === 'package' || readString(record.downloadKind) === 'audio')
  const logFileBytes = logFiles.reduce((sum, file) => sum + file.sizeBytes, 0)

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    window: {
      days: analyticsWindowDays,
      since: since.toISOString(),
      retentionDays: config.logs.retentionDays,
      rotateBytes: config.logs.rotateBytes,
      logDir: config.logs.dir,
    },
    logFiles: {
      totalFiles: logFiles.length,
      totalBytes: logFileBytes,
      byKind: {
        requests: summarizeLogFiles(logFiles.filter((file) => file.kind === 'requests')),
        mobile: summarizeLogFiles(logFiles.filter((file) => file.kind === 'mobile')),
      },
      recentFiles: logFiles.slice(-12).reverse(),
    },
    behavior: {
      eventsLast24Hours: mobileEventsLast24Hours.filter((record) => readString(record.source) === 'behavior').length,
      diagnosticsLast24Hours: diagnosticEventsLast24Hours.length,
      errorEventsLast24Hours: errorEventsLast24Hours.length,
      activeDevicesLast24Hours: countUnique(mobileEventsLast24Hours.map((record) => readString(record.deviceId))),
      topActions: topCounts(mobileEventsLast24Hours.map((record) => readString(record.eventName) || readContextAction(record.context)), 10),
      topBooks: topBookCounts(mobileEventsLast24Hours, titleByBookId),
      recentEvents: mobileEvents.slice(0, 20).map((record) => ({
        receivedAt: readString(record.receivedAt),
        clientTimestamp: readString(record.clientTimestamp),
        level: normalizeLevel(record.level),
        source: readString(record.source) || 'app',
        eventName: readString(record.eventName) || readContextAction(record.context) || 'event',
        message: readString(record.message) || 'mobile event',
        deviceId: readString(record.deviceId),
        deviceName: readString(record.deviceName),
        appVersion: readString(record.appVersion),
        bookId: readString(record.bookId),
        chapterId: readString(record.chapterId),
      })),
    },
    requests: {
      persistedLast24Hours: requestLogsLast24Hours.length,
      persistedErrorsLast24Hours: requestErrorsLast24Hours.length,
      persistedDownloadsLast24Hours: requestDownloadsLast24Hours.length,
      activeDevicesLast24Hours: countUnique(requestLogsLast24Hours.map((record) => readString(record.deviceId))),
    },
    trends: {
      daily: buildDailyTrends(records, since, now),
    },
  }
}

function summarizeLogFiles(files: Array<{ sizeBytes: number }>) {
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
  }
}

function topBookCounts(records: StructuredLogRecord[], titleByBookId: Map<string, string>) {
  return topCounts(records.map((record) => readString(record.bookId)), 10).map((item) => ({
    bookId: item.value,
    title: titleByBookId.get(item.value) ?? item.value,
    count: item.count,
  }))
}

function topCounts(values: string[], limit: number) {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, limit)
}

function buildDailyTrends(records: StructuredLogRecord[], since: Date, now: Date) {
  const buckets = new Map<string, {
    date: string
    requestCount: number
    requestErrorCount: number
    downloadCount: number
    behaviorEventCount: number
    diagnosticEventCount: number
  }>()
  for (let time = Date.parse(since.toISOString().slice(0, 10)); time <= now.getTime(); time += dayMs) {
    const date = new Date(time).toISOString().slice(0, 10)
    buckets.set(date, {
      date,
      requestCount: 0,
      requestErrorCount: 0,
      downloadCount: 0,
      behaviorEventCount: 0,
      diagnosticEventCount: 0,
    })
  }

  for (const record of records) {
    const date = readString(record.receivedAt).slice(0, 10)
    const bucket = buckets.get(date)
    if (!bucket) continue
    if (record.kind === 'gateway.request') {
      bucket.requestCount += 1
      if (readNumber(record.statusCode) >= 400) bucket.requestErrorCount += 1
      if (readString(record.downloadKind) === 'package' || readString(record.downloadKind) === 'audio') bucket.downloadCount += 1
    } else if (record.kind === 'mobile.event') {
      if (readString(record.source) === 'behavior') {
        bucket.behaviorEventCount += 1
      } else {
        bucket.diagnosticEventCount += 1
      }
    }
  }

  return Array.from(buckets.values())
}

function countUnique(values: string[]) {
  return new Set(values.filter(Boolean)).size
}

function readContextAction(value: unknown) {
  if (!isRecord(value)) return ''
  return readString(value.action)
}

function recordTime(record: StructuredLogRecord) {
  const time = Date.parse(record.receivedAt)
  return Number.isNaN(time) ? 0 : time
}

function normalizeLevel(value: unknown): 'info' | 'warn' | 'error' {
  return value === 'warn' || value === 'error' ? value : 'info'
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
