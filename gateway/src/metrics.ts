import type { FastifyRequest } from 'fastify'
import type { GatewayBookCatalog } from './data-store.js'

type GatewayRequest = FastifyRequest & {
  metricsStartedAt?: number
}

type RequestSample = {
  requestId: string
  method: string
  url: string
  statusCode: number
  durationMs: number
  time: number
  bookId?: string
  downloadKind?: 'package' | 'audio'
}

type GatewayEvent = {
  time: string
  level: 'info' | 'warn' | 'error'
  text: string
  method: string
  url: string
  statusCode: number
  durationMs: number
  bookId?: string
}

const minuteMs = 60_000
const dayMs = 24 * 60 * minuteMs

export function createGatewayMetrics() {
  const startedAt = Date.now()
  const samples: RequestSample[] = []
  const events: GatewayEvent[] = []

  function markStart(request: FastifyRequest) {
    ;(request as GatewayRequest).metricsStartedAt = Date.now()
  }

  function record(request: FastifyRequest, statusCode: number) {
    const now = Date.now()
    const started = (request as GatewayRequest).metricsStartedAt ?? now
    const durationMs = Math.max(0, now - started)
    const download = classifyDownload(request.url)
    const sample: RequestSample = {
      requestId: request.id,
      method: request.method,
      url: request.url,
      statusCode,
      durationMs,
      time: now,
      ...download,
    }
    samples.push(sample)
    trimSamples(samples, now)

    const event = buildEvent(sample)
    if (event) {
      events.unshift(event)
      events.splice(100)
    }
  }

  function snapshot(catalog: GatewayBookCatalog) {
    const now = Date.now()
    trimSamples(samples, now)
    const lastMinute = filterSince(samples, now - minuteMs)
    const last15Minutes = filterSince(samples, now - 15 * minuteMs)
    const last24Hours = filterSince(samples, now - dayMs)
    const errors = last24Hours.filter((sample) => sample.statusCode >= 400)
    const durations = last24Hours.map((sample) => sample.durationMs).sort((left, right) => left - right)
    const packageDownloads = last24Hours.filter((sample) => sample.downloadKind === 'package')
    const audioDownloads = last24Hours.filter((sample) => sample.downloadKind === 'audio')

    return {
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      process: {
        uptimeSeconds: Math.round((now - startedAt) / 1000),
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
      },
      requests: {
        lastMinute: lastMinute.length,
        last15Minutes: last15Minutes.length,
        last24Hours: last24Hours.length,
        errorRate: last24Hours.length > 0 ? errors.length / last24Hours.length : 0,
        p95Ms: percentile(durations, 0.95),
      },
      downloads: {
        packageLast24Hours: packageDownloads.length,
        audioLast24Hours: audioDownloads.length,
        topBooks: buildTopBooks(last24Hours, catalog),
      },
    }
  }

  function recentEvents() {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      events,
    }
  }

  function recentRequests() {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      requests: samples.slice(-100).reverse().map(formatRequestSample),
    }
  }

  return {
    markStart,
    record,
    snapshot,
    recentEvents,
    recentRequests,
  }
}

function formatRequestSample(sample: RequestSample) {
  return {
    requestId: sample.requestId,
    time: new Date(sample.time).toISOString(),
    method: sample.method,
    url: sample.url,
    statusCode: sample.statusCode,
    durationMs: sample.durationMs,
    bookId: sample.bookId,
    downloadKind: sample.downloadKind,
  }
}

function classifyDownload(url: string): Pick<RequestSample, 'bookId' | 'downloadKind'> {
  const packageMatch = /^\/mobile\/books\/([^/]+)\/package\/download(?:\?|$)/.exec(url)
  if (packageMatch) {
    return {
      bookId: decodeURIComponent(packageMatch[1]),
      downloadKind: 'package',
    }
  }
  const audioMatch = /^\/mobile\/books\/([^/]+)\/audio\/[^/]+\/download(?:\?|$)/.exec(url)
  if (audioMatch) {
    return {
      bookId: decodeURIComponent(audioMatch[1]),
      downloadKind: 'audio',
    }
  }
  const bookMatch = /^\/mobile\/books\/([^/?]+)/.exec(url)
  return bookMatch ? { bookId: decodeURIComponent(bookMatch[1]) } : {}
}

function buildEvent(sample: RequestSample): GatewayEvent | null {
  if (sample.statusCode >= 500) {
    return event(sample, 'error', `${sample.method} ${sample.url} 返回 ${sample.statusCode}`)
  }
  if (sample.statusCode >= 400) {
    return event(sample, 'warn', `${sample.method} ${sample.url} 返回 ${sample.statusCode}`)
  }
  if (sample.downloadKind === 'package') {
    return event(sample, 'info', `下载 ${sample.bookId} 数据包`)
  }
  if (sample.downloadKind === 'audio') {
    return event(sample, 'info', `下载 ${sample.bookId} 章节音频`)
  }
  return null
}

function event(sample: RequestSample, level: GatewayEvent['level'], text: string): GatewayEvent {
  return {
    time: new Date(sample.time).toISOString(),
    level,
    text,
    method: sample.method,
    url: sample.url,
    statusCode: sample.statusCode,
    durationMs: sample.durationMs,
    bookId: sample.bookId,
  }
}

function trimSamples(samples: RequestSample[], now: number) {
  const cutoff = now - dayMs
  while (samples.length > 0 && samples[0].time < cutoff) {
    samples.shift()
  }
}

function filterSince(samples: RequestSample[], cutoff: number) {
  return samples.filter((sample) => sample.time >= cutoff)
}

function percentile(sortedValues: number[], ratio: number) {
  if (sortedValues.length === 0) return 0
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * ratio) - 1)
  return sortedValues[index]
}

function buildTopBooks(samples: RequestSample[], catalog: GatewayBookCatalog) {
  const stats = new Map<string, { bookId: string; title: string; audioDownloads: number; packageDownloads: number }>()
  const titleById = new Map(catalog.books.map((book) => [book.id, book.title]))
  for (const sample of samples) {
    if (!sample.bookId || !sample.downloadKind) continue
    const current = stats.get(sample.bookId) ?? {
      bookId: sample.bookId,
      title: titleById.get(sample.bookId) ?? sample.bookId,
      audioDownloads: 0,
      packageDownloads: 0,
    }
    if (sample.downloadKind === 'audio') current.audioDownloads += 1
    if (sample.downloadKind === 'package') current.packageDownloads += 1
    stats.set(sample.bookId, current)
  }
  return Array.from(stats.values())
    .sort((left, right) => right.audioDownloads + right.packageDownloads - (left.audioDownloads + left.packageDownloads))
    .slice(0, 10)
}
