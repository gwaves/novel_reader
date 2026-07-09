import {
  type AdminBook,
  type AdminAudio,
  type AdminAnalyticsSummary,
  type AdminBehaviorEvent,
  type AdminDevice,
  type AdminLogFile,
  type AdminPackage,
  type AdminDownloadTrendBucket,
  type AdminRequestTrendBucket,
  type AdminRequestLog,
  type AdminSystemSummary,
  type AdminTopAction,
  type AdminTopBook,
  type ContentLabel,
  type DeviceRole,
  type Visibility,
  initialAudio,
  initialBooks,
  initialDevices,
  initialPackages,
  initialRequestLogs,
  analyticsSummary,
  overviewMetrics,
  recentEvents,
} from './mockData'

const gatewayDisplayTimeZone = 'Asia/Shanghai'

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
  note?: string
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
  process?: {
    uptimeSeconds?: number
    rssBytes?: number
    heapUsedBytes?: number
    dataDirBytes?: number
  }
  trends?: {
    requests?: Array<{
      startAt?: string
      requestCount?: number
      errorCount?: number
      p95Ms?: number
    }>
    downloads?: Array<{
      startAt?: string
      packageDownloads?: number
      audioDownloads?: number
    }>
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
  embeddingVectorCoverage?: number
  embeddingSummaryVectorCount?: number
  embeddingChunkVectorCount?: number
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

type GatewayAnalytics = {
  behavior?: {
    eventsLast24Hours?: number
    diagnosticsLast24Hours?: number
    errorEventsLast24Hours?: number
    activeDevicesLast24Hours?: number
    topActions?: GatewayTopAction[]
    topBooks?: GatewayTopBook[]
    recentEvents?: GatewayBehaviorEvent[]
  }
  requests?: {
    persistedLast24Hours?: number
    persistedDownloadsLast24Hours?: number
  }
  logFiles?: {
    totalFiles?: number
    totalBytes?: number
    recentFiles?: GatewayLogFile[]
  }
}

type GatewayTopAction = {
  value?: string
  count?: number
}

type GatewayTopBook = {
  bookId?: string
  title?: string
  count?: number
}

type GatewayBehaviorEvent = {
  receivedAt?: string
  level?: 'info' | 'warn' | 'error'
  source?: string
  eventName?: string
  message?: string
  deviceId?: string
  deviceName?: string
  bookId?: string
  chapterId?: string
}

type GatewayLogFile = {
  kind?: string
  date?: string
  fileName?: string
  relativePath?: string
  sizeBytes?: number
}

export type AdminDashboardData = {
  books: AdminBook[]
  devices: AdminDevice[]
  packages: AdminPackage[]
  audio: AdminAudio[]
  requestLogs: AdminRequestLog[]
  overviewMetrics: typeof overviewMetrics
  recentEvents: typeof recentEvents
  requestTrend: AdminRequestTrendBucket[]
  downloadTrend: AdminDownloadTrendBucket[]
  systemSummary: AdminSystemSummary
  source: 'api' | 'mock'
  status: 'ok' | 'mock' | 'unauthorized' | 'unavailable' | 'partial'
  failedSections: string[]
}

export const adminTokenStorageKey = 'novel-reader-gateway-admin-token'

export async function loadAdminDashboardData(fetcher: typeof fetch = fetch): Promise<AdminDashboardData> {
  const sections = await Promise.allSettled([
    adminFetch<{ books?: GatewayBook[] }>('/admin/books', fetcher),
    adminFetch<{ devices?: GatewayDevice[] }>('/admin/devices', fetcher),
    adminFetch<GatewayMetrics>('/admin/metrics', fetcher),
    adminFetch<GatewayEvents>('/admin/events', fetcher),
    adminFetch<{ packages?: GatewayPackage[] }>('/admin/packages', fetcher),
    adminFetch<{ audio?: GatewayAudio[] }>('/admin/audio', fetcher),
    adminFetch<{ requests?: GatewayRequestLog[] }>('/admin/requests', fetcher),
  ])

  if (sections.some((section) => section.status === 'rejected' && isAdminApiError(section.reason, 'unauthorized'))) {
    return mockDashboardData('unauthorized', 'api')
  }

  if (sections.every((section) => section.status === 'rejected' && isAdminApiError(section.reason, 'unavailable'))) {
    return mockDashboardData('unavailable', 'mock')
  }

  const [booksResult, devicesResult, metricsResult, eventsResult, packagesResult, audioResult, requestsResult] = sections
  const failedSections = sections.flatMap((section, index) => section.status === 'rejected' ? [sectionNames[index]] : [])
  const status: AdminDashboardData['status'] = failedSections.length > 0 ? 'partial' : 'ok'

  const booksResponse = booksResult.status === 'fulfilled' ? booksResult.value : { books: [] }
  const devicesResponse = devicesResult.status === 'fulfilled' ? devicesResult.value : { devices: [] }
  const metricsResponse = metricsResult.status === 'fulfilled' ? metricsResult.value : null
  const eventsResponse = eventsResult.status === 'fulfilled' ? eventsResult.value : null
  const packagesResponse = packagesResult.status === 'fulfilled' ? packagesResult.value : { packages: [] }
  const audioResponse = audioResult.status === 'fulfilled' ? audioResult.value : { audio: [] }
  const requestsResponse = requestsResult.status === 'fulfilled' ? requestsResult.value : { requests: [] }

  return {
    books: Array.isArray(booksResponse.books) ? booksResponse.books.map(mapBookLike) : [],
    devices: Array.isArray(devicesResponse.devices) ? devicesResponse.devices.map(mapDeviceLike) : [],
    packages: Array.isArray(packagesResponse.packages) ? packagesResponse.packages.map(mapPackageLike) : [],
    audio: Array.isArray(audioResponse.audio) ? audioResponse.audio.map(mapAudioLike) : [],
    requestLogs: Array.isArray(requestsResponse.requests) ? requestsResponse.requests.map(mapRequestLogLike) : [],
    overviewMetrics: metricsResponse ? mapMetrics(metricsResponse) : [],
    recentEvents: eventsResponse ? mapEvents(eventsResponse) : [],
    requestTrend: metricsResponse ? mapRequestTrend(metricsResponse) : [],
    downloadTrend: metricsResponse ? mapDownloadTrend(metricsResponse) : [],
    systemSummary: metricsResponse ? mapSystemSummary(metricsResponse) : emptySystemSummary,
    source: 'api',
    status,
    failedSections,
  }
}

export async function loadAdminOverviewData(fetcher: typeof fetch = fetch): Promise<Pick<AdminDashboardData, 'overviewMetrics' | 'recentEvents' | 'requestTrend' | 'downloadTrend' | 'systemSummary' | 'source' | 'status' | 'failedSections'>> {
  const sections = await Promise.allSettled([
    adminFetch<GatewayMetrics>('/admin/metrics', fetcher),
    adminFetch<GatewayEvents>('/admin/events', fetcher),
  ])

  if (sections.some((section) => section.status === 'rejected' && isAdminApiError(section.reason, 'unauthorized'))) {
    return {
      overviewMetrics,
      recentEvents,
      requestTrend: [],
      downloadTrend: [],
      systemSummary: emptySystemSummary,
      source: 'api',
      status: 'unauthorized',
      failedSections: ['metrics', 'events'],
    }
  }

  if (sections.every((section) => section.status === 'rejected' && isAdminApiError(section.reason, 'unavailable'))) {
    return {
      overviewMetrics,
      recentEvents,
      requestTrend: [],
      downloadTrend: [],
      systemSummary: emptySystemSummary,
      source: 'mock',
      status: 'unavailable',
      failedSections: ['metrics', 'events'],
    }
  }

  const [metricsResult, eventsResult] = sections
  const failedSections = sections.flatMap((section, index) => section.status === 'rejected' ? [['metrics', 'events'][index]] : [])
  return {
    overviewMetrics: metricsResult.status === 'fulfilled' ? mapMetrics(metricsResult.value) : [],
    recentEvents: eventsResult.status === 'fulfilled' ? mapEvents(eventsResult.value) : [],
    requestTrend: metricsResult.status === 'fulfilled' ? mapRequestTrend(metricsResult.value) : [],
    downloadTrend: metricsResult.status === 'fulfilled' ? mapDownloadTrend(metricsResult.value) : [],
    systemSummary: metricsResult.status === 'fulfilled' ? mapSystemSummary(metricsResult.value) : emptySystemSummary,
    source: 'api',
    status: failedSections.length > 0 ? 'partial' : 'ok',
    failedSections,
  }
}

export async function loadAdminAnalyticsData(fetcher: typeof fetch = fetch): Promise<AdminAnalyticsSummary> {
  try {
    return mapAnalytics(await adminFetch<GatewayAnalytics>('/admin/analytics', fetcher))
  } catch (error) {
    if (isAdminApiError(error, 'unauthorized')) return emptyAnalyticsSummary()
    return analyticsSummary
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

export async function patchDeviceNote(deviceId: string, note: string, fetcher: typeof fetch = fetch) {
  await adminFetch(`/admin/devices/${encodeURIComponent(deviceId)}`, fetcher, {
    method: 'PATCH',
    body: JSON.stringify({ note }),
  })
}

export async function downloadPackage(bookId: string, fetcher: typeof fetch = fetch) {
  return adminFetch<Blob>(`/admin/books/${encodeURIComponent(bookId)}/package/download`, fetcher, {}, 'blob')
}

export async function importBookPackage(bookId: string, bookPackage: unknown, fetcher: typeof fetch = fetch) {
  await adminFetch(`/admin/books/${encodeURIComponent(bookId)}/package`, fetcher, {
    method: 'PUT',
    body: JSON.stringify(bookPackage),
  })
}

export async function refreshBookAudio(bookId: string, fetcher: typeof fetch = fetch) {
  const response = await adminFetch<{ audio?: GatewayAudio | AdminAudio }>(`/admin/books/${encodeURIComponent(bookId)}/audio/refresh`, fetcher, {
    method: 'POST',
  })
  return response.audio ? mapAudioLike(response.audio) : null
}

export async function deleteBookAudio(bookId: string, fetcher: typeof fetch = fetch) {
  const response = await adminFetch<{ audio?: GatewayAudio | AdminAudio }>(`/admin/books/${encodeURIComponent(bookId)}/audio`, fetcher, {
    method: 'DELETE',
  })
  return response.audio ? mapAudioLike(response.audio) : null
}

export async function deleteBook(bookId: string, fetcher: typeof fetch = fetch) {
  await adminFetch(`/admin/books/${encodeURIComponent(bookId)}`, fetcher, {
    method: 'DELETE',
  })
}

export function adminErrorLabel(error: unknown) {
  if (isAdminApiError(error, 'unauthorized')) return '未授权'
  if (isAdminApiError(error, 'unavailable')) return '服务不可用'
  if (error instanceof AdminApiError && error.status >= 500) return '服务不可用'
  return '请求失败'
}

async function adminFetch<T = unknown>(
  path: string,
  fetcher: typeof fetch,
  init: RequestInit = {},
  responseType: 'json' | 'blob' = 'json',
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')
  if (init.body) headers.set('content-type', 'application/json')
  const token = readAdminToken()
  if (token) headers.set('authorization', `Bearer ${token}`)

  let response: Response
  try {
    response = await fetcher(path, {
      ...init,
      headers,
    })
  } catch (error) {
    throw new AdminApiError('Gateway admin API unavailable', 'unavailable', 0, error)
  }
  if (!response.ok) {
    const kind = response.status === 401 || response.status === 403 ? 'unauthorized' : 'http'
    throw new AdminApiError(`Gateway admin API ${response.status}`, kind, response.status)
  }
  if (responseType === 'blob') return response.blob() as Promise<T>
  return response.json() as Promise<T>
}

class AdminApiError extends Error {
  constructor(
    message: string,
    readonly kind: 'unauthorized' | 'unavailable' | 'http',
    readonly status: number,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

function isAdminApiError(error: unknown, kind: AdminApiError['kind']) {
  return error instanceof AdminApiError && error.kind === kind
}

const sectionNames = ['书籍', '设备', '指标', '事件', '数据包', '音频', '请求日志']
const emptySystemSummary: AdminSystemSummary = {
  uptimeSeconds: 0,
  rssBytes: 0,
  heapUsedBytes: 0,
  dataDirBytes: 0,
}

function mockDashboardData(status: AdminDashboardData['status'], source: AdminDashboardData['source']): AdminDashboardData {
  return {
    books: status === 'unauthorized' ? [] : initialBooks,
    devices: status === 'unauthorized' ? [] : initialDevices,
    packages: status === 'unauthorized' ? [] : initialPackages,
    audio: status === 'unauthorized' ? [] : initialAudio,
    requestLogs: status === 'unauthorized' ? [] : initialRequestLogs,
    overviewMetrics: status === 'unauthorized' ? [] : overviewMetrics,
    recentEvents: status === 'unauthorized' ? [] : recentEvents,
    requestTrend: [],
    downloadTrend: [],
    systemSummary: emptySystemSummary,
    source,
    status,
    failedSections: status === 'partial' ? [] : sectionNames,
  }
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
      summary: optionalRatioToPercent(book.summaryCoverage),
      kg: optionalRatioToPercent(book.kgCoverage),
      embedding: optionalRatioToPercent(book.embeddingCoverage),
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
    note: readString(device.note, ''),
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
  const chapterCount = readNumber(item.chapterCount)
  const missingChapters = normalizeChapterList(item.missingChapters)
  const summaryCoverage = optionalRatioToPercent(item.summaryCoverage)
  const kgCoverage = optionalRatioToPercent(item.kgCoverage)
  const embeddingCoverage = optionalRatioToPercent(item.embeddingCoverage)
  const embeddingVectorCoverage = optionalRatioToPercent(item.embeddingVectorCoverage)
  const embeddingSummaryVectorCount = readNumber(item.embeddingSummaryVectorCount)
  const embeddingChunkVectorCount = readNumber(item.embeddingChunkVectorCount)
  return {
    id: readString(item.id, `${readString(item.bookId, 'package')}-${version}`),
    bookId: readString(item.bookId, 'unknown-book'),
    bookTitle: readString(item.bookTitle, readString(item.title, '未命名书籍')),
    version: formatDate(version),
    status: normalizePackageStatus(item.status ?? item.importStatus),
    sizeMb: readNumber(item.sizeMb) || bytesToMb(item.sizeBytes),
    updatedAt: formatDate(updatedAt || importedAt),
    chapterCount,
    summaryCoverage,
    kgCoverage,
    embeddingCoverage,
    embeddingVectorCoverage,
    embeddingSummaryVectorCount,
    embeddingChunkVectorCount,
    missingChapters,
    validationIssues: buildPackageValidationIssues({
      chapterCount,
      missingChapters,
      summaryCoverage,
      kgCoverage,
      embeddingCoverage,
      embeddingVectorCoverage,
      embeddingChunkVectorCount,
      embeddingSummaryVectorCount,
    }),
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
  const ip = readString(log.ip, '-')
  return {
    id: readString(log.id, readString(log.requestId, `${readString(log.method, 'GET')}-${path}-${readString(log.time, '')}`)),
    time: formatTime(log.time),
    method: readString(log.method, 'GET').toUpperCase(),
    path,
    statusCode: readNumber(log.statusCode),
    durationMs: readNumber(log.durationMs),
    deviceName: readString(log.deviceName, '未知设备'),
    deviceId: readString(log.deviceId, '-'),
    ip,
  }
}

function mapAnalytics(payload: GatewayAnalytics): AdminAnalyticsSummary {
  return {
    eventsLast24Hours: readNumber(payload.behavior?.eventsLast24Hours),
    diagnosticsLast24Hours: readNumber(payload.behavior?.diagnosticsLast24Hours),
    errorEventsLast24Hours: readNumber(payload.behavior?.errorEventsLast24Hours),
    activeDevicesLast24Hours: readNumber(payload.behavior?.activeDevicesLast24Hours),
    persistedRequestsLast24Hours: readNumber(payload.requests?.persistedLast24Hours),
    persistedDownloadsLast24Hours: readNumber(payload.requests?.persistedDownloadsLast24Hours),
    logFileCount: readNumber(payload.logFiles?.totalFiles),
    logFileBytes: readNumber(payload.logFiles?.totalBytes),
    topActions: Array.isArray(payload.behavior?.topActions) ? payload.behavior.topActions.map(mapTopAction).filter(hasTopActionValue) : [],
    topBooks: Array.isArray(payload.behavior?.topBooks) ? payload.behavior.topBooks.map(mapTopBook).filter(hasTopBookId) : [],
    recentEvents: Array.isArray(payload.behavior?.recentEvents) ? payload.behavior.recentEvents.map(mapBehaviorEvent) : [],
    recentFiles: Array.isArray(payload.logFiles?.recentFiles) ? payload.logFiles.recentFiles.map(mapLogFile) : [],
  }
}

function emptyAnalyticsSummary(): AdminAnalyticsSummary {
  return {
    eventsLast24Hours: 0,
    diagnosticsLast24Hours: 0,
    errorEventsLast24Hours: 0,
    activeDevicesLast24Hours: 0,
    persistedRequestsLast24Hours: 0,
    persistedDownloadsLast24Hours: 0,
    logFileCount: 0,
    logFileBytes: 0,
    topActions: [],
    topBooks: [],
    recentEvents: [],
    recentFiles: [],
  }
}

function mapTopAction(item: GatewayTopAction): AdminTopAction {
  return {
    value: readString(item.value, ''),
    count: readNumber(item.count),
  }
}

function mapTopBook(item: GatewayTopBook): AdminTopBook {
  return {
    bookId: readString(item.bookId, ''),
    title: readString(item.title, readString(item.bookId, '')),
    count: readNumber(item.count),
  }
}

function hasTopActionValue(item: AdminTopAction) {
  return Boolean(item.value)
}

function hasTopBookId(item: AdminTopBook) {
  return Boolean(item.bookId)
}

function mapBehaviorEvent(event: GatewayBehaviorEvent): AdminBehaviorEvent {
  return {
    receivedAt: formatTime(event.receivedAt),
    level: event.level ?? 'info',
    source: readString(event.source, 'app'),
    eventName: readString(event.eventName, 'event'),
    message: readString(event.message, 'mobile event'),
    deviceId: readString(event.deviceId, '-'),
    deviceName: readString(event.deviceName, '未知设备'),
    bookId: readString(event.bookId, '-'),
    chapterId: readString(event.chapterId, '-'),
  }
}

function mapLogFile(file: GatewayLogFile): AdminLogFile {
  return {
    kind: file.kind === 'requests' ? 'requests' : 'mobile',
    date: readString(file.date, '-'),
    fileName: readString(file.fileName, '-'),
    relativePath: readString(file.relativePath, '-'),
    sizeBytes: readNumber(file.sizeBytes),
  }
}

function mapBookLike(book: GatewayBook | AdminBook): AdminBook {
  if ('coverage' in book && 'packageUpdatedAt' in book) return book
  return mapBook(book)
}

function mapDeviceLike(device: GatewayDevice | AdminDevice): AdminDevice {
  if ('pairingCode' in device && 'recentRequests' in device) {
    return {
      ...device,
      note: typeof device.note === 'string' ? device.note : '',
    }
  }
  return mapDevice(device)
}

function mapPackageLike(item: GatewayPackage | AdminPackage): AdminPackage {
  if (isAdminPackage(item)) return item
  return mapPackage(item)
}

function mapAudioLike(item: GatewayAudio | AdminAudio): AdminAudio {
  if (isAdminAudio(item)) {
    return {
      ...item,
      status: normalizeAudioStatus(item.status, item.chapterCount, item.availableChapters),
      coverage: ratioToPercent(item.coverage),
    }
  }
  return mapAudio(item)
}

function mapRequestLogLike(log: GatewayRequestLog | AdminRequestLog): AdminRequestLog {
  if (isAdminRequestLog(log)) return log
  return mapRequestLog(log)
}

function isAdminPackage(item: GatewayPackage | AdminPackage): item is AdminPackage {
  return typeof item.id === 'string'
    && typeof item.bookId === 'string'
    && typeof item.bookTitle === 'string'
    && typeof item.sizeMb === 'number'
    && Array.isArray(item.missingChapters)
}

function isAdminAudio(item: GatewayAudio | AdminAudio): item is AdminAudio {
  return typeof item.id === 'string'
    && typeof item.bookId === 'string'
    && typeof item.bookTitle === 'string'
    && typeof item.chapterCount === 'number'
    && typeof item.availableChapters === 'number'
    && Array.isArray(item.missingChapters)
}

function isAdminRequestLog(log: GatewayRequestLog | AdminRequestLog): log is AdminRequestLog {
  return typeof log.id === 'string'
    && typeof log.time === 'string'
    && typeof log.statusCode === 'number'
    && typeof log.durationMs === 'number'
    && typeof log.deviceName === 'string'
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

function mapRequestTrend(metrics: GatewayMetrics): AdminRequestTrendBucket[] {
  if (!Array.isArray(metrics.trends?.requests)) return []
  return metrics.trends.requests.map((bucket) => ({
    label: formatTime(bucket.startAt),
    requestCount: readNumber(bucket.requestCount),
    errorCount: readNumber(bucket.errorCount),
    p95Ms: readNumber(bucket.p95Ms),
  }))
}

function mapDownloadTrend(metrics: GatewayMetrics): AdminDownloadTrendBucket[] {
  if (!Array.isArray(metrics.trends?.downloads)) return []
  return metrics.trends.downloads.map((bucket) => ({
    label: formatTime(bucket.startAt),
    packageDownloads: readNumber(bucket.packageDownloads),
    audioDownloads: readNumber(bucket.audioDownloads),
  }))
}

function mapSystemSummary(metrics: GatewayMetrics): AdminSystemSummary {
  return {
    uptimeSeconds: readNumber(metrics.process?.uptimeSeconds),
    rssBytes: readNumber(metrics.process?.rssBytes),
    heapUsedBytes: readNumber(metrics.process?.heapUsedBytes),
    dataDirBytes: readNumber(metrics.process?.dataDirBytes),
  }
}

function mapEvents(payload: GatewayEvents): typeof recentEvents {
  if (!Array.isArray(payload.events) || payload.events.length === 0) return []
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

function buildPackageValidationIssues({
  chapterCount,
  missingChapters,
  summaryCoverage,
  kgCoverage,
  embeddingCoverage,
  embeddingVectorCoverage,
  embeddingChunkVectorCount,
  embeddingSummaryVectorCount,
}: {
  chapterCount: number
  missingChapters: Array<number | string>
  summaryCoverage: number | null
  kgCoverage: number | null
  embeddingCoverage: number | null
  embeddingVectorCoverage: number | null
  embeddingChunkVectorCount: number
  embeddingSummaryVectorCount: number
}) {
  const issues: string[] = []
  if (missingChapters.length > 0) issues.push(`章节文件缺失 ${missingChapters.length} 章`)
  const coverageItems = [
    ['Summary', summaryCoverage],
    ['KG', kgCoverage],
    ['Embedding', embeddingCoverage],
  ] as const

  for (const [label, coverage] of coverageItems) {
    const missingCount = missingCountFromCoverage(chapterCount, coverage)
    if (missingCount > 0) issues.push(`${label} 缺 ${missingCount} 章`)
  }
  if (embeddingCoverage !== null && embeddingCoverage > 0 && embeddingChunkVectorCount === 0 && embeddingSummaryVectorCount === 0) {
    issues.push('Embedding 报告存在但 Gateway 向量缺失')
  } else {
    const missingVectorChapters = missingCountFromCoverage(chapterCount, embeddingVectorCoverage)
    if (missingVectorChapters > 0) issues.push(`Gateway 向量缺 ${missingVectorChapters} 章`)
  }

  return issues
}

function missingCountFromCoverage(chapterCount: number, coverage: number | null) {
  if (chapterCount <= 0 || coverage === null || coverage >= 100) return 0
  const ratio = Math.max(0, Math.min(100, coverage)) / 100
  return Math.max(0, Math.round(chapterCount * (1 - ratio)))
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

function optionalRatioToPercent(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return ratioToPercent(value)
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
  return formatDateTimeInGatewayTimeZone(date)
}

function formatTime(value: unknown) {
  const raw = readString(value, '')
  if (!raw) return '--:--'
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return formatTimeInGatewayTimeZone(date)
}

function formatDateTimeInGatewayTimeZone(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: gatewayDisplayTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`
}

function formatTimeInGatewayTimeZone(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: gatewayDisplayTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.hour}:${values.minute}`
}

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

function bytesToMb(value: unknown) {
  return readNumber(value) / 1024 / 1024
}
