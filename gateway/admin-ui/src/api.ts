import {
  type AdminBook,
  type AdminDevice,
  type ContentLabel,
  type DeviceRole,
  type Visibility,
  initialBooks,
  initialDevices,
  overviewMetrics,
  recentEvents,
} from './mockData'

type GatewayBook = {
  id?: string
  title?: string
  author?: string
  chapterCount?: number
  updatedAt?: string
  visibility?: string
  labels?: unknown[]
  summaryCoverage?: number
  kgCoverage?: number
  embeddingCoverage?: number
  audioChapterCount?: number
}

type GatewayDevice = {
  id?: string
  name?: string
  model?: string
  platform?: string
  appVersion?: string
  pairingCode?: string
  role?: string
  firstSeenAt?: string
  lastSeenAt?: string
  lastIp?: string
}

type GatewayMetrics = {
  requests?: {
    last15Minutes?: number
    last24Hours?: number
    errorRate?: number
    p95Ms?: number
  }
  downloads?: {
    packageLast24Hours?: number
    audioLast24Hours?: number
  }
}

type GatewayEvents = {
  events?: Array<{
    time?: string
    level?: 'info' | 'warn' | 'error'
    text?: string
  }>
}

export type AdminDashboardData = {
  books: AdminBook[]
  devices: AdminDevice[]
  overviewMetrics: typeof overviewMetrics
  recentEvents: typeof recentEvents
  source: 'api' | 'mock'
}

export const adminTokenStorageKey = 'novel-reader-gateway-admin-token'

export async function loadAdminDashboardData(fetcher: typeof fetch = fetch): Promise<AdminDashboardData> {
  try {
    const [booksResponse, devicesResponse, metricsResponse, eventsResponse] = await Promise.all([
      adminFetch<{ books?: GatewayBook[] }>('/admin/books', fetcher),
      adminFetch<{ devices?: GatewayDevice[] }>('/admin/devices', fetcher),
      adminFetch<GatewayMetrics>('/admin/metrics', fetcher),
      adminFetch<GatewayEvents>('/admin/events', fetcher),
    ])
    return {
      books: Array.isArray(booksResponse.books) ? booksResponse.books.map(mapBook) : [],
      devices: Array.isArray(devicesResponse.devices) ? devicesResponse.devices.map(mapDevice) : [],
      overviewMetrics: mapMetrics(metricsResponse),
      recentEvents: mapEvents(eventsResponse),
      source: 'api',
    }
  } catch {
    return {
      books: initialBooks,
      devices: initialDevices,
      overviewMetrics,
      recentEvents,
      source: 'mock',
    }
  }
}

export async function patchBookVisibility(bookId: string, visibility: Visibility, fetcher: typeof fetch = fetch) {
  await adminFetch(`/admin/books/${encodeURIComponent(bookId)}/visibility`, fetcher, {
    method: 'PATCH',
    body: JSON.stringify({ visibility }),
  })
}

export async function patchBookLabels(bookId: string, labels: ContentLabel[], fetcher: typeof fetch = fetch) {
  await adminFetch(`/admin/books/${encodeURIComponent(bookId)}/labels`, fetcher, {
    method: 'PATCH',
    body: JSON.stringify({ labels }),
  })
}

export async function patchDeviceRole(deviceId: string, role: DeviceRole, fetcher: typeof fetch = fetch) {
  await adminFetch(`/admin/devices/${encodeURIComponent(deviceId)}`, fetcher, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  })
}

async function adminFetch<T = unknown>(path: string, fetcher: typeof fetch, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body) headers.set('content-type', 'application/json')
  const token = readAdminToken()
  if (token) headers.set('authorization', `Bearer ${token}`)

  const response = await fetcher(path, {
    ...init,
    headers,
  })
  if (!response.ok) {
    throw new Error(`Gateway admin API ${response.status}`)
  }
  return response.json() as Promise<T>
}

function readAdminToken() {
  try {
    return window.localStorage.getItem(adminTokenStorageKey)?.trim() || ''
  } catch {
    return ''
  }
}

function mapBook(book: GatewayBook): AdminBook {
  const chapterCount = readNumber(book.chapterCount)
  const audioChapterCount = readNumber(book.audioChapterCount)
  return {
    id: readString(book.id, 'unknown-book'),
    title: readString(book.title, '未命名书籍'),
    author: readString(book.author, '未知'),
    visibility: normalizeVisibility(book.visibility),
    labels: normalizeLabels(book.labels),
    chapterCount,
    packageUpdatedAt: formatDate(book.updatedAt),
    coverage: {
      summary: ratioToPercent(book.summaryCoverage),
      kg: ratioToPercent(book.kgCoverage),
      embedding: ratioToPercent(book.embeddingCoverage),
    },
    audioCoverage: chapterCount > 0 ? Math.round((audioChapterCount / chapterCount) * 100) : 0,
    recentDownloads: 0,
    packageStatus: `更新时间 ${formatDate(book.updatedAt)}`,
    missingAudioChapters: Math.max(0, chapterCount - audioChapterCount),
  }
}

function mapDevice(device: GatewayDevice): AdminDevice {
  return {
    id: readString(device.id, 'unknown-device'),
    name: readString(device.name, '未命名设备'),
    model: readString(device.model, 'Unknown'),
    platform: readString(device.platform, 'unknown'),
    appVersion: readString(device.appVersion, 'unknown'),
    pairingCode: readString(device.pairingCode, '------'),
    role: normalizeRole(device.role),
    firstSeenAt: formatDate(device.firstSeenAt),
    lastSeenAt: formatDate(device.lastSeenAt),
    lastIp: readString(device.lastIp, '-'),
    recentRequests: 0,
    recentDownloads: 0,
  }
}

function mapMetrics(metrics: GatewayMetrics): typeof overviewMetrics {
  const last24Hours = readNumber(metrics.requests?.last24Hours)
  const last15Minutes = readNumber(metrics.requests?.last15Minutes)
  const errorRate = readNumber(metrics.requests?.errorRate)
  const p95Ms = readNumber(metrics.requests?.p95Ms)
  const audioDownloads = readNumber(metrics.downloads?.audioLast24Hours)
  const packageDownloads = readNumber(metrics.downloads?.packageLast24Hours)
  return [
    { label: '今日请求', value: formatCount(last24Hours), note: `近 15 分钟 ${formatCount(last15Minutes)}` },
    { label: '错误率', value: `${(errorRate * 100).toFixed(1)}%`, note: '最近 24 小时' },
    { label: 'P95 响应', value: `${Math.round(p95Ms)}ms`, note: '最近 24 小时' },
    { label: '下载次数', value: formatCount(audioDownloads + packageDownloads), note: `音频 ${formatCount(audioDownloads)} / 数据包 ${formatCount(packageDownloads)}` },
  ]
}

function mapEvents(payload: GatewayEvents): typeof recentEvents {
  if (!Array.isArray(payload.events) || payload.events.length === 0) return recentEvents
  return payload.events.slice(0, 8).map((event) => ({
    time: formatTime(event.time),
    level: event.level ?? 'info',
    text: readString(event.text, 'Gateway 事件'),
  }))
}

function normalizeVisibility(value: unknown): Visibility {
  return value === 'trusted' || value === 'admin' || value === 'hidden' ? value : 'default'
}

function normalizeRole(value: unknown): DeviceRole {
  return value === 'trusted' || value === 'disabled' ? value : 'default'
}

function normalizeLabels(value: unknown): ContentLabel[] {
  if (!Array.isArray(value)) return []
  const allowed = new Set<ContentLabel>(['adult', 'violence', 'private', 'test', 'archived'])
  return Array.from(new Set(value.filter((label): label is ContentLabel => typeof label === 'string' && allowed.has(label as ContentLabel))))
}

function ratioToPercent(value: unknown) {
  return Math.round(readNumber(value) * 100)
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function formatDate(value: unknown) {
  const raw = readString(value, '')
  if (!raw) return '-'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function formatTime(value: unknown) {
  const raw = readString(value, '')
  if (!raw) return '--:--'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return date.toISOString().slice(11, 16)
}

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}
