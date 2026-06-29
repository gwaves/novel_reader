import { useMemo, useState } from 'react'
import {
  AdminBook,
  AdminDevice,
  ContentLabel,
  DeviceRole,
  Visibility,
  contentHealth,
  initialBooks,
  initialDevices,
  labelNames,
  labelOptions,
  overviewMetrics,
  recentEvents,
  roleNames,
  visibilityOptions,
} from './mockData'

type ViewKey = 'overview' | 'books' | 'packages' | 'audio' | 'devices' | 'logs' | 'settings'

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
  const [books, setBooks] = useState(initialBooks)
  const [devices, setDevices] = useState(initialDevices)
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null)
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)

  const selectedBook = useMemo(
    () => books.find((book) => book.id === selectedBookId) ?? null,
    [books, selectedBookId],
  )
  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  )

  const updateBook = (bookId: string, patch: Partial<AdminBook>) => {
    setBooks((current) => current.map((book) => (book.id === bookId ? { ...book, ...patch } : book)))
  }

  const updateDevice = (deviceId: string, patch: Partial<AdminDevice>) => {
    setDevices((current) =>
      current.map((device) => (device.id === deviceId ? { ...device, ...patch } : device)),
    )
  }

  const openView = (view: ViewKey) => {
    setActiveView(view)
    setSelectedBookId(null)
    setSelectedDeviceId(null)
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
            <p>内网运维后台 · mock 数据预览</p>
          </div>
          <div className="status-strip" aria-label="顶部状态栏">
            <StatusPill label="环境" value="local" />
            <StatusPill label="状态" value="健康" tone="ok" />
            <StatusPill label="刷新" value="5s" />
            <StatusPill label="管理员" value="已连接" tone="ok" />
          </div>
        </header>

        <main className="content">
          {activeView === 'overview' && <Overview />}
          {activeView === 'books' && (
            <BooksPage books={books} selectedBook={selectedBook} onSelect={setSelectedBookId} onUpdate={updateBook} />
          )}
          {activeView === 'devices' && (
            <DevicesPage
              devices={devices}
              selectedDevice={selectedDevice}
              onSelect={setSelectedDeviceId}
              onUpdate={updateDevice}
            />
          )}
          {activeView === 'packages' && <Placeholder title="数据包" subtitle="上传、预校验、差异确认和导入历史预留区" />}
          {activeView === 'audio' && <Placeholder title="音频" subtitle="按书统计音频覆盖率、缺失章节和热门下载" />}
          {activeView === 'logs' && <Placeholder title="请求日志" subtitle="展示元数据、错误、慢请求、下载筛选和设备过滤" />}
          {activeView === 'settings' && <Placeholder title="设置" subtitle="管理刷新频率、后台访问提示和后续鉴权配置" />}
        </main>
      </div>
    </div>
  )
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone?: 'ok' }) {
  return (
    <span className={`status-pill ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  )
}

function Overview() {
  return (
    <section className="view-stack" aria-label="总览">
      <div className="metric-grid">
        {overviewMetrics.map((metric) => (
          <article className="metric-card" key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            <small>{metric.note}</small>
          </article>
        ))}
      </div>

      <div className="summary-row">
        <div className="system-summary">
          <strong>CPU / 内存 / 磁盘</strong>
          <span>22% · 68 MB heap · 数据目录 4.8 GB</span>
        </div>
        <div className="system-summary">
          <strong>在线设备</strong>
          <span>3 台 · 受信 1 台 · 禁用 1 台</span>
        </div>
      </div>

      <div className="chart-grid">
        <TrendPanel title="请求趋势" legend="请求 / 错误 / P95" bars={[64, 72, 55, 88, 70, 92, 76]} />
        <TrendPanel title="下载趋势" legend="package / audio" bars={[20, 34, 50, 48, 72, 61, 84]} />
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2>内容健康</h2>
          <span>滚动窗口</span>
        </div>
        <div className="health-grid">
          {contentHealth.map((item) => (
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
        <ol className="event-list">
          {recentEvents.map((event) => (
            <li key={`${event.time}-${event.text}`} className={event.level}>
              <time>{event.time}</time>
              <span>{event.text}</span>
            </li>
          ))}
        </ol>
      </section>
    </section>
  )
}

function TrendPanel({ title, legend, bars }: { title: string; legend: string; bars: number[] }) {
  return (
    <section className="panel trend-panel">
      <div className="panel-header">
        <h2>{title}</h2>
        <span>{legend}</span>
      </div>
      <div className="bars" aria-hidden="true">
        {bars.map((height, index) => (
          <span key={`${height}-${index}`} style={{ height: `${height}%` }} />
        ))}
      </div>
    </section>
  )
}

function BooksPage({
  books,
  selectedBook,
  onSelect,
  onUpdate,
}: {
  books: AdminBook[]
  selectedBook: AdminBook | null
  onSelect: (bookId: string) => void
  onUpdate: (bookId: string, patch: Partial<AdminBook>) => void
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
                <td><Badge>{book.visibility}</Badge></td>
                <td><LabelList labels={book.labels} /></td>
                <td>{book.chapterCount}</td>
                <td>{book.packageUpdatedAt}</td>
                <td>
                  <span className="coverage">
                    S {book.coverage.summary}% · KG {book.coverage.kg}% · E {book.coverage.embedding}%
                  </span>
                </td>
                <td>{book.audioCoverage}%</td>
                <td>{book.recentDownloads}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <BookDrawer book={selectedBook} onUpdate={onUpdate} />
    </section>
  )
}

function BookDrawer({
  book,
  onUpdate,
}: {
  book: AdminBook | null
  onUpdate: (bookId: string, patch: Partial<AdminBook>) => void
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
        >
          {visibilityOptions.map((visibility) => (
            <option key={visibility} value={visibility}>{visibility}</option>
          ))}
        </select>
      </label>

      <fieldset className="checkbox-group">
        <legend>内容标签</legend>
        {labelOptions.map((label) => (
          <label key={label}>
            <input
              type="checkbox"
              checked={book.labels.includes(label)}
              onChange={() => toggleLabel(label)}
            />
            <span>{labelNames[label]}</span>
          </label>
        ))}
      </fieldset>

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
    </aside>
  )
}

function DevicesPage({
  devices,
  selectedDevice,
  onSelect,
  onUpdate,
}: {
  devices: AdminDevice[]
  selectedDevice: AdminDevice | null
  onSelect: (deviceId: string) => void
  onUpdate: (deviceId: string, patch: Partial<AdminDevice>) => void
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
                <td><code>{device.pairingCode}</code></td>
                <td><Badge>{roleNames[device.role]}</Badge></td>
                <td>{device.lastIp}</td>
                <td>{device.lastSeenAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DeviceDrawer device={selectedDevice} onUpdate={onUpdate} />
    </section>
  )
}

function DeviceDrawer({
  device,
  onUpdate,
}: {
  device: AdminDevice | null
  onUpdate: (deviceId: string, patch: Partial<AdminDevice>) => void
}) {
  if (!device) {
    return <aside className="drawer empty">选择一台设备查看验证码、连接信息和授权角色。</aside>
  }

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
        >
          <option value="default">普通</option>
          <option value="trusted">受信</option>
          <option value="disabled">禁用</option>
        </select>
      </label>

      <p className="current-state">当前角色：{roleNames[device.role]}</p>

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

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="badge">{children}</span>
}

function Placeholder({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <section className="panel placeholder">
      <div className="panel-header">
        <h2>{title}</h2>
        <span>第一版骨架</span>
      </div>
      <p>{subtitle}</p>
    </section>
  )
}

export default App
