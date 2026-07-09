export type Visibility = 'default' | 'trusted' | 'admin' | 'hidden'
export type ContentLabel = 'adult' | 'violence' | 'private' | 'test' | 'archived'
export type DeviceRole = 'default' | 'trusted' | 'disabled'

export type AdminBook = {
  id: string
  title: string
  author: string
  visibility: Visibility
  labels: ContentLabel[]
  chapterCount: number
  packageUpdatedAt: string
  coverage: {
    summary: number | null
    kg: number | null
    embedding: number | null
  }
  audioCoverage: number
  recentDownloads: number
  packageStatus: string
  missingAudioChapters: number
}

export type AdminPackage = {
  id: string
  bookId: string
  bookTitle: string
  version: string
  status: 'ready' | 'warning' | 'failed'
  sizeMb: number
  updatedAt: string
  chapterCount: number
  summaryCoverage: number | null
  kgCoverage: number | null
  embeddingCoverage: number | null
  embeddingVectorCoverage: number | null
  embeddingSummaryVectorCount: number
  embeddingChunkVectorCount: number
  missingChapters: Array<number | string>
  validationIssues: string[]
  checksum: string
}

export type AdminAudio = {
  id: string
  bookId: string
  bookTitle: string
  status: 'ready' | 'partial' | 'missing'
  chapterCount: number
  availableChapters: number
  coverage: number
  missingChapters: Array<number | string>
  totalDuration: string
  sizeMb: number
  lastGeneratedAt: string
  voice: string
  downloads24h: number
}

export type AdminDevice = {
  id: string
  name: string
  note: string
  model: string
  platform: string
  appVersion: string
  pairingCode: string
  role: DeviceRole
  firstSeenAt: string
  lastSeenAt: string
  lastIp: string
  recentRequests: number
  recentDownloads: number
}

export type AdminRequestLog = {
  id: string
  time: string
  method: string
  path: string
  statusCode: number
  durationMs: number
  deviceName: string
  deviceId: string
  ip: string
}

export type AdminRequestTrendBucket = {
  label: string
  requestCount: number
  errorCount: number
  p95Ms: number
}

export type AdminDownloadTrendBucket = {
  label: string
  packageDownloads: number
  audioDownloads: number
}

export type AdminSystemSummary = {
  uptimeSeconds: number
  rssBytes: number
  heapUsedBytes: number
  dataDirBytes: number
}

export type AdminTopAction = {
  value: string
  count: number
}

export type AdminTopBook = {
  bookId: string
  title: string
  count: number
}

export type AdminBehaviorEvent = {
  receivedAt: string
  level: 'info' | 'warn' | 'error'
  source: string
  eventName: string
  message: string
  deviceId: string
  deviceName: string
  bookId: string
  chapterId: string
}

export type AdminLogFile = {
  kind: 'requests' | 'mobile'
  date: string
  fileName: string
  relativePath: string
  sizeBytes: number
}

export type AdminAnalyticsSummary = {
  eventsLast24Hours: number
  diagnosticsLast24Hours: number
  errorEventsLast24Hours: number
  activeDevicesLast24Hours: number
  persistedRequestsLast24Hours: number
  persistedDownloadsLast24Hours: number
  logFileCount: number
  logFileBytes: number
  topActions: AdminTopAction[]
  topBooks: AdminTopBook[]
  recentEvents: AdminBehaviorEvent[]
  recentFiles: AdminLogFile[]
}

export const visibilityOptions: Visibility[] = ['default', 'trusted', 'admin', 'hidden']

export const labelNames: Record<ContentLabel, string> = {
  adult: '少儿不宜',
  violence: '暴力',
  private: '私有',
  test: '测试',
  archived: '归档',
}

export const roleNames: Record<DeviceRole, string> = {
  default: '普通',
  trusted: '受信',
  disabled: '禁用',
}

export const labelOptions = Object.keys(labelNames) as ContentLabel[]

export const overviewMetrics = [
  { label: '今日请求', value: '12,430', note: '近 15 分钟 1,208' },
  { label: '错误率', value: '0.3%', note: '404 占 62%' },
  { label: 'P95 响应', value: '180ms', note: '慢请求 9 条' },
  { label: '下载次数', value: '842', note: '音频 834 / 数据包 8' },
]

export const recentEvents = [
  { time: '10:22', level: 'info', text: '导入《烬鳞纪》数据包成功' },
  { time: '10:18', level: 'warn', text: '/mobile/books/jinlin/audio 返回 404' },
  { time: '10:10', level: 'info', text: '设备“客厅小米平板”连接，验证码 428193' },
  { time: '09:56', level: 'error', text: '《夜航档案》embedding 覆盖率低于 70%' },
]

export const analyticsSummary: AdminAnalyticsSummary = {
  eventsLast24Hours: 128,
  diagnosticsLast24Hours: 6,
  errorEventsLast24Hours: 2,
  activeDevicesLast24Hours: 3,
  persistedRequestsLast24Hours: 12430,
  persistedDownloadsLast24Hours: 842,
  logFileCount: 8,
  logFileBytes: 18 * 1024 * 1024,
  topActions: [
    { value: 'openBook', count: 42 },
    { value: 'selectChapter', count: 36 },
    { value: 'playCurrentAudio', count: 28 },
  ],
  topBooks: [
    { bookId: 'jinlin', title: '烬鳞纪', count: 76 },
    { bookId: 'yaodao', title: '妖刀记', count: 41 },
  ],
  recentEvents: [
    {
      receivedAt: '2026-07-09T10:22:18.000Z',
      level: 'info',
      source: 'behavior',
      eventName: 'playCurrentAudio',
      message: '用户行为: playCurrentAudio',
      deviceId: 'device-living-room-pad',
      deviceName: '客厅小米平板',
      bookId: 'jinlin',
      chapterId: 'chapter-88',
    },
  ],
  recentFiles: [
    {
      kind: 'mobile',
      date: '2026-07-09',
      fileName: 'mobile-2026-07-09-000.jsonl',
      relativePath: 'mobile/2026-07-09/mobile-2026-07-09-000.jsonl',
      sizeBytes: 6 * 1024 * 1024,
    },
  ],
}

export const initialPackages: AdminPackage[] = [
  {
    id: 'pkg-jinlin-20260629',
    bookId: 'jinlin',
    bookTitle: '烬鳞纪',
    version: '2026.06.29-1208',
    status: 'ready',
    sizeMb: 42.8,
    updatedAt: '2026-06-29 12:08',
    chapterCount: 186,
    summaryCoverage: 96,
    kgCoverage: 88,
    embeddingCoverage: 94,
    embeddingVectorCoverage: 94,
    embeddingSummaryVectorCount: 175,
    embeddingChunkVectorCount: 932,
    missingChapters: [],
    validationIssues: ['Summary 缺 7 章', 'KG 缺 22 章', 'Embedding 缺 11 章'],
    checksum: 'sha256:8f2c1a',
  },
  {
    id: 'pkg-night-archive-20260627',
    bookId: 'night-archive',
    bookTitle: '夜航档案',
    version: '2026.06.27-1820',
    status: 'warning',
    sizeMb: 18.6,
    updatedAt: '2026-06-27 18:20',
    chapterCount: 41,
    summaryCoverage: 82,
    kgCoverage: 56,
    embeddingCoverage: 68,
    embeddingVectorCoverage: 68,
    embeddingSummaryVectorCount: 28,
    embeddingChunkVectorCount: 154,
    missingChapters: [7, 19, 33],
    validationIssues: ['章节文件缺失 3 章', 'Summary 缺 7 章', 'KG 缺 18 章', 'Embedding 缺 13 章', 'Gateway 向量缺 13 章'],
    checksum: 'sha256:91bb03',
  },
  {
    id: 'pkg-archive-sample-20260620',
    bookId: 'archive-sample',
    bookTitle: '归档样本集',
    version: '2026.06.20-0900',
    status: 'failed',
    sizeMb: 7.4,
    updatedAt: '2026-06-20 09:00',
    chapterCount: 18,
    summaryCoverage: 60,
    kgCoverage: 40,
    embeddingCoverage: 55,
    embeddingVectorCoverage: 0,
    embeddingSummaryVectorCount: 0,
    embeddingChunkVectorCount: 0,
    missingChapters: [3, 4, 5, 6],
    validationIssues: ['章节文件缺失 4 章', 'Summary 缺 7 章', 'KG 缺 11 章', 'Embedding 缺 8 章', 'Embedding 报告存在但 Gateway 向量缺失'],
    checksum: 'sha256:pending',
  },
]

export const initialAudio: AdminAudio[] = [
  {
    id: 'audio-jinlin',
    bookId: 'jinlin',
    bookTitle: '烬鳞纪',
    status: 'partial',
    chapterCount: 186,
    availableChapters: 134,
    coverage: 72,
    missingChapters: [12, 13, 14, 88, 121],
    totalDuration: '46:20:18',
    sizeMb: 1840,
    lastGeneratedAt: '2026-06-29 11:40',
    voice: '茉莉',
    downloads24h: 412,
  },
  {
    id: 'audio-yaodao',
    bookId: 'yaodao',
    bookTitle: '妖刀记',
    status: 'ready',
    chapterCount: 92,
    availableChapters: 92,
    coverage: 100,
    missingChapters: [],
    totalDuration: '31:08:02',
    sizeMb: 1216,
    lastGeneratedAt: '2026-06-28 22:10',
    voice: '冰糖',
    downloads24h: 289,
  },
  {
    id: 'audio-night-archive',
    bookId: 'night-archive',
    bookTitle: '夜航档案',
    status: 'missing',
    chapterCount: 41,
    availableChapters: 14,
    coverage: 34,
    missingChapters: [1, 2, 3, 4, 5, 6],
    totalDuration: '04:12:31',
    sizeMb: 166,
    lastGeneratedAt: '2026-06-27 08:30',
    voice: 'mimo_default',
    downloads24h: 18,
  },
]

export const initialRequestLogs: AdminRequestLog[] = [
  {
    id: 'req-1022-audio-404',
    time: '10:22:18',
    method: 'GET',
    path: '/mobile/books/jinlin/audio/088.mp3',
    statusCode: 404,
    durationMs: 42,
    deviceName: '客厅小米平板',
    deviceId: 'device-living-room-pad',
    ip: '192.168.88.23',
  },
  {
    id: 'req-1021-package',
    time: '10:21:55',
    method: 'GET',
    path: '/mobile/books/yaodao/package',
    statusCode: 200,
    durationMs: 138,
    deviceName: '书房阅读器',
    deviceId: 'device-trusted-tablet',
    ip: '10.0.0.42',
  },
  {
    id: 'req-1019-admin',
    time: '10:19:04',
    method: 'POST',
    path: '/admin/books/night-archive/visibility',
    statusCode: 204,
    durationMs: 27,
    deviceName: 'Gateway Admin',
    deviceId: 'admin-ui',
    ip: '127.0.0.1',
  },
  {
    id: 'req-1018-slow',
    time: '10:18:11',
    method: 'GET',
    path: '/mobile/books/jinlin/package',
    statusCode: 200,
    durationMs: 914,
    deviceName: '客厅小米平板',
    deviceId: 'device-living-room-pad',
    ip: '192.168.88.23',
  },
]

export const initialBooks: AdminBook[] = [
  {
    id: 'jinlin',
    title: '烬鳞纪',
    author: '青岚',
    visibility: 'trusted',
    labels: ['adult', 'private'],
    chapterCount: 186,
    packageUpdatedAt: '2026-06-29 12:08',
    coverage: { summary: 96, kg: 88, embedding: 94 },
    audioCoverage: 72,
    recentDownloads: 128,
    packageStatus: '校验通过，42.8 MB',
    missingAudioChapters: 52,
  },
  {
    id: 'yaodao',
    title: '妖刀记',
    author: '默默猴',
    visibility: 'default',
    labels: [],
    chapterCount: 92,
    packageUpdatedAt: '2026-06-28 21:34',
    coverage: { summary: 91, kg: 74, embedding: 90 },
    audioCoverage: 100,
    recentDownloads: 231,
    packageStatus: '校验通过，30.4 MB',
    missingAudioChapters: 0,
  },
  {
    id: 'night-archive',
    title: '夜航档案',
    author: '林川',
    visibility: 'admin',
    labels: ['test'],
    chapterCount: 41,
    packageUpdatedAt: '2026-06-27 18:20',
    coverage: { summary: 82, kg: 56, embedding: 68 },
    audioCoverage: 34,
    recentDownloads: 12,
    packageStatus: 'embedding 覆盖不足',
    missingAudioChapters: 27,
  },
  {
    id: 'archive-sample',
    title: '归档样本集',
    author: '运维',
    visibility: 'hidden',
    labels: ['archived'],
    chapterCount: 18,
    packageUpdatedAt: '2026-06-20 09:00',
    coverage: { summary: 60, kg: 40, embedding: 55 },
    audioCoverage: 0,
    recentDownloads: 0,
    packageStatus: '历史样本，仅后台可见',
    missingAudioChapters: 18,
  },
]

export const initialDevices: AdminDevice[] = [
  {
    id: 'device-living-room-pad',
    name: '客厅小米平板',
    note: '客厅阅读设备',
    model: 'Xiaomi Pad 6',
    platform: 'android',
    appVersion: '0.1.0',
    pairingCode: '428193',
    role: 'default',
    firstSeenAt: '2026-06-29 09:42',
    lastSeenAt: '2分钟前',
    lastIp: '192.168.88.23',
    recentRequests: 318,
    recentDownloads: 42,
  },
  {
    id: 'device-trusted-tablet',
    name: '书房阅读器',
    note: '书房固定设备',
    model: 'Lenovo Tab',
    platform: 'android',
    appVersion: '0.1.0',
    pairingCode: '913802',
    role: 'trusted',
    firstSeenAt: '2026-06-26 19:14',
    lastSeenAt: '昨天',
    lastIp: '10.0.0.42',
    recentRequests: 86,
    recentDownloads: 11,
  },
  {
    id: 'device-disabled-phone',
    name: '旧手机',
    note: '已停用',
    model: 'Android Phone',
    platform: 'android',
    appVersion: '0.0.8',
    pairingCode: '105774',
    role: 'disabled',
    firstSeenAt: '2026-06-18 11:00',
    lastSeenAt: '7天前',
    lastIp: '192.168.88.51',
    recentRequests: 0,
    recentDownloads: 0,
  },
]
