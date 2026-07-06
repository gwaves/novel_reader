/* eslint-disable react-refresh/only-export-components */
import { type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Capacitor, CapacitorHttp, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import {
  buildGatewayHeaders,
  createGatewayError,
  deviceRoleDescription,
  deviceRoleLabel,
  errorMessage,
  getDeviceMetadata,
  GatewayError,
  isDeviceAccessBlockedError,
  isDeviceDisabledError,
  loadGatewaySettings,
  normalizeGatewaySession,
  type GatewaySession,
  type GatewaySettings,
} from './deviceIdentity'
import {
  blockedGatewaySyncMessage,
  bookCachedAudioCount,
  cloudActionBlockedReason,
  gatewaySyncBlockedReason,
  libraryVisibilityNotice,
  localCacheReadableWhenDisabled,
  mergeLocalBooksWithCloudMetadata,
  roleChangeNotice,
  syncStatusLabel,
  type BookSummary,
  type GatewayLibrarySyncState,
} from './libraryState'
import { createSpeechChapter, type SpeechSegment } from './speechSegments'
import { NovelReaderTts, type TtsVoice } from './ttsPlugin'
import { buildInfo } from './generated/buildInfo'

type BookPackage = {
  schemaVersion: 1
  book: BookSummary
  chapters?: Chapter[]
  summaries?: unknown
  knowledgeGraph?: unknown
  embeddings?: unknown
}

type Chapter = {
  id: string
  title: string
  content?: string
  text?: string
  index?: number
  chapterIndex?: number
}

type SummaryKeyPointSource = {
  index: number
  text: string
  startOffset: number
  endOffset: number
  quote?: string
  confidence?: number
  locator?: string
}

type SummaryKeyPointItem = {
  text: string
  source?: SummaryKeyPointSource
}

type SourceRange = {
  startOffset: number
  endOffset: number
}

type SourceParagraph = SourceRange & {
  text: string
  key: string
}

export type AudioChapter = {
  chapterId: string
  title?: string
  fileName: string
  manifestFileName?: string
  timelineVersion?: number
  durationMs?: number
  sizeBytes?: number
  updatedAt?: string
}

type AudioManifest = {
  version?: number
  timelineVersion?: number
  duration?: number
  timeline?: AudioTimelineEntry[]
}

type CachedAudio = {
  blob?: Blob
  filePath?: string
  manifestFilePath?: string
  manifest: AudioManifest | null
  sizeBytes?: number
}

type AudioStreamRetryState = {
  bookId: string
  currentChapterId: string
  audioChapterId: string
  attempted: boolean
}

type AppLogLevel = 'info' | 'warn' | 'error'

type AppLogEntry = {
  id: string
  timestamp: string
  level: AppLogLevel
  message: string
  source?: string
  context?: unknown
}

type LogSubmitState =
  | { status: 'idle'; message?: string }
  | { status: 'submitting'; message?: string }
  | { status: 'submitted'; message: string; receiptId?: string }
  | { status: 'error'; message: string }

type CachedAudioRecord = {
  bookId: string
  chapterId: string
  audioChapter: AudioChapter
  filePath: string
  manifest?: AudioManifest | null
  manifestFilePath?: string
  sizeBytes?: number
  cachedAt: string
  updatedAt?: string
}

type AudioCachePayload =
  | {
      kind: 'blob'
      blob: Blob
      manifest?: AudioManifest | null
    }
  | {
      kind: 'file'
      filePath: string
      manifest?: AudioManifest | null
      manifestFilePath?: string
      sizeBytes?: number
    }

type NativeAudioPlugin = {
  downloadAudio(options: {
    url: string
    token: string
    deviceId: string
    deviceName: string
    deviceModel: string
    devicePlatform: string
    appVersion: string
    bookId: string
    chapterId: string
  }): Promise<{ filePath: string; sizeBytes: number }>
  downloadAudioManifest(options: {
    url: string
    token: string
    deviceId: string
    deviceName: string
    deviceModel: string
    devicePlatform: string
    appVersion: string
    bookId: string
    chapterId: string
  }): Promise<{ filePath: string; sizeBytes: number; cached?: boolean }>
  downloadPackage(options: {
    url: string
    token: string
    deviceId: string
    deviceName: string
    deviceModel: string
    devicePlatform: string
    appVersion: string
    bookId: string
  }): Promise<{ filePath: string; sizeBytes: number }>
  importPackage(options: {
    bookId: string
    filePath: string
    expectedChapterCount?: number
  }): Promise<FullPackageImportStats & { metadataPath?: string }>
  clearAudioCache(options: { bookId: string }): Promise<{ deletedBytes?: number }>
  clearPackageCache(options: { bookId: string }): Promise<{ deletedBytes?: number }>
  downloadAndInstallApk(options: { url: string; fileName?: string }): Promise<{ filePath: string; sizeBytes: number }>
  addListener(eventName: 'packageSyncProgress', listenerFunc: (event: PackageSyncProgress) => void): Promise<PluginListenerHandle>
}

type AppUpdateManifest = {
  versionName: string
  versionCode: number
  buildNumber?: number
  gitCommit?: string
  latestUrl: string
  latestFileName?: string
  publishedAt?: string
}

type AppUpdateState =
  | { status: 'idle'; manifest?: AppUpdateManifest; message?: string }
  | { status: 'checking'; manifest?: AppUpdateManifest; message?: string }
  | { status: 'available'; manifest: AppUpdateManifest; message: string }
  | { status: 'current'; manifest?: AppUpdateManifest; message: string }
  | { status: 'downloading'; manifest: AppUpdateManifest; message: string }
  | { status: 'error'; manifest?: AppUpdateManifest; message: string }

export type AppUpdateResolution =
  | { status: 'available'; manifest: AppUpdateManifest; message: string }
  | { status: 'current'; manifest: AppUpdateManifest; message: string }

type AudioTimelineEntry = {
  id?: string
  text?: string
  sourceStart?: number
  sourceEnd?: number
  startTime?: number
  endTime?: number
  nextStartTime?: number
}

type ChapterAudioTimelineItem = {
  index: number
  startTime: number
  endTime: number
  nextStartTime: number
}

type ConnectionState = 'idle' | 'checking' | 'connected' | 'error'
type GatewayTab = 'library' | 'reader' | 'search' | 'settings'
type SettingsTab = 'reading' | 'audio' | 'sync' | 'diagnostics'

const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
  { id: 'reading', label: '阅读' },
  { id: 'audio', label: '音频' },
  { id: 'sync', label: '同步' },
  { id: 'diagnostics', label: '诊断' },
]
type SearchMode = 'rag' | 'graph'
type ReaderBackground = 'paper' | 'warm' | 'green' | 'dark'

type ReaderSettings = {
  fontSize: number
  background: ReaderBackground
}

type TtsSettings = {
  engine: 'local-tts' | 'cloud-mp3'
  locale: string
  voiceId: string
  rate: number
  pitch: number
  autoFollow: boolean
}

type SpeechPlaybackState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'playing'; segmentIndex: number; segmentId: string }
  | { status: 'paused'; segmentIndex: number; segmentId: string }
  | { status: 'error'; message: string }

export type ReadingProgress = {
  bookId: string
  chapterId: string
  scrollY: number
  updatedAt: string
}

export type ReadingProgressStore = {
  schemaVersion: 2
  books: Record<string, ReadingProgress>
}

type ReadingProgressStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
type AudioCacheStorage = Pick<Storage, 'getItem' | 'setItem'>

type FullPackageCache = {
  bookId: string
  title?: string
  author?: string
  chapterCount?: number
  wordCount?: number
  updatedAt?: string
  filePath: string
  sizeBytes: number
  cachedAt: string
  importedAt?: string
  importStats?: FullPackageImportStats
  metadataPath?: string
}

type FullPackageImportStats = {
  chapterCount?: number
  summaryCount?: number
  knowledgeGraph?: {
    entityCount?: number
    entityMentionCount?: number
    relationCount?: number
    relationMentionCount?: number
  }
  embeddings?: {
    summaryCount?: number
    chunkCount?: number
  }
}

type PackageSyncProgress = {
  bookId?: string
  phase?: 'download' | 'import'
  status?: string
  done?: number
  total?: number
}

type FullPackageStatus = 'idle' | 'downloading' | 'downloaded' | 'importing' | 'imported' | 'error'

type BookCacheSummary = {
  bookId: string
  title: string
  packageCache: FullPackageCache | null
  audioCount: number
  audioSizeBytes: number
  totalSizeBytes: number
}

type AudioDownloadQueueItem = {
  key: string
  bookId: string
  audioChapter: AudioChapter
}

type SearchResult = {
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  snippet: string
}

type RagResult = SearchResult & {
  source: 'chunk' | 'summary' | 'chapter'
  score: number
}

type GraphResult = {
  kind: 'entity' | 'relation' | 'evidence'
  id: string
  title: string
  subtitle: string
  snippet: string
  details?: string[]
  chapterId?: string
  chapterIndex?: number
}

const settingsKey = 'novel-reader-gateway-settings'
const readerSettingsKey = 'novel-reader-gateway-reader-settings'
const ttsSettingsKey = 'novel-reader-gateway-tts-settings'
const appLogKey = 'novel-reader-gateway-app-logs'
const readingProgressKey = 'novel-reader-gateway-reading-progress'
const fullPackageCacheKey = 'novel-reader-gateway-full-package-cache'
const fullPackageCacheIndexKey = 'novel-reader-gateway-full-package-cache-index'
const audioCacheIndexKey = 'novel-reader-gateway-audio-cache-index'
const packageCachePrefix = 'novel-reader-gateway-package:'
const packageCacheDbName = 'novel-reader-gateway'
const packageCacheStoreName = 'book-packages'
const legacyAudioCacheStoreName = 'chapter-audio'
const defaultGatewayBaseUrl = import.meta.env.VITE_GATEWAY_DEFAULT_BASE_URL ?? 'https://novel.gwaves.net:8888'
const maxAppLogEntries = 200
const maxSubmittedLogEntries = 200
const maxLogMessageLength = 800
const defaultGatewayToken = import.meta.env.VITE_GATEWAY_DEFAULT_TOKEN ?? '123456'
const appVersion = buildInfo.versionName
const NativeAudio = registerPlugin<NativeAudioPlugin>('GatewayAudio')
const TTS_RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2, 3] as const
const MIN_TTS_RATE = 0.5
const MAX_TTS_RATE = 3
const MIN_TTS_PITCH = 0.5
const MAX_TTS_PITCH = 2
const TTS_PREFETCH_WINDOW = 8

const defaultSettings: GatewaySettings = {
  baseUrl: defaultGatewayBaseUrl,
  token: defaultGatewayToken,
  deviceId: '',
  deviceName: 'Android Phone',
}

const defaultReaderSettings: ReaderSettings = {
  fontSize: 18,
  background: 'paper',
}

const defaultTtsSettings: TtsSettings = {
  engine: 'cloud-mp3',
  locale: 'zh-CN',
  voiceId: '',
  rate: 1,
  pitch: 1,
  autoFollow: true,
}

function App() {
  const [tab, setTab] = useState<GatewayTab>('library')
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('sync')
  const [settings, setSettings] = useState<GatewaySettings>(() => loadSettings())
  const [readerSettings, setReaderSettings] = useState<ReaderSettings>(() => loadReaderSettings())
  const [ttsSettings, setTtsSettings] = useState<TtsSettings>(() => loadTtsSettings())
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle')
  const [message, setMessage] = useState('')
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState>({ status: 'idle' })
  const [gatewaySession, setGatewaySession] = useState<GatewaySession | null>(null)
  const [librarySyncState, setLibrarySyncState] = useState<GatewayLibrarySyncState>({ status: 'never' })
  const [books, setBooks] = useState<BookSummary[]>([])
  const [localBooks, setLocalBooks] = useState<BookSummary[]>([])
  const [selectedBookId, setSelectedBookId] = useState<string | null>(() => loadLatestReadingProgress()?.bookId ?? loadFullPackageCache()?.bookId ?? null)
  const [bookPackage, setBookPackage] = useState<BookPackage | null>(null)
  const [currentChapterId, setCurrentChapterId] = useState<string | null>(null)
  const [audioChapters, setAudioChapters] = useState<AudioChapter[]>([])
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioManifest, setAudioManifest] = useState<AudioManifest | null>(null)
  const [audioTime, setAudioTime] = useState(0)
  const [chapterAudioPlaying, setChapterAudioPlaying] = useState(false)
  const [loadingAudio, setLoadingAudio] = useState(false)
  const [audioPlaybackLoading, setAudioPlaybackLoading] = useState(false)
  const [audioCatalogBookId, setAudioCatalogBookId] = useState<string | null>(null)
  const [addingBookId, setAddingBookId] = useState<string | null>(null)
  const [loadingBooks, setLoadingBooks] = useState(false)
  const [loadingPackage, setLoadingPackage] = useState(false)
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false)
  const [mp3ManagerOpen, setMp3ManagerOpen] = useState(false)
  const [searchMode, setSearchMode] = useState<SearchMode>('rag')
  const [ragUseSemantic, setRagUseSemantic] = useState(true)
  const [searchInput, setSearchInput] = useState('')
  const [submittedSearchQuery, setSubmittedSearchQuery] = useState('')
  const [ragResults, setRagResults] = useState<RagResult[]>([])
  const [ragAnswer, setRagAnswer] = useState('')
  const [ragIsSearching, setRagIsSearching] = useState(false)
  const [ragIsGeneratingAnswer, setRagIsGeneratingAnswer] = useState(false)
  const [ragStatus, setRagStatus] = useState('')
  const [ragError, setRagError] = useState('')
  const [expandedGraphResultId, setExpandedGraphResultId] = useState('')
  const [cachedAudioIds, setCachedAudioIds] = useState<Set<string>>(() => new Set())
  const [cachedAudioBookId, setCachedAudioBookId] = useState<string | null>(null)
  const [audioSyncProgress, setAudioSyncProgress] = useState<{ done: number; total: number } | null>(null)
  const [audioSyncBookId, setAudioSyncBookId] = useState<string | null>(null)
  const [audioDownloadQueueIds, setAudioDownloadQueueIds] = useState<Set<string>>(() => new Set())
  const [audioDownloadingChapterKey, setAudioDownloadingChapterKey] = useState<string | null>(null)
  const [fullPackageCache, setFullPackageCache] = useState<FullPackageCache | null>(() => loadFullPackageCache())
  const [fullPackageStatus, setFullPackageStatus] = useState<FullPackageStatus>(() => {
    const cache = loadFullPackageCache()
    return cache?.importStats ? 'imported' : cache ? 'downloaded' : 'idle'
  })
  const [fullPackageProgress, setFullPackageProgress] = useState<PackageSyncProgress | null>(null)
  const [ttsVoices, setTtsVoices] = useState<TtsVoice[]>([])
  const [ttsStatusMessage, setTtsStatusMessage] = useState('')
  const [speechPlayback, setSpeechPlayback] = useState<SpeechPlaybackState>({ status: 'idle' })
  const [activeSpeechSegmentId, setActiveSpeechSegmentId] = useState<string | null>(null)
  const [speechAutoFollowSuspended, setSpeechAutoFollowSuspended] = useState(false)
  const [cacheVersion, setCacheVersion] = useState(0)
  const [summaryHighlightRange, setSummaryHighlightRange] = useState<SourceRange | null>(null)
  const [clearingCacheKey, setClearingCacheKey] = useState<string | null>(null)
  const [latestIssue, setLatestIssue] = useState<AppLogEntry | null>(() => loadLatestIssueFromStorage(localStorage))
  const [appLogCount, setAppLogCount] = useState(() => loadAppLogEntriesFromStorage(localStorage).length)
  const [logSubmitState, setLogSubmitState] = useState<LogSubmitState>({ status: 'idle' })

  const displayLocalBooks = useMemo(
    () => mergeLocalBooksWithCloudMetadata(localBooks, books),
    [books, localBooks],
  )
  const selectedBook = useMemo(
    () => displayLocalBooks.find((book) => book.id === selectedBookId) ?? books.find((book) => book.id === selectedBookId) ?? null,
    [books, displayLocalBooks, selectedBookId],
  )
  const selectedLocalBook = useMemo(
    () => displayLocalBooks.find((book) => book.id === selectedBookId) ?? null,
    [displayLocalBooks, selectedBookId],
  )
  const chapters = useMemo(() => packageChapters(bookPackage), [bookPackage])
  const currentChapter = useMemo(
    () => chapters.find((chapter) => chapter.id === currentChapterId) ?? chapters[0] ?? null,
    [chapters, currentChapterId],
  )
  const visibleAudioChapters = useMemo(
    () => (audioCatalogBookId === selectedBookId ? audioChapters : []),
    [audioCatalogBookId, audioChapters, selectedBookId],
  )
  const visibleCachedAudioIds = useMemo(
    () => (cachedAudioBookId === selectedBookId ? cachedAudioIds : new Set<string>()),
    [cachedAudioBookId, cachedAudioIds, selectedBookId],
  )
  const visibleAudioSyncProgress = audioSyncBookId === selectedBookId ? audioSyncProgress : null
  const audioSyncRunning = Boolean(audioSyncProgress)
  const visibleFullPackageCache = fullPackageCache?.bookId === selectedBookId ? fullPackageCache : null
  const visibleFullPackageProgress = fullPackageProgress?.bookId === selectedBookId ? fullPackageProgress : null
  const displaySummaryCoverage = hasImportedPackage(visibleFullPackageCache) ? 1 : inferredSummaryCoverage(selectedBook, bookPackage, visibleFullPackageCache)
  const displayKgCoverage = inferredKgCoverage(selectedBook, bookPackage, visibleFullPackageCache)
  const displayRagAvailability = ragAvailability(selectedBook, bookPackage)
  const displayPackageLabel = packageLabel(bookPackage, selectedBook, visibleFullPackageCache)
  const displayCloudAudioChapterCount = visibleAudioChapters.length || selectedBook?.audioChapterCount || 0
  const displayCachedAudioChapterCount = visibleCachedAudioIds.size || bookCachedAudioCount(selectedLocalBook ?? selectedBook)
  const cacheSummaries = useMemo(() => buildBookCacheSummaries([...displayLocalBooks, ...books], cacheVersion), [books, displayLocalBooks, cacheVersion])
  const cachedCurrentAudio = useMemo(
    () => (selectedBookId && currentChapter?.id ? readCachedAudioChapter(selectedBookId, currentChapter.id) : null),
    [currentChapter?.id, selectedBookId, visibleCachedAudioIds],
  )
  const currentAudio = useMemo(
    () => resolveCurrentAudio(currentChapter, visibleAudioChapters, cachedCurrentAudio, selectedBookId ?? undefined),
    [cachedCurrentAudio, currentChapter, selectedBookId, visibleAudioChapters],
  )
  const audioChapterStatusRows = useMemo(
    () => buildAudioChapterStatusRows(chapters, visibleAudioChapters, visibleCachedAudioIds, currentChapter?.id, selectedBookId ?? undefined),
    [chapters, currentChapter?.id, selectedBookId, visibleAudioChapters, visibleCachedAudioIds],
  )
  const activeTimelineEntry = useMemo(
    () => findActiveTimelineEntry(audioManifest, audioTime),
    [audioManifest, audioTime],
  )
  const currentChapterPosition = useMemo(
    () => (currentChapter ? chapters.findIndex((chapter) => chapter.id === currentChapter.id) : -1),
    [chapters, currentChapter],
  )
  const speechChapter = useMemo(() => {
    if (!currentChapter || !selectedBookId) return null
    return createSpeechChapter({
      id: currentChapter.id,
      bookId: selectedBookId,
      index: currentChapter.index ?? currentChapter.chapterIndex ?? currentChapterPosition + 1,
      content: chapterContent(currentChapter),
    })
  }, [currentChapter, currentChapterPosition, selectedBookId])
  const graphResults = useMemo(
    () => (searchMode === 'graph' && submittedSearchQuery ? searchGraphPackage(bookPackage, submittedSearchQuery) : []),
    [bookPackage, searchMode, submittedSearchQuery],
  )
  const visibilityNotice = libraryVisibilityNotice(gatewaySession, books.length)
  const syncBlockedReason = gatewaySyncBlockedReason(gatewaySession)
  const cloudSyncBlocked = Boolean(syncBlockedReason)
  const visibleStatusMessage = shouldShowGlobalStatusMessage(message) ? message : ''
  const previousChapter = currentChapterPosition > 0 ? chapters[currentChapterPosition - 1] : null
  const nextChapter =
    currentChapterPosition >= 0 && currentChapterPosition < chapters.length - 1 ? chapters[currentChapterPosition + 1] : null
  const lastReaderCenterTapAtRef = useRef(0)
  const readerCardRef = useRef<HTMLElement | null>(null)
  const chapterAudioRef = useRef<HTMLAudioElement | null>(null)
  const chapterAudioTimelineRef = useRef<ChapterAudioTimelineItem[]>([])
  const activeAudioEntryKeyRef = useRef<string | null>(null)
  const renderedAudioScrollKeyRef = useRef<string | null>(null)
  const audioManifestRef = useRef<AudioManifest | null>(null)
  const pendingAudioStartTimeRef = useRef<number | null>(null)
  const pendingAudioShouldPlayRef = useRef(false)
  const audioStreamRetryRef = useRef<AudioStreamRetryState | null>(null)
  const hydratingAudioManifestBooksRef = useRef<Set<string>>(new Set())
  const pendingAutoPlayChapterIdRef = useRef<string | null>(null)
  const autoConnectAttemptedRef = useRef(false)
  const autoRestoreAttemptedRef = useRef(false)
  const lastReaderScrollYRef = useRef(0)
  const pendingRestoreScrollRef = useRef<number | null>(null)
  const speechPlaybackRef = useRef<SpeechPlaybackState>({ status: 'idle' })
  const speechSegmentsRef = useRef<SpeechSegment[]>([])
  const currentUtteranceIdRef = useRef<string | null>(null)
  const speechUtteranceIndexRef = useRef<Map<string, number>>(new Map())
  const speechQueueIdRef = useRef(0)
  const speechAutoFollowRef = useRef(true)
  const speechFollowSuspendedRef = useRef(false)
  const speechFollowTimerRef = useRef<number | null>(null)
  const isSpeechAutoScrollingRef = useRef(false)
  const playbackEngineTouchedRef = useRef(false)
  const summaryHighlightTimerRef = useRef<number | null>(null)
  const deviceMetadata = useMemo(() => getDeviceMetadata(appVersion), [])
  const audioSyncCancelRequestedRef = useRef(false)
  const audioDownloadQueueRef = useRef<AudioDownloadQueueItem[]>([])
  const audioDownloadProcessingRef = useRef(false)
  const gatewaySessionRef = useRef<GatewaySession | null>(gatewaySession)
  const cloudBookCountRef = useRef(books.length)

  function recordDiagnostic(level: AppLogLevel, message: string, context: Record<string, unknown> = {}) {
    const entry = appendAppLogToStorage(localStorage, level, message, {
      ...context,
      tab,
      selectedBookId,
      currentChapterId: currentChapter?.id,
      currentChapterIndex: currentChapter?.index ?? currentChapter?.chapterIndex,
    })
    setAppLogCount(loadAppLogEntriesFromStorage(localStorage).length)
    if (level === 'error') setLatestIssue(entry)
    return entry
  }

  function reportUserError(error: unknown, context: Record<string, unknown> = {}, prefix?: string) {
    const message = prefix ? `${prefix}：${errorMessage(error)}` : errorMessage(error)
    recordDiagnostic('error', message, {
      ...context,
      error: serializeErrorForLog(error),
    })
    setMessage(message)
    return message
  }

  async function submitLocalLogs() {
    if (!isGatewayConfigured(settings)) {
      reportUserError(new Error('请先配置 Gateway 地址和 Token。'), { action: 'submitLocalLogs' }, '提交日志失败')
      return
    }
    const entries = buildSubmittedAppLogs(loadAppLogEntriesFromStorage(localStorage), latestIssue)
    if (entries.length === 0) {
      setLogSubmitState({ status: 'idle', message: '暂无可提交日志。' })
      setMessage('暂无可提交日志')
      return
    }

    setLogSubmitState({ status: 'submitting', message: '正在提交日志...' })
    try {
      const response = await gatewayPost(settings, '/mobile/logs', {
        schemaVersion: 1,
        submittedAt: new Date().toISOString(),
        app: {
          versionName: buildInfo.versionName,
          versionCode: buildInfo.versionCode,
          buildNumber: buildInfo.buildNumber,
          gitCommit: buildInfo.gitCommit,
          dirty: buildInfo.dirty,
        },
        device: {
          id: settings.deviceId,
          name: settings.deviceName,
          model: deviceMetadata.model,
          platform: deviceMetadata.platform,
        },
        state: {
          tab,
          connectionState,
          selectedBookId,
          selectedBookTitle: selectedBook?.title,
          currentChapterId: currentChapter?.id,
          currentChapterTitle: currentChapter?.title,
          currentChapterIndex: currentChapter?.index ?? currentChapter?.chapterIndex,
          audioCatalogBookId,
          audioChapterCount: visibleAudioChapters.length,
          cachedAudioCount: visibleCachedAudioIds.size,
          speechEngine: ttsSettings.engine,
        },
        logs: entries,
      })
      const receiptId = readString(response.receiptId) || ''
      const submittedCount = typeof response.storedEntries === 'number' ? response.storedEntries : entries.length
      const nextMessage = receiptId ? `日志已提交：${receiptId}` : `日志已提交：${submittedCount} 条`
      setLogSubmitState({ status: 'submitted', message: nextMessage, receiptId })
      setMessage(nextMessage)
    } catch (error) {
      const message = reportUserError(error, { action: 'submitLocalLogs' }, '提交日志失败')
      setLogSubmitState({ status: 'error', message })
    }
  }

  function clearLocalLogs() {
    clearAppLogsFromStorage(localStorage)
    setLatestIssue(null)
    setAppLogCount(0)
    setLogSubmitState({ status: 'idle', message: '本地日志已清空。' })
    setMessage('本地日志已清空')
  }

  useEffect(() => {
    localStorage.setItem(settingsKey, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    const handleWindowError = (event: ErrorEvent) => {
      reportUserError(event.error ?? event.message, {
        action: 'window.error',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      })
    }
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      reportUserError(event.reason ?? new Error('Unhandled promise rejection'), {
        action: 'window.unhandledrejection',
      })
    }
    window.addEventListener('error', handleWindowError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    return () => {
      window.removeEventListener('error', handleWindowError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [])

  useEffect(() => {
    gatewaySessionRef.current = gatewaySession
  }, [gatewaySession])

  useEffect(() => {
    cloudBookCountRef.current = books.length
  }, [books.length])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setSummaryHighlightRange(null))
    if (summaryHighlightTimerRef.current) {
      window.clearTimeout(summaryHighlightTimerRef.current)
      summaryHighlightTimerRef.current = null
    }
    return () => window.cancelAnimationFrame(frame)
  }, [currentChapter?.id])

  function jumpToSummarySource(source: SummaryKeyPointSource) {
    if (!readerCardRef.current) return

    const target = findSourceElement(readerCardRef.current, source)
    setSummaryHighlightRange({ startOffset: source.startOffset, endOffset: source.endOffset })

    if (summaryHighlightTimerRef.current) {
      window.clearTimeout(summaryHighlightTimerRef.current)
    }
    summaryHighlightTimerRef.current = window.setTimeout(() => {
      setSummaryHighlightRange(null)
      summaryHighlightTimerRef.current = null
    }, 2000)

    target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
  }

  useEffect(() => {
    if (!audioUrl || !activeTimelineEntry) {
      renderedAudioScrollKeyRef.current = null
      return
    }

    const activeEntryKey = audioEntryKey(activeTimelineEntry)
    if (renderedAudioScrollKeyRef.current === activeEntryKey) return
    renderedAudioScrollKeyRef.current = activeEntryKey

    const frame = window.requestAnimationFrame(() => scrollToAudioHighlight())
    return () => window.cancelAnimationFrame(frame)
  }, [activeTimelineEntry, audioUrl])

  useEffect(() => {
    localStorage.setItem(readerSettingsKey, JSON.stringify(readerSettings))
  }, [readerSettings])

  useEffect(() => {
    localStorage.setItem(ttsSettingsKey, JSON.stringify(ttsSettings))
    speechAutoFollowRef.current = ttsSettings.autoFollow
  }, [ttsSettings])

  useEffect(() => {
    speechPlaybackRef.current = speechPlayback
  }, [speechPlayback])

  useEffect(() => {
    speechSegmentsRef.current = speechChapter?.segments ?? []
  }, [speechChapter])

  useEffect(() => {
    if (!currentAudio || playbackEngineTouchedRef.current || ttsSettings.engine === 'cloud-mp3') return
    setTtsSettings((current) => ({ ...current, engine: 'cloud-mp3' }))
    setTtsStatusMessage('')
    if (speechPlaybackRef.current.status !== 'idle') {
      void stopSpeechReading()
    }
  }, [currentAudio, ttsSettings.engine])

  useEffect(() => {
    if (currentAudio || !selectedBookId || !currentChapter || visibleAudioChapters.length === 0) return
    const timeout = window.setTimeout(() => recordDiagnostic('warn', '当前章节未匹配到 MP3 catalog', {
      action: 'audioCatalogMismatch',
      bookId: selectedBookId,
      currentChapterId: currentChapter.id,
      currentChapterIndex: currentChapter.index ?? currentChapter.chapterIndex,
      audioCatalogBookId,
      audioChapterCount: visibleAudioChapters.length,
      audioChapterSamples: visibleAudioChapters.slice(0, 3).map((chapter) => chapter.chapterId),
      currentMatchKeys: Array.from(chapterAudioReferenceKeys(selectedBookId, currentChapter)),
      firstAudioMatchKeys: Array.from(chapterAudioReferenceKeys(selectedBookId, visibleAudioChapters[0]?.chapterId)),
    }), 0)
    return () => window.clearTimeout(timeout)
  }, [audioCatalogBookId, currentAudio, currentChapter, selectedBookId, visibleAudioChapters])

  useEffect(() => {
    const pendingChapterId = pendingAutoPlayChapterIdRef.current
    if (!pendingChapterId || currentChapter?.id !== pendingChapterId) return
    pendingAutoPlayChapterIdRef.current = null
    if (!currentAudio) {
      window.setTimeout(() => setMessage('下一章暂无 MP3'), 0)
      return
    }
    void playCurrentAudio({ autoplay: true })
  }, [currentAudio, currentChapter?.id])

  useEffect(() => {
    void clearLegacyAudioIndexedDbCache()
    void refreshLocalLibrary()
  }, [])

  useEffect(() => {
    void restoreLastReadingFromCache()
  }, [])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let listener: PluginListenerHandle | null = null
    void NativeAudio.addListener('packageSyncProgress', (event) => {
      setFullPackageProgress(event)
      if (event.phase === 'download' && event.status === 'downloading') setFullPackageStatus('downloading')
      if (event.phase === 'download' && event.status === 'downloaded') setFullPackageStatus('downloaded')
      if (event.phase === 'import') setFullPackageStatus(event.status === 'imported' ? 'imported' : 'importing')
    }).then((nextListener) => {
      listener = nextListener
    })

    return () => {
      void listener?.remove()
    }
  }, [])

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let cancelled = false
    const handles: PluginListenerHandle[] = []

    async function bindTtsEvents() {
      handles.push(
        await NovelReaderTts.addListener('utteranceStart', (event) => {
          if (cancelled) return
          const segmentIndex = speechUtteranceIndexRef.current.get(event.utteranceId)
          if (segmentIndex == null) return
          const segment = speechSegmentsRef.current[segmentIndex]
          if (!segment) return
          setActiveSpeechSegmentId(segment.id)
          setSpeechPlayback({ status: 'playing', segmentIndex, segmentId: segment.id })
          scrollToSpeechSegment(segment.id)
        }),
      )
      handles.push(
        await NovelReaderTts.addListener('utteranceDone', (event) => {
          if (cancelled) return
          const current = speechPlaybackRef.current
          const segmentIndex = speechUtteranceIndexRef.current.get(event.utteranceId)
          if (segmentIndex != null && current.status === 'playing') {
            const nextSegment = speechSegmentsRef.current[segmentIndex + 1]
            if (nextSegment) {
              setActiveSpeechSegmentId(nextSegment.id)
              setSpeechPlayback({ status: 'playing', segmentIndex: segmentIndex + 1, segmentId: nextSegment.id })
              scrollToSpeechSegment(nextSegment.id)
              return
            }
          }

          if (event.utteranceId !== currentUtteranceIdRef.current) return
          currentUtteranceIdRef.current = null
          speechUtteranceIndexRef.current.clear()
          setActiveSpeechSegmentId(null)
          setSpeechPlayback({ status: 'idle' })
        }),
      )
      handles.push(
        await NovelReaderTts.addListener('utteranceError', (event) => {
          if (cancelled || !speechUtteranceIndexRef.current.has(event.utteranceId)) return
          const message = event.error || '系统 TTS 朗读失败。'
          currentUtteranceIdRef.current = null
          speechUtteranceIndexRef.current.clear()
          setSpeechPlayback({ status: 'error', message })
          setTtsStatusMessage(message)
        }),
      )
    }

    void bindTtsEvents()

    return () => {
      cancelled = true
      for (const handle of handles) {
        void handle.remove()
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      if (speechFollowTimerRef.current != null) window.clearTimeout(speechFollowTimerRef.current)
      currentUtteranceIdRef.current = null
      speechUtteranceIndexRef.current.clear()
      void NovelReaderTts.stop().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (tab !== 'reader' || !selectedBookId || !currentChapterId) return

    let saveTimer: number | undefined
    const save = () => {
      if (
        speechPlaybackRef.current.status === 'playing' &&
        !isSpeechAutoScrollingRef.current &&
        !speechFollowSuspendedRef.current
      ) {
        speechFollowSuspendedRef.current = true
        setSpeechAutoFollowSuspended(true)
        if (speechFollowTimerRef.current != null) window.clearTimeout(speechFollowTimerRef.current)
        speechFollowTimerRef.current = window.setTimeout(() => {
          speechFollowSuspendedRef.current = false
          setSpeechAutoFollowSuspended(false)
        }, 7000)
      }
      lastReaderScrollYRef.current = Math.max(0, window.scrollY)
      window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(() => {
        persistReadingProgress(selectedBookId, currentChapterId, lastReaderScrollYRef.current)
      }, 250)
    }

    window.addEventListener('scroll', save, { passive: true })
    return () => {
      window.removeEventListener('scroll', save)
      window.clearTimeout(saveTimer)
      persistReadingProgress(selectedBookId, currentChapterId, lastReaderScrollYRef.current)
    }
  }, [currentChapterId, selectedBookId, tab])

  useEffect(() => {
    return () => {
      if (audioUrl?.startsWith('blob:')) URL.revokeObjectURL(audioUrl)
    }
  }, [audioUrl])

  async function refreshBooks(
    options: {
      session?: GatewaySession
      roleNotice?: string | null
      previousSession?: GatewaySession | null
      previousBookCount?: number
    } = {},
  ) {
    const previousSession = options.previousSession ?? gatewaySessionRef.current
    const previousBookCount = options.previousBookCount ?? cloudBookCountRef.current
    let activeSession = options.session ?? gatewaySessionRef.current
    let activeRoleNotice = options.roleNotice ?? null
    setLoadingBooks(true)
    setLibrarySyncState({ status: 'syncing' })
    setMessage('')
    try {
      if (!options.session) {
        const refreshedSession = await fetchAuthenticatedSession()
        activeSession = refreshedSession
        if (refreshedSession.auth.role === 'disabled') {
          activeRoleNotice = applyGatewaySession(refreshedSession, previousBookCount, previousBookCount)
        }
      }
      const blockedReason = gatewaySyncBlockedReason(activeSession)
      if (blockedReason) {
        setConnectionState('error')
        setLibrarySyncState({ status: 'blocked', message: blockedReason })
        setMessage(activeRoleNotice ? `${activeRoleNotice} ${blockedReason}` : blockedReason)
        return
      }
      const response = await gatewayFetch(settings, '/mobile/books')
      const nextBooks = Array.isArray(response.books) ? (response.books as BookSummary[]) : []
      if (activeSession) {
        activeRoleNotice = roleChangeNotice(previousSession, activeSession, previousBookCount, nextBooks.length)
        if (!options.session) applyGatewaySession(activeSession, previousBookCount, nextBooks.length)
      }
      setBooks(nextBooks)
      void refreshBookAudioCounts(nextBooks)
      await refreshLocalLibrary()
      void refreshCachedAudioIds(selectedBookId)
      refreshCacheSummaries()
      setConnectionState('connected')
      setLibrarySyncState({ status: 'synced', at: new Date().toISOString(), bookCount: nextBooks.length })
      setMessage(activeRoleNotice ?? `云端书库 ${nextBooks.length} 本`)
    } catch (error) {
      const blockedMessage = blockedGatewaySyncMessage(error)
      if (blockedMessage) {
        setConnectionState('error')
        setLibrarySyncState({ status: 'blocked', message: blockedMessage })
        setMessage(blockedMessage)
        recordDiagnostic('error', blockedMessage, { action: 'refreshBooks', blocked: true })
        return
      }
      const message = reportUserError(error, { action: 'refreshBooks' })
      setConnectionState('error')
      setLibrarySyncState({ status: 'error', message })
    } finally {
      setLoadingBooks(false)
    }
  }

  async function refreshLocalLibrary() {
    const nextLocalBooks = await listLocalBookSummaries()
    setLocalBooks(nextLocalBooks)
    if (selectedBookId && !nextLocalBooks.some((book) => book.id === selectedBookId)) {
      setSelectedBookId(null)
      setBookPackage(null)
      setCurrentChapterId(null)
      setFullPackageCache(null)
      setFullPackageStatus('idle')
      setFullPackageProgress(null)
      setAudioChapters([])
      setAudioCatalogBookId(null)
      setCachedAudioBookId(null)
      setCachedAudioIds(new Set())
      clearAudioUrl()
    }
  }

  async function checkSession() {
    setConnectionState('checking')
    setMessage('')
    try {
      const previousSession = gatewaySessionRef.current
      const previousBookCount = cloudBookCountRef.current
      const session = await fetchAuthenticatedSession()
      const roleNotice = applyGatewaySession(session, previousBookCount, previousBookCount)
      if (session.auth.role === 'disabled') {
        setConnectionState('error')
        const blockedMessage = gatewaySyncBlockedReason(session) ?? errorMessage(createGatewayError({ error: { code: 'device_disabled', statusCode: 403 } }))
        setLibrarySyncState({ status: 'blocked', message: blockedMessage })
        setMessage(roleNotice ? `${roleNotice} ${blockedMessage}` : blockedMessage)
        return
      }
      setConnectionState('connected')
      setMessage(roleNotice ?? `授权状态：${deviceRoleLabel(session.auth.role)}`)
      await refreshBooks({ session, roleNotice, previousSession, previousBookCount })
    } catch (error) {
      setConnectionState('error')
      reportUserError(error, { action: 'checkSession' })
    }
  }

  async function checkAppUpdate() {
    setAppUpdateState((current) => ({ status: 'checking', manifest: current.manifest, message: '正在检查更新...' }))
    try {
      const manifest = normalizeAppUpdateManifest(await gatewayPublicFetch(settings, '/downloads/android-app.json'))
      if (!manifest) throw new Error('更新清单格式无效。')
      setAppUpdateState(resolveAppUpdateManifest(manifest, buildInfo.versionCode, buildInfo.versionName))
    } catch (error) {
      const message = reportUserError(error, { action: 'checkAppUpdate' }, '检查更新失败')
      setAppUpdateState((current) => ({
        status: 'error',
        manifest: current.manifest,
        message,
      }))
    }
  }

  async function installAppUpdate(manifest: AppUpdateManifest) {
    const updateUrl = absoluteGatewayUrl(settings, manifest.latestUrl)
    setAppUpdateState({ status: 'downloading', manifest, message: `正在下载 ${manifest.versionName}...` })
    try {
      if (Capacitor.isNativePlatform()) {
        await NativeAudio.downloadAndInstallApk({
          url: updateUrl,
          fileName: manifest.latestFileName || 'novel_gateway.apk',
        })
        setAppUpdateState({
          status: 'available',
          manifest,
          message: '安装包已下载，已打开系统安装确认。',
        })
        return
      }
      window.location.href = updateUrl
      setAppUpdateState({
        status: 'available',
        manifest,
        message: '已打开下载链接。',
      })
    } catch (error) {
      const message = reportUserError(error, { action: 'installAppUpdate', versionName: manifest.versionName }, '下载安装包失败')
      setAppUpdateState({
        status: 'error',
        manifest,
        message,
      })
    }
  }

  useEffect(() => {
    if (autoConnectAttemptedRef.current || !isGatewayConfigured(settings)) return
    autoConnectAttemptedRef.current = true
    void checkSession()
  }, [settings])

  async function openBook(bookId: string, options: { restoreProgress?: ReadingProgress | null } = {}) {
    const restoreProgress = options.restoreProgress ?? loadReadingProgress(bookId)
    setSelectedBookId(bookId)
    const cachedFullPackage = loadFullPackageCache(bookId)
    setFullPackageCache(cachedFullPackage)
    setFullPackageStatus(cachedFullPackage?.importStats ? 'imported' : cachedFullPackage ? 'downloaded' : 'idle')
    setFullPackageProgress(null)
    setLoadingPackage(true)
    setMessage('')
    setAudioChapters([])
    setAudioCatalogBookId(null)
    setCachedAudioBookId(null)
    setCachedAudioIds(new Set())
    setAudioSyncProgress(null)
    setAudioSyncBookId(null)
    clearAudioUrl()
    try {
      const cachedPackage = await loadCachedBookPackage(bookId)
      if (cachedPackage) {
        const cachedChapters = packageChapters(cachedPackage)
        const restoredChapterId =
          restoreProgress?.bookId === bookId && cachedChapters.some((chapter) => chapter.id === restoreProgress?.chapterId)
            ? restoreProgress.chapterId
            : null
        setBookPackage(cachedPackage)
        setCurrentChapterId(restoredChapterId ?? cachedChapters[0]?.id ?? null)
        setMessage('已打开本地书')
        await refreshCachedAudioIds(bookId)
        pendingRestoreScrollRef.current = restoredChapterId ? restoreProgress?.scrollY ?? 0 : 0
        setTab('reader')
        restorePendingScroll()
        setLoadingPackage(false)
        void refreshAudio(bookId, false)
        return
      }

      if (!localCacheReadableWhenDisabled(gatewaySessionRef.current, Boolean(cachedPackage)) && gatewaySessionRef.current?.auth.role === 'disabled') {
        setConnectionState('error')
        setMessage('设备已禁用，本地没有可读缓存。本地缓存仍可读，云端同步已禁用。')
        return
      }

      const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/package`)
      const nextPackage = normalizeBookPackage(response.package)
      const nextChapters = packageChapters(nextPackage)
      const restoredChapterId =
        restoreProgress?.bookId === bookId && nextChapters.some((chapter) => chapter.id === restoreProgress?.chapterId)
          ? restoreProgress.chapterId
          : null
      setBookPackage(nextPackage)
      setCurrentChapterId(restoredChapterId ?? nextChapters[0]?.id ?? null)
      const cached = await cacheBookPackage(bookId, nextPackage)
      setMessage(cached ? '数据包已加载' : '数据包已加载，缓存空间不足')
      await refreshAudio(bookId, false)
      await refreshCachedAudioIds(bookId)
      pendingRestoreScrollRef.current = restoredChapterId ? restoreProgress?.scrollY ?? 0 : 0
      setTab('reader')
      restorePendingScroll()
    } catch (error) {
      if (isDeviceDisabledError(error)) {
        reportUserError(error, { action: 'openBook', bookId })
        return
      }
      const cachedPackage = await loadCachedBookPackage(bookId)
      const cachedChapters = packageChapters(cachedPackage)
      const restoredChapterId =
        restoreProgress?.bookId === bookId && cachedChapters.some((chapter) => chapter.id === restoreProgress?.chapterId)
          ? restoreProgress.chapterId
          : null
      setBookPackage(cachedPackage)
      setCurrentChapterId(restoredChapterId ?? cachedChapters[0]?.id ?? null)
      const message = cachedPackage
        ? reportUserError(error, { action: 'openBook', bookId, fallback: 'cachedPackage' }, '已使用本地缓存')
        : reportUserError(error, { action: 'openBook', bookId })
      setMessage(message)
      await refreshCachedAudioIds(bookId)
      if (cachedPackage) {
        pendingRestoreScrollRef.current = restoredChapterId ? restoreProgress?.scrollY ?? 0 : 0
        setTab('reader')
        restorePendingScroll()
      }
    } finally {
      setLoadingPackage(false)
    }
  }

  function selectBook(bookId: string) {
    setSelectedBookId(bookId)
    const cachedFullPackage = loadFullPackageCache(bookId)
    setFullPackageCache(cachedFullPackage)
    setFullPackageStatus(cachedFullPackage?.importStats ? 'imported' : cachedFullPackage ? 'downloaded' : 'idle')
    setFullPackageProgress(null)
    setMessage('')
    setBookPackage(null)
    setCurrentChapterId(null)
    setAudioChapters([])
    setAudioCatalogBookId(null)
    setCachedAudioBookId(null)
    setCachedAudioIds(new Set())
    setAudioSyncProgress(null)
    setAudioSyncBookId(null)
    clearAudioUrl()
    void refreshCachedAudioIds(bookId)
    void loadCachedBookPackageSelection(bookId)
  }

  async function loadCachedBookPackageSelection(bookId: string) {
    const cachedPackage = await loadCachedBookPackage(bookId)
    if (!cachedPackage) return
    const cachedChapters = packageChapters(cachedPackage)
    setBookPackage((current) => (current?.book?.id === bookId ? current : cachedPackage))
    setCurrentChapterId((current) => (current && cachedChapters.some((chapter) => chapter.id === current) ? current : cachedChapters[0]?.id ?? null))
  }

  async function syncFullPackage(bookId: string) {
    if (!Capacitor.isNativePlatform()) return
    if (fullPackageStatus === 'downloading' || fullPackageStatus === 'importing') return
    const blockedReason = cloudActionBlockedReason(gatewaySessionRef.current, '下载完整包')
    if (blockedReason) {
      setConnectionState('error')
      setMessage(blockedReason)
      return
    }
    const sourceBook = books.find((book) => book.id === bookId) ?? localBooks.find((book) => book.id === bookId)
    setFullPackageStatus('downloading')
    setFullPackageProgress({ bookId, phase: 'download', status: 'downloading', done: 0, total: 0 })
    try {
      const downloaded = await downloadPackageToNativeFile(settings, bookId)
      const downloadedCache: FullPackageCache = {
        bookId,
        title: sourceBook?.title,
        author: sourceBook?.author,
        chapterCount: sourceBook?.chapterCount,
        wordCount: sourceBook?.wordCount,
        updatedAt: sourceBook?.updatedAt,
        filePath: downloaded.filePath,
        sizeBytes: downloaded.sizeBytes,
        cachedAt: new Date().toISOString(),
      }
      saveFullPackageCache(downloadedCache)
      setFullPackageCache(downloadedCache)
      setFullPackageStatus('importing')
      setFullPackageProgress({ bookId, phase: 'import', status: 'parsing', done: 0, total: 4 })
      const importStats = await importPackageToNativeStore(bookId, downloaded.filePath, sourceBook?.chapterCount)
      const importedCache: FullPackageCache = {
        ...downloadedCache,
        title: sourceBook?.title,
        author: sourceBook?.author,
        chapterCount: sourceBook?.chapterCount,
        wordCount: sourceBook?.wordCount,
        updatedAt: sourceBook?.updatedAt,
        importedAt: new Date().toISOString(),
        importStats,
        metadataPath: importStats.metadataPath,
      }
      saveFullPackageCache(importedCache)
      setFullPackageCache(importedCache)
      setFullPackageStatus('imported')
      setFullPackageProgress({ bookId, phase: 'import', status: 'imported', done: 4, total: 4 })
      await refreshLocalLibrary()
      if (bookId === selectedBookId) {
        const refreshedPackage = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/package`)
          .then((response) => normalizeBookPackage(response.package))
          .catch(() => loadCachedBookPackage(bookId))
        if (refreshedPackage) {
          await cacheBookPackage(bookId, refreshedPackage)
          const refreshedChapters = packageChapters(refreshedPackage)
          setBookPackage(refreshedPackage)
          setCurrentChapterId((currentId) =>
            currentId && refreshedChapters.some((chapter) => chapter.id === currentId)
              ? currentId
              : refreshedChapters[0]?.id ?? null,
          )
        }
        await refreshAudio(bookId, false)
        await refreshCachedAudioIds(bookId)
      }
      setMessage('完整数据包已导入')
    } catch (error) {
      setFullPackageStatus('error')
      reportUserError(error, { action: 'syncFullPackage', bookId }, '完整包同步失败')
    }
  }

  async function syncCurrentFullPackage() {
    if (!selectedBookId) return
    await syncFullPackage(selectedBookId)
  }

  async function addCloudBookToShelf(bookId: string) {
    if (addingBookId) return
    const blockedReason = cloudActionBlockedReason(gatewaySessionRef.current, '加入书架')
    if (blockedReason) {
      setConnectionState('error')
      setMessage(blockedReason)
      return
    }
    setAddingBookId(bookId)
    setMessage('')
    try {
      const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/package`)
      const nextPackage = normalizeBookPackage(response.package)
      const cached = await cacheBookPackage(bookId, nextPackage)
      if (!cached) {
        setMessage('基础包已下载，但本机缓存空间不足')
        return
      }
      const nextChapters = packageChapters(nextPackage)
      setSelectedBookId(bookId)
      setBookPackage(nextPackage)
      setCurrentChapterId(nextChapters[0]?.id ?? null)
      const cachedFullPackage = loadFullPackageCache(bookId)
      setFullPackageCache(cachedFullPackage)
      setFullPackageStatus(cachedFullPackage?.importStats ? 'imported' : cachedFullPackage ? 'downloaded' : 'idle')
      setFullPackageProgress(null)
      await refreshLocalLibrary()
      await refreshCachedAudioIds(bookId)
      refreshCacheSummaries()
      setMessage('已加入书架')
    } catch (error) {
      if (isDeviceAccessBlockedError(error)) {
        setConnectionState('error')
      }
      reportUserError(error, { action: 'addCloudBookToShelf', bookId })
    } finally {
      setAddingBookId(null)
    }
  }

  async function refreshAudio(bookId = selectedBookId, showMessage = true) {
    if (!bookId) return
    const blockedReason = cloudActionBlockedReason(gatewaySessionRef.current, '刷新 MP3')
    if (blockedReason) {
      setConnectionState('error')
      if (showMessage) setMessage(blockedReason)
      await refreshCachedAudioIds(bookId)
      return
    }
    setLoadingAudio(true)
    try {
      const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/audio`)
      const nextAudioChapters = Array.isArray(response.chapters) ? response.chapters.filter(isAudioChapter) : []
      setAudioChapters(nextAudioChapters)
      setAudioCatalogBookId(bookId)
      recordDiagnostic('info', 'MP3 catalog loaded', {
        action: 'refreshAudio',
        bookId,
        count: nextAudioChapters.length,
        firstChapterId: nextAudioChapters[0]?.chapterId,
        currentChapterId,
      })
      await refreshCachedAudioIds(bookId)
      void hydrateCachedAudioManifests(bookId, nextAudioChapters)
      if (showMessage) setMessage(`音频 ${nextAudioChapters.length} 章`)
    } catch (error) {
      if (isDeviceDisabledError(error)) {
        setConnectionState('error')
      }
      const message = reportUserError(error, { action: 'refreshAudio', bookId })
      if (!showMessage) setMessage(message)
    } finally {
      setLoadingAudio(false)
    }
  }

  async function refreshBookAudioCounts(sourceBooks: BookSummary[]) {
    const booksWithAudioCounts = await Promise.all(
      sourceBooks.map(async (book) => {
        try {
          const chapters = await fetchAudioCatalog(book.id)
          return {
            ...book,
            audioChapterCount: chapters.length,
          }
        } catch {
          return book
        }
      }),
    )
    setBooks((currentBooks) =>
      currentBooks.map((book) => booksWithAudioCounts.find((updatedBook) => updatedBook.id === book.id) ?? book),
    )
  }

  async function playCurrentAudio(options: { autoplay?: boolean; sourcePosition?: number | null; startTime?: number } = {}) {
    if (!selectedBookId || !currentChapter) return
    await stopSpeechReading()
    if (!currentAudio) {
      setMessage('当前章节暂无音频')
      return
    }
    setAudioPlaybackLoading(true)
    try {
      const cachedAudio = readCachedAudio(selectedBookId, currentChapter.id)
      let manifest = await loadCachedAudioManifest(cachedAudio)
      if (!manifest && cachedAudio && currentAudio.manifestFileName) {
        manifest = await ensureCachedAudioManifest(selectedBookId, currentChapter.id, currentAudio).catch(() => null)
      }
      if (!manifest && currentAudio.manifestFileName) {
        manifest = await fetchAudioManifest(selectedBookId, currentAudio).catch(() => null)
      }
      const missingCachedTimeline = Boolean(cachedAudio && options.sourcePosition != null && !manifest)
      if (missingCachedTimeline) {
        recordDiagnostic('warn', '本地 MP3 缺少时间轴，无法定位到当前位置', {
          action: 'playCurrentAudio',
          bookId: selectedBookId,
          currentChapterId: currentChapter.id,
          audioChapterId: currentAudio.chapterId,
          hasCachedAudio: Boolean(cachedAudio),
          hasManifestFilePath: Boolean(cachedAudio?.manifestFilePath),
        })
      }
      let playbackUrl = cachedAudio?.filePath ? Capacitor.convertFileSrc(cachedAudio.filePath) : ''
      const blob: Blob | undefined = cachedAudio?.blob
      let usesRemoteStream = false
      if (!cachedAudio) {
        playbackUrl = await createAudioStreamUrl(settings, selectedBookId, currentAudio.chapterId)
        usesRemoteStream = true
      }
      if (!playbackUrl && blob) {
        playbackUrl = URL.createObjectURL(blob)
      }
      const startTime =
        typeof options.startTime === 'number'
          ? options.startTime
          : options.sourcePosition == null
            ? 0
            : getAudioTimeForSourcePositionInManifest(manifest, options.sourcePosition) ?? 0
      clearAudioUrl()
      audioStreamRetryRef.current = usesRemoteStream
        ? {
            bookId: selectedBookId,
            currentChapterId: currentChapter.id,
            audioChapterId: currentAudio.chapterId,
            attempted: false,
          }
        : null
      buildChapterAudioTimeline(manifest?.timeline ?? [])
      audioManifestRef.current = manifest
      pendingAudioStartTimeRef.current = startTime
      pendingAudioShouldPlayRef.current = options.autoplay ?? true
      setAudioManifest(manifest)
      setAudioTime(startTime)
      setAudioUrl(playbackUrl)
      setMessage(missingCachedTimeline ? '本地 MP3 缺少时间轴，已从头播放；联网后会自动补齐' : '音频已加载')
    } catch (error) {
      pendingAudioStartTimeRef.current = null
      pendingAudioShouldPlayRef.current = false
      reportUserError(error, {
        action: 'playCurrentAudio',
        bookId: selectedBookId,
        currentChapterId: currentChapter.id,
        audioChapterId: currentAudio.chapterId,
      })
    } finally {
      setAudioPlaybackLoading(false)
    }
  }

  async function refreshCachedAudioIds(bookId = selectedBookId) {
    if (!bookId) {
      setCachedAudioIds(new Set())
      setCachedAudioBookId(null)
      return
    }
    const ids = await listCachedAudioChapterIds(bookId)
    setCachedAudioIds(new Set(ids))
    setCachedAudioBookId(bookId)
  }

  async function ensureAudioCatalog(bookId: string) {
    if (audioCatalogBookId === bookId && audioChapters.length > 0) return audioChapters
    const nextAudioChapters = await fetchAudioCatalog(bookId)
    setAudioChapters(nextAudioChapters)
    setAudioCatalogBookId(bookId)
    await refreshCachedAudioIds(bookId)
    void hydrateCachedAudioManifests(bookId, nextAudioChapters)
    return nextAudioChapters
  }

  async function hydrateCachedAudioManifests(bookId: string, catalog: AudioChapter[]) {
    if (!Capacitor.isNativePlatform() || hydratingAudioManifestBooksRef.current.has(bookId)) return
    const records = Object.values(loadAudioCacheIndex()).filter(
      (record) => record.bookId === bookId && !record.manifestFilePath,
    )
    if (!records.length) return

    hydratingAudioManifestBooksRef.current.add(bookId)
    let updated = 0
    try {
      for (const record of records) {
        const audioChapter = findAudioChapterForReference(record.chapterId, catalog, bookId) ?? record.audioChapter
        if (!audioChapter.manifestFileName) continue
        const manifest = await ensureCachedAudioManifest(bookId, record.chapterId, audioChapter).catch(() => null)
        if (manifest) updated += 1
      }
      if (updated > 0) {
        recordDiagnostic('info', '已补齐本地 MP3 时间轴缓存', {
          action: 'hydrateCachedAudioManifests',
          bookId,
          updated,
          cachedCount: records.length,
        })
      }
    } catch (error) {
      recordDiagnostic('warn', '补齐本地 MP3 时间轴失败', {
        action: 'hydrateCachedAudioManifests',
        bookId,
        error: serializeErrorForLog(error),
      })
    } finally {
      hydratingAudioManifestBooksRef.current.delete(bookId)
    }
  }

  async function syncCurrentBookAudioRange(limit: number | 'current' | 'all') {
    if (!selectedBookId) return
    const bookId = selectedBookId
    const blockedReason = cloudActionBlockedReason(gatewaySessionRef.current, '下载 MP3')
    if (blockedReason) {
      setConnectionState('error')
      setMessage(blockedReason)
      return
    }
    try {
      const catalog = await ensureAudioCatalog(bookId)
      if (catalog.length === 0) {
        setMessage('当前书籍暂无音频')
        return
      }
      const startIndex = Math.max(
        0,
        currentChapter ? catalog.findIndex((chapter) => chapterAudioReferencesMatch(selectedBookId ?? bookId, currentChapter, chapter.chapterId)) : 0,
      )
      const safeStartIndex = startIndex >= 0 ? startIndex : 0
      const targetChapters =
        limit === 'all'
          ? catalog.filter((chapter) => !readCachedAudio(bookId, chapter.chapterId))
          : catalog
              .slice(safeStartIndex, safeStartIndex + (limit === 'current' ? 1 : limit))
              .filter((chapter) => !readCachedAudio(bookId, chapter.chapterId))
      if (targetChapters.length === 0) {
        setMessage(limit === 'all' ? '所有可缓存 MP3 都已下载' : '选中范围暂无可下载 MP3')
        return
      }
      const label = limit === 'all' ? '未缓存音频' : limit === 'current' ? '当前章节 MP3' : `后续 ${limit} 章 MP3`
      await syncBookAudioChapters(bookId, targetChapters, label)
    } catch (error) {
      if (isDeviceDisabledError(error)) {
        setConnectionState('error')
      }
      reportUserError(error, { action: 'syncCurrentBookAudioRange', bookId, limit })
    }
  }

  async function syncBookAudioChapters(bookId: string, chaptersToSync: AudioChapter[], label: string) {
    const blockedReason = cloudActionBlockedReason(gatewaySessionRef.current, '下载 MP3')
    if (blockedReason) {
      setConnectionState('error')
      setMessage(blockedReason)
      return
    }
    audioSyncCancelRequestedRef.current = false
    setAudioSyncBookId(bookId)
    setCachedAudioBookId(bookId)
    setCachedAudioIds(new Set(await listCachedAudioChapterIds(bookId)))
    setAudioSyncProgress({ done: 0, total: chaptersToSync.length })
    try {
      let done = 0
      for (const audioChapter of chaptersToSync) {
        if (audioSyncCancelRequestedRef.current) break
        const cached = readCachedAudio(bookId, audioChapter.chapterId)
        if (!cached) {
          await cacheAudioChapter(bookId, audioChapter)
        }
        done += 1
        setAudioSyncProgress({ done, total: chaptersToSync.length })
        setCachedAudioIds((current) => new Set(current).add(audioChapter.chapterId))
      }
      await refreshCachedAudioIds(bookId)
      await refreshLocalLibrary()
      setMessage(
        audioSyncCancelRequestedRef.current
          ? `${label} 已停止，已缓存 ${done}/${chaptersToSync.length} 章`
          : `${label} 已缓存 ${chaptersToSync.length}/${chaptersToSync.length} 章`,
      )
    } catch (error) {
      if (isDeviceDisabledError(error)) {
        setConnectionState('error')
      }
      reportUserError(error, { action: 'syncBookAudioChapters', bookId, targetCount: chaptersToSync.length, label })
    } finally {
      setAudioSyncProgress(null)
      setAudioSyncBookId(null)
      audioSyncCancelRequestedRef.current = false
    }
  }

  function enqueueAudioChapterDownload(bookId: string, audioChapter: AudioChapter) {
    const blockedReason = cloudActionBlockedReason(gatewaySessionRef.current, '下载 MP3')
    if (blockedReason) {
      setConnectionState('error')
      setMessage(blockedReason)
      return
    }
    if (readCachedAudio(bookId, audioChapter.chapterId)) {
      setCachedAudioIds((current) => new Set(current).add(audioChapter.chapterId))
      setMessage('本章 MP3 已缓存')
      return
    }
    const key = audioDownloadQueueKey(bookId, audioChapter.chapterId)
    if (audioDownloadingChapterKey === key || audioDownloadQueueRef.current.some((item) => item.key === key)) {
      setMessage('本章 MP3 已在下载队列中')
      return
    }
    audioDownloadQueueRef.current = [...audioDownloadQueueRef.current, { key, bookId, audioChapter }]
    setAudioDownloadQueueIds((current) => new Set(current).add(key))
    setMessage(`已加入下载队列：${audioChapter.title ?? audioChapter.chapterId}`)
    void processAudioDownloadQueue()
  }

  async function processAudioDownloadQueue() {
    if (audioDownloadProcessingRef.current) return
    audioDownloadProcessingRef.current = true
    try {
      while (audioDownloadQueueRef.current.length > 0) {
        const item = audioDownloadQueueRef.current.shift()
        if (!item) continue
        setAudioDownloadQueueIds((current) => {
          const next = new Set(current)
          next.delete(item.key)
          return next
        })
        setAudioDownloadingChapterKey(item.key)
        setCachedAudioBookId(item.bookId)
        try {
          if (!readCachedAudio(item.bookId, item.audioChapter.chapterId)) {
            await cacheAudioChapter(item.bookId, item.audioChapter)
          }
          setCachedAudioIds((current) => new Set(current).add(item.audioChapter.chapterId))
          await refreshCachedAudioIds(item.bookId)
          await refreshLocalLibrary()
          setMessage(`已缓存：${item.audioChapter.title ?? item.audioChapter.chapterId}`)
        } catch (error) {
          if (isDeviceDisabledError(error)) {
            setConnectionState('error')
          }
          reportUserError(error, {
            action: 'processAudioDownloadQueue',
            bookId: item.bookId,
            audioChapterId: item.audioChapter.chapterId,
          }, '缓存失败')
        } finally {
          setAudioDownloadingChapterKey(null)
        }
      }
    } finally {
      audioDownloadProcessingRef.current = false
    }
  }

  function stopAudioSync() {
    audioSyncCancelRequestedRef.current = true
    setMessage('正在停止 MP3 同步，当前章节完成后停止')
  }

  function openMp3Manager() {
    setMp3ManagerOpen(true)
    if (!selectedBookId) return
    if (audioCatalogBookId !== selectedBookId && !cloudSyncBlocked) {
      void refreshAudio(selectedBookId, false)
    }
    if (!bookPackage || bookPackage.book?.id !== selectedBookId) {
      void loadBookPackageForMp3Manager(selectedBookId)
    }
  }

  async function loadBookPackageForMp3Manager(bookId: string) {
    try {
      const cachedPackage = await loadCachedBookPackage(bookId)
      if (cachedPackage) {
        const cachedChapters = packageChapters(cachedPackage)
        setBookPackage(cachedPackage)
        setCurrentChapterId((current) => (current && cachedChapters.some((chapter) => chapter.id === current) ? current : cachedChapters[0]?.id ?? null))
        return
      }
      if (cloudSyncBlocked) return
      const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/package`)
      const nextPackage = normalizeBookPackage(response.package)
      const nextChapters = packageChapters(nextPackage)
      setBookPackage(nextPackage)
      setCurrentChapterId(nextChapters[0]?.id ?? null)
      void cacheBookPackage(bookId, nextPackage)
    } catch (error) {
      recordDiagnostic('warn', 'MP3 管理加载章节失败', {
        action: 'loadBookPackageForMp3Manager',
        bookId,
        error: serializeErrorForLog(error),
      })
    }
  }

  async function fetchAuthenticatedSession() {
    const session = normalizeGatewaySession(await gatewayFetch(settings, '/auth/session'))
    if (!session?.authenticated) {
      throw createGatewayError({ error: { code: 'device_unauthorized', statusCode: 403 } })
    }
    return session
  }

  function applyGatewaySession(session: GatewaySession, previousBookCount: number, nextBookCount: number) {
    const notice = roleChangeNotice(gatewaySessionRef.current, session, previousBookCount, nextBookCount)
    gatewaySessionRef.current = session
    setGatewaySession(session)
    return notice
  }

  function refreshCacheSummaries() {
    setCacheVersion((version) => version + 1)
  }

  async function clearBookAudioCache(bookId: string) {
    const key = `${bookId}:audio`
    setClearingCacheKey(key)
    try {
      if (bookId === selectedBookId) clearAudioUrl()
      if (Capacitor.isNativePlatform()) {
        await NativeAudio.clearAudioCache({ bookId })
      }
      const index = loadAudioCacheIndex()
      for (const cacheKey of Object.keys(index)) {
        if (index[cacheKey]?.bookId === bookId) delete index[cacheKey]
      }
      saveAudioCacheIndex(index)
      if (bookId === selectedBookId) {
        setCachedAudioIds(new Set())
        setCachedAudioBookId(bookId)
      }
      refreshCacheSummaries()
      setMessage('音频缓存已清除')
    } catch (error) {
      reportUserError(error, { action: 'clearBookAudioCache', bookId }, '清除音频缓存失败')
    } finally {
      setClearingCacheKey(null)
    }
  }

  async function clearBookPackageCache(bookId: string) {
    const key = `${bookId}:package`
    setClearingCacheKey(key)
    try {
      if (Capacitor.isNativePlatform()) {
        await NativeAudio.clearPackageCache({ bookId })
      }
      removeFullPackageCache(bookId)
      await deleteBookPackageFromIndexedDb(bookId)
      localStorage.removeItem(`${packageCachePrefix}${bookId}`)
      if (bookId === selectedBookId) {
        setFullPackageCache(null)
        setFullPackageStatus('idle')
        setFullPackageProgress(null)
      }
      await refreshLocalLibrary()
      refreshCacheSummaries()
      setMessage('完整数据包缓存已清除')
    } catch (error) {
      reportUserError(error, { action: 'clearBookPackageCache', bookId }, '清除完整包缓存失败')
    } finally {
      setClearingCacheKey(null)
    }
  }

  async function deleteLocalBook(bookId: string) {
    const key = `${bookId}:book`
    setClearingCacheKey(key)
    try {
      if (bookId === selectedBookId) clearAudioUrl()
      if (Capacitor.isNativePlatform()) {
        await NativeAudio.clearAudioCache({ bookId }).catch(() => undefined)
        await NativeAudio.clearPackageCache({ bookId }).catch(() => undefined)
      }
      const audioIndex = loadAudioCacheIndex()
      for (const cacheKey of Object.keys(audioIndex)) {
        if (audioIndex[cacheKey]?.bookId === bookId) delete audioIndex[cacheKey]
      }
      saveAudioCacheIndex(audioIndex)
      removeFullPackageCache(bookId)
      await deleteBookPackageFromIndexedDb(bookId)
      localStorage.removeItem(`${packageCachePrefix}${bookId}`)
      removeReadingProgress(bookId)
      if (bookId === selectedBookId) {
        setSelectedBookId(null)
        setBookPackage(null)
        setCurrentChapterId(null)
        setFullPackageCache(null)
        setFullPackageStatus('idle')
        setFullPackageProgress(null)
        setAudioChapters([])
        setAudioCatalogBookId(null)
        setCachedAudioBookId(null)
        setCachedAudioIds(new Set())
        setAudioSyncProgress(null)
        setAudioSyncBookId(null)
        if (tab === 'reader') setTab('library')
      }
      await refreshLocalLibrary()
      refreshCacheSummaries()
      setMessage('本地书已删除')
    } catch (error) {
      reportUserError(error, { action: 'deleteLocalBook', bookId }, '删除本地书失败')
    } finally {
      setClearingCacheKey(null)
    }
  }

  async function fetchAudioCatalog(bookId: string) {
    const response = await gatewayFetch(settings, `/mobile/books/${encodeURIComponent(bookId)}/audio`)
    return Array.isArray(response.chapters) ? response.chapters.filter(isAudioChapter) : []
  }

  async function fetchAudioManifest(bookId: string, audioChapter: AudioChapter) {
    if (!audioChapter.manifestFileName) return null
    return gatewayFetch(
      settings,
      `/mobile/books/${encodeURIComponent(bookId)}/audio/${encodeURIComponent(audioChapter.chapterId)}/manifest`,
    ).then(normalizeAudioManifest)
  }

  async function readAudioManifestFile(filePath: string) {
    const response = await fetch(Capacitor.convertFileSrc(filePath))
    if (!response.ok) throw new Error(`Cached audio manifest HTTP ${response.status}`)
    const parsed = (await response.json()) as unknown
    return isRecord(parsed) ? normalizeAudioManifest(parsed) : null
  }

  async function loadCachedAudioManifest(cachedAudio: CachedAudio | null) {
    if (!cachedAudio) return null
    if (cachedAudio.manifest) return cachedAudio.manifest
    if (!cachedAudio.manifestFilePath) return null
    try {
      return await readAudioManifestFile(cachedAudio.manifestFilePath)
    } catch (error) {
      recordDiagnostic('warn', '读取本地 MP3 时间轴失败', {
        action: 'loadCachedAudioManifest',
        manifestFilePath: cachedAudio.manifestFilePath,
        error: serializeErrorForLog(error),
      })
      return null
    }
  }

  async function cacheAudioManifestForChapter(bookId: string, audioChapter: AudioChapter) {
    if (!audioChapter.manifestFileName) return { manifest: null, manifestFilePath: undefined }
    if (Capacitor.isNativePlatform()) {
      const downloaded = await downloadAudioManifestToNativeFile(settings, bookId, audioChapter.chapterId)
      return {
        manifest: await readAudioManifestFile(downloaded.filePath),
        manifestFilePath: downloaded.filePath,
      }
    }
    return {
      manifest: await fetchAudioManifest(bookId, audioChapter),
      manifestFilePath: undefined,
    }
  }

  async function ensureCachedAudioManifest(bookId: string, cacheChapterId: string, audioChapter: AudioChapter) {
    const cachedAudio = readCachedAudio(bookId, cacheChapterId)
    const cachedManifest = await loadCachedAudioManifest(cachedAudio)
    if (cachedManifest) return cachedManifest
    const manifestPayload = await cacheAudioManifestForChapter(bookId, audioChapter)
    updateCachedAudioManifest(bookId, cacheChapterId, manifestPayload)
    return manifestPayload.manifest
  }

  async function cacheAudioChapter(bookId: string, audioChapter: AudioChapter): Promise<AudioCachePayload> {
    if (Capacitor.isNativePlatform()) {
      const downloaded = await downloadAudioToNativeFile(settings, bookId, audioChapter.chapterId)
      const manifestPayload = await cacheAudioManifestForChapter(bookId, audioChapter).catch((error) => {
        recordDiagnostic('warn', '缓存 MP3 时间轴失败', {
          action: 'cacheAudioManifestForChapter',
          bookId,
          audioChapterId: audioChapter.chapterId,
          error: serializeErrorForLog(error),
        })
        return { manifest: null, manifestFilePath: undefined }
      })
      const payload: AudioCachePayload = {
        kind: 'file',
        filePath: downloaded.filePath,
        manifest: manifestPayload.manifest,
        manifestFilePath: manifestPayload.manifestFilePath,
        sizeBytes: downloaded.sizeBytes,
      }
      writeCachedAudio(bookId, audioChapter, payload)
      return payload
    }

    const blob = await gatewayFetchBlob(
      settings,
      `/mobile/books/${encodeURIComponent(bookId)}/audio/${encodeURIComponent(audioChapter.chapterId)}/download`,
    )
    const payload: AudioCachePayload = { kind: 'blob', blob }
    return payload
  }

  function clearAudioUrl() {
    chapterAudioRef.current?.pause()
    chapterAudioTimelineRef.current = []
    activeAudioEntryKeyRef.current = null
    audioManifestRef.current = null
    pendingAudioStartTimeRef.current = null
    pendingAudioShouldPlayRef.current = false
    setAudioUrl((currentUrl) => {
      if (currentUrl?.startsWith('blob:')) URL.revokeObjectURL(currentUrl)
      return null
    })
    setAudioManifest(null)
    setAudioTime(0)
    setChapterAudioPlaying(false)
    audioStreamRetryRef.current = null
    if (speechPlaybackRef.current.status !== 'playing') setActiveSpeechSegmentId(null)
  }

  async function handleChapterAudioError(audio: HTMLAudioElement) {
    const retry = audioStreamRetryRef.current
    if (!retry || retry.attempted || retry.bookId !== selectedBookId || retry.currentChapterId !== currentChapter?.id) {
      setChapterAudioPlaying(false)
      reportUserError(new Error('MP3 播放失败'), {
        action: 'chapterAudioError',
        mediaErrorCode: audio.error?.code,
        mediaNetworkState: audio.networkState,
        mediaReadyState: audio.readyState,
        audioSrc: redactUrlForLog(audio.currentSrc || audio.src),
        retryAvailable: Boolean(retry),
      })
      return
    }

    retry.attempted = true
    const resumeTime = Number.isFinite(audio.currentTime) ? audio.currentTime : audioTime
    const manifest = audioManifestRef.current ?? audioManifest
    setAudioPlaybackLoading(true)
    try {
      const playbackUrl = await createAudioStreamUrl(settings, retry.bookId, retry.audioChapterId)
      clearAudioUrl()
      audioStreamRetryRef.current = retry
      buildChapterAudioTimeline(manifest?.timeline ?? [])
      audioManifestRef.current = manifest
      pendingAudioStartTimeRef.current = resumeTime
      pendingAudioShouldPlayRef.current = true
      setAudioManifest(manifest)
      setAudioTime(resumeTime)
      setAudioUrl(playbackUrl)
      setMessage('在线播放链接已刷新')
    } catch (error) {
      audioStreamRetryRef.current = null
      setChapterAudioPlaying(false)
      reportUserError(error, {
        action: 'refreshAudioStreamAfterError',
        bookId: retry.bookId,
        currentChapterId: retry.currentChapterId,
        audioChapterId: retry.audioChapterId,
        mediaErrorCode: audio.error?.code,
      })
    } finally {
      setAudioPlaybackLoading(false)
    }
  }

  async function toggleChapterAudioPlayback() {
    const audio = chapterAudioRef.current
    if (!audio) {
      await playCurrentAudio()
      return
    }

    if (audio.paused) {
      await audio.play().catch((error) => reportUserError(error, { action: 'toggleChapterAudioPlayback' }))
    } else {
      audio.pause()
    }
  }

  function getAudioTimeForSegment(segmentIndex: number): number {
    const timeline = chapterAudioTimelineRef.current
    if (!timeline.length) return 0
    const exact = timeline.find((item) => item.index === segmentIndex)
    if (exact) return exact.startTime
    return timeline.find((item) => item.index > segmentIndex)?.startTime ?? timeline.at(-1)?.startTime ?? 0
  }

  function getAudioTimeForSourcePosition(sourcePosition: number): number | null {
    return getAudioTimeForSourcePositionInManifest(audioManifestRef.current ?? audioManifest, sourcePosition)
  }

  function getAudioTimeForSourcePositionInManifest(manifest: AudioManifest | null, sourcePosition: number): number | null {
    const timeline = manifest?.timeline ?? []
    if (!timeline.length) return null
    const entry = timeline.find(
      (item) =>
        typeof item.sourceStart === 'number' &&
        typeof item.sourceEnd === 'number' &&
        sourcePosition >= item.sourceStart &&
        sourcePosition < item.sourceEnd,
    )
    if (!entry || typeof entry.sourceStart !== 'number' || typeof entry.sourceEnd !== 'number') {
      return getNearestAudioTimeForSourcePosition(manifest, sourcePosition)
    }
    const startTime = entry.startTime ?? 0
    const endTime = entry.endTime ?? entry.nextStartTime ?? startTime
    const ratio = clampAudioRatio((sourcePosition - entry.sourceStart) / Math.max(1, entry.sourceEnd - entry.sourceStart))
    return startTime + ratio * Math.max(0, endTime - startTime)
  }

  function getNearestAudioTimeForSourcePosition(manifest: AudioManifest | null, sourcePosition: number): number | null {
    const timeline = manifest?.timeline ?? []
    let nearest: { time: number; distance: number } | null = null
    for (const entry of timeline) {
      if (typeof entry.sourceStart !== 'number' || typeof entry.sourceEnd !== 'number') continue
      const startTime = entry.startTime ?? 0
      const endTime = entry.endTime ?? entry.nextStartTime ?? startTime
      if (sourcePosition < entry.sourceStart) {
        const distance = entry.sourceStart - sourcePosition
        if (!nearest || distance < nearest.distance) nearest = { time: startTime, distance }
      } else if (sourcePosition >= entry.sourceEnd) {
        const distance = sourcePosition - entry.sourceEnd
        if (!nearest || distance < nearest.distance) nearest = { time: endTime, distance }
      }
    }
    return nearest?.time ?? null
  }

  function clampAudioTime(audio: HTMLAudioElement, time: number) {
    if (!Number.isFinite(time)) return 0
    const upperBound = Number.isFinite(audio.duration) ? Math.max(0, audio.duration - 0.05) : Number.MAX_SAFE_INTEGER
    return Math.min(Math.max(0, time), upperBound)
  }

  function seekChapterAudio(audio: HTMLAudioElement, time: number, shouldPlay: boolean) {
    const nextTime = clampAudioTime(audio, time)
    activeAudioEntryKeyRef.current = null
    audio.currentTime = nextTime
    setAudioTime(nextTime)
    window.setTimeout(() => scrollToAudioHighlight(true), 0)
    if (shouldPlay) {
      void audio.play().catch((error) => reportUserError(error, { action: 'seekChapterAudio', targetTime: nextTime }))
    }
  }

  function resumeAudioAutoFollow() {
    if (speechFollowTimerRef.current != null) window.clearTimeout(speechFollowTimerRef.current)
    speechFollowSuspendedRef.current = false
    setSpeechAutoFollowSuspended(false)
  }

  async function playCurrentAudioFromVisiblePosition() {
    const sourcePosition = findCurrentVisibleSourcePosition()
    resumeAudioAutoFollow()
    if (!audioUrl) {
      await playCurrentAudio({ autoplay: true, sourcePosition })
      return
    }
    const audio = chapterAudioRef.current
    if (!audio) return
    const audioTime =
      sourcePosition == null
        ? getAudioTimeForSegment(findCurrentVisibleSpeechSegmentIndex() ?? 0)
        : getAudioTimeForSourcePosition(sourcePosition) ?? getAudioTimeForSegment(findCurrentVisibleSpeechSegmentIndex() ?? 0)
    seekChapterAudio(audio, audioTime, true)
  }

  function selectChapter(chapterId: string) {
    void stopSpeechReading()
    setCurrentChapterId(chapterId)
    clearAudioUrl()
    lastReaderScrollYRef.current = 0
    window.scrollTo({ top: 0 })
    if (selectedBookId) {
      persistReadingProgress(selectedBookId, chapterId, 0)
    }
  }

  function handleChapterAudioEnded() {
    setChapterAudioPlaying(false)
    if (!nextChapter) {
      setMessage('本书 MP3 已播放完')
      return
    }
    pendingAutoPlayChapterIdRef.current = nextChapter.id
    selectChapter(nextChapter.id)
  }

  function openSearchResult(chapterId: string) {
    selectChapter(chapterId)
    setTab('reader')
    window.scrollTo({ top: 0 })
  }

  function updateSearchInput(value: string) {
    setSearchInput(value)
    setSubmittedSearchQuery('')
    setRagResults([])
    setRagAnswer('')
    setExpandedGraphResultId('')
    setRagStatus('')
    setRagError('')
  }

  function switchSearchMode(nextMode: SearchMode) {
    if (nextMode === searchMode) return
    setSearchMode(nextMode)
    setSubmittedSearchQuery('')
    setRagResults([])
    setRagAnswer('')
    setExpandedGraphResultId('')
    setRagStatus('')
    setRagError('')
  }

  function submitSearch() {
    const query = searchInput.trim()
    if (!bookPackage || !query) return
    setSubmittedSearchQuery(query)
    if (searchMode === 'rag') {
      setRagAnswer('')
      void runRagSearch(query)
    } else {
      setRagResults([])
      setRagAnswer('')
      setRagStatus('')
      setRagError('')
    }
  }

  function openGraphResult(result: GraphResult) {
    if (result.chapterId) {
      openSearchResult(result.chapterId)
      return
    }
    setExpandedGraphResultId((current) => (current === `${result.kind}-${result.id}` ? '' : `${result.kind}-${result.id}`))
  }

  async function runRagSearch(query: string) {
    if (!bookPackage) return
    setRagIsSearching(true)
    setRagError('')
    setRagStatus(ragUseSemantic ? '正在请求 Gateway embedding 语义搜索...' : '正在检索本地正文、概要和 chunk...')
    try {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      if (ragUseSemantic) {
        const semanticResults = await searchGatewayRag(settings, selectedBookId ?? bookPackage.book.id, query)
        setRagResults(semanticResults)
        setRagStatus(`Gateway embedding 检索完成，召回 ${semanticResults.length} 个相关章节。`)
        return
      }
      const results = searchRagPackage(bookPackage, query)
      setRagResults(results)
      setRagStatus(`检索完成，召回 ${results.length} 个相关章节。`)
    } catch (error) {
      const fallbackResults = searchRagPackage(bookPackage, query)
      setRagResults(fallbackResults)
      setRagError('')
      setRagStatus(ragFallbackStatus(error, fallbackResults.length))
    } finally {
      setRagIsSearching(false)
    }
  }

  async function generateRagAnswer() {
    const query = submittedSearchQuery || searchInput.trim()
    if (!bookPackage || !query) return
    setRagIsGeneratingAnswer(true)
    setRagError('')
    setRagStatus('正在调用 Gateway RAG + LLM 生成答案...')
    try {
      const response = await gatewayGenerateRagAnswer(settings, selectedBookId ?? bookPackage.book.id, query)
      if (response.results.length > 0) {
        setRagResults(response.results)
      }
      setRagAnswer(response.answer)
      setRagStatus('答案已生成。')
    } catch (error) {
      setRagError(gatewayUserFacingError(error) || '生成答案失败。')
      setRagStatus('')
    } finally {
      setRagIsGeneratingAnswer(false)
    }
  }

  async function restoreLastReadingFromCache() {
    if (autoRestoreAttemptedRef.current) return
    const progress = loadLatestReadingProgress()
    if (!progress) return

    const cachedPackage = await loadCachedBookPackage(progress.bookId)
    if (!cachedPackage) return

    const cachedChapters = packageChapters(cachedPackage)
    if (!cachedChapters.length) return

    const restoredChapterId = cachedChapters.some((chapter) => chapter.id === progress.chapterId)
      ? progress.chapterId
      : cachedChapters[0].id
    const cachedFullPackage = loadFullPackageCache(progress.bookId)

    autoRestoreAttemptedRef.current = true
    setSelectedBookId(progress.bookId)
    setBookPackage(cachedPackage)
    setCurrentChapterId(restoredChapterId)
    setFullPackageCache(cachedFullPackage)
    setFullPackageStatus(cachedFullPackage?.importStats ? 'imported' : cachedFullPackage ? 'downloaded' : 'idle')
    setFullPackageProgress(null)
    setAudioChapters([])
    setAudioCatalogBookId(null)
    setAudioSyncProgress(null)
    setAudioSyncBookId(null)
    clearAudioUrl()
    await refreshCachedAudioIds(progress.bookId)
    pendingRestoreScrollRef.current = restoredChapterId === progress.chapterId ? progress.scrollY : 0
    lastReaderScrollYRef.current = pendingRestoreScrollRef.current
    setTab('reader')
    restorePendingScroll()
  }

  function switchTab(nextTab: GatewayTab) {
    if (tab === 'reader' && selectedBookId && currentChapterId) {
      const scrollY = Math.max(0, window.scrollY)
      lastReaderScrollYRef.current = scrollY
      persistReadingProgress(selectedBookId, currentChapterId, scrollY)
    }

    if (nextTab === 'reader' && selectedBookId && (!bookPackage || bookPackage.book.id !== selectedBookId)) {
      void openBook(selectedBookId, { restoreProgress: loadReadingProgress(selectedBookId) })
      return
    }

    if (nextTab === 'reader') {
      prepareReaderScrollRestore()
    }

    setTab(nextTab)
    if (nextTab === 'reader') {
      restorePendingScroll()
    }
  }

  function openSettingsTab(nextSettingsTab: SettingsTab) {
    setSettingsTab(nextSettingsTab)
    switchTab('settings')
  }

  function prepareReaderScrollRestore() {
    if (!selectedBookId) return
    const progress = loadReadingProgress(selectedBookId)
    if (!progress || progress.bookId !== selectedBookId) return

    const canRestoreChapter = chapters.some((chapter) => chapter.id === progress.chapterId)
    if (canRestoreChapter) {
      if (progress.chapterId !== currentChapterId) {
        setCurrentChapterId(progress.chapterId)
      }
      pendingRestoreScrollRef.current = progress.scrollY
      lastReaderScrollYRef.current = progress.scrollY
    }
  }

  function restorePendingScroll() {
    const scrollY = pendingRestoreScrollRef.current
    if (scrollY === null) return
    pendingRestoreScrollRef.current = null
    window.setTimeout(() => {
      window.scrollTo({ top: scrollY, behavior: 'auto' })
      lastReaderScrollYRef.current = Math.max(0, scrollY)
    }, 120)
  }

  function updateReaderFontSize(nextFontSize: number) {
    setReaderSettings((current) => ({
      ...current,
      fontSize: Math.min(28, Math.max(15, nextFontSize)),
    }))
  }

  function updateReaderBackground(background: ReaderBackground) {
    setReaderSettings((current) => ({
      ...current,
      background,
    }))
  }

  function scrollReaderPage(direction: 'up' | 'down') {
    const distance = Math.max(320, window.innerHeight * 0.72)
    window.scrollBy({
      top: direction === 'down' ? distance : -distance,
      behavior: 'smooth',
    })
  }

  async function refreshTtsAvailability() {
    if (!Capacitor.isNativePlatform()) {
      setTtsVoices([])
      setTtsStatusMessage('语音阅读需要在 Android App 中使用。')
      return false
    }

    setTtsStatusMessage('正在检测系统语音引擎...')
    try {
      const availability = await withTimeout(
        NovelReaderTts.getAvailability({ locale: ttsSettings.locale }),
        10000,
        '系统 TTS 检测超时，请在系统设置中选择默认文字转语音引擎。',
      )
      setTtsVoices(availability.voices)
      if (!availability.available || !availability.languageAvailable) {
        setTtsStatusMessage(availability.error || '当前系统 TTS 不可用，请检查系统语音设置。')
        return false
      }
      setTtsStatusMessage(
        availability.voices.length
          ? `系统 TTS 可用，发现 ${availability.voices.length} 个 ${ttsSettings.locale} 音色。`
          : '系统 TTS 可用，将使用默认音色。',
      )
      return true
    } catch (error) {
      setTtsVoices([])
      const message = reportUserError(error, { action: 'refreshTtsAvailability', locale: ttsSettings.locale }, '系统 TTS 检测失败')
      setTtsStatusMessage(message)
      return false
    }
  }

  async function openSystemTtsSettings() {
    if (!Capacitor.isNativePlatform()) {
      setTtsStatusMessage('系统语音设置只能在 Android App 中打开。')
      return
    }
    try {
      await NovelReaderTts.openTtsSettings()
      setTtsStatusMessage('请在系统页面选择文字转语音引擎，然后返回本应用重新检测。')
    } catch (error) {
      const message = reportUserError(error, { action: 'openSystemTtsSettings' }, '无法打开系统语音设置')
      setTtsStatusMessage(message)
    }
  }

  async function openSystemTtsDataCheck() {
    if (!Capacitor.isNativePlatform()) {
      setTtsStatusMessage('系统语音检查只能在 Android App 中打开。')
      return
    }
    try {
      await NovelReaderTts.checkTtsData()
      setTtsStatusMessage('请按系统提示安装或启用语音数据，然后返回本应用重新检测。')
    } catch (error) {
      const message = reportUserError(error, { action: 'openSystemTtsDataCheck' }, '无法打开系统语音检查')
      setTtsStatusMessage(message)
    }
  }

  function scrollToSpeechSegment(segmentId: string, force = false) {
    if (!force && (!speechAutoFollowRef.current || speechFollowSuspendedRef.current)) return
    const target = document.querySelector(`[data-speech-segment-id="${CSS.escape(segmentId)}"]`)
    if (!target) return

    isSpeechAutoScrollingRef.current = true
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => {
      isSpeechAutoScrollingRef.current = false
    }, 800)
  }

  function scrollToAudioHighlight(force = false) {
    if (!force && (!speechAutoFollowRef.current || speechFollowSuspendedRef.current)) return
    const target = document.querySelector('[data-audio-highlight-anchor="true"]')
    if (!target) return

    isSpeechAutoScrollingRef.current = true
    scrollElementStartToViewportCenter(target, 'smooth', window, getReadableViewportBounds())
    window.setTimeout(() => {
      isSpeechAutoScrollingRef.current = false
    }, 800)
  }

  function getReadableViewportBounds() {
    const viewportHeight = window.visualViewport?.height || window.innerHeight || document.documentElement.clientHeight || 0
    const bottomNavBounds = document.querySelector('.bottom-nav')?.getBoundingClientRect()
    const visibleBottom =
      bottomNavBounds && bottomNavBounds.top > 0 && bottomNavBounds.top < viewportHeight
        ? bottomNavBounds.top
        : viewportHeight
    return { top: 0, bottom: visibleBottom }
  }

  function clampAudioRatio(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.min(1, Math.max(0, value))
  }

  function mapSpeechSegmentToAudioTimeline(
    segment: SpeechSegment,
    index: number,
    audioTimeline: AudioTimelineEntry[],
  ): ChapterAudioTimelineItem | null {
    let startTime = Number.POSITIVE_INFINITY
    let endTime = Number.NEGATIVE_INFINITY
    let nextStartTime = Number.NEGATIVE_INFINITY

    for (const entry of audioTimeline) {
      if (typeof entry.sourceStart !== 'number' || typeof entry.sourceEnd !== 'number') continue
      const overlapStart = Math.max(segment.startChar, entry.sourceStart)
      const overlapEnd = Math.min(segment.endChar, entry.sourceEnd)
      if (overlapEnd <= overlapStart) continue

      const sourceLength = Math.max(1, entry.sourceEnd - entry.sourceStart)
      const speechDuration = Math.max(0, (entry.endTime ?? entry.startTime ?? 0) - (entry.startTime ?? 0))
      const mappedStart = (entry.startTime ?? 0) + clampAudioRatio((overlapStart - entry.sourceStart) / sourceLength) * speechDuration
      const mappedEnd = (entry.startTime ?? 0) + clampAudioRatio((overlapEnd - entry.sourceStart) / sourceLength) * speechDuration
      startTime = Math.min(startTime, mappedStart)
      endTime = Math.max(endTime, mappedEnd)
      nextStartTime = Math.max(nextStartTime, entry.nextStartTime ?? entry.endTime ?? mappedEnd)
    }

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null
    return {
      index,
      startTime,
      endTime,
      nextStartTime: Number.isFinite(nextStartTime) ? Math.max(nextStartTime, endTime) : endTime,
    }
  }

  function buildChapterAudioTimeline(audioTimeline: AudioTimelineEntry[]) {
    const segments = speechSegmentsRef.current
    const mappedTimeline = segments
      .map((segment, index) => mapSpeechSegmentToAudioTimeline(segment, index, audioTimeline))
      .filter((item): item is ChapterAudioTimelineItem => Boolean(item))
      .sort((left, right) => left.startTime - right.startTime)
    chapterAudioTimelineRef.current = mappedTimeline.map((item, index) => {
      const nextItem = mappedTimeline[index + 1]
      return {
        ...item,
        nextStartTime: nextItem ? Math.max(item.endTime, nextItem.startTime) : item.nextStartTime,
      }
    })
  }

  function findAudioSegmentIndex(currentTime: number): number | null {
    const activeEntry = findActiveTimelineEntry(audioManifest, currentTime)
    const sourceIndex = findAudioSegmentIndexBySourcePosition(activeEntry, currentTime)
    if (sourceIndex != null) return sourceIndex

    const timeline = chapterAudioTimelineRef.current
    if (!timeline.length) return null
    const active = timeline.find((item) => currentTime >= item.startTime && currentTime < item.nextStartTime)
    if (active) return active.index
    return timeline.find((item) => currentTime < item.startTime)?.index ?? timeline.at(-1)?.index ?? null
  }

  function findAudioSegmentIndexBySourcePosition(activeEntry: AudioTimelineEntry | null, currentTime: number): number | null {
    if (!activeEntry || typeof activeEntry.sourceStart !== 'number' || typeof activeEntry.sourceEnd !== 'number') return null
    const segments = speechSegmentsRef.current
    if (!segments.length) return null

    const entryStartTime = activeEntry.startTime ?? 0
    const entryEndTime = activeEntry.endTime ?? activeEntry.nextStartTime ?? entryStartTime
    const duration = Math.max(0.001, entryEndTime - entryStartTime)
    const ratio = clampAudioRatio((currentTime - entryStartTime) / duration)
    const sourcePosition = activeEntry.sourceStart + ratio * Math.max(1, activeEntry.sourceEnd - activeEntry.sourceStart)

    const containingIndex = segments.findIndex((segment) => sourcePosition >= segment.startChar && sourcePosition < segment.endChar)
    if (containingIndex >= 0) return containingIndex

    let nearestIndex: number | null = null
    let nearestDistance = Number.POSITIVE_INFINITY
    segments.forEach((segment, index) => {
      const distance =
        sourcePosition < segment.startChar
          ? segment.startChar - sourcePosition
          : sourcePosition > segment.endChar
            ? sourcePosition - segment.endChar
            : 0
      if (distance < nearestDistance) {
        nearestIndex = index
        nearestDistance = distance
      }
    })
    return nearestIndex
  }

  function audioEntryKey(entry: AudioTimelineEntry) {
    return entry.id ?? `${entry.startTime ?? 0}:${entry.endTime ?? 0}:${entry.sourceStart ?? ''}:${entry.sourceEnd ?? ''}`
  }

  function handleChapterAudioTimeUpdate(audio: HTMLAudioElement) {
    const currentTime = audio.currentTime
    setAudioTime(currentTime)
    const activeEntry = findActiveTimelineEntry(audioManifest, currentTime)
    if (activeEntry) {
      const activeEntryKey = audioEntryKey(activeEntry)
      if (activeAudioEntryKeyRef.current !== activeEntryKey) {
        activeAudioEntryKeyRef.current = activeEntryKey
      }
      const currentIndex = findAudioSegmentIndexBySourcePosition(activeEntry, currentTime)
      if (currentIndex != null) {
        const segment = speechSegmentsRef.current[currentIndex]
        if (segment) setSpeechPlayback({ status: 'playing', segmentIndex: currentIndex, segmentId: segment.id })
      }
      if (activeSpeechSegmentId) setActiveSpeechSegmentId(null)
      return
    }
    const currentIndex = findAudioSegmentIndex(currentTime)
    if (currentIndex == null) return
    const segment = speechSegmentsRef.current[currentIndex]
    if (!segment || activeSpeechSegmentId === segment.id) return
    setActiveSpeechSegmentId(segment.id)
    setSpeechPlayback({ status: 'playing', segmentIndex: currentIndex, segmentId: segment.id })
    scrollToSpeechSegment(segment.id)
  }

  function findCurrentVisibleSpeechSegmentIndex(): number | null {
    const segments = speechSegmentsRef.current
    if (!segments.length) return null

    const viewportBottom = window.innerHeight || document.documentElement.clientHeight
    const viewportCenter = viewportBottom * 0.45
    let nearestVisible: { index: number; distance: number } | null = null

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      const target = document.querySelector(`[data-speech-segment-id="${CSS.escape(segment.id)}"]`)
      if (!(target instanceof HTMLElement)) continue

      const bounds = target.getBoundingClientRect()
      if (bounds.bottom < 0 || bounds.top > viewportBottom) continue
      if (bounds.top <= viewportCenter && bounds.bottom >= viewportCenter) return index

      const segmentCenter = (bounds.top + bounds.bottom) / 2
      const distance = Math.abs(segmentCenter - viewportCenter)
      if (!nearestVisible || distance < nearestVisible.distance) nearestVisible = { index, distance }
    }

    return nearestVisible?.index ?? null
  }

  function findCurrentVisibleSourcePosition(): number | null {
    const viewportBottom = window.innerHeight || document.documentElement.clientHeight
    const viewportCenter = viewportBottom * 0.45
    const targets = Array.from(document.querySelectorAll('[data-source-start][data-source-end]'))
    let nearest: { position: number; distance: number } | null = null

    for (const target of targets) {
      if (!(target instanceof HTMLElement)) continue
      const sourceStart = Number(target.dataset.sourceStart)
      const sourceEnd = Number(target.dataset.sourceEnd)
      if (!Number.isFinite(sourceStart) || !Number.isFinite(sourceEnd)) continue

      const bounds = target.getBoundingClientRect()
      if (bounds.bottom < 0 || bounds.top > viewportBottom) continue
      if (bounds.top <= viewportCenter && bounds.bottom >= viewportCenter) return Math.floor((sourceStart + sourceEnd) / 2)

      const segmentCenter = (bounds.top + bounds.bottom) / 2
      const distance = Math.abs(segmentCenter - viewportCenter)
      if (!nearest || distance < nearest.distance) nearest = { position: Math.floor((sourceStart + sourceEnd) / 2), distance }
    }

    return nearest?.position ?? null
  }

  async function playSpeechSegment(segmentIndex: number) {
    const segment = speechSegmentsRef.current[segmentIndex]
    if (!segment) {
      currentUtteranceIdRef.current = null
      speechUtteranceIndexRef.current.clear()
      setActiveSpeechSegmentId(null)
      setSpeechPlayback({ status: 'idle' })
      return
    }

    speechQueueIdRef.current += 1
    const queueId = speechQueueIdRef.current
    const utterances = speechSegmentsRef.current.slice(segmentIndex).map((entry, offset) => {
      const utteranceId = `speech-${queueId}-${segmentIndex + offset}`
      return { text: entry.text, utteranceId }
    })
    speechUtteranceIndexRef.current = new Map(
      utterances.map((utterance, offset) => [utterance.utteranceId, segmentIndex + offset]),
    )
    currentUtteranceIdRef.current = utterances.at(-1)?.utteranceId ?? null
    setActiveSpeechSegmentId(segment.id)
    setSpeechPlayback({ status: 'playing', segmentIndex, segmentId: segment.id })
    scrollToSpeechSegment(segment.id)

    try {
      if (typeof NovelReaderTts.speakPrefetchedQueue === 'function') {
        await NovelReaderTts.speakPrefetchedQueue({
          locale: ttsSettings.locale,
          pitch: ttsSettings.pitch,
          prefetchWindow: TTS_PREFETCH_WINDOW,
          rate: ttsSettings.rate,
          utterances,
          voiceId: ttsSettings.voiceId || undefined,
        })
        return
      }

      await NovelReaderTts.speakQueue({
        locale: ttsSettings.locale,
        pitch: ttsSettings.pitch,
        rate: ttsSettings.rate,
        utterances,
        voiceId: ttsSettings.voiceId || undefined,
      })
    } catch (error) {
      currentUtteranceIdRef.current = null
      speechUtteranceIndexRef.current.clear()
      const message = reportUserError(error, { action: 'playSpeechSegment', segmentIndex }, '语音朗读失败')
      setSpeechPlayback({ status: 'error', message })
      setTtsStatusMessage(message)
    }
  }

  async function startSpeechReading(startIndexOverride: number | null = null) {
    if (!speechChapter?.segments.length) return
    clearAudioUrl()
    setSpeechPlayback({ status: 'checking' })
    setTtsStatusMessage('')
    try {
      const available = await refreshTtsAvailability()
      if (!available) {
        setSpeechPlayback({ status: 'error', message: '系统 TTS 不可用。' })
        return
      }
      await playSpeechSegment(startIndexOverride ?? findCurrentVisibleSpeechSegmentIndex() ?? 0)
    } catch (error) {
      const message = reportUserError(error, { action: 'startSpeechReading' }, '语音阅读启动失败')
      setSpeechPlayback({ status: 'error', message })
      setTtsStatusMessage(message)
    }
  }

  async function pauseSpeechReading() {
    const current = speechPlaybackRef.current
    if (current.status !== 'playing') return
    currentUtteranceIdRef.current = null
    speechUtteranceIndexRef.current.clear()
    await NovelReaderTts.stop().catch(() => undefined)
    setSpeechPlayback({ status: 'paused', segmentIndex: current.segmentIndex, segmentId: current.segmentId })
  }

  async function resumeSpeechReading() {
    const current = speechPlaybackRef.current
    if (current.status !== 'paused') return
    await playSpeechSegment(current.segmentIndex)
  }

  async function startSpeechReadingFromCurrentPosition() {
    await startSpeechReading(findCurrentVisibleSpeechSegmentIndex() ?? 0)
  }

  async function stopSpeechReading() {
    currentUtteranceIdRef.current = null
    speechUtteranceIndexRef.current.clear()
    await NovelReaderTts.stop().catch(() => undefined)
    setActiveSpeechSegmentId(null)
    setSpeechPlayback({ status: 'idle' })
  }

  function followSpeechSegment() {
    if (audioUrl && activeTimelineEntry) {
      resumeAudioAutoFollow()
      scrollToAudioHighlight(true)
      return
    }
    const current = speechPlaybackRef.current
    if (current.status !== 'playing' && current.status !== 'paused') return
    resumeAudioAutoFollow()
    scrollToSpeechSegment(current.segmentId, true)
  }

  function updateTtsSettings(nextSettings: TtsSettings) {
    const normalized = normalizeTtsSettings(nextSettings)
    setTtsSettings(normalized)
    if (chapterAudioRef.current) {
      chapterAudioRef.current.defaultPlaybackRate = normalized.rate
      chapterAudioRef.current.playbackRate = normalized.rate
    }
    if (speechPlaybackRef.current.status === 'playing') {
      void NovelReaderTts.setRate({ rate: normalized.rate }).catch(() => undefined)
      void NovelReaderTts.setPitch({ pitch: normalized.pitch }).catch(() => undefined)
    }
  }

  function getSpeechPlaybackLabel() {
    if (ttsSettings.engine === 'cloud-mp3') {
      if (chapterAudioPlaying) return `正在播放 MP3 · ${formatDuration(audioTime * 1000)}`
      if (audioUrl) return `MP3 已加载 · ${formatDuration(audioTime * 1000)}`
      return currentAudio ? '本章可播放章节 MP3' : '当前章节暂无 MP3'
    }
    if (speechPlayback.status === 'playing') return `正在朗读 ${speechPlayback.segmentIndex + 1}/${speechChapter?.segments.length ?? 0}`
    if (speechPlayback.status === 'paused') return `已暂停在 ${speechPlayback.segmentIndex + 1}/${speechChapter?.segments.length ?? 0}`
    if (speechPlayback.status === 'checking') return '正在检测系统语音'
    if (speechPlayback.status === 'error') return speechPlayback.message
    return `本章 ${speechChapter?.segments.length ?? 0} 个朗读片段`
  }

  function renderSpeechActions() {
    if (ttsSettings.engine === 'cloud-mp3') {
      return (
        <div className="speech-actions">
          <button type="button" onClick={() => void (audioUrl ? toggleChapterAudioPlayback() : playCurrentAudio())} disabled={isAudioPlaybackDisabled(currentAudio, audioPlaybackLoading)}>
            {audioUrl ? (chapterAudioPlaying ? '暂停' : '继续播放') : audioButtonLabel(currentAudio, audioPlaybackLoading)}
          </button>
          <button type="button" onClick={() => void playCurrentAudioFromVisiblePosition()} disabled={isAudioPlaybackDisabled(currentAudio, audioPlaybackLoading)}>
            从当前位置播放
          </button>
        </div>
      )
    }

    return (
      <div className="speech-actions">
        {(speechPlayback.status === 'idle' || speechPlayback.status === 'error') && (
          <>
            <button type="button" onClick={() => void startSpeechReading()} disabled={!speechChapter?.segments.length}>开始播放</button>
            <button type="button" onClick={() => void startSpeechReadingFromCurrentPosition()} disabled={!speechChapter?.segments.length}>从当前位置播放</button>
          </>
        )}
        {speechPlayback.status === 'checking' && <button type="button" disabled>检测中</button>}
        {speechPlayback.status === 'playing' && (
          <>
            <button type="button" onClick={() => void pauseSpeechReading()}>暂停</button>
            <button type="button" onClick={() => void stopSpeechReading()}>停止</button>
          </>
        )}
        {speechPlayback.status === 'paused' && (
          <>
            <button type="button" onClick={() => void resumeSpeechReading()}>继续</button>
            <button type="button" onClick={() => void startSpeechReadingFromCurrentPosition()}>从当前位置播放</button>
            <button type="button" onClick={() => void stopSpeechReading()}>停止</button>
          </>
        )}
        {speechAutoFollowSuspended && <button type="button" onClick={followSpeechSegment}>跟随朗读</button>}
      </div>
    )
  }

  function renderSpeechRateField() {
    const selectedIndex = Math.max(0, TTS_RATE_PRESETS.findIndex((rate) => Math.abs(ttsSettings.rate - rate) < 0.001))
    const safeIndex = selectedIndex >= 0 ? selectedIndex : closestRatePresetIndex(ttsSettings.rate)
    return (
      <label className="tts-rate-field">
        <span>语速 · {ttsSettings.rate.toFixed(ttsSettings.rate % 1 === 0 ? 0 : 2)}x</span>
        <div className="rate-slider-field">
          <input
            aria-label="语音朗读倍速"
            max={TTS_RATE_PRESETS.length - 1}
            min={0}
            step={1}
            type="range"
            value={safeIndex}
            onChange={(event) => updateTtsSettings({ ...ttsSettings, rate: TTS_RATE_PRESETS[Number(event.target.value)] })}
          />
          <div className="rate-slider-dots" aria-hidden="true">
            {TTS_RATE_PRESETS.map((rate, index) => (
              <span className={index === safeIndex ? 'active' : ''} key={rate} />
            ))}
          </div>
          <div className="rate-slider-labels">
            {TTS_RATE_PRESETS.map((rate, index) => (
              <button
                aria-label={`${rate}x`}
                className={index === safeIndex ? 'active' : ''}
                key={rate}
                type="button"
                onClick={() => updateTtsSettings({ ...ttsSettings, rate })}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>
      </label>
    )
  }

  function renderPlaybackEngineField() {
    return (
      <div className="segmented-control" aria-label="播放引擎">
        <button
          className={ttsSettings.engine === 'local-tts' ? 'active' : ''}
          type="button"
          onClick={() => {
            playbackEngineTouchedRef.current = true
            updateTtsSettings({ ...ttsSettings, engine: 'local-tts' })
          }}
        >
          本地 TTS
        </button>
        <button
          className={ttsSettings.engine === 'cloud-mp3' ? 'active' : ''}
          type="button"
          onClick={() => {
            playbackEngineTouchedRef.current = true
            updateTtsSettings({ ...ttsSettings, engine: 'cloud-mp3' })
          }}
        >
          章节 MP3
        </button>
      </div>
    )
  }

  function handleReaderTap(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.closest('button, input, select, textarea, a, label, audio')) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const xRatio = (event.clientX - bounds.left) / bounds.width

    if (xRatio >= 0.25 && xRatio <= 0.75) {
      const now = event.timeStamp
      if (now - lastReaderCenterTapAtRef.current < 360) {
        lastReaderCenterTapAtRef.current = 0
        setChapterPickerOpen(true)
        return
      }
      lastReaderCenterTapAtRef.current = now
      return
    }

    lastReaderCenterTapAtRef.current = 0
    scrollReaderPage(xRatio < 0.25 ? 'up' : 'down')
  }

  return (
    <main className="app-shell">
      {tab !== 'reader' ? (
        <header className="top-bar">
          <div>
            <h1>{tab === 'library' ? '书库' : tab === 'search' ? '搜索' : '设置'}</h1>
            <p>{tab === 'library' ? `${displayLocalBooks.length} 本地书` : tab === 'search' ? (selectedBook?.title ?? '未选择书籍') : connectionLabel(connectionState)}</p>
          </div>
          <button className="icon-button" type="button" onClick={() => void (tab === 'library' ? refreshLocalLibrary() : refreshBooks())} disabled={tab !== 'library' && loadingBooks}>
            刷新
          </button>
        </header>
      ) : null}

      {visibleStatusMessage && tab !== 'reader' ? <div className={`status-line status-${connectionState}`}>{visibleStatusMessage}</div> : null}
      {latestIssue ? (
        <section className={`issue-banner issue-${latestIssue.level}`} role="alert">
          <div>
            <strong>{latestIssue.level === 'error' ? '最近错误' : '诊断提醒'}</strong>
            <span>{formatDateTime(latestIssue.timestamp)}</span>
            <p>{latestIssue.message}</p>
          </div>
          <div className="issue-actions">
            <button type="button" onClick={() => void submitLocalLogs()} disabled={logSubmitState.status === 'submitting'}>
              {logSubmitState.status === 'submitting' ? '提交中' : '提交日志'}
            </button>
            <button type="button" onClick={() => setLatestIssue(null)}>忽略</button>
          </div>
        </section>
      ) : null}

      {tab === 'library' ? (
        <section className="library-page">
          <div className="book-list">
            <div className="section-title">
              <h2>书库</h2>
              <span>{`${displayLocalBooks.length} 本`}</span>
            </div>
            <div className={`visibility-notice role-${gatewaySession?.auth.role ?? 'unknown'}`}>{visibilityNotice}</div>
            {displayLocalBooks.length === 0 ? (
              <div className="empty-state">
                <p>还没有本地书</p>
                <button type="button" onClick={() => switchTab('settings')}>去云端书库下载</button>
              </div>
            ) : (
              <div className="book-items">
                {displayLocalBooks.map((book) => {
                  const audioCount = book.id === selectedBookId ? displayCachedAudioChapterCount : bookCachedAudioCount(book)
                  return (
                    <button
                      className={book.id === selectedBookId ? 'book-row active' : 'book-row'}
                      type="button"
                      key={book.id}
                      onClick={() => selectBook(book.id)}
                    >
                      <span className="book-title">{book.title}</span>
                      <span className="book-meta">{formatBookMeta(book, audioCount)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="book-detail">
            <div className="section-title">
              <h2>{selectedLocalBook?.title ?? '阅读'}</h2>
              <span>{loadingPackage ? '加载中' : selectedLocalBook ? `${selectedLocalBook.chapterCount} 章` : ''}</span>
            </div>
            {selectedLocalBook ? (
              <div className="detail-body">
                <dl>
                  <div>
                    <dt>作者</dt>
                    <dd>{selectedLocalBook.author || '未标注'}</dd>
                  </div>
                  <div>
                    <dt>字数</dt>
                    <dd>{selectedLocalBook.wordCount ? selectedLocalBook.wordCount.toLocaleString('zh-CN') : '未统计'}</dd>
                  </div>
                  <div>
                    <dt>本机音频</dt>
                    <dd>{displayCachedAudioChapterCount} 章</dd>
                  </div>
                  <div>
                    <dt>更新</dt>
                    <dd>{formatDate(selectedLocalBook.updatedAt)}</dd>
                  </div>
                </dl>
                <div className="coverage-row">
                  <Coverage label="概要" value={displaySummaryCoverage} />
                  <Coverage label="图谱" value={displayKgCoverage} />
                  <StatusCoverage label="RAG" value={displayRagAvailability} />
                </div>
                <div className="package-line">
                  <span>Package</span>
                  <strong>{displayPackageLabel}</strong>
                </div>
                <div className="package-line">
                  <span>完整数据包</span>
                  <strong>{fullPackageLabel(visibleFullPackageCache, fullPackageStatus)}</strong>
                </div>
                {visibleFullPackageProgress ? (
                  <div className="package-line">
                    <span>{visibleFullPackageProgress.phase === 'download' ? '下载进度' : '导入进度'}</span>
                    <strong>{fullPackageProgressLabel(visibleFullPackageProgress)}</strong>
                  </div>
                ) : null}
                <button
                  className="secondary-button full-width-button"
                  type="button"
                  onClick={() => void syncCurrentFullPackage()}
                  disabled={!selectedBookId || Boolean(syncBlockedReason) || fullPackageStatus === 'downloading' || fullPackageStatus === 'importing'}
                >
                  {fullPackageStatus === 'downloading'
                    ? '下载数据包中'
                    : fullPackageStatus === 'importing'
                      ? '导入数据包中'
                      : visibleFullPackageCache
                        ? '重新下载完整包'
                        : '下载完整数据包'}
                </button>
                <div className="package-line">
                  <span>本机音频</span>
                  <strong>
                    {visibleAudioSyncProgress
                      ? `${visibleAudioSyncProgress.done}/${visibleAudioSyncProgress.total}`
                      : loadingAudio
                        ? '同步中'
                        : `${displayCachedAudioChapterCount}/${displayCloudAudioChapterCount} 已缓存`}
                  </strong>
                </div>
                <button
                  className="secondary-button full-width-button"
                  type="button"
                  onClick={openMp3Manager}
                  disabled={!selectedBookId || loadingAudio}
                >
                  {visibleAudioSyncProgress ? `同步音频 ${visibleAudioSyncProgress.done}/${visibleAudioSyncProgress.total}` : 'MP3 管理'}
                </button>
                {visibleAudioSyncProgress ? (
                  <button className="secondary-button danger-button full-width-button" type="button" onClick={stopAudioSync}>
                    停止 MP3 同步
                  </button>
                ) : null}
                <button className="primary-button full-width-button" type="button" onClick={() => void openBook(selectedLocalBook.id)} disabled={loadingPackage}>
                  开始阅读
                </button>
                <button
                  className="secondary-button danger-button full-width-button"
                  type="button"
                  disabled={!selectedBookId || clearingCacheKey === `${selectedBookId}:book`}
                  onClick={() => {
                    if (!selectedBookId) return
                    if (window.confirm(`删除本地书《${selectedLocalBook.title}》？完整数据包和本机 MP3 都会从本机移除。`)) {
                      void deleteLocalBook(selectedBookId)
                    }
                  }}
                >
                  {clearingCacheKey === `${selectedBookId}:book` ? '删除中' : '删除本地书'}
                </button>
              </div>
            ) : (
              <div className="empty-state">
                <p>选择一本本地书</p>
                <button type="button" onClick={() => switchTab('settings')}>去云端书库下载</button>
              </div>
            )}
          </div>
        </section>
      ) : tab === 'reader' ? (
        <section className="reader-page">
          {!bookPackage || !currentChapter ? (
            <div className="empty-state reader-empty">
              <p>请选择一本书。</p>
              <button type="button" onClick={() => switchTab('library')}>回到书库</button>
            </div>
          ) : (
            <>
              <div className="chapter-toolbar">
                <select value={currentChapter.id} onChange={(event) => selectChapter(event.target.value)}>
                  {chapters.map((chapter, index) => (
                    <option key={chapter.id} value={chapter.id}>
                      {index + 1}. {chapter.title}
                    </option>
                  ))}
                </select>
                <button type="button" onClick={() => setChapterPickerOpen(true)}>菜单</button>
              </div>
              <div className="chapter-nav-row">
                <button type="button" onClick={() => selectChapter(previousChapter?.id ?? currentChapter.id)} disabled={!previousChapter}>
                  上一章
                </button>
                <button type="button" onClick={() => selectChapter(nextChapter?.id ?? currentChapter.id)} disabled={!nextChapter}>
                  下一章
                </button>
              </div>
              {message ? <div className={`status-line reader-status status-${connectionState}`}>{message}</div> : null}
              <article
                className={`reader-card ${readerSettings.background}`}
                ref={readerCardRef}
                onClick={handleReaderTap}
                style={{ '--reader-font-size': `${readerSettings.fontSize}px` } as CSSProperties}
              >
                <h2>{currentChapter.title}</h2>
                <ChapterSummary bookPackage={bookPackage} chapter={currentChapter} onJumpToSource={jumpToSummarySource} />
                <div className="chapter-text">
                  {speechChapter ? (
                    <SpeechTextContent
                      speechChapter={speechChapter}
                      activeSegmentId={activeSpeechSegmentId}
                      activeEntry={activeTimelineEntry}
                      summaryHighlightRange={summaryHighlightRange}
                    />
                  ) : (
                    <TextContent
                      text={chapterContent(currentChapter)}
                      activeEntry={activeTimelineEntry}
                      summaryHighlightRange={summaryHighlightRange}
                    />
                  )}
                </div>
              </article>
              <div className="chapter-nav-row bottom">
                <button type="button" onClick={() => selectChapter(previousChapter?.id ?? currentChapter.id)} disabled={!previousChapter}>
                  上一章
                </button>
                <button type="button" onClick={() => selectChapter(nextChapter?.id ?? currentChapter.id)} disabled={!nextChapter}>
                  下一章
                </button>
              </div>
              {chapterPickerOpen ? (
                <div className="reader-menu-overlay" role="presentation" onClick={() => setChapterPickerOpen(false)}>
                  <section className="reader-menu-sheet" role="dialog" aria-modal="true" aria-label="阅读控制" onClick={(event) => event.stopPropagation()}>
                    <div className="reader-menu-header">
                      <div>
                        <strong>{currentChapter.title}</strong>
                        <span>{currentChapterPosition + 1}/{chapters.length}</span>
                      </div>
                      <button className="reader-menu-close" type="button" aria-label="关闭" onClick={() => setChapterPickerOpen(false)}>×</button>
                    </div>
                    <label className="chapter-select-field reader-menu-group">
                      <span>章节</span>
                      <select value={currentChapter.id} onChange={(event) => selectChapter(event.target.value)}>
                        {chapters.map((chapter, index) => (
                          <option key={chapter.id} value={chapter.id}>
                            {index + 1}. {chapter.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="chapter-nav-row reader-menu-nav">
                      <button type="button" onClick={() => selectChapter(previousChapter?.id ?? currentChapter.id)} disabled={!previousChapter}>
                        上一章
                      </button>
                      <button type="button" onClick={() => selectChapter(nextChapter?.id ?? currentChapter.id)} disabled={!nextChapter}>
                        下一章
                      </button>
                    </div>
                    <div className="speech-control-panel reader-menu-group">
                      <div>
                        <strong>{ttsSettings.engine === 'cloud-mp3' ? '章节 MP3' : '语音阅读'}</strong>
                        <span>{getSpeechPlaybackLabel()}</span>
                      </div>
                      {renderPlaybackEngineField()}
                      {renderSpeechActions()}
                      {renderSpeechRateField()}
                      {ttsSettings.engine === 'local-tts' ? (
                        <>
                          <label className="tts-toggle-row">
                            <input
                              type="checkbox"
                              checked={ttsSettings.autoFollow}
                              onChange={(event) => updateTtsSettings({ ...ttsSettings, autoFollow: event.target.checked })}
                            />
                            <span>朗读时跟随正文</span>
                          </label>
                          <label className="tts-select-field">
                            <span>音调</span>
                            <input
                              max={MAX_TTS_PITCH}
                              min={MIN_TTS_PITCH}
                              step={0.05}
                              type="number"
                              value={ttsSettings.pitch}
                              onChange={(event) => updateTtsSettings({ ...ttsSettings, pitch: Number(event.target.value) })}
                            />
                          </label>
                          <label className="tts-select-field">
                            <span>语言</span>
                            <input
                              value={ttsSettings.locale}
                              onChange={(event) => updateTtsSettings({ ...ttsSettings, locale: event.target.value })}
                            />
                          </label>
                          {ttsVoices.length > 0 ? (
                        <label className="tts-select-field">
                          <span>音色</span>
                          <select
                            value={ttsSettings.voiceId}
                            onChange={(event) => updateTtsSettings({ ...ttsSettings, voiceId: event.target.value })}
                          >
                            <option value="">系统默认</option>
                            {ttsVoices.map((voice) => (
                              <option key={voice.id} value={voice.id}>
                                {voice.name || voice.id}
                              </option>
                            ))}
                          </select>
                        </label>
                          ) : null}
                          <div className="tts-secondary-actions">
                            <button type="button" onClick={() => void refreshTtsAvailability()}>检测语音</button>
                            <button type="button" onClick={() => void openSystemTtsSettings()}>系统语音设置</button>
                            <button type="button" onClick={() => void openSystemTtsDataCheck()}>安装语音包</button>
                          </div>
                        </>
                      ) : null}
                      {ttsSettings.engine === 'local-tts' && ttsStatusMessage ? <p className="speech-status">{ttsStatusMessage}</p> : null}
                    </div>
                    <div className="reader-settings reader-menu-group">
                      <strong>字号</strong>
                      <div className="reader-size-control">
                        <button type="button" onClick={() => updateReaderFontSize(readerSettings.fontSize - 1)}>A-</button>
                        <input
                          aria-label="字体大小"
                          max={28}
                          min={15}
                          type="range"
                          value={readerSettings.fontSize}
                          onChange={(event) => updateReaderFontSize(Number(event.target.value))}
                        />
                        <button type="button" onClick={() => updateReaderFontSize(readerSettings.fontSize + 1)}>A+</button>
                        <span>{readerSettings.fontSize}px</span>
                      </div>
                      <strong>背景</strong>
                      <div className="reader-background-control">
                        {(['paper', 'warm', 'green', 'dark'] as ReaderBackground[]).map((background) => (
                          <button
                            aria-label={backgroundLabel(background)}
                            className={`reader-swatch ${background} ${readerSettings.background === background ? 'active' : ''}`}
                            key={background}
                            type="button"
                            onClick={() => updateReaderBackground(background)}
                          />
                        ))}
                      </div>
                    </div>
                  </section>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : (
        <section className="settings-page" hidden={tab !== 'settings'}>
          <nav className="settings-tabs segmented-control" aria-label="设置分类">
            {settingsTabs.map((settingsTabItem) => (
              <button
                className={settingsTab === settingsTabItem.id ? 'active' : ''}
                key={settingsTabItem.id}
                type="button"
                onClick={() => setSettingsTab(settingsTabItem.id)}
              >
                {settingsTabItem.label}
              </button>
            ))}
          </nav>
          {settingsTab === 'reading' ? (
            <section className="settings-card reader-preferences-panel">
              <div className="section-title">
                <h2>阅读</h2>
                <span>{readerSettings.fontSize}px</span>
              </div>
              <div className="settings-card-body">
                <dl className="settings-summary-grid">
                  <div>
                    <dt>当前书籍</dt>
                    <dd>{selectedBook?.title ?? '未选择'}</dd>
                  </div>
                  <div>
                    <dt>当前章节</dt>
                    <dd>{currentChapter ? `${Math.max(1, currentChapterPosition + 1)} / ${chapters.length}` : '未打开'}</dd>
                  </div>
                </dl>
                <div className="reader-settings compact-reader-settings">
                  <strong>字号</strong>
                  <div className="reader-size-control">
                    <button type="button" onClick={() => updateReaderFontSize(readerSettings.fontSize - 1)}>A-</button>
                    <input
                      aria-label="字体大小"
                      max={28}
                      min={15}
                      type="range"
                      value={readerSettings.fontSize}
                      onChange={(event) => updateReaderFontSize(Number(event.target.value))}
                    />
                    <button type="button" onClick={() => updateReaderFontSize(readerSettings.fontSize + 1)}>A+</button>
                    <span>{readerSettings.fontSize}px</span>
                  </div>
                  <strong>背景</strong>
                  <div className="reader-background-control">
                    {(['paper', 'warm', 'green', 'dark'] as ReaderBackground[]).map((background) => (
                      <button
                        aria-label={backgroundLabel(background)}
                        className={`reader-swatch ${background} ${readerSettings.background === background ? 'active' : ''}`}
                        key={background}
                        type="button"
                        onClick={() => updateReaderBackground(background)}
                      />
                    ))}
                  </div>
                </div>
                <button className="primary-button full-width-button" type="button" onClick={() => switchTab('reader')} disabled={!selectedBookId}>
                  回到阅读
                </button>
              </div>
            </section>
          ) : null}
          {settingsTab === 'audio' ? (
            <section className="settings-card audio-settings-panel speech-control-panel">
              <div className="section-title">
                <h2>音频</h2>
                <span>{ttsSettings.engine === 'cloud-mp3' ? '章节 MP3' : '本地 TTS'}</span>
              </div>
              <div className="settings-card-body">
                <dl className="settings-summary-grid">
                  <div>
                    <dt>当前书籍</dt>
                    <dd>{selectedBook?.title ?? '未选择'}</dd>
                  </div>
                  <div>
                    <dt>本机音频</dt>
                    <dd>{displayCachedAudioChapterCount}/{displayCloudAudioChapterCount} 章已缓存</dd>
                  </div>
                </dl>
                {renderPlaybackEngineField()}
                {renderSpeechRateField()}
                {ttsSettings.engine === 'local-tts' ? (
                  <>
                    <label className="tts-toggle-row">
                      <input
                        type="checkbox"
                        checked={ttsSettings.autoFollow}
                        onChange={(event) => updateTtsSettings({ ...ttsSettings, autoFollow: event.target.checked })}
                      />
                      <span>朗读时跟随正文</span>
                    </label>
                    <label className="tts-select-field">
                      <span>音调</span>
                      <input
                        max={MAX_TTS_PITCH}
                        min={MIN_TTS_PITCH}
                        step={0.05}
                        type="number"
                        value={ttsSettings.pitch}
                        onChange={(event) => updateTtsSettings({ ...ttsSettings, pitch: Number(event.target.value) })}
                      />
                    </label>
                    <label className="tts-select-field">
                      <span>语言</span>
                      <input
                        value={ttsSettings.locale}
                        onChange={(event) => updateTtsSettings({ ...ttsSettings, locale: event.target.value })}
                      />
                    </label>
                    {ttsVoices.length > 0 ? (
                      <label className="tts-select-field">
                        <span>音色</span>
                        <select
                          value={ttsSettings.voiceId}
                          onChange={(event) => updateTtsSettings({ ...ttsSettings, voiceId: event.target.value })}
                        >
                          <option value="">系统默认</option>
                          {ttsVoices.map((voice) => (
                            <option key={voice.id} value={voice.id}>
                              {voice.name || voice.id}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <div className="tts-secondary-actions">
                      <button type="button" onClick={() => void refreshTtsAvailability()}>检测语音</button>
                      <button type="button" onClick={() => void openSystemTtsSettings()}>系统语音设置</button>
                      <button type="button" onClick={() => void openSystemTtsDataCheck()}>安装语音包</button>
                    </div>
                  </>
                ) : null}
                {ttsSettings.engine === 'local-tts' && ttsStatusMessage ? <p className="speech-status">{ttsStatusMessage}</p> : null}
                <div className="settings-actions">
                  <button className="primary-button" type="button" onClick={openMp3Manager} disabled={!selectedBookId || loadingAudio}>
                    MP3 管理
                  </button>
                  <button className="secondary-button" type="button" onClick={refreshCacheSummaries}>
                    刷新缓存
                  </button>
                </div>
              </div>
            </section>
          ) : null}
          {settingsTab === 'sync' ? (
            <>
          <section className="settings-panel">
            <label>
              <span>Gateway</span>
              <input
                value={settings.baseUrl}
                inputMode="url"
                onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })}
              />
            </label>
            <label>
              <span>Token</span>
              <input
                value={settings.token}
                type="password"
                onChange={(event) => setSettings({ ...settings, token: event.target.value })}
              />
            </label>
            <label>
              <span>设备</span>
              <input
                value={settings.deviceName}
                onChange={(event) => setSettings({ ...settings, deviceName: event.target.value })}
              />
            </label>
            <label>
              <span>设备 ID</span>
              <input readOnly value={settings.deviceId} />
            </label>
            <div className={`device-identity-card role-${gatewaySession?.auth.role ?? 'default'}`}>
              <div className="device-identity-heading">
                <strong>{gatewaySession ? deviceRoleLabel(gatewaySession.auth.role) : '授权状态未知'}</strong>
                <span>{gatewaySession?.auth.pairingCode ? `配对码 ${gatewaySession.auth.pairingCode}` : '未获取配对码'}</span>
              </div>
              <dl>
                <div>
                  <dt>设备 ID</dt>
                  <dd>{settings.deviceId}</dd>
                </div>
                <div>
                  <dt>设备名</dt>
                  <dd>{settings.deviceName || '未命名设备'}</dd>
                </div>
                <div>
                  <dt>Pairing Code</dt>
                  <dd>{gatewaySession?.auth.pairingCode || '未获取'}</dd>
                </div>
                <div>
                  <dt>当前角色 / 授权</dt>
                  <dd>{gatewaySession ? `${deviceRoleLabel(gatewaySession.auth.role)} / 已授权` : '未知 / 未刷新'}</dd>
                </div>
                <div>
                  <dt>授权说明</dt>
                  <dd>{gatewaySession ? deviceRoleDescription(gatewaySession.auth.role) : '点击刷新授权状态获取当前设备身份'}</dd>
                </div>
                <div>
                  <dt>可见范围</dt>
                  <dd>{gatewaySession?.auth.allowedVisibilities.length ? gatewaySession.auth.allowedVisibilities.join('、') : '未获取'}</dd>
                </div>
                <div>
                  <dt>设备型号</dt>
                  <dd>{deviceMetadata.model}</dd>
                </div>
                <div>
                  <dt>平台 / 版本</dt>
                  <dd>{`${deviceMetadata.platform} / ${deviceMetadata.appVersion}`}</dd>
                </div>
                <div>
                  <dt>最近同步</dt>
                  <dd>{syncStatusLabel(librarySyncState)}</dd>
                </div>
              </dl>
            </div>
            <div className="settings-actions">
              <button className="primary-button" type="button" onClick={() => void checkSession()} disabled={connectionState === 'checking'}>
                {connectionState === 'checking' ? '刷新中' : '刷新授权状态'}
              </button>
              <button className="secondary-button" type="button" onClick={() => void refreshBooks()} disabled={loadingBooks || Boolean(syncBlockedReason)}>
                {loadingBooks ? '同步中' : '刷新云端书库'}
              </button>
            </div>
          </section>

          <section className="cache-manager cloud-library-panel">
            <div className="section-title">
              <h2>云端书库</h2>
              <span>{loadingBooks ? '同步中' : `${books.length} 本`}</span>
            </div>
            {books.length ? (
              <div className="book-items">
                {books.map((book) => {
                  const localMatch = findMatchingLocalBook(book, localBooks)
                  const isLocal = Boolean(localMatch)
                  const isBusy = addingBookId === book.id
                  return (
                    <div className="cloud-book-row" key={book.id}>
                      <button className="book-row" type="button" onClick={() => selectBook(localMatch?.id ?? book.id)}>
                        <span className="book-title">{book.title}</span>
                        <span className="book-meta">{formatBookMeta(book, book.audioChapterCount)}</span>
                      </button>
                      <button
                        className={isLocal ? 'secondary-button compact-button' : 'primary-button compact-button'}
                        type="button"
                        disabled={isBusy || Boolean(syncBlockedReason)}
                        onClick={() => {
                          if (localMatch) {
                            selectBook(localMatch.id)
                            switchTab('library')
                            return
                          }
                          void addCloudBookToShelf(book.id)
                        }}
                      >
                        {isBusy ? '加入中' : isLocal ? '已在书架' : '加入书架'}
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="empty-state">
                <p>尚未刷新云端书库</p>
                <button type="button" onClick={() => void refreshBooks()} disabled={loadingBooks || Boolean(syncBlockedReason)}>
                  {loadingBooks ? '同步中' : '刷新云端书库'}
                </button>
              </div>
            )}
          </section>

            </>
          ) : null}
          {settingsTab === 'audio' ? (
          <section className="cache-manager">
            <div className="section-title">
              <h2>缓存管理</h2>
              <button className="secondary-button compact-button" type="button" onClick={refreshCacheSummaries}>
                刷新
              </button>
            </div>
            {cacheSummaries.length ? (
              <div className="cache-book-list">
                {cacheSummaries.map((cache) => (
                  <article className="cache-book-card" key={cache.bookId}>
                    <div className="cache-book-heading">
                      <strong>{cache.title}</strong>
                      <span>{formatBytes(cache.totalSizeBytes)}</span>
                    </div>
                    <dl>
                      <div>
                        <dt>完整数据包</dt>
                        <dd>{cache.packageCache ? formatBytes(cache.packageCache.sizeBytes) : '无缓存'}</dd>
                      </div>
                      <div>
                        <dt>MP3 音频</dt>
                        <dd>{cache.audioCount} 章 · {formatBytes(cache.audioSizeBytes)}</dd>
                      </div>
                    </dl>
                    <div className="cache-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={!cache.packageCache || clearingCacheKey === `${cache.bookId}:package`}
                        onClick={() => void clearBookPackageCache(cache.bookId)}
                      >
                        {clearingCacheKey === `${cache.bookId}:package` ? '清除中' : '清除数据包'}
                      </button>
                      <button
                        className="secondary-button danger-button"
                        type="button"
                        disabled={cache.audioCount === 0 || clearingCacheKey === `${cache.bookId}:audio`}
                        onClick={() => void clearBookAudioCache(cache.bookId)}
                      >
                        {clearingCacheKey === `${cache.bookId}:audio` ? '清除中' : '清除 MP3'}
                      </button>
                      <button
                        className="secondary-button danger-button cache-delete-book-button"
                        type="button"
                        disabled={!cache.packageCache || clearingCacheKey === `${cache.bookId}:book`}
                        onClick={() => {
                          if (window.confirm(`删除本地书《${cache.title}》？完整数据包和本机 MP3 都会从本机移除。`)) {
                            void deleteLocalBook(cache.bookId)
                          }
                        }}
                      >
                        {clearingCacheKey === `${cache.bookId}:book` ? '删除中' : '删除本地书'}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="cache-empty">还没有本地缓存。打开书籍或同步音频后会显示在这里。</p>
            )}
          </section>
          ) : null}
          {settingsTab === 'sync' ? (
          <section className="sync-summary">
            <div className="section-title">
              <h2>同步状态</h2>
              <span>{books.length} 本</span>
            </div>
            <dl>
              <div>
                <dt>连接</dt>
                <dd>{connectionLabel(connectionState)}</dd>
              </div>
              <div>
                <dt>当前书籍</dt>
                <dd>{selectedBook?.title ?? '未选择'}</dd>
              </div>
              <div>
                <dt>Package</dt>
                <dd>{displayPackageLabel}</dd>
              </div>
              <div>
                <dt>本机音频</dt>
                <dd>{displayCachedAudioChapterCount}/{displayCloudAudioChapterCount} 章已缓存</dd>
              </div>
            </dl>
          </section>
          ) : null}
          {settingsTab === 'diagnostics' ? (
            <>
          <section className="app-version-card">
            <div>
              <span>AI小说助手</span>
              <strong>{buildInfo.versionName}</strong>
            </div>
            <dl>
              <div>
                <dt>构建号</dt>
                <dd>{buildInfo.buildNumber}</dd>
              </div>
              <div>
                <dt>Version Code</dt>
                <dd>{buildInfo.versionCode}</dd>
              </div>
              <div>
                <dt>提交</dt>
                <dd>{`${buildInfo.gitCommit}${buildInfo.dirty ? ' · dirty' : ''}`}</dd>
              </div>
              <div>
                <dt>构建时间</dt>
                <dd>{formatBuildTime(buildInfo.buildTime)}</dd>
              </div>
            </dl>
          </section>

          <section className="app-update-panel">
            <div className="section-title">
              <h2>应用更新</h2>
              <span>{appUpdateStatusLabel(appUpdateState)}</span>
            </div>
            <dl>
              <div>
                <dt>当前版本</dt>
                <dd>{buildInfo.versionName}</dd>
              </div>
              <div>
                <dt>当前 Version Code</dt>
                <dd>{buildInfo.versionCode}</dd>
              </div>
              <div>
                <dt>线上版本</dt>
                <dd>{appUpdateState.manifest?.versionName ?? '未检查'}</dd>
              </div>
              <div>
                <dt>线上 Version Code</dt>
                <dd>{appUpdateState.manifest?.versionCode ?? '未检查'}</dd>
              </div>
            </dl>
            {appUpdateState.message ? <p className={`update-message update-${appUpdateState.status}`}>{appUpdateState.message}</p> : null}
            <div className="settings-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => void checkAppUpdate()}
                disabled={appUpdateState.status === 'checking' || appUpdateState.status === 'downloading'}
              >
                {appUpdateState.status === 'checking' ? '检查中' : '检查更新'}
              </button>
              <button
                className="primary-button"
                type="button"
                onClick={() => appUpdateState.manifest ? void installAppUpdate(appUpdateState.manifest) : undefined}
                disabled={appUpdateState.status !== 'available'}
              >
                {appUpdateState.status === 'downloading' ? '下载中' : '下载并安装'}
              </button>
            </div>
          </section>

          <section className="diagnostics-panel">
            <div className="section-title">
              <h2>问题诊断</h2>
              <span>{appLogCount} 条</span>
            </div>
            <dl>
              <div>
                <dt>最近错误</dt>
                <dd>{latestIssue ? formatDateTime(latestIssue.timestamp) : '无'}</dd>
              </div>
              <div>
                <dt>提交状态</dt>
                <dd>{logSubmitState.status === 'idle' ? '未提交' : logSubmitState.status === 'submitting' ? '提交中' : logSubmitState.status === 'submitted' ? '已提交' : '失败'}</dd>
              </div>
            </dl>
            {latestIssue ? <p className="diagnostics-message">{latestIssue.message}</p> : null}
            {logSubmitState.message ? <p className={`diagnostics-message diagnostics-${logSubmitState.status}`}>{logSubmitState.message}</p> : null}
            <div className="settings-actions">
              <button
                className="primary-button"
                type="button"
                onClick={() => void submitLocalLogs()}
                disabled={logSubmitState.status === 'submitting' || appLogCount === 0}
              >
                {logSubmitState.status === 'submitting' ? '提交中' : '提交本地日志'}
              </button>
              <button className="secondary-button" type="button" onClick={clearLocalLogs} disabled={appLogCount === 0}>
                清空日志
              </button>
            </div>
          </section>
            </>
          ) : null}
        </section>
      )}

      {mp3ManagerOpen ? (
        <div className="reader-menu-overlay" role="presentation" onClick={() => setMp3ManagerOpen(false)}>
          <section className="reader-menu-sheet mp3-manager-sheet" role="dialog" aria-modal="true" aria-label="MP3 管理" onClick={(event) => event.stopPropagation()}>
            <div className="reader-menu-header">
              <div>
                <strong>MP3 管理</strong>
                <span>{selectedLocalBook?.title ?? selectedBook?.title ?? '未选择书籍'}</span>
              </div>
              <button className="reader-menu-close" type="button" aria-label="关闭" onClick={() => setMp3ManagerOpen(false)}>×</button>
            </div>
            <div className="mp3-status-grid">
              <div>
                <dt>本机 MP3</dt>
                <dd>{displayCachedAudioChapterCount} 章</dd>
              </div>
              <div>
                <dt>可缓存 MP3</dt>
                <dd>{displayCloudAudioChapterCount || visibleAudioChapters.length || '未刷新'} 章</dd>
              </div>
              <div>
                <dt>当前章节</dt>
                <dd>{currentChapter ? `${Math.max(1, currentChapterPosition + 1)} / ${chapters.length}` : '未打开'}</dd>
              </div>
            </div>
            <div className="mp3-chapter-list">
              <div className="mp3-chapter-list-heading">
                <strong>章节缓存明细</strong>
                <span>{audioChapterStatusRows.length ? `${visibleCachedAudioIds.size}/${audioChapterStatusRows.filter((row) => row.hasAudio).length} 已缓存` : '未加载章节'}</span>
              </div>
              {audioChapterStatusRows.length ? (
                <div className="mp3-chapter-rows">
                  {audioChapterStatusRows.map((row) => (
                    <div
                      className={[
                        'mp3-chapter-row',
                        row.isCurrent ? 'current' : '',
                        row.cached ? 'cached' : row.hasAudio ? 'missing' : 'unavailable',
                      ].filter(Boolean).join(' ')}
                      key={row.chapterId}
                    >
                      <button className="mp3-chapter-title-button" type="button" onClick={() => selectChapter(row.chapterId)}>
                        <span>{row.index}. {row.title}</span>
                      </button>
                      {row.cached ? (
                        <strong className="mp3-chapter-status">已缓存</strong>
                      ) : row.hasAudio && row.audioChapter ? (
                        <button
                          className="mp3-chapter-cache-button"
                          type="button"
                          disabled={
                            cloudSyncBlocked ||
                            audioDownloadingChapterKey === audioDownloadQueueKey(selectedBookId ?? '', row.audioChapter.chapterId) ||
                            audioDownloadQueueIds.has(audioDownloadQueueKey(selectedBookId ?? '', row.audioChapter.chapterId))
                          }
                          onClick={() => {
                            if (!selectedBookId || !row.audioChapter) return
                            enqueueAudioChapterDownload(selectedBookId, row.audioChapter)
                          }}
                        >
                          {audioDownloadingChapterKey === audioDownloadQueueKey(selectedBookId ?? '', row.audioChapter.chapterId)
                            ? '下载中'
                            : audioDownloadQueueIds.has(audioDownloadQueueKey(selectedBookId ?? '', row.audioChapter.chapterId))
                              ? '队列中'
                              : '缓存'}
                        </button>
                      ) : (
                        <strong className="mp3-chapter-status">无音频</strong>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mp3-chapter-empty">打开书籍后显示每章 MP3 缓存状态。</p>
              )}
            </div>
            {visibleAudioSyncProgress ? (
              <div className="package-line mp3-progress-line">
                <span>下载进度</span>
                <strong>{visibleAudioSyncProgress.done}/{visibleAudioSyncProgress.total}</strong>
              </div>
            ) : null}
            {syncBlockedReason ? <div className="visibility-notice role-disabled">{syncBlockedReason}</div> : null}
            <div className="mp3-action-list">
              {visibleAudioSyncProgress ? (
                <button className="danger-button" type="button" onClick={stopAudioSync}>
                  停止同步
                </button>
              ) : null}
              <button type="button" onClick={() => void syncCurrentBookAudioRange('current')} disabled={!selectedBookId || !currentChapter || loadingAudio || audioSyncRunning || cloudSyncBlocked}>
                当前章节
              </button>
              <button type="button" onClick={() => void syncCurrentBookAudioRange(10)} disabled={!selectedBookId || !currentChapter || loadingAudio || audioSyncRunning || cloudSyncBlocked}>
                当前起 10 章
              </button>
              <button type="button" onClick={() => void syncCurrentBookAudioRange(30)} disabled={!selectedBookId || !currentChapter || loadingAudio || audioSyncRunning || cloudSyncBlocked}>
                当前起 30 章
              </button>
              <button type="button" onClick={() => void syncCurrentBookAudioRange('all')} disabled={!selectedBookId || loadingAudio || audioSyncRunning || cloudSyncBlocked}>
                全部未缓存
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={!selectedBookId || displayCachedAudioChapterCount === 0 || clearingCacheKey === `${selectedBookId}:audio`}
                onClick={() => {
                  if (!selectedBookId) return
                  if (window.confirm('删除本书所有本机 MP3？完整数据包和阅读进度会保留。')) {
                    void clearBookAudioCache(selectedBookId)
                  }
                }}
              >
                {clearingCacheKey === `${selectedBookId}:audio` ? '删除中' : '删除本书 MP3'}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {tab === 'search' ? (
        <section className="search-page">
          <section className="search-panel">
            <div className="section-title">
              <h2>搜索</h2>
              {bookPackage ? (
                <span>
                  {packageChapters(bookPackage).length} 章 · chunk {getEmbeddingChunks(bookPackage).length} · 图谱 {getKnowledgeGraphEntities(bookPackage).length}/{getKnowledgeGraphRelations(bookPackage).length}
                </span>
              ) : (
                <span>未加载</span>
              )}
            </div>
            {!bookPackage ? (
              <div className="empty-state">
                <p>请先在书库选择一本书并加载完整数据包。</p>
                <button type="button" onClick={() => switchTab('library')}>回到书库</button>
              </div>
            ) : (
              <>
                <div className="segmented-control search-mode-tabs" aria-label="搜索类型">
                  <button className={searchMode === 'rag' ? 'active' : ''} type="button" onClick={() => switchSearchMode('rag')}>RAG</button>
                  <button className={searchMode === 'graph' ? 'active' : ''} type="button" onClick={() => switchSearchMode('graph')}>知识图谱</button>
                </div>
                <div className="search-input-row">
                  <input
                    className="search-input"
                    value={searchInput}
                    onChange={(event) => updateSearchInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitSearch()
                    }}
                    placeholder={searchMode === 'rag' ? '问一个剧情问题，或输入关键词' : '搜索人物、地点、关系、证据'}
                  />
                  <button type="button" onClick={submitSearch} disabled={ragIsSearching || !searchInput.trim()}>
                    {ragIsSearching ? '检索中' : '检索'}
                  </button>
                </div>
                {searchMode === 'rag' ? (
                  <>
                    <label className="search-toggle">
                      <input
                        type="checkbox"
                        checked={ragUseSemantic}
                        onChange={(event) => setRagUseSemantic(event.target.checked)}
                      />
                      <span>调用 embedding 语义召回</span>
                    </label>
                    {ragStatus ? <p className="muted-text search-status">{ragStatus}</p> : null}
                    <p className="muted-text search-status">
                      {ragUseSemantic
                        ? '默认通过 Gateway 调用 embedding 语义搜索，移动端不下载向量。'
                        : '当前仅使用本地关键词检索，未调用 embedding 服务生成查询向量。'}
                    </p>
                    {ragError ? <p className="search-error">{ragError}</p> : null}
                    {ragAnswer ? (
                      <article className="search-answer-card">
                        <strong>生成答案</strong>
                        <p>{ragAnswer}</p>
                      </article>
                    ) : null}
                    <div className="search-results">
                      {ragResults.length > 0 ? (
                        <button
                          className="secondary-button search-answer-button"
                          type="button"
                          onClick={() => void generateRagAnswer()}
                          disabled={ragIsGeneratingAnswer}
                        >
                          {ragIsGeneratingAnswer ? '生成中' : '结合 RAG 生成答案'}
                        </button>
                      ) : null}
                      {ragResults.map((result) => (
                        <button className="search-result" key={`${result.source}-${result.chapterId}`} type="button" onClick={() => openSearchResult(result.chapterId)}>
                          <strong>{result.chapterIndex}. {result.chapterTitle}</strong>
                          <small>{sourceLabel(result.source)} · score {result.score.toFixed(1)}</small>
                          <span>{result.snippet}</span>
                        </button>
                      ))}
                      {searchInput && !submittedSearchQuery && !ragIsSearching && ragResults.length === 0 ? <p className="muted-text">点击检索开始搜索。</p> : null}
                      {submittedSearchQuery && !ragIsSearching && ragResults.length === 0 ? <p className="muted-text">没有召回相关章节，可以换一个更接近原文或概要的关键词。</p> : null}
                    </div>
                  </>
                ) : (
                  <div className="search-results">
                    {graphResults.map((result) => (
                      <button className="search-result graph-result" key={`${result.kind}-${result.id}`} type="button" onClick={() => openGraphResult(result)}>
                        <strong>{result.title}</strong>
                        <small>{result.subtitle}</small>
                        <span>{result.snippet}</span>
                        {expandedGraphResultId === `${result.kind}-${result.id}` && result.details?.length ? (
                          <div className="graph-detail-list">
                            {result.details.map((detail, index) => (
                              <p key={`${result.id}-detail-${index}`}>{detail}</p>
                            ))}
                          </div>
                        ) : null}
                      </button>
                    ))}
                    {searchInput && !submittedSearchQuery ? <p className="muted-text">点击检索开始搜索。</p> : null}
                    {submittedSearchQuery && graphResults.length === 0 ? <p className="muted-text">没有匹配的实体、关系或证据。</p> : null}
                  </div>
                )}
              </>
            )}
          </section>
        </section>
      ) : null}

      {audioUrl ? (
        <audio
          className="persistent-audio-player"
          ref={chapterAudioRef}
          src={audioUrl}
          onTimeUpdate={(event) => handleChapterAudioTimeUpdate(event.currentTarget)}
          onLoadedMetadata={(event) => {
            event.currentTarget.defaultPlaybackRate = ttsSettings.rate
            event.currentTarget.playbackRate = ttsSettings.rate
            const pendingStartTime = pendingAudioStartTimeRef.current
            if (pendingStartTime != null) {
              pendingAudioStartTimeRef.current = null
              seekChapterAudio(event.currentTarget, pendingStartTime, pendingAudioShouldPlayRef.current)
              pendingAudioShouldPlayRef.current = false
            }
          }}
          onError={(event) => void handleChapterAudioError(event.currentTarget)}
          onPlay={(event) => {
            event.currentTarget.playbackRate = ttsSettings.rate
            setChapterAudioPlaying(true)
          }}
          onPause={() => setChapterAudioPlaying(false)}
          onEnded={handleChapterAudioEnded}
        />
      ) : null}

      <nav className="bottom-nav" aria-label="主导航">
        <button className={tab === 'library' ? 'active' : ''} type="button" onClick={() => switchTab('library')}>
          书库
        </button>
        <button className={tab === 'reader' ? 'active' : ''} type="button" onClick={() => switchTab('reader')}>
          阅读
        </button>
        <button className={tab === 'search' ? 'active' : ''} type="button" onClick={() => switchTab('search')}>
          搜索
        </button>
        <button className={tab === 'settings' ? 'active' : ''} type="button" onClick={() => switchTab('settings')}>
          设置
        </button>
      </nav>
    </main>
  )
}

function sourceLabel(source: RagResult['source']) {
  if (source === 'chunk') return '正文片段'
  if (source === 'summary') return '章节概要'
  return '章节全文'
}

export async function searchGatewayRag(settings: GatewaySettings, bookId: string, query: string): Promise<RagResult[]> {
  const response = await gatewayPost(settings, '/ai/search', {
    bookId,
    query,
    limit: 20,
  })
  const results = Array.isArray(response.results) ? response.results.filter(isRecord) : []
  return results
    .map((result) => ({
      chapterId: readString(result.chapterId),
      chapterIndex: readNumber(result.chapterIndex) ?? 0,
      chapterTitle: readString(result.chapterTitle) || '未命名章节',
      snippet: readString(result.snippet),
      source: normalizeRagResultSource(result.source),
      score: readNumber(result.score) ?? 0,
    }))
    .filter((result) => Boolean(result.chapterId))
}

export async function gatewayGenerateRagAnswer(
  settings: GatewaySettings,
  bookId: string,
  query: string,
): Promise<{ answer: string; results: RagResult[] }> {
  const response = await gatewayPost(settings, '/ai/rag-answer', {
    bookId,
    query,
    limit: 10,
  })
  const results = Array.isArray(response.results) ? response.results.filter(isRecord) : []
  return {
    answer: readString(response.answer),
    results: results
      .map((result) => ({
        chapterId: readString(result.chapterId),
        chapterIndex: readNumber(result.chapterIndex) ?? 0,
        chapterTitle: readString(result.chapterTitle) || '未命名章节',
        snippet: readString(result.snippet),
        source: normalizeRagResultSource(result.source),
        score: readNumber(result.score) ?? 0,
      }))
      .filter((result) => Boolean(result.chapterId)),
  }
}

function normalizeRagResultSource(value: unknown): RagResult['source'] {
  return value === 'summary' || value === 'chapter' || value === 'chunk' ? value : 'chunk'
}

function normalizeSearchText(value: string) {
  return value.trim().toLowerCase()
}

function getSearchTerms(query: string) {
  const normalized = normalizeSearchText(query)
  if (!normalized) return []
  const terms = new Set<string>([normalized])
  for (const term of normalized.split(/[\s,，.。!！?？:：;；、"'“”‘’《》()[\]（）]+/).filter(Boolean)) {
    terms.add(term)
    for (const part of term.split(/[的是了和与及或在把被都谁什么哪些哪位为何为什么怎么如何吗呢啊]+/).filter(Boolean)) {
      terms.add(part)
      if (/[\u3400-\u9fff]/.test(part) && part.length >= 4) {
        for (let size = 4; size >= 2; size -= 1) {
          for (let index = 0; index <= part.length - size; index += 1) {
            terms.add(part.slice(index, index + size))
          }
        }
      }
    }
  }
  return Array.from(terms).filter((term) => term.length >= 2)
}

function scoreSearchText(text: string, query: string) {
  const normalizedText = normalizeSearchText(text)
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedText || !normalizedQuery) return 0

  let score = normalizedText.includes(normalizedQuery) ? 6 : 0
  for (const term of getSearchTerms(query)) {
    let index = normalizedText.indexOf(term)
    while (index >= 0) {
      score += Math.min(4, term.length)
      index = normalizedText.indexOf(term, index + term.length)
    }
  }
  return score
}

function findSnippet(text: string, query: string) {
  const normalizedText = text.replace(/\s+/g, ' ')
  const lowerText = normalizedText.toLowerCase()
  let matchedQuery = query
  let index = lowerText.indexOf(query.toLowerCase())
  if (index < 0) {
    for (const term of getSearchTerms(query)) {
      index = lowerText.indexOf(term)
      if (index >= 0) {
        matchedQuery = term
        break
      }
    }
  }
  if (index < 0) return normalizedText.slice(0, 120)
  const start = Math.max(0, index - 48)
  const end = Math.min(normalizedText.length, index + matchedQuery.length + 96)
  return `${start > 0 ? '...' : ''}${normalizedText.slice(start, end)}${end < normalizedText.length ? '...' : ''}`
}

function searchRagPackage(bookPackage: BookPackage, query: string, queryEmbedding: number[] | null = null): RagResult[] {
  const chapters = packageChapters(bookPackage)
  const chapterById = new Map(chapters.map((chapter, index) => [chapter.id, { chapter, index }]))
  const candidates = new Map<string, RagResult>()

  function addCandidate(result: RagResult) {
    const current = candidates.get(result.chapterId)
    if (!current || result.score > current.score) candidates.set(result.chapterId, result)
  }

  for (const chunk of getEmbeddingChunks(bookPackage)) {
    const chapterId = readString(chunk.chapterId)
    const text = readString(chunk.text)
    if (!chapterId || !text) continue
    if (queryEmbedding?.length) {
      const chunkEmbedding = readEmbeddingVector(chunk)
      if (chunkEmbedding.length === queryEmbedding.length) {
        const semanticScore = cosineSimilarity(queryEmbedding, chunkEmbedding)
        if (semanticScore > 0) {
          const match = chapterById.get(chapterId)
          if (match) {
            addCandidate({
              chapterId,
              chapterIndex: readNumber(chunk.chapterIndex) ?? match.chapter.index ?? match.chapter.chapterIndex ?? match.index + 1,
              chapterTitle: match.chapter.title,
              snippet: findSnippet(text, query),
              source: 'chunk',
              score: semanticScore * 100 + 40,
            })
          }
        }
      }
    }
    const score = scoreSearchText(text, query)
    if (!score) continue
    const match = chapterById.get(chapterId)
    if (!match) continue
    addCandidate({
      chapterId,
      chapterIndex: readNumber(chunk.chapterIndex) ?? match.chapter.index ?? match.chapter.chapterIndex ?? match.index + 1,
      chapterTitle: match.chapter.title,
      snippet: findSnippet(text, query),
      source: 'chunk',
      score: score + 20,
    })
  }

  for (const summary of getSummaries(bookPackage)) {
    const chapterId = readString(summary.chapterId) || readString(summary.id)
    if (!chapterId) continue
    const match = chapterById.get(chapterId)
    if (!match) continue
    const haystack = [match.chapter.title, readString(summary.short), readString(summary.detail), readString(summary.summary), readString(summary.description), readStringArray(summary.keyPoints).join(' ')].join('\n')
    const score = scoreSearchText(haystack, query)
    if (!score) continue
    addCandidate({
      chapterId,
      chapterIndex: match.chapter.index ?? match.chapter.chapterIndex ?? match.index + 1,
      chapterTitle: match.chapter.title,
      snippet: findSnippet(haystack, query),
      source: 'summary',
      score: score + 12,
    })
  }

  chapters.forEach((chapter, index) => {
    const content = chapterContent(chapter)
    const score = scoreSearchText(`${chapter.title}\n${content}`, query)
    if (!score) return
    addCandidate({
      chapterId: chapter.id,
      chapterIndex: chapter.index ?? chapter.chapterIndex ?? index + 1,
      chapterTitle: chapter.title,
      snippet: findSnippet(content, query),
      source: 'chapter',
      score,
    })
  })

  return Array.from(candidates.values())
    .sort((left, right) => right.score - left.score || left.chapterIndex - right.chapterIndex)
    .slice(0, 20)
}

function searchGraphPackage(bookPackage: BookPackage | null, query: string): GraphResult[] {
  if (!bookPackage) return []
  const entities = getKnowledgeGraphEntities(bookPackage)
  const relations = getKnowledgeGraphRelations(bookPackage)
  const entityMentions = getKnowledgeGraphMentions(bookPackage, 'entityMentions')
  const relationMentions = getKnowledgeGraphMentions(bookPackage, 'relationMentions')
  const entityById = new Map(entities.map((entity) => [readString(entity.id), entity]))
  const chapterById = new Map(packageChapters(bookPackage).map((chapter, index) => [chapter.id, { chapter, index }]))

  const entityResults = entities
    .map((entity) => {
      const id = readString(entity.id)
      const name = readString(entity.name) || readString(entity.normalizedName) || '未知实体'
      const aliases = readStringArray(entity.aliases)
      const names = [name, readString(entity.normalizedName), ...aliases].filter(Boolean)
      const exactNameBonus = names.some((entry) => normalizeSearchText(entry) === normalizeSearchText(query)) ? 1000 : 0
      const nameScore = scoreSearchText(names.join('\n'), query)
      const descriptionScore = scoreSearchText([readString(entity.type), readString(entity.description)].join('\n'), query)
      const score = exactNameBonus + nameScore * 20 + descriptionScore
      if (!score) return null
      const mentions = entityMentions.filter((mention) => readString(mention.entityId) === id)
      const relatedRelations = relations.filter((relation) => readString(relation.sourceEntityId) === id || readString(relation.targetEntityId) === id)
      const relationCount = relatedRelations.length
      const mentionCount = mentions.length || readNumber(entity.mentionCount) || readNumber(entity.mentions)
      const detailLines = [
        aliases.length ? `别名：${aliases.slice(0, 24).join('、')}${aliases.length > 24 ? '...' : ''}` : '',
        readString(entity.description) ? `说明：${readString(entity.description)}` : '',
        relatedRelations.length
          ? `相关关系：${relatedRelations.slice(0, 8).map((relation) => {
              const sourceName = readString(entityById.get(readString(relation.sourceEntityId))?.name) || '未知实体'
              const targetName = readString(entityById.get(readString(relation.targetEntityId))?.name) || '未知实体'
              return `${sourceName} - ${readString(relation.type) || '关系'} - ${targetName}`
            }).join('；')}${relatedRelations.length > 8 ? '...' : ''}`
          : '',
        ...mentions.slice(0, 3).map((mention) => `证据：第 ${readNumber(mention.chapterIndex) ?? '?'} 章，${readString(mention.evidence)}`),
      ].filter(Boolean)
      return {
        kind: 'entity' as const,
        id: id || name,
        title: name,
        subtitle: `${readString(entity.type) || '实体'} · 出现 ${mentionCount ?? 0} 次 · 关系 ${relationCount} 条`,
        snippet: readString(entity.description) || readString(mentions.find((mention) => readString(mention.evidence))?.evidence) || '命中实体名称或别名。',
        details: detailLines,
        score,
      }
    })
    .filter(isPresent)

  const relationResults = relations
    .map((relation) => {
      const id = readString(relation.id)
      const source = entityById.get(readString(relation.sourceEntityId))
      const target = entityById.get(readString(relation.targetEntityId))
      const sourceName = readString(source?.name) || '未知实体'
      const targetName = readString(target?.name) || '未知实体'
      const haystack = [sourceName, targetName, readString(relation.type), readString(relation.description)].join('\n')
      const score = scoreSearchText(haystack, query)
      if (!score) return null
      const mentions = relationMentions.filter((mention) => readString(mention.relationId) === id)
      const detailLines = [
        readString(relation.description) ? `说明：${readString(relation.description)}` : '',
        ...mentions.slice(0, 3).map((mention) => `证据：第 ${readNumber(mention.chapterIndex) ?? '?'} 章，${readString(mention.evidence)}`),
      ].filter(Boolean)
      return {
        kind: 'relation' as const,
        id: id || `${sourceName}-${targetName}`,
        title: `${sourceName} → ${targetName}`,
        subtitle: `${readString(relation.type) || '关系'} · 证据 ${mentions.length} 条`,
        snippet: readString(relation.description) || readString(mentions.find((mention) => readString(mention.evidence))?.evidence) || '命中关系名称或端点。',
        details: detailLines,
        score,
      }
    })
    .filter(isPresent)

  const evidenceResults = [...entityMentions, ...relationMentions]
    .map((mention) => {
      const evidence = readString(mention.evidence)
      const score = scoreSearchText(evidence, query)
      if (!score) return null
      const chapterId = readString(mention.chapterId)
      const match = chapterById.get(chapterId)
      return {
        kind: 'evidence' as const,
        id: readString(mention.id) || `${chapterId}-${evidence.slice(0, 16)}`,
        title: `${readNumber(mention.chapterIndex) ?? match?.chapter.index ?? match?.index ?? ''}. ${match?.chapter.title ?? '图谱证据'}`,
        subtitle: '图谱证据',
        snippet: findSnippet(evidence, query),
        chapterId,
        chapterIndex: readNumber(mention.chapterIndex) ?? match?.chapter.index ?? match?.index,
        score,
      }
    })
    .filter(isPresent)

  return [...entityResults, ...relationResults, ...evidenceResults]
    .sort((left, right) => right.score - left.score)
    .slice(0, 30)
}

function getSummaries(bookPackage: BookPackage) {
  const summaries = bookPackage.summaries
  if (Array.isArray(summaries)) return summaries.filter(isRecord)
  if (isRecord(summaries)) return Object.values(summaries).filter(isRecord)
  return []
}

function getEmbeddingChunks(bookPackage: BookPackage) {
  const embeddings = bookPackage.embeddings
  if (!isRecord(embeddings)) return []
  return Array.isArray(embeddings.chunks) ? embeddings.chunks.filter(isRecord) : []
}

function readEmbeddingVector(chunk: Record<string, unknown>) {
  const value = chunk.embedding ?? chunk.vector ?? chunk.values
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry)) : []
}

function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }
  if (!leftNorm || !rightNorm) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function getKnowledgeGraphEntities(bookPackage: BookPackage) {
  const graph = bookPackage.knowledgeGraph
  return isRecord(graph) && Array.isArray(graph.entities) ? graph.entities.filter(isRecord) : []
}

function getKnowledgeGraphRelations(bookPackage: BookPackage) {
  const graph = bookPackage.knowledgeGraph
  return isRecord(graph) && Array.isArray(graph.relations) ? graph.relations.filter(isRecord) : []
}

function getKnowledgeGraphMentions(bookPackage: BookPackage, key: 'entityMentions' | 'relationMentions') {
  const graph = bookPackage.knowledgeGraph
  return isRecord(graph) && Array.isArray(graph[key]) ? graph[key].filter(isRecord) : []
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null
}

function splitSourceParagraphs(text: string): SourceParagraph[] {
  const paragraphs: SourceParagraph[] = []
  const lines = text.split('\n')
  let offset = 0

  lines.forEach((line, index) => {
    const startOffset = offset
    const normalized = line.replace(/\r$/, '')
    const trimmed = normalized.trim()
    const trimStart = normalized.indexOf(trimmed)
    if (trimmed) {
      const paragraphStart = startOffset + Math.max(0, trimStart)
      paragraphs.push({
        key: `${index}-${paragraphStart}`,
        text: trimmed,
        startOffset: paragraphStart,
        endOffset: paragraphStart + trimmed.length,
      })
    }
    offset += line.length + 1
  })

  return paragraphs
}

function rangesOverlap(left: SourceRange, right: SourceRange | null | undefined) {
  return Boolean(right && left.startOffset < right.endOffset && left.endOffset > right.startOffset)
}

function findSourceElement(container: HTMLElement, source: SourceRange) {
  const elements = Array.from(container.querySelectorAll<HTMLElement>('[data-source-start][data-source-end]'))
  return (
    elements.find((element) => {
      const start = Number(element.dataset.sourceStart)
      const end = Number(element.dataset.sourceEnd)
      return Number.isFinite(start) && Number.isFinite(end) && start <= source.startOffset && end >= source.endOffset
    }) ??
    elements.find((element) => {
      const start = Number(element.dataset.sourceStart)
      const end = Number(element.dataset.sourceEnd)
      return Number.isFinite(start) && Number.isFinite(end) && start <= source.startOffset && end > source.startOffset
    }) ??
    null
  )
}

function TextContent({
  text,
  activeEntry,
  summaryHighlightRange,
}: {
  text: string
  activeEntry?: AudioTimelineEntry | null
  summaryHighlightRange?: SourceRange | null
}) {
  const highlighted = splitHighlightedText(text, activeEntry)
  if (highlighted) {
    return (
      <p
        className={
          rangesOverlap({ startOffset: 0, endOffset: text.length }, summaryHighlightRange)
            ? 'highlighted-text chapter-source-highlight'
            : 'highlighted-text'
        }
        data-source-start={0}
        data-source-end={text.length}
      >
        <span>{highlighted.before}</span>
        <mark data-audio-highlight-anchor="true">{highlighted.active}</mark>
        <span>{highlighted.after}</span>
      </p>
    )
  }

  const paragraphs = splitSourceParagraphs(text)
  if (paragraphs.length === 0) {
    return <p className="muted-text">这一章没有正文。</p>
  }
  return (
    <>
      {paragraphs.map((paragraph) => (
        <p
          className={rangesOverlap(paragraph, summaryHighlightRange) ? 'chapter-source-highlight' : undefined}
          data-source-start={paragraph.startOffset}
          data-source-end={paragraph.endOffset}
          key={paragraph.key}
        >
          {paragraph.text}
        </p>
      ))}
    </>
  )
}

function SpeechTextContent({
  speechChapter,
  activeSegmentId,
  activeEntry,
  summaryHighlightRange,
}: {
  speechChapter: ReturnType<typeof createSpeechChapter>
  activeSegmentId: string | null
  activeEntry?: AudioTimelineEntry | null
  summaryHighlightRange?: SourceRange | null
}) {
  if (speechChapter.paragraphs.length === 0) {
    return <p className="muted-text">这一章没有正文。</p>
  }

  return (
    <>
      {speechChapter.paragraphs.map((paragraph) => (
        <p key={`speech-paragraph-${paragraph.paragraphIndex}`}>
          {paragraph.segments.map((segment, index) => (
            <span
              className={[
                'speech-segment',
                segment.id === activeSegmentId ? 'active' : '',
                rangesOverlap({ startOffset: segment.startChar, endOffset: segment.endChar }, summaryHighlightRange)
                  ? 'chapter-source-highlight'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-speech-segment-id={segment.id}
              data-source-start={segment.startChar}
              data-source-end={segment.endChar}
              key={segment.id}
            >
              {renderSpeechSegmentText(segment, activeEntry)}
              {index < paragraph.segments.length - 1 ? ' ' : ''}
            </span>
          ))}
        </p>
      ))}
    </>
  )
}

function renderSpeechSegmentText(segment: SpeechSegment, activeEntry?: AudioTimelineEntry | null) {
  if (
    !activeEntry ||
    typeof activeEntry.sourceStart !== 'number' ||
    typeof activeEntry.sourceEnd !== 'number' ||
    activeEntry.sourceEnd <= segment.startChar ||
    activeEntry.sourceStart >= segment.endChar
  ) {
    return segment.text
  }

  const overlapStart = Math.max(segment.startChar, activeEntry.sourceStart)
  const overlapEnd = Math.min(segment.endChar, activeEntry.sourceEnd)
  const relativeStart = Math.max(0, Math.min(segment.text.length, overlapStart - segment.startChar))
  const relativeEnd = Math.max(relativeStart, Math.min(segment.text.length, overlapEnd - segment.startChar))

  return (
    <>
      {segment.text.slice(0, relativeStart)}
      <mark data-audio-highlight-anchor="true">{segment.text.slice(relativeStart, relativeEnd)}</mark>
      {segment.text.slice(relativeEnd)}
    </>
  )
}

function ChapterSummary({
  bookPackage,
  chapter,
  onJumpToSource,
}: {
  bookPackage: BookPackage
  chapter: Chapter
  onJumpToSource: (source: SummaryKeyPointSource) => void
}) {
  const summary = findChapterSummary(bookPackage, chapter)
  const short = summary ? summaryText(summary, ['short', 'brief', 'summary', 'title']) : ''
  const detail = summary ? summaryText(summary, ['detail', 'details', 'content', 'description']) : ''
  const keyPoints = summary ? summaryKeyPointItems(summary) : []
  const skippable = summary ? summaryText(summary, ['skippable', 'skipReason', 'readingTip']) : ''

  return (
    <aside className={summary ? 'summary-box' : 'summary-box summary-empty'}>
      <strong>本章概要</strong>
      {summary ? (
        <>
          {short ? <p className="summary-short">{short}</p> : null}
          {detail ? <p>{detail}</p> : null}
          {keyPoints.length > 0 ? (
            <ul>
              {keyPoints.map((point, index) => (
                <li key={`${chapter.id}-summary-${index}`}>
                  {point.source ? (
                    <button
                      type="button"
                      className="summary-source-link"
                      onClick={(event) => {
                        event.stopPropagation()
                        onJumpToSource(point.source!)
                      }}
                    >
                      {point.text}
                    </button>
                  ) : (
                    point.text
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          {skippable ? <p className="summary-skip">{skippable}</p> : null}
          {!short && !detail && keyPoints.length === 0 && !skippable ? <p>当前概要为空。</p> : null}
        </>
      ) : (
        <p>当前同步包没有这章的概要。可以回到书库重新同步完整数据包。</p>
      )}
    </aside>
  )
}

function Coverage({ label, value }: { label: string; value?: number }) {
  const percent = typeof value === 'number' ? Math.round(value * 100) : null
  return (
    <div className="coverage">
      <span>{label}</span>
      <div className="meter">
        <div style={{ width: `${percent ?? 0}%` }} />
      </div>
      <strong>{percent === null ? '读取中' : `${percent}%`}</strong>
    </div>
  )
}

function StatusCoverage({ label, value }: { label: string; value: string }) {
  return (
    <div className="coverage">
      <span>{label}</span>
      <div className="meter">
        <div style={{ width: value === '未加载' ? '0%' : '100%' }} />
      </div>
      <strong>{value}</strong>
    </div>
  )
}

function findChapterSummary(bookPackage: BookPackage, chapter: Chapter): Record<string, unknown> | null {
  const summaries = bookPackage.summaries
  if (Array.isArray(summaries)) {
    const matched = summaries.find((entry) => {
      if (!isRecord(entry)) return false
      return (
        entry.chapterId === chapter.id ||
        entry.id === chapter.id ||
        sameOptionalInteger(entry.chapterIndex, chapter.index) ||
        sameOptionalInteger(entry.index, chapter.index) ||
        sameOptionalInteger(entry.chapterIndex, chapter.chapterIndex) ||
        sameOptionalInteger(entry.index, chapter.chapterIndex)
      )
    })
    return isRecord(matched) ? matched : null
  }
  if (isRecord(summaries)) {
    const byId = summaries[chapter.id]
    if (isRecord(byId)) return byId
  }
  return null
}

function sameOptionalInteger(left: unknown, right: unknown) {
  return typeof left === 'number' && typeof right === 'number' && left === right
}

function summaryText(summary: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = summary[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function summaryList(summary: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = summary[key]
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim())
    }
  }
  return []
}

function summaryKeyPointItems(summary: Record<string, unknown>): SummaryKeyPointItem[] {
  const keyPoints = summaryList(summary, ['keyPoints', 'keypoints', 'points', 'bullets'])
  const sourceByIndex = new Map(summaryKeyPointSources(summary, keyPoints).map((source) => [source.index, source]))
  return keyPoints.map((text, index) => ({ text, source: sourceByIndex.get(index) }))
}

function summaryKeyPointSources(summary: Record<string, unknown>, keyPoints: string[]): SummaryKeyPointSource[] {
  const value = summary.keyPointSources
  if (!Array.isArray(value)) return []

  return value
    .map((entry, fallbackIndex): SummaryKeyPointSource | null => {
      if (!isRecord(entry)) return null
      const index = typeof entry.index === 'number' && Number.isInteger(entry.index) ? entry.index : fallbackIndex
      const startOffset = readNumber(entry.startOffset)
      const endOffset = readNumber(entry.endOffset)
      if (index < 0 || index >= keyPoints.length || startOffset == null || endOffset == null || endOffset <= startOffset) return null
      return {
        index,
        text: readString(entry.text) || keyPoints[index] || '',
        startOffset,
        endOffset,
        quote: readString(entry.quote) || undefined,
        confidence: readNumber(entry.confidence),
        locator: readString(entry.locator) || undefined,
      }
    })
    .filter((entry): entry is SummaryKeyPointSource => Boolean(entry))
}

async function gatewayFetch(settings: GatewaySettings, path: string) {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  if (!settings.token.trim()) {
    throw new Error('请填写 Token')
  }

  const headers = buildGatewayHeaders(settings, getDeviceMetadata(appVersion))
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      headers,
      readTimeout: 120000,
      connectTimeout: 15000,
      url: `${baseUrl}${path}`,
    })
    const body = typeof response.data === 'string' ? parseJsonBody(response.data) : response.data
    if (response.status < 200 || response.status >= 300) {
      throw createGatewayError(body, `Gateway HTTP ${response.status}`, response.status)
    }
    return body as Record<string, unknown>
  }

  const response = await fetch(`${baseUrl}${path}`, {
    headers,
  })
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!response.ok) {
    throw createGatewayError(body, `Gateway HTTP ${response.status}`, response.status)
  }
  return body as Record<string, unknown>
}

async function gatewayPublicFetch(settings: GatewaySettings, path: string) {
  const url = absoluteGatewayUrl(settings, path)
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      readTimeout: 120000,
      connectTimeout: 15000,
      url,
    })
    const body = typeof response.data === 'string' ? parseJsonBody(response.data) : response.data
    if (response.status < 200 || response.status >= 300) {
      throw createGatewayError(body, `Gateway HTTP ${response.status}`, response.status)
    }
    return body as Record<string, unknown>
  }

  const response = await fetch(url)
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!response.ok) {
    throw createGatewayError(body, `Gateway HTTP ${response.status}`, response.status)
  }
  return body as Record<string, unknown>
}

function absoluteGatewayUrl(settings: GatewaySettings, pathOrUrl: string) {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  return `${baseUrl}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`
}

async function gatewayPost(settings: GatewaySettings, path: string, data: Record<string, unknown>) {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  if (!settings.token.trim()) {
    throw new Error('请填写 Token')
  }

  const headers = buildGatewayHeaders(settings, getDeviceMetadata(appVersion), {
    'Content-Type': 'application/json',
  })
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.post({
      headers,
      readTimeout: 120000,
      connectTimeout: 15000,
      url: `${baseUrl}${path}`,
      data,
    })
    const body = typeof response.data === 'string' ? parseJsonBody(response.data) : response.data
    if (response.status < 200 || response.status >= 300) {
      throw createGatewayError(body, `Gateway HTTP ${response.status}`, response.status)
    }
    return body as Record<string, unknown>
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  })
  const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
  if (!response.ok) {
    throw createGatewayError(body, `Gateway HTTP ${response.status}`, response.status)
  }
  return body as Record<string, unknown>
}

async function createAudioStreamUrl(settings: GatewaySettings, bookId: string, chapterId: string) {
  const response = await gatewayPost(
    settings,
    `/mobile/books/${encodeURIComponent(bookId)}/audio/${encodeURIComponent(chapterId)}/stream-token`,
    {},
  )
  const streamUrl = typeof response.streamUrl === 'string' ? response.streamUrl : ''
  if (!streamUrl) {
    throw new Error('Gateway 未返回 MP3 在线播放地址')
  }
  return absoluteGatewayUrl(settings, streamUrl)
}

async function gatewayFetchBlob(settings: GatewaySettings, path: string) {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  if (!settings.token.trim()) {
    throw new Error('请填写 Token')
  }

  const headers = buildGatewayHeaders(settings, getDeviceMetadata(appVersion))
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      headers,
      readTimeout: 120000,
      connectTimeout: 15000,
      responseType: 'blob',
      url: `${baseUrl}${path}`,
    })
    if (response.status < 200 || response.status >= 300) {
      const body = typeof response.data === 'string' ? parseJsonBody(response.data) : response.data
      throw createGatewayError(body, `Gateway HTTP ${response.status}`, response.status)
    }
    return capacitorDataToBlob(response.data)
  }

  const response = await fetch(`${baseUrl}${path}`, {
    headers,
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
    throw createGatewayError(body, `Gateway HTTP ${response.status}`, response.status)
  }
  return response.blob()
}

async function downloadAudioToNativeFile(settings: GatewaySettings, bookId: string, chapterId: string) {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  if (!settings.token.trim()) {
    throw new Error('请填写 Token')
  }

  const metadata = getDeviceMetadata(appVersion)
  return NativeAudio.downloadAudio({
    bookId,
    chapterId,
    appVersion: metadata.appVersion,
    deviceId: settings.deviceId,
    deviceModel: metadata.model,
    deviceName: settings.deviceName.trim() || 'Android Phone',
    devicePlatform: metadata.platform,
    token: settings.token.trim(),
    url: `${baseUrl}/mobile/books/${encodeURIComponent(bookId)}/audio/${encodeURIComponent(chapterId)}/download`,
  })
}

async function downloadAudioManifestToNativeFile(settings: GatewaySettings, bookId: string, chapterId: string) {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  if (!settings.token.trim()) {
    throw new Error('请填写 Token')
  }

  const metadata = getDeviceMetadata(appVersion)
  return NativeAudio.downloadAudioManifest({
    bookId,
    chapterId,
    appVersion: metadata.appVersion,
    deviceId: settings.deviceId,
    deviceModel: metadata.model,
    deviceName: settings.deviceName.trim() || 'Android Phone',
    devicePlatform: metadata.platform,
    token: settings.token.trim(),
    url: `${baseUrl}/mobile/books/${encodeURIComponent(bookId)}/audio/${encodeURIComponent(chapterId)}/manifest`,
  })
}

async function downloadPackageToNativeFile(settings: GatewaySettings, bookId: string) {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || baseUrl === 'https:') {
    throw new Error('请填写 Gateway 地址')
  }
  if (!settings.token.trim()) {
    throw new Error('请填写 Token')
  }

  const metadata = getDeviceMetadata(appVersion)
  return NativeAudio.downloadPackage({
    bookId,
    appVersion: metadata.appVersion,
    deviceId: settings.deviceId,
    deviceModel: metadata.model,
    deviceName: settings.deviceName.trim() || 'Android Phone',
    devicePlatform: metadata.platform,
    token: settings.token.trim(),
    url: `${baseUrl}/mobile/books/${encodeURIComponent(bookId)}/package/download`,
  })
}

async function importPackageToNativeStore(bookId: string, filePath: string, expectedChapterCount?: number) {
  return NativeAudio.importPackage({
    bookId,
    filePath,
    expectedChapterCount,
  })
}

async function listLocalBookSummaries(): Promise<BookSummary[]> {
  const fullPackageIndex = loadFullPackageCacheIndex()
  const audioIndex = loadAudioCacheIndex()
  const cachedPackages = await listCachedBookPackages()
  const bookIds = new Set<string>([...Object.keys(fullPackageIndex), ...cachedPackages.map((entry) => entry.bookId)])
  const books = await Promise.all(
    Array.from(bookIds).map(async (bookId) => {
      const cache = fullPackageIndex[bookId] ?? null
      const indexedPackage = cachedPackages.find((entry) => entry.bookId === bookId)?.package ?? null
      const cachedPackage = indexedPackage ?? (await loadCachedBookPackage(bookId))
      const packageBook = cachedPackage?.book
      const localAudioChapterCount = Object.values(audioIndex).filter((record) => record.bookId === bookId).length
      return {
        id: bookId,
        title: packageBook?.title || cache?.title || bookId,
        author: packageBook?.author || cache?.author,
        chapterCount: packageBook?.chapterCount || cache?.chapterCount || cache?.importStats?.chapterCount || packageChapters(cachedPackage).length || 0,
        wordCount: packageBook?.wordCount ?? cache?.wordCount,
        summaryCoverage: packageBook?.summaryCoverage,
        kgCoverage: packageBook?.kgCoverage,
        embeddingCoverage: packageBook?.embeddingCoverage,
        audioChapterCount: packageBook?.audioChapterCount,
        localAudioChapterCount,
        updatedAt: packageBook?.updatedAt || cache?.updatedAt || cache?.importedAt || cache?.cachedAt || new Date().toISOString(),
      } satisfies BookSummary
    }),
  )
  return books.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))
}

function loadFullPackageCache(bookId?: string | null): FullPackageCache | null {
  const index = loadFullPackageCacheIndex()
  if (bookId) return index[bookId] ?? null

  const progress = loadLatestReadingProgress()
  if (progress?.bookId && index[progress.bookId]) return index[progress.bookId]

  const indexedCaches = Object.values(index).sort((left, right) => Date.parse(right.importedAt || right.cachedAt) - Date.parse(left.importedAt || left.cachedAt))
  if (indexedCaches[0]) return indexedCaches[0]
  return null
}

function loadFullPackageCacheIndex(): Record<string, FullPackageCache> {
  const index: Record<string, FullPackageCache> = {}
  try {
    const parsed = JSON.parse(localStorage.getItem(fullPackageCacheIndexKey) || '{}') as unknown
    if (isRecord(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        const cache = normalizeFullPackageCache(value)
        if (cache && cache.bookId === key) index[key] = cache
      }
    }
  } catch {
    // Ignore invalid cache index and fall back to the legacy single-book key.
  }

  return index
}

function loadLegacyFullPackageCache(): FullPackageCache | null {
  try {
    const cached = localStorage.getItem(fullPackageCacheKey)
    if (!cached) return null
    const parsed = JSON.parse(cached) as unknown
    return normalizeFullPackageCache(parsed)
  } catch {
    return null
  }
}

function normalizeFullPackageCache(value: unknown): FullPackageCache | null {
  if (!isRecord(value)) return null
  if (typeof value.bookId !== 'string' || typeof value.filePath !== 'string') return null
  if (typeof value.sizeBytes !== 'number' || typeof value.cachedAt !== 'string') return null
  return {
    bookId: value.bookId,
    title: typeof value.title === 'string' ? value.title : undefined,
    author: typeof value.author === 'string' ? value.author : undefined,
    chapterCount: typeof value.chapterCount === 'number' ? value.chapterCount : undefined,
    wordCount: typeof value.wordCount === 'number' ? value.wordCount : undefined,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
    filePath: value.filePath,
    sizeBytes: value.sizeBytes,
    cachedAt: value.cachedAt,
    importedAt: typeof value.importedAt === 'string' ? value.importedAt : undefined,
    importStats: normalizeFullPackageImportStats(value.importStats),
    metadataPath: typeof value.metadataPath === 'string' ? value.metadataPath : undefined,
  }
}

function saveFullPackageCache(cache: FullPackageCache) {
  const index = loadFullPackageCacheIndex()
  index[cache.bookId] = cache
  try {
    localStorage.removeItem(fullPackageCacheKey)
  } catch {
    // Best effort: the legacy single-book cache is optional.
  }
  try {
    localStorage.setItem(fullPackageCacheIndexKey, JSON.stringify(index))
  } catch {
    removeLegacyBookPackageCachesFromLocalStorage()
    try {
      localStorage.setItem(fullPackageCacheIndexKey, JSON.stringify(index))
    } catch {
      // The native file/import already succeeded; a localStorage quota issue must not abort sync.
    }
  }
  try {
    localStorage.setItem(fullPackageCacheKey, JSON.stringify(cache))
  } catch {
    // Keep this compatibility key best-effort only. The indexed cache above is authoritative.
  }
}

function removeLegacyBookPackageCachesFromLocalStorage() {
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(packageCachePrefix)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // Ignore storage enumeration failures in constrained WebViews.
  }
}

function removeFullPackageCache(bookId: string) {
  const index = loadFullPackageCacheIndex()
  delete index[bookId]
  localStorage.setItem(fullPackageCacheIndexKey, JSON.stringify(index))
  const legacy = loadLegacyFullPackageCache()
  if (legacy?.bookId === bookId) {
    localStorage.removeItem(fullPackageCacheKey)
  }
}

function parseJsonBody(value: string) {
  try {
    return JSON.parse(value) as { error?: { message?: string } } & Record<string, unknown>
  } catch {
    return {}
  }
}

export function loadAppLogEntriesFromStorage(storage: Pick<Storage, 'getItem'>): AppLogEntry[] {
  try {
    const parsed = JSON.parse(storage.getItem(appLogKey) || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(normalizeAppLogEntry).filter((entry): entry is AppLogEntry => Boolean(entry))
  } catch {
    return []
  }
}

export function appendAppLogToStorage(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  level: AppLogLevel,
  message: string,
  context?: unknown,
  source = 'app',
) {
  const entry: AppLogEntry = {
    id: createAppLogId(),
    timestamp: new Date().toISOString(),
    level,
    message: String(message || level).slice(0, maxLogMessageLength),
    source,
    context: sanitizeLogValue(context),
  }
  const entries = [...loadAppLogEntriesFromStorage(storage), entry].slice(-maxAppLogEntries)
  saveAppLogEntries(storage, entries)
  return entry
}

function clearAppLogsFromStorage(storage: Pick<Storage, 'removeItem'>) {
  storage.removeItem(appLogKey)
}

function loadLatestIssueFromStorage(storage: Pick<Storage, 'getItem'>) {
  return [...loadAppLogEntriesFromStorage(storage)].reverse().find((entry) => entry.level === 'error' || entry.level === 'warn') ?? null
}

export function buildSubmittedAppLogs(entries: AppLogEntry[], latestIssue: AppLogEntry | null) {
  const nextEntries = latestIssue && !entries.some((entry) => entry.id === latestIssue.id) ? [...entries, latestIssue] : entries
  return nextEntries.slice(-maxSubmittedLogEntries)
}

function saveAppLogEntries(storage: Pick<Storage, 'setItem'>, entries: AppLogEntry[]) {
  let safeEntries = entries
  while (safeEntries.length > 0) {
    try {
      storage.setItem(appLogKey, JSON.stringify(safeEntries))
      return
    } catch {
      safeEntries = safeEntries.slice(Math.ceil(safeEntries.length / 2))
    }
  }
}

function normalizeAppLogEntry(value: unknown): AppLogEntry | null {
  if (!isRecord(value)) return null
  const level = value.level === 'info' || value.level === 'warn' || value.level === 'error' ? value.level : null
  const message = typeof value.message === 'string' ? value.message : ''
  const timestamp = typeof value.timestamp === 'string' ? value.timestamp : ''
  if (!level || !message || !timestamp) return null
  return {
    id: typeof value.id === 'string' && value.id ? value.id : createAppLogId(),
    timestamp,
    level,
    message: message.slice(0, maxLogMessageLength),
    source: typeof value.source === 'string' ? value.source.slice(0, 80) : undefined,
    context: sanitizeLogValue(value.context),
  }
}

function createAppLogId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `log-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function serializeErrorForLog(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 8).join('\n') : undefined,
      ...(error instanceof GatewayError ? { code: error.code, statusCode: error.statusCode } : {}),
    }
  }
  return sanitizeLogValue(error)
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.slice(0, 500)
  if (depth >= 4) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeLogValue(entry, depth + 1))
  if (!isRecord(value)) return String(value).slice(0, 200)
  return Object.fromEntries(
    Object.entries(value).slice(0, 40).map(([key, entry]) => [
      key,
      /token|authorization|password|secret/i.test(key) ? '[redacted]' : sanitizeLogValue(entry, depth + 1),
    ]),
  )
}

function redactUrlForLog(url: string) {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/token|secret|key|auth/i.test(key)) parsed.searchParams.set(key, '[redacted]')
    }
    return parsed.toString().slice(0, 500)
  } catch {
    return url.replace(/([?&](?:token|secret|key|auth)=)[^&]+/gi, '$1[redacted]').slice(0, 500)
  }
}

function capacitorDataToBlob(value: unknown) {
  if (value instanceof Blob) return value
  if (typeof value === 'string') {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return new Blob([bytes], { type: 'audio/mpeg' })
  }
  return new Blob([], { type: 'audio/mpeg' })
}

function loadSettings(): GatewaySettings {
  return loadGatewaySettings(localStorage, settingsKey, defaultSettings)
}

function isGatewayConfigured(settings: GatewaySettings) {
  const baseUrl = settings.baseUrl.trim()
  return Boolean(baseUrl && baseUrl !== 'https://' && baseUrl !== 'https:' && settings.token.trim())
}

function loadReaderSettings(): ReaderSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(readerSettingsKey) || 'null') as Partial<ReaderSettings> | null
    const background = isReaderBackground(parsed?.background) ? parsed.background : defaultReaderSettings.background
    const fontSize = typeof parsed?.fontSize === 'number' ? Math.min(28, Math.max(15, parsed.fontSize)) : defaultReaderSettings.fontSize
    return { fontSize, background }
  } catch {
    return defaultReaderSettings
  }
}

function loadTtsSettings(): TtsSettings {
  try {
    return normalizeTtsSettings(JSON.parse(localStorage.getItem(ttsSettingsKey) || 'null') as Partial<TtsSettings> | null)
  } catch {
    return defaultTtsSettings
  }
}

function normalizeTtsSettings(settings: Partial<TtsSettings> | null | undefined): TtsSettings {
  return {
    engine: settings?.engine === 'local-tts' || settings?.engine === 'cloud-mp3' ? settings.engine : defaultTtsSettings.engine,
    locale: typeof settings?.locale === 'string' && settings.locale.trim() ? settings.locale.trim() : defaultTtsSettings.locale,
    voiceId: typeof settings?.voiceId === 'string' ? settings.voiceId : defaultTtsSettings.voiceId,
    rate: clampNumber(settings?.rate, MIN_TTS_RATE, MAX_TTS_RATE, defaultTtsSettings.rate),
    pitch: clampNumber(settings?.pitch, MIN_TTS_PITCH, MAX_TTS_PITCH, defaultTtsSettings.pitch),
    autoFollow: typeof settings?.autoFollow === 'boolean' ? settings.autoFollow : defaultTtsSettings.autoFollow,
  }
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback
}

function closestRatePresetIndex(value: number) {
  return TTS_RATE_PRESETS.reduce(
    (bestIndex, rate, index) => (Math.abs(rate - value) < Math.abs(TTS_RATE_PRESETS[bestIndex] - value) ? index : bestIndex),
    0,
  )
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer != null) window.clearTimeout(timer)
  })
}

export function normalizeReadingProgress(value: unknown): ReadingProgress | null {
  if (!isRecord(value) || typeof value.bookId !== 'string' || typeof value.chapterId !== 'string') return null
  return {
    bookId: value.bookId,
    chapterId: value.chapterId,
    scrollY: typeof value.scrollY === 'number' && Number.isFinite(value.scrollY) ? Math.max(0, value.scrollY) : 0,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date().toISOString(),
  }
}

export function normalizeReadingProgressStore(value: unknown): ReadingProgressStore {
  const store: ReadingProgressStore = { schemaVersion: 2, books: {} }
  const legacyProgress = normalizeReadingProgress(value)
  if (legacyProgress) {
    store.books[legacyProgress.bookId] = legacyProgress
    return store
  }

  if (!isRecord(value) || value.schemaVersion !== 2 || !isRecord(value.books)) return store

  for (const progressValue of Object.values(value.books)) {
    const progress = normalizeReadingProgress(progressValue)
    if (progress) store.books[progress.bookId] = progress
  }
  return store
}

export function loadReadingProgressFromStorage(storage: Pick<ReadingProgressStorage, 'getItem'>, bookId: string): ReadingProgress | null {
  return loadReadingProgressStoreFromStorage(storage).books[bookId] ?? null
}

export function loadLatestReadingProgressFromStorage(storage: Pick<ReadingProgressStorage, 'getItem'>): ReadingProgress | null {
  const store = loadReadingProgressStoreFromStorage(storage)
  return Object.values(store.books).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null
}

export function saveReadingProgressToStorage(storage: Pick<ReadingProgressStorage, 'getItem' | 'setItem'>, progress: ReadingProgress) {
  const store = loadReadingProgressStoreFromStorage(storage)
  store.books[progress.bookId] = progress
  storage.setItem(readingProgressKey, JSON.stringify(store))
}

export function removeReadingProgressFromStorage(storage: ReadingProgressStorage, bookId: string) {
  const store = loadReadingProgressStoreFromStorage(storage)
  delete store.books[bookId]
  if (Object.keys(store.books).length) {
    storage.setItem(readingProgressKey, JSON.stringify(store))
  } else {
    storage.removeItem(readingProgressKey)
  }
}

function loadReadingProgressStoreFromStorage(storage: Pick<ReadingProgressStorage, 'getItem'>): ReadingProgressStore {
  try {
    return normalizeReadingProgressStore(JSON.parse(storage.getItem(readingProgressKey) || 'null'))
  } catch {
    return { schemaVersion: 2, books: {} }
  }
}

function loadReadingProgress(bookId: string): ReadingProgress | null {
  return loadReadingProgressFromStorage(localStorage, bookId)
}

function loadLatestReadingProgress(): ReadingProgress | null {
  return loadLatestReadingProgressFromStorage(localStorage)
}

function saveReadingProgress(progress: ReadingProgress) {
  try {
    saveReadingProgressToStorage(localStorage, progress)
  } catch {
    // Best effort; reading should continue even if the WebView storage is full.
  }
}

function removeReadingProgress(bookId: string) {
  try {
    removeReadingProgressFromStorage(localStorage, bookId)
  } catch {
    // Best effort; stale progress is harmless and can be overwritten later.
  }
}

function persistReadingProgress(bookId: string | null, chapterId: string | null, scrollY: number) {
  if (!bookId || !chapterId) return
  saveReadingProgress({
    bookId,
    chapterId,
    scrollY: Math.max(0, scrollY),
    updatedAt: new Date().toISOString(),
  })
}

function isReaderBackground(value: unknown): value is ReaderBackground {
  return value === 'paper' || value === 'warm' || value === 'green' || value === 'dark'
}

function backgroundLabel(background: ReaderBackground) {
  if (background === 'warm') return '暖色'
  if (background === 'green') return '护眼'
  if (background === 'dark') return '夜间'
  return '纸张'
}

function connectionLabel(state: ConnectionState) {
  if (state === 'connected') return '已连接'
  if (state === 'checking') return '连接中'
  if (state === 'error') return '连接失败'
  return '未连接'
}

function findMatchingLocalBook(cloudBook: BookSummary, localBooks: BookSummary[]) {
  const exactMatch = localBooks.find((book) => book.id === cloudBook.id)
  if (exactMatch) return exactMatch

  const cloudTitle = normalizeBookTitle(cloudBook.title)
  return (
    localBooks.find((book) => {
      if (normalizeBookTitle(book.title) !== cloudTitle) return false
      if (book.chapterCount && cloudBook.chapterCount && book.chapterCount !== cloudBook.chapterCount) return false
      return true
    }) ?? null
  )
}

function normalizeBookTitle(title: string) {
  return title.trim().replace(/\s+/g, '').toLocaleLowerCase()
}

function formatBookMeta(book: BookSummary, audioChapterCount = book.audioChapterCount) {
  const parts = [`${book.chapterCount} 章`]
  if (book.author) parts.push(book.author)
  if (audioChapterCount) parts.push(`${audioChapterCount} 可缓存音频`)
  return parts.join(' · ')
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function packageSummary(bookPackage: BookPackage) {
  const chapterCount = packageChapters(bookPackage).length
  return chapterCount > 0 ? `${chapterCount} 章` : '已加载'
}

function packageLabel(bookPackage: BookPackage | null, book: BookSummary | null, fullPackage: FullPackageCache | null) {
  if (bookPackage) return packageSummary(bookPackage)
  const importedChapterCount = fullPackage?.importStats?.chapterCount ?? 0
  if (hasImportedPackage(fullPackage)) return importedChapterCount > 0 ? `${importedChapterCount} 章` : '已导入'
  if (book?.chapterCount) return `${book.chapterCount} 章`
  return '未加载'
}

function packageChapters(bookPackage: BookPackage | null): Chapter[] {
  if (!bookPackage || !Array.isArray(bookPackage.chapters)) return []
  return bookPackage.chapters.filter(isChapter).sort((left, right) => {
    const leftIndex = left.index ?? left.chapterIndex ?? 0
    const rightIndex = right.index ?? right.chapterIndex ?? 0
    return leftIndex - rightIndex || left.title.localeCompare(right.title)
  })
}

function chapterContent(chapter: Chapter) {
  return chapter.content ?? chapter.text ?? ''
}

function normalizeBookPackage(value: unknown): BookPackage {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.book)) {
    throw new Error('Gateway 返回的数据包格式无效')
  }

  const rawChapters = Array.isArray(value.chapters)
    ? value.chapters.map(normalizeChapter).filter((chapter): chapter is Chapter => Boolean(chapter))
    : []
  return {
    ...value,
    schemaVersion: 1,
    book: value.book as BookSummary,
    chapters: rawChapters,
  }
}

async function cacheBookPackage(bookId: string, bookPackage: BookPackage) {
  const indexedDbCached = await writeBookPackageToIndexedDb(bookId, bookPackage)
  if (indexedDbCached) {
    try {
      localStorage.removeItem(`${packageCachePrefix}${bookId}`)
    } catch {
      // Ignore cleanup failures; IndexedDB already has the current package.
    }
    return true
  }

  try {
    localStorage.setItem(`${packageCachePrefix}${bookId}`, JSON.stringify(bookPackage))
    return true
  } catch {
    return false
  }
}

async function loadCachedBookPackage(bookId: string): Promise<BookPackage | null> {
  const indexedDbPackage = await readBookPackageFromIndexedDb(bookId)
  if (indexedDbPackage) return indexedDbPackage

  try {
    const cached = localStorage.getItem(`${packageCachePrefix}${bookId}`)
    return cached ? normalizeBookPackage(JSON.parse(cached) as unknown) : null
  } catch {
    return null
  }
}

async function writeBookPackageToIndexedDb(bookId: string, bookPackage: BookPackage) {
  try {
    const db = await openPackageCacheDb()
    await runPackageStoreRequest(db, 'readwrite', packageCacheStoreName, (store) =>
      store.put({
        bookId,
        package: bookPackage,
        cachedAt: new Date().toISOString(),
      }),
    )
    db.close()
    return true
  } catch {
    return false
  }
}

async function readBookPackageFromIndexedDb(bookId: string) {
  try {
    const db = await openPackageCacheDb()
    const record = await runPackageStoreRequest(db, 'readonly', packageCacheStoreName, (store) => store.get(bookId))
    db.close()
    if (!isRecord(record)) return null
    return normalizeBookPackage(record.package)
  } catch {
    return null
  }
}

async function listCachedBookPackages() {
  const records: Array<{ bookId: string; package: BookPackage }> = []
  try {
    const db = await openPackageCacheDb()
    const values = await runPackageStoreRequest<unknown[]>(db, 'readonly', packageCacheStoreName, (store) => store.getAll())
    db.close()
    for (const value of values) {
      if (!isRecord(value) || typeof value.bookId !== 'string') continue
      try {
        records.push({
          bookId: value.bookId,
          package: normalizeBookPackage(value.package),
        })
      } catch {
        // Skip stale or malformed cached packages.
      }
    }
  } catch {
    // IndexedDB can be unavailable in constrained webviews; fall back to localStorage below.
  }

  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key?.startsWith(packageCachePrefix)) continue
      const bookId = key.slice(packageCachePrefix.length)
      if (!bookId || records.some((record) => record.bookId === bookId)) continue
      const raw = localStorage.getItem(key)
      if (!raw) continue
      records.push({
        bookId,
        package: normalizeBookPackage(JSON.parse(raw) as unknown),
      })
    }
  } catch {
    // Best effort only.
  }

  return records
}

async function deleteBookPackageFromIndexedDb(bookId: string) {
  try {
    const db = await openPackageCacheDb()
    await runPackageStoreRequest(db, 'readwrite', packageCacheStoreName, (store) => store.delete(bookId))
    db.close()
  } catch {
    // Best effort; package file/index cleanup should still continue.
  }
}

function writeCachedAudio(bookId: string, audioChapter: AudioChapter, payload: AudioCachePayload) {
  writeCachedAudioToStorage(localStorage, bookId, audioChapter, payload)
}

export function writeCachedAudioToStorage(
  storage: AudioCacheStorage,
  bookId: string,
  audioChapter: AudioChapter,
  payload: AudioCachePayload,
) {
  if (payload.kind !== 'file') return
  const index = loadAudioCacheIndexFromStorage(storage)
  index[audioCacheKey(bookId, audioChapter.chapterId)] = {
    bookId,
    chapterId: audioChapter.chapterId,
    audioChapter,
    filePath: payload.filePath,
    manifest: payload.manifest ?? null,
    manifestFilePath: payload.manifestFilePath,
    sizeBytes: payload.sizeBytes || audioChapter.sizeBytes,
    cachedAt: new Date().toISOString(),
    updatedAt: audioChapter.updatedAt,
  }
  saveAudioCacheIndexToStorage(storage, index)
}

function updateCachedAudioManifest(
  bookId: string,
  chapterId: string,
  payload: Pick<CachedAudioRecord, 'manifest' | 'manifestFilePath'>,
) {
  updateCachedAudioManifestInStorage(localStorage, bookId, chapterId, payload)
}

export function updateCachedAudioManifestInStorage(
  storage: AudioCacheStorage,
  bookId: string,
  chapterId: string,
  payload: Pick<CachedAudioRecord, 'manifest' | 'manifestFilePath'>,
) {
  const index = loadAudioCacheIndexFromStorage(storage)
  const key = audioCacheKey(bookId, chapterId)
  const record = index[key]
  if (!record) return
  index[key] = {
    ...record,
    manifest: payload.manifest ?? record.manifest ?? null,
    manifestFilePath: payload.manifestFilePath || record.manifestFilePath,
  }
  saveAudioCacheIndexToStorage(storage, index)
}

function readCachedAudio(bookId: string, chapterId: string): CachedAudio | null {
  return readCachedAudioFromStorage(localStorage, bookId, chapterId)
}

export function readCachedAudioFromStorage(storage: Pick<AudioCacheStorage, 'getItem'>, bookId: string, chapterId: string): CachedAudio | null {
  const record = loadAudioCacheIndexFromStorage(storage)[audioCacheKey(bookId, chapterId)]
  if (!record?.filePath) return null
  const manifest = isRecord(record.manifest) ? normalizeAudioManifest(record.manifest) : null
  return {
    filePath: record.filePath,
    manifest,
    manifestFilePath: typeof record.manifestFilePath === 'string' && record.manifestFilePath ? record.manifestFilePath : undefined,
    sizeBytes: record.sizeBytes,
  }
}

function readCachedAudioChapter(bookId: string, chapterId: string): AudioChapter | null {
  return readCachedAudioChapterFromStorage(localStorage, bookId, chapterId)
}

export function readCachedAudioChapterFromStorage(storage: Pick<AudioCacheStorage, 'getItem'>, bookId: string, chapterId: string): AudioChapter | null {
  const record = loadAudioCacheIndexFromStorage(storage)[audioCacheKey(bookId, chapterId)]
  if (!record?.filePath || record.chapterId !== chapterId) return null
  return record.audioChapter
}

async function listCachedAudioChapterIds(bookId: string) {
  return listCachedAudioChapterIdsFromStorage(localStorage, bookId)
}

export function listCachedAudioChapterIdsFromStorage(storage: Pick<AudioCacheStorage, 'getItem'>, bookId: string) {
  return Object.values(loadAudioCacheIndexFromStorage(storage))
    .filter((record) => record.bookId === bookId)
    .map((record) => record.chapterId)
}

function loadAudioCacheIndex(): Record<string, CachedAudioRecord> {
  return loadAudioCacheIndexFromStorage(localStorage)
}

export function loadAudioCacheIndexFromStorage(storage: Pick<AudioCacheStorage, 'getItem'>): Record<string, CachedAudioRecord> {
  try {
    const parsed = JSON.parse(storage.getItem(audioCacheIndexKey) || '{}') as unknown
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, CachedAudioRecord] => {
        const record = entry[1]
        return (
          isRecord(record) &&
          typeof record.bookId === 'string' &&
          typeof record.chapterId === 'string' &&
          typeof record.filePath === 'string' &&
          record.filePath.length > 0 &&
          isAudioChapter(record.audioChapter)
        )
      }),
    )
  } catch {
    return {}
  }
}

function saveAudioCacheIndex(index: Record<string, CachedAudioRecord>) {
  saveAudioCacheIndexToStorage(localStorage, index)
}

function saveAudioCacheIndexToStorage(storage: Pick<AudioCacheStorage, 'setItem'>, index: Record<string, CachedAudioRecord>) {
  try {
    storage.setItem(audioCacheIndexKey, JSON.stringify(index))
  } catch {
    // Audio files remain on disk; this only affects the cached-count display.
  }
}

function audioCacheKey(bookId: string, chapterId: string) {
  return `${bookId}:${chapterId}`
}

function audioDownloadQueueKey(bookId: string, chapterId: string) {
  return `${bookId}:${chapterId}`
}

export function gatewayUserFacingError(error: unknown) {
  const message = errorMessage(error)
  if (/bearer token is invalid/i.test(message)) return 'Gateway Token 无效，请在设置页检查 Token 后重试。'
  return message
}

export function ragFallbackStatus(error: unknown, fallbackCount: number) {
  const reason = gatewayUserFacingError(error).replace(/[。.]$/, '')
  return `Gateway embedding 检索失败${reason ? `：${reason}` : ''}；已自动改用本地关键词检索，召回 ${fallbackCount} 个相关章节。`
}

type ChapterAudioReference =
  | string
  | {
      id?: string
      chapterId?: string
      index?: number
      chapterIndex?: number
    }
  | null
  | undefined

export function resolveCurrentAudio(
  currentChapter: ChapterAudioReference,
  visibleAudioChapters: AudioChapter[],
  cachedAudioChapter: AudioChapter | null,
  bookId?: string,
) {
  const currentChapterId = chapterAudioReferenceId(currentChapter)
  if (!currentChapterId) return null
  return (
    findAudioChapterForReference(currentChapter, visibleAudioChapters, bookId) ??
    (cachedAudioChapter && chapterAudioReferencesMatch(bookId, currentChapter, cachedAudioChapter.chapterId) ? cachedAudioChapter : null)
  )
}

function findAudioChapterForReference(reference: ChapterAudioReference, audioChapters: AudioChapter[], bookId?: string) {
  const exactId = chapterAudioReferenceId(reference)
  const exact = exactId ? audioChapters.find((chapter) => chapter.chapterId === exactId) : null
  if (exact) return exact
  const referenceKeys = chapterAudioReferenceKeys(bookId, reference)
  return audioChapters.find((chapter) => hasSharedChapterAudioKey(referenceKeys, chapterAudioReferenceKeys(bookId, chapter.chapterId))) ?? null
}

function chapterAudioReferencesMatch(bookId: string | undefined, left: ChapterAudioReference, right: ChapterAudioReference) {
  const leftId = chapterAudioReferenceId(left)
  const rightId = chapterAudioReferenceId(right)
  if (leftId && rightId && leftId === rightId) return true
  return hasSharedChapterAudioKey(chapterAudioReferenceKeys(bookId, left), chapterAudioReferenceKeys(bookId, right))
}

function chapterAudioReferenceId(reference: ChapterAudioReference) {
  if (!reference) return ''
  if (typeof reference === 'string') return reference.trim()
  return (reference.id ?? reference.chapterId ?? '').trim()
}

function chapterAudioReferenceKeys(bookId: string | undefined, reference: ChapterAudioReference) {
  const keys = new Set<string>()
  const id = chapterAudioReferenceId(reference)
  if (id) {
    keys.add(`id:${id}`)
    for (const candidate of chapterAudioIdCandidates(bookId, id)) {
      const ordinal = chapterOrdinalFromId(candidate)
      if (ordinal != null) keys.add(`chapter:${ordinal}`)
    }
  }
  if (reference && typeof reference !== 'string') {
    const index = Number.isSafeInteger(reference.index) && reference.index! > 0 ? reference.index : reference.chapterIndex
    if (Number.isSafeInteger(index) && index! > 0) keys.add(`chapter:${index}`)
  }
  return keys
}

function chapterAudioIdCandidates(bookId: string | undefined, rawId: string) {
  const trimmed = rawId.trim()
  const candidates = new Set<string>([trimmed])
  if (bookId && trimmed.startsWith(`${bookId}:`)) candidates.add(trimmed.slice(bookId.length + 1))
  const tail = trimmed.includes(':') ? trimmed.split(':').at(-1) : ''
  if (tail) candidates.add(tail)
  return candidates
}

function chapterOrdinalFromId(id: string) {
  const normalized = id.trim().toLowerCase()
  const match = /^(?:ch|chapter[-_]?)0*(\d+)$/.exec(normalized) ?? /^0*(\d+)$/.exec(normalized)
  if (!match) return null
  const ordinal = Number(match[1])
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : null
}

function hasSharedChapterAudioKey(left: Set<string>, right: Set<string>) {
  for (const key of left) {
    if (right.has(key)) return true
  }
  return false
}

type AudioChapterStatusRow = {
  chapterId: string
  index: number
  title: string
  cached: boolean
  hasAudio: boolean
  isCurrent: boolean
  audioChapter: AudioChapter | null
}

export function buildAudioChapterStatusRows(
  chapters: Chapter[],
  audioChapters: AudioChapter[],
  cachedAudioIds: Set<string>,
  currentChapterId: string | null | undefined,
  bookId?: string,
): AudioChapterStatusRow[] {
  const cachedAudioKeys = new Set(
    Array.from(cachedAudioIds).flatMap((chapterId) => Array.from(chapterAudioReferenceKeys(bookId, chapterId))),
  )
  return chapters.map((chapter, index) => ({
    chapterId: chapter.id,
    index: chapter.index ?? chapter.chapterIndex ?? index + 1,
    title: chapter.title,
    cached: cachedAudioIds.has(chapter.id) || hasSharedChapterAudioKey(chapterAudioReferenceKeys(bookId, chapter), cachedAudioKeys),
    hasAudio:
      Boolean(findAudioChapterForReference(chapter, audioChapters, bookId)) ||
      cachedAudioIds.has(chapter.id) ||
      hasSharedChapterAudioKey(chapterAudioReferenceKeys(bookId, chapter), cachedAudioKeys),
    isCurrent: chapter.id === currentChapterId,
    audioChapter: findAudioChapterForReference(chapter, audioChapters, bookId),
  }))
}

type HighlightScrollTarget = Pick<Element, 'getBoundingClientRect'>

type HighlightScrollViewport = {
  innerHeight?: number
  pageYOffset?: number
  scrollY?: number
  scrollTo: (options: ScrollToOptions) => void
  document?: {
    documentElement?: {
      clientHeight?: number
      scrollTop?: number
    }
  }
}

type HighlightScrollBounds = {
  top?: number
  bottom?: number
}

export function scrollElementStartToViewportCenter(
  target: HighlightScrollTarget,
  behavior: ScrollBehavior = 'smooth',
  viewport: HighlightScrollViewport = window,
  readableBounds: HighlightScrollBounds = {},
) {
  const targetBounds = target.getBoundingClientRect()
  const viewportHeight = viewport.innerHeight || viewport.document?.documentElement?.clientHeight || 0
  const currentScrollY = viewport.scrollY || viewport.pageYOffset || viewport.document?.documentElement?.scrollTop || 0
  const visibleTop = Math.max(0, readableBounds.top ?? 0)
  const visibleBottom = Math.max(visibleTop, Math.min(viewportHeight, readableBounds.bottom ?? viewportHeight))
  const visibleCenter = visibleTop + (visibleBottom - visibleTop) / 2
  const targetScrollTop = Math.max(0, targetBounds.top + currentScrollY - visibleCenter)
  viewport.scrollTo({ top: targetScrollTop, behavior })
}

function buildBookCacheSummaries(books: BookSummary[], version: number): BookCacheSummary[] {
  void version
  const bookTitles = new Map(books.map((book) => [book.id, book.title]))
  const packageIndex = loadFullPackageCacheIndex()
  const audioIndex = loadAudioCacheIndex()
  const bookIds = new Set<string>([...bookTitles.keys(), ...Object.keys(packageIndex), ...Object.values(audioIndex).map((record) => record.bookId)])
  return Array.from(bookIds)
    .map((bookId) => {
      const audioRecords = Object.values(audioIndex).filter((record) => record.bookId === bookId)
      const audioSizeBytes = audioRecords.reduce((total, record) => total + (record.sizeBytes ?? record.audioChapter.sizeBytes ?? 0), 0)
      const packageCache = packageIndex[bookId] ?? null
      return {
        bookId,
        title: bookTitles.get(bookId) ?? packageCache?.bookId ?? bookId,
        packageCache,
        audioCount: audioRecords.length,
        audioSizeBytes,
        totalSizeBytes: audioSizeBytes + (packageCache?.sizeBytes ?? 0),
      }
    })
    .filter((summary) => summary.packageCache || summary.audioCount > 0)
    .sort((left, right) => right.totalSizeBytes - left.totalSizeBytes || left.title.localeCompare(right.title))
}

function openPackageCacheDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is not available.'))
      return
    }

    const request = indexedDB.open(packageCacheDbName, 3)
    request.onerror = () => reject(request.error ?? new Error('Failed to open package cache.'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(packageCacheStoreName)) {
        db.createObjectStore(packageCacheStoreName, { keyPath: 'bookId' })
      }
      if (db.objectStoreNames.contains(legacyAudioCacheStoreName)) {
        db.deleteObjectStore(legacyAudioCacheStoreName)
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

async function clearLegacyAudioIndexedDbCache() {
  try {
    const db = await openPackageCacheDb()
    db.close()
  } catch {
    // Best effort cleanup for old audio Blob records.
  }
}

function runPackageStoreRequest<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  storeName: string,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>,
) {
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const request = createRequest(transaction.objectStore(storeName))
    request.onerror = () => reject(request.error ?? new Error('Package cache request failed.'))
    request.onsuccess = () => resolve(request.result)
    transaction.onerror = () => reject(transaction.error ?? new Error('Package cache transaction failed.'))
  })
}

function isChapter(value: unknown): value is Chapter {
  return normalizeChapter(value) !== null
}

function normalizeChapter(value: unknown): Chapter | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' || typeof value.id === 'number' ? String(value.id).trim() : ''
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  if (!id || !title) return null
  const index = readOptionalInteger(value.index)
  const chapterIndex = readOptionalInteger(value.chapterIndex)
  return {
    ...value,
    id,
    title,
    index,
    chapterIndex,
  } as Chapter
}

function isAudioChapter(value: unknown): value is AudioChapter {
  if (!isRecord(value)) return false
  return typeof value.chapterId === 'string' && typeof value.fileName === 'string'
}

function normalizeAudioManifest(value: Record<string, unknown>): AudioManifest | null {
  const timeline = Array.isArray(value.timeline) ? value.timeline.filter(isAudioTimelineEntry) : []
  return {
    version: readOptionalInteger(value.version),
    timelineVersion: readOptionalInteger(value.timelineVersion),
    duration: typeof value.duration === 'number' ? value.duration : undefined,
    timeline,
  }
}

function isAudioTimelineEntry(value: unknown): value is AudioTimelineEntry {
  if (!isRecord(value)) return false
  return typeof value.startTime === 'number' && typeof value.endTime === 'number'
}

function findActiveTimelineEntry(manifest: AudioManifest | null, currentTime: number) {
  const timeline = manifest?.timeline
  if (!timeline?.length) return null
  return (
    timeline.find((entry) => {
      const start = entry.startTime ?? 0
      const end = entry.nextStartTime ?? entry.endTime ?? start
      return currentTime >= start && currentTime < end
    }) ?? null
  )
}

function splitHighlightedText(text: string, activeEntry?: AudioTimelineEntry | null) {
  if (!activeEntry) return null
  const start = readBoundedIndex(activeEntry.sourceStart, text.length)
  const end = readBoundedIndex(activeEntry.sourceEnd, text.length)
  if (start == null || end == null || end <= start) return null
  return {
    before: text.slice(0, start),
    active: text.slice(start, end),
    after: text.slice(end),
  }
}

function readBoundedIndex(value: unknown, length: number) {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  return Math.max(0, Math.min(length, value))
}

function readOptionalInteger(value: unknown) {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function readNonEmptyString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

export function normalizeAppUpdateManifest(value: unknown): AppUpdateManifest | null {
  if (!isRecord(value)) return null
  const versionName = readNonEmptyString(value.versionName) || readNonEmptyString(value.version)
  const latestUrl = readNonEmptyString(value.latestUrl)
  const versionCode = readOptionalInteger(value.versionCode)
  if (!versionName || !latestUrl || typeof versionCode !== 'number') return null
  return {
    versionName,
    versionCode,
    buildNumber: readOptionalInteger(value.buildNumber),
    gitCommit: readNonEmptyString(value.gitCommit) || undefined,
    latestUrl,
    latestFileName: readNonEmptyString(value.latestFileName) || undefined,
    publishedAt: readNonEmptyString(value.publishedAt) || undefined,
  }
}

export function resolveAppUpdateManifest(
  manifest: AppUpdateManifest,
  currentVersionCode: number = buildInfo.versionCode,
  currentVersionName: string = buildInfo.versionName,
): AppUpdateResolution {
  if (manifest.versionCode > currentVersionCode) {
    return {
      status: 'available',
      manifest,
      message: `发现新版本 ${manifest.versionName}`,
    }
  }
  return {
    status: 'current',
    manifest,
    message: `已是最新版本 ${currentVersionName}`,
  }
}

export function appUpdateStatusLabel(state: AppUpdateState) {
  if (state.status === 'checking') return '检查中'
  if (state.status === 'available') return '有新版本'
  if (state.status === 'current') return '已是最新'
  if (state.status === 'downloading') return '下载中'
  if (state.status === 'error') return '检查失败'
  return '未检查'
}

function normalizeFullPackageImportStats(value: unknown): FullPackageImportStats | undefined {
  if (!isRecord(value)) return undefined
  const graph = isRecord(value.knowledgeGraph) ? value.knowledgeGraph : undefined
  const embeddings = isRecord(value.embeddings) ? value.embeddings : undefined
  return {
    chapterCount: readOptionalInteger(value.chapterCount),
    summaryCount: readOptionalInteger(value.summaryCount),
    knowledgeGraph: graph
      ? {
          entityCount: readOptionalInteger(graph.entityCount),
          entityMentionCount: readOptionalInteger(graph.entityMentionCount),
          relationCount: readOptionalInteger(graph.relationCount),
          relationMentionCount: readOptionalInteger(graph.relationMentionCount),
        }
      : undefined,
    embeddings: embeddings
      ? {
          summaryCount: readOptionalInteger(embeddings.summaryCount),
          chunkCount: readOptionalInteger(embeddings.chunkCount),
        }
      : undefined,
  }
}

function fullPackageProgressLabel(progress: PackageSyncProgress | null) {
  if (!progress) return ''
  if (progress.phase === 'download') {
    const total = typeof progress.total === 'number' && progress.total > 0 ? progress.total : 0
    const done = typeof progress.done === 'number' ? progress.done : 0
    if (total > 0) return `下载 ${Math.min(100, Math.round((done / total) * 100))}%`
    return done > 0 ? `已下载 ${formatBytes(done)}` : '准备下载'
  }
  if (progress.phase === 'import') {
    if (progress.status === 'parsing') return '解析完整包'
    if (progress.status === 'summaries') return '导入摘要'
    if (progress.status === 'knowledgeGraph') return '导入图谱'
    if (progress.status === 'embeddings') return '导入向量'
    if (progress.status === 'imported') return '导入完成'
    return '导入中'
  }
  return ''
}

function inferredSummaryCoverage(book: BookSummary | null, bookPackage: BookPackage | null, fullPackage: FullPackageCache | null) {
  if (hasImportedPackage(fullPackage)) return 1
  const importedSummaryCount = fullPackage?.importStats?.summaryCount ?? 0
  const importedChapterCount = fullPackage?.importStats?.chapterCount ?? 0
  if (importedChapterCount > 0) {
    return importedSummaryCount > 0 ? Math.min(1, importedSummaryCount / importedChapterCount) : 1
  }
  const summaries = bookPackage?.summaries
  const summaryCount = Array.isArray(summaries) ? summaries.length : isRecord(summaries) ? Object.keys(summaries).length : 0
  const chapterCount = bookPackage ? packageChapters(bookPackage).length : (book?.chapterCount ?? 0)
  return bookPackage && chapterCount > 0 ? Math.min(1, summaryCount / chapterCount) : 0
}

function inferredKgCoverage(book: BookSummary | null, bookPackage: BookPackage | null, fullPackage: FullPackageCache | null) {
  void book
  return hasKnowledgeGraph(bookPackage) || hasImportedKnowledgeGraph(fullPackage) ? 1 : 0
}

function ragAvailability(book: BookSummary | null, bookPackage: BookPackage | null) {
  if ((book?.embeddingCoverage ?? 0) > 0) return '云端'
  if (bookPackage) return '本地'
  return '未加载'
}

function hasImportedPackage(fullPackage: FullPackageCache | null) {
  return Boolean(fullPackage?.importStats || fullPackage?.importedAt || fullPackage?.metadataPath)
}

function hasKnowledgeGraph(bookPackage: BookPackage | null) {
  const graph = bookPackage?.knowledgeGraph
  return isRecord(graph) && (
    hasNonEmptyArray(graph.entities) ||
    hasNonEmptyArray(graph.relations) ||
    hasPositiveCount(graph.entityMentions) ||
    hasPositiveCount(graph.relationMentions)
  )
}

function hasImportedKnowledgeGraph(fullPackage: FullPackageCache | null) {
  const graph = fullPackage?.importStats?.knowledgeGraph
  return Boolean(
    graph &&
      ((graph.entityCount ?? 0) > 0 ||
        (graph.relationCount ?? 0) > 0 ||
        (graph.entityMentionCount ?? 0) > 0 ||
        (graph.relationMentionCount ?? 0) > 0),
  )
}

function hasNonEmptyArray(value: unknown) {
  return Array.isArray(value) && value.length > 0
}

function hasPositiveCount(value: unknown) {
  return isRecord(value) && typeof value.count === 'number' && value.count > 0
}

function audioButtonLabel(currentAudio: AudioChapter | null, loadingAudio: boolean) {
  if (loadingAudio) return '加载中'
  return currentAudio ? '播放' : '无音频'
}

export function isAudioPlaybackDisabled(currentAudio: AudioChapter | null, playbackLoading: boolean) {
  return !currentAudio || playbackLoading
}

function fullPackageLabel(cache: FullPackageCache | null, status: FullPackageStatus) {
  if (status === 'downloading') return '后台下载中'
  if (status === 'importing') return '导入中'
  if (cache?.importStats) return `已导入 ${formatBytes(cache.sizeBytes)}`
  if (cache) return `已下载 ${formatBytes(cache.sizeBytes)}`
  if (status === 'error') return '下载失败'
  return '未下载'
}

function formatDuration(durationMs?: number) {
  if (!durationMs) return '时长未知'
  const totalSeconds = Math.round(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatBuildTime(value: string) {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value || 'unknown'
  return new Date(time).toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatBytes(sizeBytes?: number) {
  if (!sizeBytes) return '大小未知'
  const mb = sizeBytes / 1024 / 1024
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shouldShowGlobalStatusMessage(message: string) {
  if (!message) return false
  return !['数据包已加载', '完整数据包已导入'].includes(message)
}

export default App
