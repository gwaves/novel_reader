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
    summary: number
    kg: number
    embedding: number
  }
  audioCoverage: number
  recentDownloads: number
  packageStatus: string
  missingAudioChapters: number
}

export type AdminDevice = {
  id: string
  name: string
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

export const contentHealth = [
  { label: '书籍', value: '12 本' },
  { label: '受限', value: '3 本' },
  { label: '隐藏', value: '1 本' },
  { label: '缺音频章节', value: '28' },
  { label: '异常数据包', value: '1' },
]

export const recentEvents = [
  { time: '10:22', level: 'info', text: '导入《烬鳞纪》数据包成功' },
  { time: '10:18', level: 'warn', text: '/mobile/books/jinlin/audio 返回 404' },
  { time: '10:10', level: 'info', text: '设备“客厅小米平板”连接，验证码 428193' },
  { time: '09:56', level: 'error', text: '《夜航档案》embedding 覆盖率低于 70%' },
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
