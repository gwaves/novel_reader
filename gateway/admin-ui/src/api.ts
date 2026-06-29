import {
  type AdminBook,
  type AdminDevice,
  type AdminAudio,
  type AdminPackage,
  type AdminRequestLog,
  type ContentLabel,
  type DeviceRole,
  type Visibility,
  initialAudio,
  initialBooks,
  initialDevices,
  initialPackages,
  initialRequestLogs,
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

type GatewayPackage = {
  id?: string
  bookId?: string
  bookTitle?: string
  title?: string
  version?: string
  status?: string
  importStatus?: string
  sizeMb?: number
  sizeBytes?: number
  updatedAt?: string
  importedAt?: string
  chapterCount?: number
  packageChapterCount?: number
  summaryCoverage?: number
  kgCoverage?: number
  embeddingCoverage?: number
  missingChapters?: unknown[]
  checksum?: string
  errorCode?: string
}

type GatewayAudio = {
  id?: string
  bookId?: string
  bookTitle?: string
  title?: string
  status?: string
  chapterCount?: number
  availableChapters?: number
  audioChapterCount?: number
  coverage?: number
  missingChapters?: unknown[]
  missingChapterIds?: unknown[]
  totalDuration?: string
  sizeMb?: number
  totalSizeBytes?: number
  lastGeneratedAt?: string
  updatedAt?: string
  voice?: string
  downloads24h?: number
}

type GatewayRequestLog = {
  id?: string
  requestId?: string
  time?: string
  method?: string
  path?: string
  url?: string
  statusCode?: number
  durationMs?: number
  deviceName?: string
  deviceId?: string
  ip?: string
}

export type AdminDashboardData = {
  books: AdminBook[]
  devices: AdminDevice[]
  packages: AdminPackage[]
  audio: AdminAudio[]
  requestLogs: AdminRequestLog[]
  overviewMetrics: typeof overviewMetrics
  recentEvents: typeof recentEvents
  source: 'api' | 'mock'
}

export const adminTokenStorageKey = 'novel-reader-gateway-admin-token'

export async function loadAdminDashboardData(fetcher: typeof fetch = fetch): Promise<AdminDashboardData> {
  try {
    const [
      booksResponse,
      devicesResponse,
      metricsResponse,
      eventsResponse,
      packagesResponse,
      audioResponse,
      requestsResponse,
    ] = await Promise.all([
      adminFetch<{ books?: GatewayBook[] }>('/admin/books', fetcher),
      adminFetch<{ devices?: GatewayDevice[] }>('/admin/devices', fetcher),
      adminFetch<GatewayMetrics>('/admin/metrics', fetcher),
      adminFetch<GatewayEvents>('/admin/events', fetcher),
      adminFetch<{ packages?: GatewayPackage[] }>('/admin/packages', fetcher),
      adminFetch<{ audio?: GatewayAudio[] }>('/admin/audio', fetcher),
      adminFetch<{ requests?: GatewayRequestLog[] }>('/admin/requests', fetcher),
    ])
    return {
      books: Array.isArray(booksResponse.books) ? booksResponse.books.map(mapBook) : [],
      devices: Array.isArray(devicesResponse.devices) ? devicesResponse.devices.map(mapDevice) : [],
      packages: Array.isArray(packagesResponse.packages) ? packagesResponse.packages.map(mapPackage) : [],
      audio: Array.isArray(audioResponse.audio) ? audioResponse.audio.map(mapAudio) : [],
      requestLogs: Array.isArray(requestsResponse.requests) ? requestsResponse.requests.map(mapRequestLog) : [],
      overviewMetrics: mapMetrics(metricsResponse),
      recentEvents: mapEvents(eventsResponse),
      source: 'api',
    }
  } catch {
    return {
      books: initialBooks,
      devices: initialDevices,
      packages: initialPackages,
      audio: initialAudio,
      requestLogs: initialRequestLogs,
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

function mapPackage(item: GatewayPackage): AdminPackage {
  const importedAt = readString(item.importedAt, '')
  const updatedAt = readString(item.updatedAt, '')
  const version = readString(item.version, importedAt || updatedAt || 'latest')
  return {
    id: readString(item.id, `${readString(item.bookId, 'package')}-${version}`),
    bookId: readString(item.bookId, 'unknown-book'),
    bookTitle: readString(item.bookTitle, readString(item.title, '未命名书籍')),
    version: formatDate(version),
    status: normalizePackageStatus(item.status ?? item.importStatus),
    sizeMb: readNumber(item.sizeMb) || bytesToMb(item.sizeBytes),
    updatedAt: formatDate(updatedAt || importedAt),
    chapterCount: readNumber(item.chapterCount),
    summaryCoverage: ratioToPercent(item.summaryCoverage),
    kgCoverage: ratioToPercent(item.kgCoverage),
    embeddingCoverage: ratioToPercent(item.embeddingCoverage),
    missingChapters: normalizeChapterList(item.missingChapters),
    checksum: readString(item.checksum, readString(item.errorCode, '-')),
  }
}

function mapAudio(item: GatewayAudio): AdminAudio {
  const chapterCount = readNumber(item.chapterCount)
  const availableChapters = readNumber(item.availableChapters ?? item.audioChapterCount)
  const missingChapters = normalizeChapterList(item.missingChapters ?? item.missingChapterIds)
  return {
    id: readString(item.id, `audio-${readString(item.bookId, 'unknown-book')}`),
    bookId: readString(item.bookId, 'unknown-book'),
    bookTitle: readString(item.bookTitle, readString(item.title, '未命名书籍')),
    status: normalizeAudioStatus(item.status, chapterCount, availableChapters),
    chapterCount,
    availableChapters,
    coverage: item.coverage === undefined
      ? chapterCount > 0 ? Math.round((availableChapters / chapterCount) * 100) : 0
      : ratioToPercent(item.coverage),
    missingChapters,
    totalDuration: readString(item.totalDuration, '-'),
    sizeMb: readNumber(item.sizeMb) || bytesToMb(item.totalSizeBytes),
    lastGeneratedAt: formatDate(item.lastGeneratedAt ?? item.updatedAt),
    voice: readString(item.voice, '默认'),
    downloads24h: readNumber(item.downloads24h),
  }
}

function mapRequestLog(log: GatewayRequestLog): AdminRequestLog {
  const path = readString(log.path, readString(log.url, '/'))
  return {
    id: readString(log.id, readString(log.requestId, `${readString(log.method, 'GET')}-${path}-${readString(log.time, '')}`)),
    time: formatTime(log.time),
    method: readString(log.method, 'GET').toUpperCase(),
    path,
    statusCode: readNumber(log.statusCode),
    durationMs: readNumber(log.durationMs),
    deviceName: readString(log.deviceName, '未知设备'),
    deviceId: readString(log.deviceId, '-'),
    ip: readString(log.ip, '-'),
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

function normalizePackageStatus(value: unknown): AdminPackage['status'] {
  if (value === 'imported') return 'ready'
  if (value === 'missing' || value === 'invalid') return 'failed'
  return value === 'warning' || value === 'failed' ? value : 'ready'
}

function normalizeAudioStatus(value: unknown, chapterCount = 0, availableChapters = 0): AdminAudio['status'] {
  if (value === undefined && chapterCount > 0) {
    if (availableChapters <= 0) return 'missing'
    if (availableChapters < chapterCount) return 'partial'
  }
  return value === 'partial' || value === 'missing' ? value : 'ready'
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
  const number = readNumber(value)
  return number <= 1 ? Math.round(number * 100) : Math.round(number)
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeChapterList(value: unknown): Array<number | string> {
  if (!Array.isArray(value)) return []
  return value.filter((chapter): chapter is number | string => {
    if (Number.isInteger(chapter) && chapter > 0) return true
    return typeof chapter === 'string' && Boolean(chapter.trim())
  })
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

function bytesToMb(value: unknown) {
  return readNumber(value) / 1024 / 1024
}
