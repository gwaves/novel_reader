import { useEffect, useMemo, useState } from 'react'
import {
  adminErrorLabel,
  adminTokenStorageKey,
  deleteBook,
  deleteBookAudio,
  downloadPackage,
  importBookPackage,
  loadAdminDashboardData,
  loadAdminOverviewData,
  patchBookLabels,
  patchBookVisibility,
  patchDeviceNote,
  patchDeviceRole,
  refreshBookAudio,
  type AdminDashboardData,
} from './api'
import {
  AdminAudio,
  AdminBook,
  AdminDevice,
  AdminDownloadTrendBucket,
  AdminPackage,
  AdminRequestTrendBucket,
  AdminRequestLog,
  AdminSystemSummary,
  ContentLabel,
  DeviceRole,
  Visibility,
  labelNames,
  labelOptions,
  overviewMetrics as mockOverviewMetrics,
  recentEvents as mockRecentEvents,
  roleNames,
  visibilityOptions,
} from './mockData'

type ViewKey = 'overview' | 'books' | 'packages' | 'audio' | 'devices' | 'logs' | 'settings'
type ConnectionStatus = AdminDashboardData['status'] | 'loading'
type OperationState = 'idle' | 'saving' | 'success' | 'failed'
type OperationStatus = {
  state: OperationState
  message: string
}
type RetryAction = {
  label: string
  run: () => void
}

const navItems: Array<{ key: ViewKey; label: string }> = [
  { key: 'overview', label: '总览' },
  { key: 'books', label: '书籍' },
  { key: 'packages', label: '数据包' },
  { key: 'audio', label: '音频' },
  { key: 'devices', label: '设备' },
  { key: 'logs', label: '请求日志' },
  { key: 'settings', label: '设置' },
]

function App() {
  const [activeView, setActiveView] = useState<ViewKey>('overview')
  const [books, setBooks] = useState<AdminBook[]>([])
  const [devices, setDevices] = useState<AdminDevice[]>([])
  const [packages, setPackages] = useState<AdminPackage[]>([])
  const [audio, setAudio] = useState<AdminAudio[]>([])
  const [requestLogs, setRequestLogs] = useState<AdminRequestLog[]>([])
  const [metrics, setMetrics] = useState<typeof mockOverviewMetrics>([])
  const [events, setEvents] = useState<typeof mockRecentEvents>([])
  const [requestTrend, setRequestTrend] = useState<AdminRequestTrendBucket[]>([])
  const [downloadTrend, setDownloadTrend] = useState<AdminDownloadTrendBucket[]>([])
  const [systemSummary, setSystemSummary] = useState<AdminSystemSummary>(emptySystemSummary())
  const [dataSource, setDataSource] = useState<AdminDashboardData['source']>('api')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('loading')
  const [loadMessage, setLoadMessage] = useState('正在连接 Gateway 管理 API')
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [adminToken, setAdminToken] = useState(readStoredAdminToken)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [bookOperationStatus, setBookOperationStatus] = useState<Record<string, OperationStatus>>({})
  const [bookRetryActions, setBookRetryActions] = useState<Record<string, RetryAction>>({})
  const [deviceOperationStatus, setDeviceOperationStatus] = useState<Record<string, OperationStatus>>({})
  const [deviceRetryActions, setDeviceRetryActions] = useState<Record<string, RetryAction>>({})
  const [packageOperationStatus, setPackageOperationStatus] = useState<Record<string, OperationStatus>>({})
  const [audioOperationStatus, setAudioOperationStatus] = useState<Record<string, OperationStatus>>({})

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? null,
    [books, selectedBookId],
  )
  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  )
  const hasLoadedDetailData = books.length > 0 || devices.length > 0 || packages.length > 0 || audio.length > 0 || requestLogs.length > 0
  const isInitialLoading = connectionStatus === 'loading' || (connectionStatus === 'partial' && activeView !== 'overview' && !hasLoadedDetailData)

  const applyDashboardData = (data: AdminDashboardData) => {
    setBooks(data.books)
    setDevices(data.devices)
    setPackages(data.packages)
    setAudio(data.audio)
    setRequestLogs(data.requestLogs)
    setMetrics(data.overviewMetrics)
    setEvents(data.recentEvents)
    setRequestTrend(data.requestTrend)
    setDownloadTrend(data.downloadTrend)
    setSystemSummary(data.systemSummary)
    setDataSource(data.source)
    setConnectionStatus(data.status)
    setLoadMessage(connectionMessage(data))
  }

  const refreshDashboardData = async () => {
    setIsRefreshing(true)
    setLoadMessage('正在连接 Gateway 管理 API')
    if (books.length === 0 && devices.length === 0 && packages.length === 0 && audio.length === 0) {
      setConnectionStatus('loading')
      setDataSource('api')
    }
    const data = await loadAdminDashboardData()
    applyDashboardData(data)
    setIsRefreshing(false)
  }

  useEffect(() => {
    let cancelled = false
    void loadAdminOverviewData().then((data) => {
      if (cancelled) return
      setMetrics(data.overviewMetrics)
      setEvents(data.recentEvents)
      setRequestTrend(data.requestTrend)
      setDownloadTrend(data.downloadTrend)
      setSystemSummary(data.systemSummary)
      setDataSource(data.source)
      setConnectionStatus(data.status === 'ok' ? 'partial' : data.status)
      setLoadMessage(data.status === 'ok' ? '总览已加载，正在加载后台明细' : connectionMessage({
        books: [],
        devices: [],
        packages: [],
        audio: [],
        requestLogs: [],
        overviewMetrics: data.overviewMetrics,
        recentEvents: data.recentEvents,
        requestTrend: data.requestTrend,
        downloadTrend: data.downloadTrend,
        systemSummary: data.systemSummary,
        source: data.source,
        status: data.status,
        failedSections: data.failedSections,
      }))
    })
    void loadAdminDashboardData().then((data) => {
      if (!cancelled) applyDashboardData(data)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const saveBookPatch = async (
    bookId: string,
    patch: Partial<AdminBook>,
    operationKey: string,
    label: string,
  ) => {
    const previous = books.find((book) => book.id === bookId)
    if (!previous) return
    setBookOperationStatus((current) => ({ ...current, [operationKey]: { state: 'saving', message: '保存中' } }))
    setBookRetryActions((current) => omitKey(current, operationKey))
    setBooks((current) => current.map((book) => (book.id === bookId ? { ...book, ...patch } : book)))
    if (isLocalDemoEdit(connectionStatus, adminToken)) {
      setBookOperationStatus((current) => ({ ...current, [operationKey]: { state: 'success', message: '本地已更新' } }))
      return
    }
    try {
      if (patch.visibility) await patchBookVisibility(bookId, patch.visibility)
      if (patch.labels) await patchBookLabels(bookId, patch.labels)
      setBookOperationStatus((current) => ({ ...current, [operationKey]: { state: 'success', message: '保存成功' } }))
    } catch {
      setBooks((current) => current.map((book) => (book.id === bookId ? previous : book)))
      setBookOperationStatus((current) => ({ ...current, [operationKey]: { state: 'failed', message: '保存失败，已回滚' } }))
      setBookRetryActions((current) => ({
        ...current,
        [operationKey]: { label: `重试保存${label}`, run: () => void saveBookPatch(bookId, patch, operationKey, label) },
      }))
    }
  }

  const updateBook = (bookId: string, patch: Partial<AdminBook>) => {
    if (patch.visibility) void saveBookPatch(bookId, patch, `${bookId}:visibility`, '可见范围')
    if (patch.labels) void saveBookPatch(bookId, patch, `${bookId}:labels`, '标签')
  }

  const handleDeleteBook = async (book: AdminBook) => {
    if (!window.confirm(`确认删除《${book.title}》？这会同时删除 package、音频和相关清单。`)) return
    const operationKey = `${book.id}:delete`
    setBookOperationStatus((current) => ({ ...current, [operationKey]: { state: 'saving', message: '删除中' } }))
    if (isLocalDemoEdit(connectionStatus, adminToken)) {
      removeBookRows(book.id)
      setLoadMessage('已删除书籍')
      setBookOperationStatus((current) => ({ ...current, [operationKey]: { state: 'success', message: '本地已删除' } }))
      return
    }
    try {
      await deleteBook(book.id)
      removeBookRows(book.id)
      setLoadMessage('已删除书籍')
      setBookOperationStatus((current) => ({ ...current, [operationKey]: { state: 'success', message: '已删除书籍' } }))
    } catch (error) {
      setBookOperationStatus((current) => ({
        ...current,
        [operationKey]: { state: 'failed', message: `删除失败：${adminErrorLabel(error)}` },
      }))
    }
  }

  const removeBookRows = (bookId: string) => {
    setBooks((current) => current.filter((book) => book.id !== bookId))
    setPackages((current) => current.filter((item) => item.bookId !== bookId))
    setAudio((current) => current.filter((item) => item.bookId !== bookId))
    setSelectedBookId((current) => (current === bookId ? null : current))
  }

  const saveDevicePatch = async (deviceId: string, patch: Partial<AdminDevice>, operationKey: string) => {
    const previous = devices.find((device) => device.id === deviceId)
    if (!previous) return
    setDeviceOperationStatus((current) => ({ ...current, [operationKey]: { state: 'saving', message: '保存中' } }))
    setDeviceRetryActions((current) => omitKey(current, operationKey))
    setDevices((current) => current.map((device) => (device.id === deviceId ? { ...device, ...patch } : device)))
    if (isLocalDemoEdit(connectionStatus, adminToken)) {
      setDeviceOperationStatus((current) => ({ ...current, [operationKey]: { state: 'success', message: '本地已更新' } }))
      return
    }
    try {
      if (patch.role) await patchDeviceRole(deviceId, patch.role)
      if (patch.note !== undefined) await patchDeviceNote(deviceId, patch.note)
      setDeviceOperationStatus((current) => ({ ...current, [operationKey]: { state: 'success', message: '保存成功' } }))
    } catch {
      setDevices((current) => current.map((device) => (device.id === deviceId ? previous : device)))
      setDeviceOperationStatus((current) => ({ ...current, [operationKey]: { state: 'failed', message: '保存失败，已回滚' } }))
      setDeviceRetryActions((current) => ({
        ...current,
        [operationKey]: { label: patch.note !== undefined ? '重试保存设备备注' : '重试保存设备角色', run: () => void saveDevicePatch(deviceId, patch, operationKey) },
      }))
    }
  }

  const updateDevice = (deviceId: string, patch: Partial<AdminDevice>) => {
    if (patch.role) void saveDevicePatch(deviceId, patch, `${deviceId}:role`)
    if (patch.note !== undefined) void saveDevicePatch(deviceId, { note: patch.note }, `${deviceId}:note`)
  }

  const handleDownloadPackage = async (item: AdminPackage) => {
    setPackageOperationStatus((current) => ({ ...current, [item.id]: { state: 'saving', message: '准备下载' } }))
    try {
      const packageBlob = await downloadPackage(item.bookId)
      savePackageBlob(item, packageBlob)
      setPackageOperationStatus((current) => ({ ...current, [item.id]: { state: 'success', message: '下载已就绪' } }))
    } catch (error) {
      setPackageOperationStatus((current) => ({
        ...current,
        [item.id]: { state: 'failed', message: `下载失败：${adminErrorLabel(error)}` },
      }))
    }
  }

  const handleReimportPackage = async (item: AdminPackage, file: File | null) => {
    if (!file) return
    const operationKey = item.bookId
    setPackageOperationStatus((current) => ({ ...current, [operationKey]: { state: 'saving', message: '重新导入中' } }))
    try {
      const bookPackage = JSON.parse(await readTextFile(file)) as unknown
      await importBookPackage(item.bookId, bookPackage)
      const data = await loadAdminDashboardData()
      applyDashboardData(data)
      setLoadMessage(connectionMessage(data))
      setPackageOperationStatus((current) => ({ ...current, [operationKey]: { state: 'success', message: '重新导入完成' } }))
    } catch (error) {
      setPackageOperationStatus((current) => ({
        ...current,
        [operationKey]: { state: 'failed', message: `重新导入失败：${error instanceof SyntaxError ? 'JSON 无效' : adminErrorLabel(error)}` },
      }))
    }
  }

  const replaceAudioRow = (nextAudio: AdminAudio) => {
    setAudio((current) => current.map((item) => (item.bookId === nextAudio.bookId || item.id === nextAudio.id ? nextAudio : item)))
  }

  const handleRefreshBookAudio = async (item: AdminAudio) => {
    setAudioOperationStatus((current) => ({ ...current, [item.id]: { state: 'saving', message: '刷新中' } }))
    try {
      const nextAudio = await refreshBookAudio(item.bookId)
      if (nextAudio) replaceAudioRow(nextAudio)
      setAudioOperationStatus((current) => ({ ...current, [item.id]: { state: 'success', message: '刷新完成' } }))
    } catch (error) {
      setAudioOperationStatus((current) => ({
        ...current,
        [item.id]: { state: 'failed', message: `刷新失败：${adminErrorLabel(error)}` },
      }))
    }
  }

  const handleDeleteBookAudio = async (item: AdminAudio) => {
    if (!window.confirm(`确认清理《${item.bookTitle}》的音频文件？`)) return
    setAudioOperationStatus((current) => ({ ...current, [item.id]: { state: 'saving', message: '清理中' } }))
    try {
      const nextAudio = await deleteBookAudio(item.bookId)
      if (nextAudio) replaceAudioRow(nextAudio)
      setAudioOperationStatus((current) => ({ ...current, [item.id]: { state: 'success', message: '已清理音频' } }))
    } catch (error) {
      setAudioOperationStatus((current) => ({
        ...current,
        [item.id]: { state: 'failed', message: `清理失败：${adminErrorLabel(error)}` },
      }))
    }
  }

  const openView = (view: ViewKey) => {
    setActiveView(view)
    setSelectedBookId(null)
    setSelectedDeviceId(null)
  }

  const saveAdminToken = (nextToken: string) => {
    const trimmedToken = nextToken.trim()
    setAdminToken(trimmedToken)
    try {
      if (trimmedToken) {
        window.localStorage.setItem(adminTokenStorageKey, trimmedToken)
        setLoadMessage('管理员 Token 已保存，刷新后验证连接')
      } else {
        window.localStorage.removeItem(adminTokenStorageKey)
        setLoadMessage('管理员 Token 已清除，刷新后使用匿名请求')
      }
    } catch {
      setLoadMessage('浏览器本地存储不可用，Token 未保存')
    }
  }

  return (
    <div className="admin-shell">
      <aside className="sidebar" aria-label="管理后台导航">
        <div className="brand">
          <span className="brand-mark">NR</span>
          <span>
            <strong>Gateway</strong>
            <small>Admin Console</small>
          </span>
        </div>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className="nav-button"
              aria-current={activeView === item.key ? 'page' : undefined}
              onClick={() => openView(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div>
            <h1>Novel Reader Gateway</h1>
            <p>内网运维后台 · {loadMessage}</p>
          </div>
          <div className="status-strip" aria-label="顶部状态栏">
            <StatusPill label="环境" value="local" />
            <StatusPill label="状态" value="健康" tone="ok" />
            <StatusPill label="刷新" value="5s" />
            <StatusPill
              label="数据"
              value={isInitialLoading ? '连接中' : dataSource === 'api' ? '实时' : 'Mock'}
              tone={!isInitialLoading && dataSource === 'api' ? 'ok' : undefined}
            />
          </div>
        </header>

        <main className="content">
          {isInitialLoading && activeView !== 'settings' && <LoadingPanel title={navTitle(activeView)} />}
          {!isInitialLoading && activeView === 'overview' && (
            <Overview
              metrics={metrics}
              events={events}
              requestTrend={requestTrend}
              downloadTrend={downloadTrend}
              books={books}
              packages={packages}
              audio={audio}
              devices={devices}
              systemSummary={systemSummary}
              detailLoaded={hasLoadedDetailData}
            />
          )}
          {!isInitialLoading && activeView === 'books' && (
            <BooksPage
              books={books}
              selectedBook={selectedBook}
              onSelect={setSelectedBookId}
              onUpdate={updateBook}
              onDelete={handleDeleteBook}
              operationStatus={selectedBook ? {
                visibility: bookOperationStatus[`${selectedBook.id}:visibility`],
                labels: bookOperationStatus[`${selectedBook.id}:labels`],
                delete: bookOperationStatus[`${selectedBook.id}:delete`],
              } : {}}
              retryActions={selectedBook ? {
                visibility: bookRetryActions[`${selectedBook.id}:visibility`],
                labels: bookRetryActions[`${selectedBook.id}:labels`],
              } : {}}
            />
          )}
          {!isInitialLoading && activeView === 'devices' && (
            <DevicesPage
              devices={devices}
              selectedDevice={selectedDevice}
              onSelect={setSelectedDeviceId}
              onUpdate={updateDevice}
              operationStatus={selectedDevice ? deviceOperationStatus[`${selectedDevice.id}:role`] : undefined}
              noteOperationStatus={selectedDevice ? deviceOperationStatus[`${selectedDevice.id}:note`] : undefined}
              retryAction={selectedDevice ? deviceRetryActions[`${selectedDevice.id}:role`] : undefined}
              noteRetryAction={selectedDevice ? deviceRetryActions[`${selectedDevice.id}:note`] : undefined}
            />
          )}
          {!isInitialLoading && activeView === 'packages' && (
            <PackagesPage
              packages={packages}
              operationStatus={packageOperationStatus}
              onDownload={handleDownloadPackage}
              onReimport={handleReimportPackage}
            />
          )}
          {!isInitialLoading && activeView === 'audio' && (
            <AudioPage
              audio={audio}
              operationStatus={audioOperationStatus}
              onRefresh={handleRefreshBookAudio}
              onDelete={handleDeleteBookAudio}
            />
          )}
          {!isInitialLoading && activeView === 'logs' && <RequestLogsPage requestLogs={requestLogs} />}
          {activeView === 'settings' && (
            <SettingsPage
              key={adminToken}
              adminToken={adminToken}
              dataSource={dataSource}
              connectionStatus={connectionStatus}
              isRefreshing={isRefreshing}
              loadMessage={loadMessage}
              onRefresh={() => void refreshDashboardData()}
              onSaveToken={saveAdminToken}
            />
          )}
        </main>
      </div>
    </div>
  )
}

function readTextFile(file: File) {
  if (typeof file.text === 'function') return file.text()
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')))
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Failed to read file.')))
    reader.readAsText(file)
  })
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone?: 'ok' }) {
  return (
    <span className={`status-pill ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  )
}

function LoadingPanel({ title }: { title: string }) {
  return (
    <section className="panel loading-panel" aria-label={`${title}加载状态`}>
      <h2>{title}</h2>
      <p>正在加载后台数据</p>
    </section>
  )
}

function Overview({
  metrics,
  events,
  requestTrend,
  downloadTrend,
  books,
  packages,
  audio,
  devices,
  systemSummary,
  detailLoaded,
}: {
  metrics: typeof mockOverviewMetrics
  events: typeof mockRecentEvents
  requestTrend: AdminRequestTrendBucket[]
  downloadTrend: AdminDownloadTrendBucket[]
  books: AdminBook[]
  packages: AdminPackage[]
  audio: AdminAudio[]
  devices: AdminDevice[]
  systemSummary: AdminSystemSummary
  detailLoaded: boolean
}) {
  const healthItems = buildContentHealth(books, packages, audio, detailLoaded)
  const deviceText = buildDeviceSummary(devices, detailLoaded)
  return (
    <section className="view-stack" aria-label="总览">
      <div className="metric-grid">
        {metrics.map((metric) => (
          <article className="metric-card" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.note}</small>
          </article>
        ))}
      </div>

      <div className="summary-row">
        <div className="system-summary">
          <strong>运行 / 内存 / 数据目录</strong>
          <span>
            运行 {formatDuration(systemSummary.uptimeSeconds)} · heap {formatBytes(systemSummary.heapUsedBytes)} · RSS {formatBytes(systemSummary.rssBytes)} · 数据目录 {formatBytes(systemSummary.dataDirBytes)}
          </span>
        </div>
        <div className="system-summary">
          <strong>在线设备</strong>
          <span>{deviceText}</span>
        </div>
      </div>

      <div className="chart-grid">
        <RequestTrendPanel buckets={requestTrend} />
        <DownloadTrendPanel buckets={downloadTrend} />
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2>内容健康</h2>
          <span>滚动窗口</span>
        </div>
        <div className="health-grid">
          {healthItems.map((item) => (
            <div key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>最近事件</h2>
          <span>最近 30 分钟</span>
        </div>
        {events.length > 0 ? (
          <ol className="event-list">
            {events.map((event) => (
              <li key={`${event.time}-${event.text}`} className={event.level}>
                <time>{event.time}</time>
                <span>{event.text}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty-state">最近 30 分钟暂无事件</p>
        )}
      </section>
    </section>
  )
}

function RequestTrendPanel({ buckets }: { buckets: AdminRequestTrendBucket[] }) {
  const maxValue = Math.max(1, ...buckets.map((bucket) => Math.max(bucket.requestCount, bucket.errorCount, bucket.p95Ms)))
  const hasData = buckets.some((bucket) => bucket.requestCount > 0 || bucket.errorCount > 0 || bucket.p95Ms > 0)
  return (
    <section className="panel trend-panel">
      <div className="panel-header">
        <h2>请求趋势</h2>
        <span>最近 60 分钟 · 请求 / 错误 / P95</span>
      </div>
      {hasData ? (
        <div className="bars trend-bars" aria-label="最近 60 分钟请求趋势">
          {buckets.map((bucket) => (
            <span
              key={bucket.label}
              className="bar-group"
              title={`${bucket.label} 请求 ${bucket.requestCount} / 错误 ${bucket.errorCount} / P95 ${bucket.p95Ms}ms`}
            >
              <i className="bar request" style={{ height: `${barHeight(bucket.requestCount, maxValue)}%` }} />
              <i className="bar error" style={{ height: `${barHeight(bucket.errorCount, maxValue)}%` }} />
              <i className="bar p95" style={{ height: `${barHeight(bucket.p95Ms, maxValue)}%` }} />
            </span>
          ))}
        </div>
      ) : (
        <p className="empty-trend">最近 60 分钟暂无请求数据</p>
      )}
    </section>
  )
}

function DownloadTrendPanel({ buckets }: { buckets: AdminDownloadTrendBucket[] }) {
  const maxValue = Math.max(1, ...buckets.map((bucket) => Math.max(bucket.packageDownloads, bucket.audioDownloads)))
  const hasData = buckets.some((bucket) => bucket.packageDownloads > 0 || bucket.audioDownloads > 0)
  return (
    <section className="panel trend-panel">
      <div className="panel-header">
        <h2>下载趋势</h2>
        <span>最近 60 分钟 · package / audio</span>
      </div>
      {hasData ? (
        <div className="bars trend-bars" aria-label="最近 60 分钟下载趋势">
          {buckets.map((bucket) => (
            <span
              key={bucket.label}
              className="bar-group"
              title={`${bucket.label} package ${bucket.packageDownloads} / audio ${bucket.audioDownloads}`}
            >
              <i className="bar package" style={{ height: `${barHeight(bucket.packageDownloads, maxValue)}%` }} />
              <i className="bar audio" style={{ height: `${barHeight(bucket.audioDownloads, maxValue)}%` }} />
            </span>
          ))}
        </div>
      ) : (
        <p className="empty-trend">最近 60 分钟暂无下载数据</p>
      )}
    </section>
  )
}

function barHeight(value: number, maxValue: number) {
  if (value <= 0) return 0
  return Math.max(6, Math.round((value / maxValue) * 100))
}

function buildDeviceSummary(devices: AdminDevice[], detailLoaded: boolean) {
  if (!detailLoaded) return '正在加载'
  const trustedCount = devices.filter((device) => device.role === 'trusted').length
  const disabledCount = devices.filter((device) => device.role === 'disabled').length
  return `${devices.length} 台 · 受信 ${trustedCount} 台 · 禁用 ${disabledCount} 台`
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '-'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${Math.floor(seconds)}s`
}

function buildContentHealth(books: AdminBook[], packages: AdminPackage[], audio: AdminAudio[], detailLoaded: boolean) {
  if (!detailLoaded) {
    return [
      { label: '书籍', value: '加载中' },
      { label: '受限', value: '加载中' },
      { label: '隐藏', value: '加载中' },
      { label: '缺音频章节', value: '加载中' },
      { label: '异常数据包', value: '加载中' },
    ]
  }

  const restrictedCount = books.filter((book) => book.visibility !== 'default').length
  const hiddenCount = books.filter((book) => book.visibility === 'hidden').length
  const missingAudioChapters = audio.reduce((sum, item) => sum + Math.max(0, item.chapterCount - item.availableChapters), 0)
  const badPackageCount = packages.filter((item) => item.status !== 'ready').length

  return [
    { label: '书籍', value: `${books.length} 本` },
    { label: '受限', value: `${restrictedCount} 本` },
    { label: '隐藏', value: `${hiddenCount} 本` },
    { label: '缺音频章节', value: `${missingAudioChapters}` },
    { label: '异常数据包', value: `${badPackageCount}` },
  ]
}

function BooksPage({
  books,
  selectedBook,
  onSelect,
  onUpdate,
  onDelete,
  operationStatus,
  retryActions,
}: {
  books: AdminBook[]
  selectedBook: AdminBook | null
  onSelect: (bookId: string) => void
  onUpdate: (bookId: string, patch: Partial<AdminBook>) => void
  onDelete: (book: AdminBook) => void
  operationStatus: Partial<Record<'visibility' | 'labels' | 'delete', OperationStatus>>
  retryActions: Partial<Record<'visibility' | 'labels', RetryAction>>
}) {
  return (
    <section className="split-view">
      <div className="panel table-panel">
        <div className="panel-header">
          <h2>书籍</h2>
          <span>{books.length} 本 · 全量后台视图</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>书名</th>
              <th>作者</th>
              <th>可见范围</th>
              <th>内容标签</th>
              <th>章节数</th>
              <th>数据包更新时间</th>
              <th>覆盖率</th>
              <th>音频覆盖率</th>
              <th>最近下载</th>
            </tr>
          </thead>
          <tbody>
            {books.map((book) => (
              <tr
                key={book.id}
                className={selectedBook?.id === book.id ? 'selected' : undefined}
                onClick={() => onSelect(book.id)}
              >
                <td><strong>{book.title}</strong></td>
                <td>{book.author}</td>
                <td><Badge tone={book.visibility}>{book.visibility}</Badge></td>
                <td><LabelList labels={book.labels} /></td>
                <td>{book.chapterCount}</td>
                <td>{book.packageUpdatedAt}</td>
                <td>
                  <span className="coverage">
                    S {formatCoverage(book.coverage.summary)} · KG {formatCoverage(book.coverage.kg)} · E {formatCoverage(book.coverage.embedding)}
                  </span>
                </td>
                <td>{book.audioCoverage}%</td>
                <td>{book.recentDownloads}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <BookDrawer
        book={selectedBook}
        onUpdate={onUpdate}
        onDelete={onDelete}
        operationStatus={operationStatus}
        retryActions={retryActions}
      />
    </section>
  )
}

function BookDrawer({
  book,
  onUpdate,
  onDelete,
  operationStatus,
  retryActions,
}: {
  book: AdminBook | null
  onUpdate: (bookId: string, patch: Partial<AdminBook>) => void
  onDelete: (book: AdminBook) => void
  operationStatus: Partial<Record<'visibility' | 'labels' | 'delete', OperationStatus>>
  retryActions: Partial<Record<'visibility' | 'labels', RetryAction>>
}) {
  if (!book) {
    return <aside className="drawer empty">选择一本书查看可见范围、标签和数据包状态。</aside>
  }

  const toggleLabel = (label: ContentLabel) => {
    const labels = book.labels.includes(label)
      ? book.labels.filter((current) => current !== label)
      : [...book.labels, label]
    onUpdate(book.id, { labels })
  }

  return (
    <aside className="drawer" aria-label="书籍详情">
      <div className="drawer-header">
        <span>书籍详情</span>
        <h2>{book.title}</h2>
        <p>{book.author} · {book.chapterCount} 章</p>
      </div>

      <label className="field">
        <span>可见范围</span>
        <select
          value={book.visibility}
          onChange={(event) => onUpdate(book.id, { visibility: event.target.value as Visibility })}
          disabled={operationStatus.visibility?.state === 'saving'}
        >
          {visibilityOptions.map((visibility) => (
            <option key={visibility} value={visibility}>{visibility}</option>
          ))}
        </select>
      </label>
      <OperationNote status={operationStatus.visibility} retryAction={retryActions.visibility} />

      <fieldset className="checkbox-group">
        <legend>内容标签</legend>
        {labelOptions.map((label) => (
          <label key={label}>
            <input
              type="checkbox"
              checked={book.labels.includes(label)}
              disabled={operationStatus.labels?.state === 'saving'}
              onChange={() => toggleLabel(label)}
            />
            <span>{labelNames[label]}</span>
          </label>
        ))}
      </fieldset>
      <OperationNote status={operationStatus.labels} retryAction={retryActions.labels} />

      <p className="current-state">
        当前标签：{book.labels.length > 0 ? book.labels.map((label) => labelNames[label]).join('、') : '无'}
      </p>

      <dl className="detail-list">
        <div><dt>Package 校验</dt><dd>{book.packageStatus}</dd></div>
        <div><dt>音频缺失</dt><dd>{book.missingAudioChapters} 章</dd></div>
        <div><dt>最近请求</dt><dd>{book.recentDownloads * 3} 次</dd></div>
      </dl>

      <div className="action-row">
        <button type="button">下载 package</button>
        <button type="button">上传替换</button>
      </div>

      <div className="danger-zone">
        <strong>危险操作</strong>
        <button
          type="button"
          className="danger-button"
          disabled={operationStatus.delete?.state === 'saving'}
          onClick={() => onDelete(book)}
        >
          删除 {book.title}
        </button>
        <OperationNote status={operationStatus.delete} />
      </div>
    </aside>
  )
}

function DevicesPage({
  devices,
  selectedDevice,
  onSelect,
  onUpdate,
  operationStatus,
  noteOperationStatus,
  retryAction,
  noteRetryAction,
}: {
  devices: AdminDevice[]
  selectedDevice: AdminDevice | null
  onSelect: (deviceId: string) => void
  onUpdate: (deviceId: string, patch: Partial<AdminDevice>) => void
  operationStatus?: OperationStatus
  noteOperationStatus?: OperationStatus
  retryAction?: RetryAction
  noteRetryAction?: RetryAction
}) {
  return (
    <section className="split-view">
      <div className="panel table-panel">
        <div className="panel-header">
          <h2>设备</h2>
          <span>按验证码识别待授权设备</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>设备名</th>
              <th>备注</th>
              <th>验证码</th>
              <th>角色</th>
              <th>最近 IP</th>
              <th>最近连接</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr
                key={device.id}
                className={selectedDevice?.id === device.id ? 'selected' : undefined}
                onClick={() => onSelect(device.id)}
              >
                <td><strong>{device.name}</strong></td>
                <td>{device.note ? <span>{device.note}</span> : <span className="muted">无</span>}</td>
                <td><code>{device.pairingCode}</code></td>
                <td><Badge tone={device.role}>{roleNames[device.role]}</Badge></td>
                <td>{device.lastIp}</td>
                <td>{device.lastSeenAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DeviceDrawer
        device={selectedDevice}
        onUpdate={onUpdate}
        operationStatus={operationStatus}
        noteOperationStatus={noteOperationStatus}
        retryAction={retryAction}
        noteRetryAction={noteRetryAction}
      />
    </section>
  )
}

function PackagesPage({
  packages,
  operationStatus,
  onDownload,
  onReimport,
}: {
  packages: AdminPackage[]
  operationStatus: Record<string, OperationStatus>
  onDownload: (item: AdminPackage) => void
  onReimport: (item: AdminPackage, file: File | null) => void
}) {
  const missingSummaries = packages
    .map((item) => packageMissingSummary(item))
    .filter((item) => item.count > 0)
  const totalMissing = missingSummaries.reduce((sum, item) => sum + item.count, 0)
  const missingTooltip = missingSummaries.length > 0
    ? missingSummaries.map((item) => `${item.title}：${item.detail}`).join('\n')
    : '无缺失数据'
  const readyCount = packages.filter((item) => item.status === 'ready').length

  return (
    <section className="view-stack" aria-label="数据包">
      <div className="operation-summary">
        <SummaryTile label="数据包" value={`${packages.length} 个`} note={`${readyCount} 个可发布`} />
        <SummaryTile label="缺失章节" value={`${totalMissing} 章`} note="悬停查看明细" title={missingTooltip} />
        <SummaryTile label="异常状态" value={`${packages.length - readyCount} 个`} note="warning / failed" />
      </div>

      <section className="panel table-panel">
        <div className="panel-header">
          <h2>数据包</h2>
          <span>导入版本、覆盖率和缺失章节</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>书籍</th>
              <th>版本</th>
              <th>状态</th>
              <th>大小</th>
              <th>更新时间</th>
              <th>覆盖率</th>
              <th>缺失章节</th>
              <th>校验</th>
              <th>操作</th>
              <th>操作状态</th>
            </tr>
          </thead>
          <tbody>
            {packages.map((item) => {
              const status = operationStatus[item.id] ?? operationStatus[item.bookId]
              return (
                <tr key={item.id}>
                  <td><strong>{item.bookTitle}</strong></td>
                  <td><code>{item.version}</code></td>
                  <td><Badge>{packageStatusNames[item.status]}</Badge></td>
                  <td>{formatSizeMb(item.sizeMb)}</td>
                  <td>{item.updatedAt}</td>
                  <td>
                    <span className="coverage">
                      S {formatCoverage(item.summaryCoverage)} · KG {formatCoverage(item.kgCoverage)} · E报告 {formatCoverage(item.embeddingCoverage)} · 向量 {formatEmbeddingVectors(item)}
                    </span>
                  </td>
                  <td><PackageMissingCell item={item} /></td>
                  <td><code>{item.checksum}</code></td>
                  <td>
                    <button
                      type="button"
                      className="table-action"
                      disabled={status?.state === 'saving'}
                      onClick={() => onDownload(item)}
                    >
                      下载 {item.bookTitle} package
                    </button>
                    <input
                      type="file"
                      className="table-file-input"
                      accept="application/json,.json"
                      aria-label={`重新导入 ${item.bookTitle} package`}
                      disabled={status?.state === 'saving'}
                      onChange={(event) => {
                        onReimport(item, event.target.files?.[0] ?? null)
                        event.currentTarget.value = ''
                      }}
                    />
                  </td>
                  <td><OperationInline status={status} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </section>
  )
}

function AudioPage({
  audio,
  operationStatus,
  onRefresh,
  onDelete,
}: {
  audio: AdminAudio[]
  operationStatus: Record<string, OperationStatus>
  onRefresh: (item: AdminAudio) => void
  onDelete: (item: AdminAudio) => void
}) {
  const missingTotal = audio.reduce((sum, item) => sum + Math.max(0, item.chapterCount - item.availableChapters), 0)
  const downloads = audio.reduce((sum, item) => sum + item.downloads24h, 0)
  const averageCoverage = audio.length > 0
    ? Math.round(audio.reduce((sum, item) => sum + item.coverage, 0) / audio.length)
    : 0

  return (
    <section className="view-stack" aria-label="音频">
      <div className="operation-summary">
        <SummaryTile label="平均覆盖率" value={`${averageCoverage}%`} note="按书籍平均" />
        <SummaryTile label="缺音频章节" value={`${missingTotal} 章`} note="章节数 - 已生成" />
        <SummaryTile label="24h 下载" value={formatCount(downloads)} note="音频文件请求" />
      </div>

      <section className="panel table-panel">
        <div className="panel-header">
          <h2>音频</h2>
          <span>覆盖率、缺失章节和生成信息</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>书籍</th>
              <th>状态</th>
              <th>覆盖率</th>
              <th>章节</th>
              <th>缺失章节</th>
              <th>总时长</th>
              <th>大小</th>
              <th>声音</th>
              <th>最近生成</th>
              <th>24h 下载</th>
              <th>操作</th>
              <th>操作状态</th>
            </tr>
          </thead>
          <tbody>
            {audio.map((item) => {
              const status = operationStatus[item.id]
              return (
                <tr key={item.id}>
                  <td><strong>{item.bookTitle}</strong></td>
                  <td><Badge>{audioStatusNames[item.status]}</Badge></td>
                  <td>{item.coverage}%</td>
                  <td>{item.availableChapters}/{item.chapterCount}</td>
                  <td><ChapterList chapters={item.missingChapters} /></td>
                  <td>{item.totalDuration}</td>
                  <td>{formatSizeMb(item.sizeMb)}</td>
                  <td>{item.voice}</td>
                  <td>{item.lastGeneratedAt}</td>
                  <td>{formatCount(item.downloads24h)}</td>
                  <td>
                    <div className="table-action-group">
                      <button
                        type="button"
                        className="table-action"
                        disabled={status?.state === 'saving'}
                        onClick={() => onRefresh(item)}
                      >
                        刷新 {item.bookTitle} 音频状态
                      </button>
                      <button
                        type="button"
                        className="table-action danger"
                        disabled={status?.state === 'saving'}
                        onClick={() => onDelete(item)}
                      >
                        清理 {item.bookTitle} 音频
                      </button>
                    </div>
                  </td>
                  <td><OperationInline status={status} /></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </section>
  )
}

function RequestLogsPage({ requestLogs }: { requestLogs: AdminRequestLog[] }) {
  const errors = requestLogs.filter((log) => log.statusCode >= 400).length
  const slowRequests = requestLogs.filter((log) => log.durationMs >= 500).length
  const p95 = requestLogs.length > 0
    ? [...requestLogs].sort((a, b) => a.durationMs - b.durationMs)[Math.max(0, Math.ceil(requestLogs.length * 0.95) - 1)].durationMs
    : 0

  return (
    <section className="view-stack" aria-label="请求日志">
      <div className="operation-summary">
        <SummaryTile label="请求数" value={`${requestLogs.length} 条`} note="最近窗口" />
        <SummaryTile label="错误请求" value={`${errors} 条`} note="HTTP 4xx / 5xx" />
        <SummaryTile label="慢请求" value={`${slowRequests} 条`} note={`P95 ${p95}ms`} />
      </div>

      <section className="panel table-panel">
        <div className="panel-header">
          <h2>请求日志</h2>
          <span>方法、路径、状态码、耗时、设备和源 IP</span>
        </div>
        <table className="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>方法</th>
              <th>路径</th>
              <th>状态码</th>
              <th>耗时</th>
              <th>设备</th>
              <th>设备 ID</th>
              <th>源 IP</th>
            </tr>
          </thead>
          <tbody>
            {requestLogs.map((log) => (
              <tr key={log.id}>
                <td>{log.time}</td>
                <td><Badge>{log.method}</Badge></td>
                <td><code>{log.path}</code></td>
                <td><StatusCode code={log.statusCode} /></td>
                <td>{log.durationMs}ms</td>
                <td>{log.deviceName}</td>
                <td><code>{log.deviceId}</code></td>
                <td>{log.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  )
}

function DeviceDrawer({
  device,
  onUpdate,
  operationStatus,
  noteOperationStatus,
  retryAction,
  noteRetryAction,
}: {
  device: AdminDevice | null
  onUpdate: (deviceId: string, patch: Partial<AdminDevice>) => void
  operationStatus?: OperationStatus
  noteOperationStatus?: OperationStatus
  retryAction?: RetryAction
  noteRetryAction?: RetryAction
}) {
  const [noteDraft, setNoteDraft] = useState('')

  useEffect(() => {
    setNoteDraft(device?.note ?? '')
  }, [device?.id, device?.note])

  if (!device) {
    return <aside className="drawer empty">选择一台设备查看验证码、连接信息和授权角色。</aside>
  }

  const normalizedNote = noteDraft.trim().slice(0, 80)
  const noteChanged = normalizedNote !== device.note

  return (
    <aside className="drawer" aria-label="设备详情">
      <div className="drawer-header">
        <span>设备详情</span>
        <h2>{device.name}</h2>
        <p>{device.model} · {device.platform} · App {device.appVersion}</p>
      </div>

      <label className="field">
        <span>设备角色</span>
        <select
          value={device.role}
          onChange={(event) => onUpdate(device.id, { role: event.target.value as DeviceRole })}
          disabled={operationStatus?.state === 'saving'}
        >
          <option value="default">普通</option>
          <option value="trusted">受信</option>
          <option value="disabled">禁用</option>
        </select>
      </label>
      <OperationNote status={operationStatus} retryAction={retryAction} />

      <p className="current-state">当前角色：{roleNames[device.role]}</p>

      <label className="field">
        <span>备注</span>
        <input
          value={noteDraft}
          maxLength={80}
          onChange={(event) => setNoteDraft(event.target.value)}
          disabled={noteOperationStatus?.state === 'saving'}
          placeholder="位置、用途或负责人"
        />
      </label>
      <div className="drawer-actions">
        <small>{noteDraft.length}/80</small>
        <button
          type="button"
          className={`table-action note-save-button ${noteOperationStatus?.state === 'saving' ? 'saving' : ''}`}
          disabled={!noteChanged || noteOperationStatus?.state === 'saving'}
          onClick={() => onUpdate(device.id, { note: normalizedNote })}
        >
          保存备注
        </button>
      </div>
      <OperationNote status={noteOperationStatus} retryAction={noteRetryAction} />

      <dl className="detail-list">
        <div><dt>设备 ID</dt><dd>{device.id}</dd></div>
        <div><dt>验证码</dt><dd>{device.pairingCode}</dd></div>
        <div><dt>首次连接</dt><dd>{device.firstSeenAt}</dd></div>
        <div><dt>最近 IP</dt><dd>{device.lastIp}</dd></div>
        <div><dt>最近请求</dt><dd>{device.recentRequests} 次</dd></div>
        <div><dt>下载次数</dt><dd>{device.recentDownloads} 次</dd></div>
      </dl>
    </aside>
  )
}

function LabelList({ labels }: { labels: ContentLabel[] }) {
  if (labels.length === 0) {
    return <span className="muted">无</span>
  }

  return (
    <span className="label-list">
      {labels.map((label) => (
        <Badge key={label}>{labelNames[label]}</Badge>
      ))}
    </span>
  )
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: Visibility | DeviceRole }) {
  return <span className={`badge ${tone ? `badge-${tone}` : ''}`}>{children}</span>
}

function SummaryTile({ label, value, note, title }: { label: string; value: string; note: string; title?: string }) {
  return (
    <div className="system-summary" title={title}>
      <strong>{label}</strong>
      <span>{value} · {note}</span>
    </div>
  )
}

function PackageMissingCell({ item }: { item: AdminPackage }) {
  const summary = packageMissingSummary(item)
  if (summary.count === 0) return <span className="muted">无</span>
  return (
    <span className="missing-cell" title={summary.detail}>
      {summary.count} 章
    </span>
  )
}

function packageMissingSummary(item: AdminPackage) {
  const coverageMissingCounts = [
    missingCountFromCoverage(item.chapterCount, item.summaryCoverage),
    missingCountFromCoverage(item.chapterCount, item.kgCoverage),
    missingCountFromCoverage(item.chapterCount, item.embeddingCoverage),
  ]
  const count = Math.max(item.missingChapters.length, ...coverageMissingCounts)
  const details = item.validationIssues.length > 0
    ? item.validationIssues
    : item.missingChapters.map((chapter) => typeof chapter === 'number' ? `第 ${chapter} 章` : String(chapter))
  return {
    title: item.bookTitle,
    count,
    detail: details.length > 0 ? details.join('；') : '无缺失数据',
  }
}

function missingCountFromCoverage(chapterCount: number, coverage: number | null) {
  if (chapterCount <= 0 || coverage === null || coverage >= 100) return 0
  const ratio = Math.max(0, Math.min(100, coverage)) / 100
  return Math.max(0, Math.round(chapterCount * (1 - ratio)))
}

function ChapterList({ chapters }: { chapters: Array<number | string> }) {
  if (chapters.length === 0) return <span className="muted">无</span>
  const visible = chapters.slice(0, 5).map((chapter) => (
    typeof chapter === 'number' ? `第 ${chapter} 章` : chapter
  )).join('、')
  const suffix = chapters.length > 5 ? ` 等 ${chapters.length} 章` : ''
  return <span>{visible}{suffix}</span>
}

function StatusCode({ code }: { code: number }) {
  const tone = code >= 500 ? 'error' : code >= 400 ? 'warn' : 'ok'
  return <span className={`status-code ${tone}`}>{code}</span>
}

function OperationInline({ status }: { status?: OperationStatus }) {
  if (!status) return <span className="muted">待操作</span>
  return <span className={`operation-status ${status.state}`}>{status.message}</span>
}

function OperationNote({ status, retryAction }: { status?: OperationStatus; retryAction?: RetryAction }) {
  if (!status) return null
  return (
    <div className={`operation-note ${status.state}`}>
      <span>{status.message}</span>
      {retryAction && (
        <button type="button" onClick={retryAction.run}>
          {retryAction.label}
        </button>
      )}
    </div>
  )
}

function formatSizeMb(sizeMb: number) {
  return sizeMb >= 1024 ? `${(sizeMb / 1024).toFixed(1)} GB` : `${sizeMb.toFixed(1)} MB`
}

function formatCount(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

const packageStatusNames: Record<AdminPackage['status'], string> = {
  ready: '可发布',
  warning: '需复查',
  failed: '失败',
}

const audioStatusNames: Record<AdminAudio['status'], string> = {
  ready: '完整',
  partial: '部分缺失',
  missing: '缺失',
}

function SettingsPage({
  adminToken,
  dataSource,
  connectionStatus,
  isRefreshing,
  loadMessage,
  onRefresh,
  onSaveToken,
}: {
  adminToken: string
  dataSource: AdminDashboardData['source']
  connectionStatus: ConnectionStatus
  isRefreshing: boolean
  loadMessage: string
  onRefresh: () => void
  onSaveToken: (token: string) => void
}) {
  const [draftToken, setDraftToken] = useState(adminToken)

  return (
    <section className="settings-grid" aria-label="设置">
      <form
        className="panel settings-panel"
        onSubmit={(event) => {
          event.preventDefault()
          onSaveToken(draftToken)
        }}
      >
        <div className="panel-header">
          <h2>后台访问</h2>
          <span>{connectionTitle(connectionStatus, dataSource)}</span>
        </div>

        <label className="field">
          <span>管理员 Token</span>
          <input
            aria-label="管理员 Token"
            autoComplete="off"
            placeholder="粘贴内网后台 Token"
            type="password"
            value={draftToken}
            onChange={(event) => setDraftToken(event.target.value)}
          />
        </label>

        <p className="setting-note">Token 仅保存在本机浏览器，后续请求会自动携带 Authorization Bearer。</p>

        <div className="action-row">
          <button type="submit">保存 Token</button>
          <button type="button" onClick={() => onSaveToken('')}>清除 Token</button>
        </div>
      </form>

      <section className="panel settings-panel">
        <div className="panel-header">
          <h2>数据连接</h2>
          <span>{loadMessage}</span>
        </div>

        <dl className="detail-list">
          <div><dt>连接状态</dt><dd>{connectionTitle(connectionStatus, dataSource)}</dd></div>
          <div><dt>数据来源</dt><dd>{dataSource === 'api' ? 'Gateway 管理 API' : '本地 mock 数据'}</dd></div>
          <div><dt>Token 状态</dt><dd>{adminToken ? '已保存' : '未设置'}</dd></div>
          <div><dt>处理建议</dt><dd>{connectionStatus === 'unauthorized' ? '需要有效管理员 Token' : '可刷新验证最新状态'}</dd></div>
          <div><dt>存储键</dt><dd><code>{adminTokenStorageKey}</code></dd></div>
        </dl>

        <div className="action-row">
          <button type="button" disabled={isRefreshing} onClick={onRefresh}>
            {isRefreshing ? '刷新中' : '刷新后台数据'}
          </button>
        </div>
      </section>
    </section>
  )
}

function readStoredAdminToken() {
  try {
    return window.localStorage.getItem(adminTokenStorageKey)?.trim() || ''
  } catch {
    return ''
  }
}

function connectionMessage(data: AdminDashboardData) {
  if (data.status === 'unauthorized') return '未授权：管理员 Token 无效或缺失'
  if (data.status === 'unavailable') return 'API 不可用，正在显示 mock 数据'
  if (data.status === 'partial') return `部分后台接口失败：${data.failedSections.join('、')} 已回退到可用数据`
  if (data.status === 'mock') return 'API 不可用，正在显示 mock 数据'
  return '已连接 Gateway 管理 API'
}

function connectionTitle(status: ConnectionStatus, source: AdminDashboardData['source']) {
  if (status === 'loading') return '连接中'
  if (status === 'unauthorized') return '未授权'
  if (status === 'partial') return '部分可用'
  if (status === 'unavailable' || status === 'mock') return 'Mock 数据'
  return source === 'api' ? '实时数据' : 'Mock 数据'
}

function navTitle(view: ViewKey) {
  return navItems.find((item) => item.key === view)?.label ?? '后台数据'
}

function omitKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record }
  delete next[key]
  return next
}

function isLocalDemoEdit(status: ConnectionStatus, token: string) {
  return !token && (status === 'mock' || status === 'unavailable')
}

function emptySystemSummary(): AdminSystemSummary {
  return {
    uptimeSeconds: 0,
    rssBytes: 0,
    heapUsedBytes: 0,
    dataDirBytes: 0,
  }
}

function formatCoverage(value: number | null) {
  return value === null ? '-' : `${value}%`
}

function formatEmbeddingVectors(item: AdminPackage) {
  const total = item.embeddingChunkVectorCount + item.embeddingSummaryVectorCount
  return `${total} (${formatCoverage(item.embeddingVectorCoverage)})`
}

function savePackageBlob(item: AdminPackage, packageBlob: Blob) {
  if (navigator.userAgent.toLowerCase().includes('jsdom')) return
  if (typeof URL.createObjectURL !== 'function') return
  const objectUrl = URL.createObjectURL(packageBlob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = `${item.bookId}-${item.version}.zip`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(objectUrl)
}

export default App
