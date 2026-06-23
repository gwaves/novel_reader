import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import {
  MobileApiClient,
  type MobileBookListItem,
  type MobileBookPackage,
  type MobileChapterAudio,
  type MobileKgEntity,
  type MobileKgRelation,
} from './lib/mobileApi'
import {
  getChapterAudioCache,
  getSpeechProgress,
  getBookPackage,
  getLatestReadingProgress,
  getReadingProgress,
  listChapterAudioCache,
  listLocalBooks,
  loadSettings,
  saveChapterAudioCache,
  saveBookPackage,
  saveBookEmbeddings,
  saveReadingProgress,
  saveSpeechProgress,
  saveSettings,
  type MobileAppSettings,
  type ReaderBackground,
  type LocalBook,
} from './lib/localLibrary'
import { createSpeechChapter, type SpeechSegment } from './lib/speechSegments'
import { NovelReaderTts, type TtsVoice } from './lib/ttsPlugin'

type Tab = 'library' | 'sync' | 'reader' | 'search'
type SearchMode = 'rag' | 'graph'

type SpeechPlaybackState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'playing'; segmentIndex: number; segmentId: string }
  | { status: 'paused'; segmentIndex: number; segmentId: string }
  | { status: 'error'; message: string }

const TTS_RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2, 3] as const

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

type GraphEntityResult = {
  kind: 'entity'
  entity: MobileKgEntity
  mentions: number
  relationCount: number
  snippet: string
}

type GraphRelationResult = {
  kind: 'relation'
  relation: MobileKgRelation
  sourceName: string
  targetName: string
  mentions: number
  snippet: string
}

type GraphEvidenceResult = {
  kind: 'evidence'
  id: string
  chapterId: string
  chapterIndex: number
  title: string
  snippet: string
}

type GraphResult = GraphEntityResult | GraphRelationResult | GraphEvidenceResult

function formatCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万`
  return String(count)
}

function formatSyncDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString()
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function findSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, ' ')
  const normalizedQuery = query.toLowerCase()
  let matchedQuery = query
  let index = normalizedText.toLowerCase().indexOf(normalizedQuery)
  if (index < 0) {
    for (const term of getSearchTerms(query)) {
      index = normalizedText.toLowerCase().indexOf(term)
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

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase()
}

function getSearchTerms(query: string): string[] {
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

function scoreSearchText(text: string, query: string): number {
  const normalizedText = normalizeSearchText(text)
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedText || !normalizedQuery) return 0

  let score = normalizedText.includes(normalizedQuery) ? 6 : 0
  for (const term of getSearchTerms(query)) {
    if (term.length < 2) continue
    let index = normalizedText.indexOf(term)
    while (index >= 0) {
      score += Math.min(4, term.length)
      index = normalizedText.indexOf(term, index + term.length)
    }
  }
  return score
}

function sourceLabel(source: RagResult['source']): string {
  if (source === 'chunk') return '正文片段'
  if (source === 'summary') return '章节概要'
  return '章节全文'
}

function backgroundLabel(background: ReaderBackground): string {
  if (background === 'warm') return '暖黄'
  if (background === 'green') return '护眼绿'
  if (background === 'dark') return '夜间'
  return '纸白'
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: number | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer != null) {
      window.clearTimeout(timer)
    }
  })
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length)
  if (!length) return 0

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (!leftNorm || !rightNorm) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

async function createQueryEmbedding(settings: {
  baseUrl: string
  apiKey: string
  model: string
}, query: string, proxyClient?: MobileApiClient): Promise<number[]> {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  const model = settings.model.trim()
  if (!baseUrl || !model) {
    throw new Error('请先在同步页配置 Embedding 服务的 Base URL 和模型名。')
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`
  }

  const embeddingPayload = { model, input: query, encoding_format: 'float' }

  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.post({
      data: embeddingPayload,
      headers,
      url: `${baseUrl}/embeddings`,
    })

    if (response.status >= 200 && response.status < 300) {
      const embedding = response.data?.data?.[0]?.embedding
      if (Array.isArray(embedding) && embedding.length > 0) {
        return embedding
      }
      throw new Error('查询 embedding 响应为空。')
    }

    const shouldTryOllama = response.status === 404 || baseUrl.includes('11434')
    if (!shouldTryOllama) {
      throw new Error(`查询 embedding 失败 ${response.status}：${JSON.stringify(response.data) || '请求失败'}`)
    }
  } else if (proxyClient) {
    const payload = await proxyClient.createEmbedding({
      apiKey: settings.apiKey,
      baseUrl,
      input: query,
      model,
    })
    const embedding = payload.data?.[0]?.embedding
    if (Array.isArray(embedding) && embedding.length > 0) {
      return embedding
    }
    throw new Error('查询 embedding 响应为空。')
  } else {
    const openAiResponse = await fetch(`${baseUrl}/embeddings`, {
      body: JSON.stringify(embeddingPayload),
      headers,
      method: 'POST',
    })

    if (openAiResponse.ok) {
      const payload = (await openAiResponse.json()) as { data?: Array<{ embedding?: number[] }> }
      const embedding = payload.data?.[0]?.embedding
      if (Array.isArray(embedding) && embedding.length > 0) {
        return embedding
      }
      throw new Error('查询 embedding 响应为空。')
    }

    const openAiBody = await openAiResponse.text()
    const shouldTryOllama = openAiResponse.status === 404 || baseUrl.includes('11434')

    if (!shouldTryOllama) {
      throw new Error(`查询 embedding 失败 ${openAiResponse.status}：${openAiBody || '请求失败'}`)
    }
  }

  if (Capacitor.isNativePlatform()) {
    const ollamaResponse = await CapacitorHttp.post({
      data: { model, prompt: query },
      headers: { 'Content-Type': 'application/json' },
      url: `${baseUrl}/api/embeddings`,
    })
    if (ollamaResponse.status >= 200 && ollamaResponse.status < 300) {
      const embedding = ollamaResponse.data?.embedding
      if (Array.isArray(embedding) && embedding.length > 0) {
        return embedding
      }
      throw new Error('Ollama embedding 响应为空。')
    }
    throw new Error(`查询 embedding 失败 ${ollamaResponse.status}：${JSON.stringify(ollamaResponse.data) || '请求失败'}`)
  }

  const ollamaResponse = await fetch(`${baseUrl}/api/embeddings`, {
    body: JSON.stringify({ model, prompt: query }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (ollamaResponse.ok) {
    const payload = (await ollamaResponse.json()) as { embedding?: number[] }
    if (Array.isArray(payload.embedding) && payload.embedding.length > 0) {
      return payload.embedding
    }
    throw new Error('Ollama embedding 响应为空。')
  }

  const ollamaBody = await ollamaResponse.text()
  throw new Error(`查询 embedding 失败 ${ollamaResponse.status}：${ollamaBody || '请求失败'}`)
}

async function testEmbeddingServiceConfig(settings: {
  baseUrl: string
  apiKey: string
  model: string
}, proxyClient?: MobileApiClient): Promise<number> {
  const embedding = await createQueryEmbedding(settings, 'ping', proxyClient)
  return embedding.length
}

async function generateAnswerWithExternalLlm(settings: {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  thinkingEnabled?: boolean
}, prompt: string): Promise<string> {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  const model = settings.model.trim()
  if (!baseUrl || !model) {
    throw new Error('请先在同步页配置外部 LLM 的 Base URL 和模型名。')
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`
  }

  const requestBody: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: '你是长篇小说阅读助手。请只根据给定材料回答，并引用章节号。' },
      { role: 'user', content: prompt },
    ],
    temperature: settings.temperature,
  }

  if (settings.thinkingEnabled === false) {
    requestBody.chat_template_kwargs = { enable_thinking: false }
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    body: JSON.stringify(requestBody),
    headers,
    method: 'POST',
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`外部 LLM 返回 ${response.status}：${body || '请求失败'}`)
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return (payload.choices?.[0]?.message?.content ?? '').trim()
}

async function testExternalLlmConfig(settings: {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
}): Promise<void> {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  const model = settings.model.trim()
  if (!baseUrl || !model) {
    throw new Error('请先填写外部 LLM 的 Base URL 和模型名。')
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '这是连通性测试。请只回复 OK。' },
        { role: 'user', content: 'ping' },
      ],
      max_tokens: 8,
      temperature: settings.temperature,
    }),
    headers,
    method: 'POST',
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`外部 LLM 测试失败 ${response.status}：${body || '请求失败'}`)
  }

  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  if (!payload.choices?.length) {
    throw new Error('外部 LLM 测试失败：响应中没有 choices。')
  }
}

function App() {
  const [tab, setTab] = useState<Tab>('library')
  const [baseUrl, setBaseUrl] = useState('')
  const [syncToken, setSyncToken] = useState('')
  const [llmBaseUrl, setLlmBaseUrl] = useState('')
  const [llmApiKey, setLlmApiKey] = useState('')
  const [llmModel, setLlmModel] = useState('')
  const [llmTemperature, setLlmTemperature] = useState(0.3)
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState('')
  const [embeddingApiKey, setEmbeddingApiKey] = useState('')
  const [embeddingModel, setEmbeddingModel] = useState('')
  const [remoteBooks, setRemoteBooks] = useState<MobileBookListItem[]>([])
  const [localBooks, setLocalBooks] = useState<LocalBook[]>([])
  const [activePackage, setActivePackage] = useState<MobileBookPackage | null>(null)
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [syncStatusMessage, setSyncStatusMessage] = useState('')
  const [llmStatusMessage, setLlmStatusMessage] = useState('')
  const [embeddingStatusMessage, setEmbeddingStatusMessage] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [submittedSearchQuery, setSubmittedSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('rag')
  const [ragResults, setRagResults] = useState<RagResult[]>([])
  const [ragAnswer, setRagAnswer] = useState('')
  const [ragError, setRagError] = useState('')
  const [ragUseSemantic, setRagUseSemantic] = useState(false)
  const [isRagSearching, setIsRagSearching] = useState(false)
  const [isGeneratingAnswer, setIsGeneratingAnswer] = useState(false)
  const [ragGenerationStatus, setRagGenerationStatus] = useState('')
  const [hasRagSearched, setHasRagSearched] = useState(false)
  const [ragSearchStatus, setRagSearchStatus] = useState('')
  const [readerFontSize, setReaderFontSize] = useState(19)
  const [readerBackground, setReaderBackground] = useState<ReaderBackground>('paper')
  const [ttsEngine, setTtsEngine] = useState<MobileAppSettings['tts']['engine']>('local-tts')
  const [ttsLocale, setTtsLocale] = useState('zh-CN')
  const [ttsVoiceId, setTtsVoiceId] = useState('')
  const [ttsRate, setTtsRate] = useState(1)
  const [ttsPitch, setTtsPitch] = useState(1)
  const [ttsAutoFollow, setTtsAutoFollow] = useState(true)
  const [ttsResumeFromProgress, setTtsResumeFromProgress] = useState(true)
  const [ttsVoices, setTtsVoices] = useState<TtsVoice[]>([])
  const [ttsStatusMessage, setTtsStatusMessage] = useState('')
  const [ttsSettingsMessage, setTtsSettingsMessage] = useState('')
  const [remoteChapterAudio, setRemoteChapterAudio] = useState<MobileChapterAudio[]>([])
  const [cachedChapterAudioCount, setCachedChapterAudioCount] = useState(0)
  const [speechPlayback, setSpeechPlayback] = useState<SpeechPlaybackState>({ status: 'idle' })
  const [activeSpeechSegmentId, setActiveSpeechSegmentId] = useState<string | null>(null)
  const [speechAutoFollowSuspended, setSpeechAutoFollowSuspended] = useState(false)
  const [readerMenuOpen, setReaderMenuOpen] = useState(false)
  const pendingRestoreScrollRef = useRef<number | null>(null)
  const progressSaveTimerRef = useRef<number | null>(null)
  const activePackageRef = useRef<MobileBookPackage | null>(null)
  const activeChapterIdRef = useRef<string | null>(null)
  const tabRef = useRef<Tab>('library')
  const isRestoringScrollRef = useRef(false)
  const skipNextCleanupProgressSaveRef = useRef(false)
  const speechPlaybackRef = useRef<SpeechPlaybackState>({ status: 'idle' })
  const speechSegmentsRef = useRef<SpeechSegment[]>([])
  const currentUtteranceIdRef = useRef<string | null>(null)
  const speechUtteranceIndexRef = useRef<Map<string, number>>(new Map())
  const chapterAudioElementRef = useRef<HTMLAudioElement | null>(null)
  const chapterAudioObjectUrlRef = useRef<string | null>(null)
  const chapterAudioTimelineRef = useRef<Array<{ endTime: number; index: number }>>([])
  const speechAutoFollowRef = useRef(true)
  const speechFollowSuspendedUntilRef = useRef(0)
  const speechFollowTimerRef = useRef<number | null>(null)
  const isSpeechAutoScrollingRef = useRef(false)
  const lastReaderCenterTapAtRef = useRef(0)

  const client = useMemo(() => new MobileApiClient({ baseUrl, syncToken }), [baseUrl, syncToken])

  const activeChapter = useMemo(() => {
    if (!activePackage || !activeChapterId) return null
    return activePackage.chapters.find((chapter) => chapter.id === activeChapterId) ?? null
  }, [activeChapterId, activePackage])

  const activeSummary = activeChapter ? activePackage?.summaries.find((summary) => summary.chapterId === activeChapter.id) : null

  const speechChapter = useMemo(() => (activeChapter ? createSpeechChapter(activeChapter) : null), [activeChapter])

  const activeChapterPosition = useMemo(() => {
    if (!activePackage || !activeChapterId) return -1
    return activePackage.chapters.findIndex((chapter) => chapter.id === activeChapterId)
  }, [activeChapterId, activePackage])

  const previousChapter = activePackage && activeChapterPosition > 0 ? activePackage.chapters[activeChapterPosition - 1] : null
  const nextChapter =
    activePackage && activeChapterPosition >= 0 && activeChapterPosition < activePackage.chapters.length - 1
      ? activePackage.chapters[activeChapterPosition + 1]
      : null

  useEffect(() => {
    activePackageRef.current = activePackage
    activeChapterIdRef.current = activeChapterId
    tabRef.current = tab
  }, [activeChapterId, activePackage, tab])

  useEffect(() => {
    speechPlaybackRef.current = speechPlayback
  }, [speechPlayback])

  useEffect(() => {
    speechSegmentsRef.current = speechChapter?.segments ?? []
  }, [speechChapter])

  useEffect(() => {
    speechAutoFollowRef.current = ttsAutoFollow
  }, [ttsAutoFollow])

  const textSearchResults = useMemo<SearchResult[]>(() => {
    const query = submittedSearchQuery.trim()
    if (!activePackage || searchMode !== 'rag' || !query) return []

    return activePackage.chapters
      .map((chapter) => {
        const summary = activePackage.summaries.find((entry) => entry.chapterId === chapter.id)
        const haystack = `${chapter.title}\n${summary?.short ?? ''}\n${summary?.detail ?? ''}\n${chapter.content}`
        if (!haystack.toLowerCase().includes(query.toLowerCase())) return null
        return {
          chapterId: chapter.id,
          chapterIndex: chapter.index,
          chapterTitle: chapter.title,
          snippet: findSnippet(haystack, query),
        }
      })
      .filter((result): result is SearchResult => Boolean(result))
      .slice(0, 30)
  }, [activePackage, searchMode, submittedSearchQuery])

  const activeChapterAudio = useMemo(
    () => remoteChapterAudio.find((audio) => audio.chapterId === activeChapterId) ?? null,
    [activeChapterId, remoteChapterAudio],
  )

  const graphResults = useMemo<GraphResult[]>(() => {
    const query = submittedSearchQuery.trim()
    if (!activePackage || searchMode !== 'graph' || !query) return []

    const entityById = new Map(activePackage.knowledgeGraph.entities.map((entity) => [entity.id, entity]))
    const chapterById = new Map(activePackage.chapters.map((chapter) => [chapter.id, chapter]))

    const entityResults: GraphEntityResult[] = activePackage.knowledgeGraph.entities
      .map((entity) => {
        const haystack = [
          entity.name,
          entity.normalizedName,
          entity.type,
          entity.aliases.join(' '),
          entity.description ?? '',
        ].join('\n')
        const score = scoreSearchText(haystack, query)
        if (!score) return null
        const mentions = activePackage.knowledgeGraph.entityMentions.filter((mention) => mention.entityId === entity.id)
        const relationCount = activePackage.knowledgeGraph.relations.filter(
          (relation) => relation.sourceEntityId === entity.id || relation.targetEntityId === entity.id,
        ).length
        return {
          kind: 'entity' as const,
          entity,
          mentions: mentions.length,
          relationCount,
          snippet: entity.description || mentions.find((mention) => mention.evidence)?.evidence || '命中实体名称或别名。',
          score,
        }
      })
      .filter((result): result is GraphEntityResult & { score: number } => Boolean(result))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)

    const relationResults: GraphRelationResult[] = activePackage.knowledgeGraph.relations
      .map((relation) => {
        const source = entityById.get(relation.sourceEntityId)
        const target = entityById.get(relation.targetEntityId)
        const haystack = [
          source?.name ?? '',
          target?.name ?? '',
          relation.type,
          relation.description ?? '',
        ].join('\n')
        const score = scoreSearchText(haystack, query)
        if (!score) return null
        const mentions = activePackage.knowledgeGraph.relationMentions.filter((mention) => mention.relationId === relation.id)
        return {
          kind: 'relation' as const,
          relation,
          sourceName: source?.name ?? '未知实体',
          targetName: target?.name ?? '未知实体',
          mentions: mentions.length,
          snippet: relation.description || mentions.find((mention) => mention.evidence)?.evidence || '命中关系名称或端点。',
          score,
        }
      })
      .filter((result): result is GraphRelationResult & { score: number } => Boolean(result))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)

    const evidenceResults: GraphEvidenceResult[] = [
      ...activePackage.knowledgeGraph.entityMentions.map((mention) => ({
        id: mention.id,
        chapterId: mention.chapterId,
        chapterIndex: mention.chapterIndex,
        evidence: mention.evidence ?? '',
      })),
      ...activePackage.knowledgeGraph.relationMentions.map((mention) => ({
        id: mention.id,
        chapterId: mention.chapterId,
        chapterIndex: mention.chapterIndex,
        evidence: mention.evidence ?? '',
      })),
    ]
      .map((mention) => {
        const score = scoreSearchText(mention.evidence, query)
        if (!score) return null
        const chapter = chapterById.get(mention.chapterId)
        return {
          kind: 'evidence' as const,
          id: mention.id,
          chapterId: mention.chapterId,
          chapterIndex: mention.chapterIndex,
          title: chapter?.title ?? `第 ${mention.chapterIndex} 章`,
          snippet: findSnippet(mention.evidence, query),
          score,
        }
      })
      .filter((result): result is GraphEvidenceResult & { score: number } => Boolean(result))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)

    return [...entityResults, ...relationResults, ...evidenceResults].slice(0, 30)
  }, [activePackage, searchMode, submittedSearchQuery])

  const hydrate = useCallback(async () => {
    const [settings, books, latestProgress] = await Promise.all([loadSettings(), listLocalBooks(), getLatestReadingProgress()])
    setBaseUrl(settings.baseUrl)
    setSyncToken(settings.syncToken)
    setLlmBaseUrl(settings.externalLlm.baseUrl)
    setLlmApiKey(settings.externalLlm.apiKey)
    setLlmModel(settings.externalLlm.model)
    setLlmTemperature(settings.externalLlm.temperature)
    setEmbeddingBaseUrl(settings.embeddingService.baseUrl)
    setEmbeddingApiKey(settings.embeddingService.apiKey)
    setEmbeddingModel(settings.embeddingService.model)
    setReaderFontSize(settings.reader.fontSize)
    setReaderBackground(settings.reader.background)
    setTtsEngine(settings.tts.engine)
    setTtsLocale(settings.tts.locale)
    setTtsVoiceId(settings.tts.voiceId)
    setTtsRate(settings.tts.rate)
    setTtsPitch(settings.tts.pitch)
    setTtsAutoFollow(settings.tts.autoFollow)
    setTtsResumeFromProgress(settings.tts.resumeFromProgress)
    setLocalBooks(books)

    if (!latestProgress || !books.some((book) => book.id === latestProgress.bookId)) return

    const pkg = await getBookPackage(latestProgress.bookId)
    if (!pkg) return

    const progressChapter = pkg.chapters.some((chapter) => chapter.id === latestProgress.chapterId)
      ? latestProgress.chapterId
      : pkg.chapters[0]?.id ?? null

    setActivePackage(pkg)
    setActiveChapterId(progressChapter)
    pendingRestoreScrollRef.current = latestProgress.chapterId === progressChapter ? latestProgress.scrollY : 0
    setTab('reader')
  }, [])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void hydrate()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [hydrate])

  const saveCurrentReadingProgress = useCallback((scrollY = window.scrollY) => {
    const currentPackage = activePackageRef.current
    const currentChapterId = activeChapterIdRef.current
    if (tabRef.current !== 'reader' || !currentPackage || !currentChapterId) return
    void saveReadingProgress({
      bookId: currentPackage.book.id,
      chapterId: currentChapterId,
      scrollY,
    })
  }, [])

  const restoreReaderScroll = useCallback((scrollY: number) => {
    isRestoringScrollRef.current = true
    const target = Math.max(0, Math.round(scrollY))
    const scrollToTarget = () => window.scrollTo({ top: target })

    window.requestAnimationFrame(() => {
      scrollToTarget()
      window.requestAnimationFrame(() => {
        scrollToTarget()
        window.setTimeout(() => {
          scrollToTarget()
          isRestoringScrollRef.current = false
        }, 120)
      })
    })
  }, [])

  useEffect(() => {
    if (tab !== 'reader' || !activePackage || !activeChapterId) return

    let cancelled = false
    const bookId = activePackage.book.id

    async function restoreProgress() {
      const explicitScroll = pendingRestoreScrollRef.current
      pendingRestoreScrollRef.current = null

      if (explicitScroll != null) {
        restoreReaderScroll(explicitScroll)
        return
      }

      const progress = await getReadingProgress(bookId)
      if (cancelled) return

      restoreReaderScroll(progress?.chapterId === activeChapterId ? progress.scrollY : 0)
    }

    void restoreProgress()

    return () => {
      cancelled = true
    }
  }, [activeChapterId, activePackage, restoreReaderScroll, tab])

  useEffect(() => {
    if (tab !== 'reader' || !activePackage || !activeChapterId) return

    function scheduleSaveProgress() {
      if (isRestoringScrollRef.current) return
      if (
        speechPlaybackRef.current.status === 'playing' &&
        !isSpeechAutoScrollingRef.current &&
        Date.now() > speechFollowSuspendedUntilRef.current
      ) {
        speechFollowSuspendedUntilRef.current = Date.now() + 7000
        setSpeechAutoFollowSuspended(true)
        if (speechFollowTimerRef.current != null) {
          window.clearTimeout(speechFollowTimerRef.current)
        }
        speechFollowTimerRef.current = window.setTimeout(() => {
          speechFollowSuspendedUntilRef.current = 0
          setSpeechAutoFollowSuspended(false)
        }, 7000)
      }
      if (progressSaveTimerRef.current != null) {
        window.clearTimeout(progressSaveTimerRef.current)
      }
      progressSaveTimerRef.current = window.setTimeout(() => {
        if (!activePackage || !activeChapterId) return
        void saveReadingProgress({
          bookId: activePackage.book.id,
          chapterId: activeChapterId,
          scrollY: window.scrollY,
        })
      }, 400)
    }

    window.addEventListener('scroll', scheduleSaveProgress, { passive: true })

    return () => {
      window.removeEventListener('scroll', scheduleSaveProgress)
      if (progressSaveTimerRef.current != null) {
        window.clearTimeout(progressSaveTimerRef.current)
        progressSaveTimerRef.current = null
      }
      if (skipNextCleanupProgressSaveRef.current) {
        skipNextCleanupProgressSaveRef.current = false
        return
      }
      void saveReadingProgress({
        bookId: activePackage.book.id,
        chapterId: activeChapterId,
        scrollY: window.scrollY,
      })
    }
  }, [activeChapterId, activePackage, tab])

  useEffect(() => {
    function saveBeforePageLeaves() {
      saveCurrentReadingProgress()
    }

    function saveWhenHidden() {
      if (document.visibilityState === 'hidden') {
        saveCurrentReadingProgress()
      }
    }

    window.addEventListener('pagehide', saveBeforePageLeaves)
    window.addEventListener('beforeunload', saveBeforePageLeaves)
    document.addEventListener('visibilitychange', saveWhenHidden)

    return () => {
      window.removeEventListener('pagehide', saveBeforePageLeaves)
      window.removeEventListener('beforeunload', saveBeforePageLeaves)
      document.removeEventListener('visibilitychange', saveWhenHidden)
    }
  }, [saveCurrentReadingProgress])

  function getCurrentSettings(overrides: Partial<MobileAppSettings> = {}): MobileAppSettings {
    return {
      baseUrl,
      syncToken,
      externalLlm: {
        baseUrl: llmBaseUrl,
        apiKey: llmApiKey,
        model: llmModel,
        temperature: llmTemperature,
      },
      embeddingService: {
        baseUrl: embeddingBaseUrl,
        apiKey: embeddingApiKey,
        model: embeddingModel,
      },
      reader: {
        fontSize: readerFontSize,
        background: readerBackground,
      },
      tts: {
        engine: ttsEngine,
        locale: ttsLocale,
        voiceId: ttsVoiceId,
        rate: ttsRate,
        pitch: ttsPitch,
        autoFollow: ttsAutoFollow,
        resumeFromProgress: ttsResumeFromProgress,
      },
      ...overrides,
    }
  }

  async function persistSettings() {
    await saveSettings(getCurrentSettings())
    setMessage('配置已保存。')
  }

  async function persistReaderSettings(nextReader: MobileAppSettings['reader']) {
    await saveSettings(getCurrentSettings({ reader: nextReader }))
  }

  async function persistTtsSettings(nextTts: MobileAppSettings['tts']) {
    await saveSettings(getCurrentSettings({ tts: nextTts }))
  }

  async function saveTtsSettingsFromPanel() {
    await persistTtsSettings(getCurrentTtsSettings())
    setTtsSettingsMessage('语音阅读配置已保存。')
  }

  async function testExternalLlm() {
    setIsBusy(true)
    setLlmStatusMessage('正在测试外部 LLM...')
    try {
      await testExternalLlmConfig({
        baseUrl: llmBaseUrl,
        apiKey: llmApiKey,
        model: llmModel,
        temperature: llmTemperature,
      })
      setLlmStatusMessage('外部 LLM 测试通过。')
    } catch (error) {
      setLlmStatusMessage(error instanceof Error ? error.message : '外部 LLM 测试失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function testEmbeddingService() {
    setIsBusy(true)
    setEmbeddingStatusMessage('正在测试 Embedding 服务...')
    try {
      const dimension = await testEmbeddingServiceConfig({
        baseUrl: embeddingBaseUrl,
        apiKey: embeddingApiKey,
        model: embeddingModel,
      }, client)
      setEmbeddingStatusMessage(`Embedding 服务测试通过，维度 ${dimension}。`)
    } catch (error) {
      setEmbeddingStatusMessage(error instanceof Error ? error.message : 'Embedding 服务测试失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function testConnection() {
    setIsBusy(true)
    setSyncStatusMessage('正在测试 PC API 连接...')
    try {
      const manifest = await client.getManifest()
      setSyncStatusMessage(`连接成功：schema v${manifest.schemaVersion}，服务时间 ${new Date(manifest.generatedAt).toLocaleString()}。`)
    } catch (error) {
      setSyncStatusMessage(error instanceof Error ? error.message : '连接失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function loadRemoteBooks() {
    setIsBusy(true)
    setSyncStatusMessage('正在读取 PC 书架...')
    try {
      await persistSettings()
      const books = await client.listBooks()
      setRemoteBooks(books)
      setSyncStatusMessage(`发现 ${books.length} 本可同步书籍。`)
    } catch (error) {
      setSyncStatusMessage(error instanceof Error ? error.message : '读取 PC 书架失败。')
    } finally {
      setIsBusy(false)
    }
  }

  function bookHasRemoteEmbeddings(book: MobileBookListItem): boolean {
    return book.embeddingCoverage.embeddedSummaries > 0 || book.embeddingCoverage.embeddedChunks > 0
  }

  function getLocalBook(bookId: string): LocalBook | null {
    return localBooks.find((book) => book.id === bookId) ?? null
  }

  async function downloadEmbeddingPatch(bookId: string, remoteBook?: MobileBookListItem): Promise<MobileBookPackage> {
    const totalChapters = Math.max(1, remoteBook?.chapterCount ?? 1)
    const pageSize = 10
    let downloadedChapters = 0
    let embeddingPackage: MobileBookPackage | null = null

    for (let start = 0; start < totalChapters; start += pageSize) {
      const remainingChapters = Math.max(0, totalChapters - downloadedChapters)
      const currentPageSize = Math.min(pageSize, totalChapters - start)
      setSyncStatusMessage(
        `正在补下载《${remoteBook?.title ?? '本书'}》Embedding：已下载 ${downloadedChapters}/${totalChapters} 章，还剩 ${remainingChapters} 章...`,
      )

      const page = await client.downloadBookPackage(bookId, {
        embeddingLimit: currentPageSize,
        embeddingStart: start,
        includeEmbeddings: true,
        sections: 'embeddings',
      })

      downloadedChapters = Math.min(totalChapters, start + currentPageSize)
      if (embeddingPackage) {
        embeddingPackage.generatedAt = page.generatedAt
        embeddingPackage.integrity = page.integrity
        embeddingPackage.packageVersion = page.packageVersion
        embeddingPackage.embeddings = {
          summaries: [...embeddingPackage.embeddings.summaries, ...page.embeddings.summaries],
          chunks: [...embeddingPackage.embeddings.chunks, ...page.embeddings.chunks],
        }
      } else {
        embeddingPackage = page
      }

      setSyncStatusMessage(
        `正在补下载《${remoteBook?.title ?? '本书'}》Embedding：已下载 ${downloadedChapters}/${totalChapters} 章，还剩 ${Math.max(0, totalChapters - downloadedChapters)} 章，已收到 ${embeddingPackage.embeddings.chunks.length} 个 chunk。`,
      )
    }

    if (!embeddingPackage) {
      throw new Error('没有收到可导入的 Embedding 数据。')
    }
    return embeddingPackage
  }

  async function downloadBook(bookId: string, options: { includeEmbeddings: boolean }) {
    setIsBusy(true)
    setSyncStatusMessage('')
    try {
      const remoteBook = remoteBooks.find((book) => book.id === bookId)
      const localBook = getLocalBook(bookId)
      const shouldPatchEmbeddings = options.includeEmbeddings && Boolean(localBook)
      const packageLabel = shouldPatchEmbeddings
        ? 'Embedding 精简包'
        : options.includeEmbeddings
          ? '完整离线包（含 Embedding）'
          : '轻量离线包'
      setSyncStatusMessage(`正在下载《${remoteBook?.title ?? '本书'}》${packageLabel}...`)
      const pkg = shouldPatchEmbeddings
        ? await downloadEmbeddingPatch(bookId, remoteBook)
        : await client.downloadBookPackage(bookId, {
            includeEmbeddings: options.includeEmbeddings,
            sections: 'full',
          })
      setSyncStatusMessage(`正在导入《${pkg.book.title}》到本地...`)
      const savedPackage = shouldPatchEmbeddings ? await saveBookEmbeddings(pkg) : pkg
      if (!shouldPatchEmbeddings) {
        await saveBookPackage(pkg)
      }
      setLocalBooks(await listLocalBooks())
      setActivePackage(savedPackage)
      if (!shouldPatchEmbeddings) {
        setActiveChapterId(savedPackage.chapters[0]?.id ?? null)
        pendingRestoreScrollRef.current = 0
        if (savedPackage.chapters[0]) {
          void saveReadingProgress({ bookId: savedPackage.book.id, chapterId: savedPackage.chapters[0].id, scrollY: 0 })
        }
      }
      setSyncStatusMessage(
        options.includeEmbeddings
          ? `已导入《${savedPackage.book.title}》，包含 ${savedPackage.embeddings.summaries.length} 个概要 embedding、${savedPackage.embeddings.chunks.length} 个 chunk embedding。`
          : `已导入《${savedPackage.book.title}》轻量包。`,
      )
      if (!shouldPatchEmbeddings) {
        setTab('reader')
      }
    } catch (error) {
      setSyncStatusMessage(error instanceof Error ? error.message : '同步书籍失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function refreshBookAudio(bookId = activePackage?.book.id) {
    if (!bookId) return
    setIsBusy(true)
    setSyncStatusMessage('正在读取 PC 端音频目录...')
    try {
      const audio = await client.listBookAudio(bookId)
      setRemoteChapterAudio(audio)
      const cached = await listChapterAudioCache(bookId)
      setCachedChapterAudioCount(cached.length)
      setSyncStatusMessage(audio.length ? `发现 ${audio.length} 个章节 MP3，可下载到本机。` : 'PC 端暂未匹配到章节 MP3，请先在 PC Web 端配置音频目录。')
    } catch (error) {
      setSyncStatusMessage(error instanceof Error ? error.message : '读取音频目录失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function downloadChapterAudio(audio: MobileChapterAudio) {
    setIsBusy(true)
    setSyncStatusMessage(`正在下载第 ${audio.chapterIndex} 章 MP3（${formatBytes(audio.bytes)}）...`)
    try {
      const blob = await client.downloadAudio(audio)
      await saveChapterAudioCache({
        audioId: audio.id,
        blob,
        bookId: audio.bookId,
        bytes: audio.bytes,
        chapterId: audio.chapterId,
        chapterIndex: audio.chapterIndex,
        chapterTitle: audio.chapterTitle,
        filename: audio.filename,
        updatedAt: audio.updatedAt,
      })
      setCachedChapterAudioCount((await listChapterAudioCache(audio.bookId)).length)
      setSyncStatusMessage(`已缓存第 ${audio.chapterIndex} 章 MP3。`)
    } catch (error) {
      setSyncStatusMessage(error instanceof Error ? error.message : '下载章节 MP3 失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function openLocalBook(bookId: string) {
    const pkg = await getBookPackage(bookId)
    if (!pkg) {
      setMessage('本地书籍不存在，请重新同步。')
      return
    }
    const progress = await getReadingProgress(bookId)
    const progressChapter =
      progress && pkg.chapters.some((chapter) => chapter.id === progress.chapterId)
        ? progress.chapterId
        : pkg.chapters[0]?.id ?? null
    setActivePackage(pkg)
    setActiveChapterId(progressChapter)
    setRemoteChapterAudio([])
    setCachedChapterAudioCount((await listChapterAudioCache(bookId)).length)
    pendingRestoreScrollRef.current = progress?.chapterId === progressChapter ? progress.scrollY : 0
    setMessage('')
    setTab('reader')
  }

  function openChapter(chapterId: string) {
    if (speechPlaybackRef.current.status === 'playing' || speechPlaybackRef.current.status === 'paused') {
      void stopSpeechReading()
    }
    setReaderMenuOpen(false)
    saveCurrentReadingProgress()
    setActiveChapterId(chapterId)
    if (activePackage) {
      void saveReadingProgress({ bookId: activePackage.book.id, chapterId, scrollY: 0 })
    }
    pendingRestoreScrollRef.current = 0
    setMessage('')
    setTab('reader')
    window.scrollTo({ top: 0 })
  }

  function changeChapter(chapterId: string | null) {
    if (!chapterId) return
    openChapter(chapterId)
  }

  function scrollReaderPage(direction: 'up' | 'down') {
    const distance = Math.max(320, window.innerHeight * 0.72)
    window.scrollBy({
      top: direction === 'down' ? distance : -distance,
      behavior: 'smooth',
    })
  }

  function handleReaderTap(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.closest('button, input, select, textarea, a, label')) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const xRatio = (event.clientX - bounds.left) / bounds.width

    if (xRatio >= 0.25 && xRatio <= 0.75) {
      const now = Date.now()
      if (now - lastReaderCenterTapAtRef.current < 360) {
        lastReaderCenterTapAtRef.current = 0
        setReaderMenuOpen(true)
        return
      }
      lastReaderCenterTapAtRef.current = now
      return
    }

    lastReaderCenterTapAtRef.current = 0
    scrollReaderPage(xRatio < 0.25 ? 'up' : 'down')
  }

  function updateReaderFontSize(fontSize: number) {
    const nextFontSize = Math.max(15, Math.min(28, fontSize))
    setReaderFontSize(nextFontSize)
    void persistReaderSettings({ fontSize: nextFontSize, background: readerBackground })
  }

  function updateReaderBackground(background: ReaderBackground) {
    setReaderBackground(background)
    void persistReaderSettings({ fontSize: readerFontSize, background })
  }

  function switchTab(nextTab: Tab) {
    if (tab === 'reader' && nextTab !== 'reader') {
      setReaderMenuOpen(false)
      const currentScrollY = window.scrollY
      pendingRestoreScrollRef.current = currentScrollY
      skipNextCleanupProgressSaveRef.current = true
      saveCurrentReadingProgress(currentScrollY)
    }
    if (nextTab !== tab) {
      setMessage('')
    }
    setTab(nextTab)
  }

  function getCurrentTtsSettings(overrides: Partial<MobileAppSettings['tts']> = {}): MobileAppSettings['tts'] {
    return {
      engine: ttsEngine,
      locale: ttsLocale,
      voiceId: ttsVoiceId,
      rate: ttsRate,
      pitch: ttsPitch,
      autoFollow: ttsAutoFollow,
      resumeFromProgress: ttsResumeFromProgress,
      ...overrides,
    }
  }

  async function refreshTtsAvailability() {
    setTtsSettingsMessage('')
    if (!Capacitor.isNativePlatform()) {
      setTtsVoices([])
      setTtsStatusMessage('语音阅读需要在 Android App 中使用。')
      return false
    }

    setTtsStatusMessage('正在检测系统语音引擎...')
    try {
      const availability = await withTimeout(
        NovelReaderTts.getAvailability({ locale: ttsLocale }),
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
          ? `系统 TTS 可用，发现 ${availability.voices.length} 个 ${ttsLocale} 音色。`
          : '系统 TTS 可用，将使用默认音色。',
      )
      return true
    } catch (error) {
      setTtsVoices([])
      setTtsStatusMessage(error instanceof Error ? error.message : '系统 TTS 检测失败。')
      return false
    }
  }

  async function openSystemTtsSettings() {
    setTtsSettingsMessage('')
    if (!Capacitor.isNativePlatform()) {
      setTtsStatusMessage('系统语音设置只能在 Android App 中打开。')
      return
    }
    try {
      await NovelReaderTts.openTtsSettings()
      setTtsStatusMessage('请在系统页面选择文字转语音引擎，然后返回本应用重新检测。')
    } catch (error) {
      setTtsStatusMessage(error instanceof Error ? error.message : '无法打开系统语音设置。')
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
      setTtsStatusMessage(error instanceof Error ? error.message : '无法打开系统语音检查。')
    }
  }

  function saveCurrentSpeechProgress(segment: SpeechSegment, segmentIndex: number) {
    void saveSpeechProgress({
      bookId: segment.bookId,
      chapterId: segment.chapterId,
      segmentId: segment.id,
      segmentIndex,
      voiceId: ttsVoiceId || null,
      rate: ttsRate,
      pitch: ttsPitch,
    })
  }

  function releaseChapterAudio() {
    if (chapterAudioElementRef.current) {
      chapterAudioElementRef.current.pause()
      chapterAudioElementRef.current.src = ''
      chapterAudioElementRef.current.load()
      chapterAudioElementRef.current = null
    }
    if (chapterAudioObjectUrlRef.current) {
      URL.revokeObjectURL(chapterAudioObjectUrlRef.current)
      chapterAudioObjectUrlRef.current = null
    }
    chapterAudioTimelineRef.current = []
  }

  function buildChapterAudioTimeline(duration: number) {
    const segments = speechSegmentsRef.current
    const totalWeight = Math.max(1, segments.reduce((sum, segment) => sum + Math.max(1, segment.text.length), 0))
    let elapsed = 0
    chapterAudioTimelineRef.current = segments.map((segment, index) => {
      elapsed += (Math.max(1, segment.text.length) / totalWeight) * duration
      return { endTime: elapsed, index }
    })
  }

  function findAudioSegmentIndex(currentTime: number): number {
    const timeline = chapterAudioTimelineRef.current
    if (!timeline.length) return 0
    return timeline.find((item) => currentTime <= item.endTime)?.index ?? timeline.at(-1)?.index ?? 0
  }

  function getAudioTimeForSegment(segmentIndex: number): number {
    const timeline = chapterAudioTimelineRef.current
    if (!timeline.length || segmentIndex <= 0) return 0
    return timeline[Math.min(segmentIndex - 1, timeline.length - 1)]?.endTime ?? 0
  }

  function scrollToSpeechSegment(segmentId: string, force = false) {
    if (!force && (!speechAutoFollowRef.current || Date.now() < speechFollowSuspendedUntilRef.current)) return
    const target = document.querySelector(`[data-speech-segment-id="${CSS.escape(segmentId)}"]`)
    if (!target) return

    isSpeechAutoScrollingRef.current = true
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => {
      isSpeechAutoScrollingRef.current = false
    }, 800)
  }

  function findCurrentVisibleSpeechSegmentIndex(): number | null {
    const segments = speechSegmentsRef.current
    if (!segments.length) return null

    const viewportTop = 0
    const viewportBottom = window.innerHeight || document.documentElement.clientHeight
    const viewportCenter = viewportBottom * 0.45
    let nearestVisible: { index: number; distance: number } | null = null

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      const target = document.querySelector(`[data-speech-segment-id="${CSS.escape(segment.id)}"]`)
      if (!(target instanceof HTMLElement)) continue

      const bounds = target.getBoundingClientRect()
      if (bounds.bottom < viewportTop || bounds.top > viewportBottom) continue
      if (bounds.top <= viewportCenter && bounds.bottom >= viewportCenter) {
        return index
      }

      const segmentCenter = (bounds.top + bounds.bottom) / 2
      const distance = Math.abs(segmentCenter - viewportCenter)
      if (!nearestVisible || distance < nearestVisible.distance) {
        nearestVisible = { index, distance }
      }
    }

    return nearestVisible?.index ?? null
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

    const queueId = Date.now()
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
    saveCurrentSpeechProgress(segment, segmentIndex)

    try {
      await NovelReaderTts.speakQueue({
        locale: ttsLocale,
        pitch: ttsPitch,
        rate: ttsRate,
        utterances,
        voiceId: ttsVoiceId || undefined,
      })
    } catch (error) {
      currentUtteranceIdRef.current = null
      speechUtteranceIndexRef.current.clear()
      setSpeechPlayback({ status: 'error', message: error instanceof Error ? error.message : '语音朗读失败。' })
      setTtsStatusMessage(error instanceof Error ? error.message : '语音朗读失败。')
    }
  }

  async function playChapterAudio(segmentIndex: number) {
    if (!activePackage || !activeChapter) return
    const cached = await getChapterAudioCache(activePackage.book.id, activeChapter.id)
    if (!cached) {
      setSpeechPlayback({ status: 'error', message: '本章 MP3 尚未下载，请先到同步页刷新并下载章节音频。' })
      setTtsStatusMessage('本章 MP3 尚未下载，请先到同步页刷新并下载章节音频。')
      return
    }

    releaseChapterAudio()
    const audio = new Audio()
    const objectUrl = URL.createObjectURL(cached.blob)
    const startSegment = speechSegmentsRef.current[segmentIndex]
    if (!startSegment) return

    chapterAudioElementRef.current = audio
    chapterAudioObjectUrlRef.current = objectUrl
    audio.src = objectUrl
    audio.preload = 'auto'
    audio.onloadedmetadata = () => {
      buildChapterAudioTimeline(audio.duration || 0)
      audio.currentTime = getAudioTimeForSegment(segmentIndex)
    }
    audio.ontimeupdate = () => {
      const currentIndex = findAudioSegmentIndex(audio.currentTime)
      const segment = speechSegmentsRef.current[currentIndex]
      if (!segment) return
      if (speechPlaybackRef.current.status !== 'playing' || speechPlaybackRef.current.segmentIndex === currentIndex) return
      setActiveSpeechSegmentId(segment.id)
      setSpeechPlayback({ status: 'playing', segmentIndex: currentIndex, segmentId: segment.id })
      scrollToSpeechSegment(segment.id)
      saveCurrentSpeechProgress(segment, currentIndex)
    }
    audio.onended = () => {
      releaseChapterAudio()
      setActiveSpeechSegmentId(null)
      setSpeechPlayback({ status: 'idle' })
    }
    audio.onerror = () => {
      releaseChapterAudio()
      setSpeechPlayback({ status: 'error', message: 'MP3 播放失败。' })
      setTtsStatusMessage('MP3 播放失败。')
    }

    setActiveSpeechSegmentId(startSegment.id)
    setSpeechPlayback({ status: 'playing', segmentIndex, segmentId: startSegment.id })
    scrollToSpeechSegment(startSegment.id)
    saveCurrentSpeechProgress(startSegment, segmentIndex)
    await audio.play()
  }

  async function startSpeechReading() {
    if (!activePackage || !activeChapter || !speechChapter?.segments.length) return

    setSpeechPlayback({ status: 'checking' })
    setTtsStatusMessage('')
    try {
      const visibleStartIndex = findCurrentVisibleSpeechSegmentIndex()
      let startIndex = visibleStartIndex ?? 0
      if (visibleStartIndex == null && ttsResumeFromProgress) {
        const progress = await getSpeechProgress(activePackage.book.id)
        if (progress?.chapterId === activeChapter.id) {
          startIndex = Math.min(Math.max(0, progress.segmentIndex), speechChapter.segments.length - 1)
        }
      }

      if (ttsEngine === 'cloud-mp3') {
        await playChapterAudio(startIndex)
        return
      }

      const available = await refreshTtsAvailability()
      if (!available) {
        setSpeechPlayback({ status: 'error', message: '系统 TTS 不可用。' })
        return
      }

      await playSpeechSegment(startIndex)
    } catch (error) {
      const message = error instanceof Error ? error.message : '语音阅读启动失败。'
      setSpeechPlayback({ status: 'error', message })
      setTtsStatusMessage(message)
    }
  }

  async function pauseSpeechReading() {
    const current = speechPlaybackRef.current
    if (current.status !== 'playing') return
    if (ttsEngine === 'cloud-mp3' && chapterAudioElementRef.current) {
      chapterAudioElementRef.current.pause()
      setSpeechPlayback({ status: 'paused', segmentIndex: current.segmentIndex, segmentId: current.segmentId })
      return
    }
    currentUtteranceIdRef.current = null
    speechUtteranceIndexRef.current.clear()
    await NovelReaderTts.stop().catch(() => undefined)
    setSpeechPlayback({ status: 'paused', segmentIndex: current.segmentIndex, segmentId: current.segmentId })
  }

  async function resumeSpeechReading() {
    const current = speechPlaybackRef.current
    if (current.status !== 'paused') return
    if (ttsEngine === 'cloud-mp3' && chapterAudioElementRef.current) {
      await chapterAudioElementRef.current.play()
      setSpeechPlayback({ status: 'playing', segmentIndex: current.segmentIndex, segmentId: current.segmentId })
      return
    }
    await playSpeechSegment(current.segmentIndex)
  }

  async function stopSpeechReading() {
    releaseChapterAudio()
    currentUtteranceIdRef.current = null
    speechUtteranceIndexRef.current.clear()
    await NovelReaderTts.stop().catch(() => undefined)
    setActiveSpeechSegmentId(null)
    setSpeechPlayback({ status: 'idle' })
  }

  function followSpeechSegment() {
    const current = speechPlaybackRef.current
    if (current.status !== 'playing' && current.status !== 'paused') return
    speechFollowSuspendedUntilRef.current = 0
    setSpeechAutoFollowSuspended(false)
    scrollToSpeechSegment(current.segmentId, true)
  }

  function getSpeechPlaybackLabel() {
    if (speechPlayback.status === 'playing') return `正在朗读 ${speechPlayback.segmentIndex + 1}/${speechChapter?.segments.length ?? 0}`
    if (speechPlayback.status === 'paused') return `已暂停在 ${speechPlayback.segmentIndex + 1}/${speechChapter?.segments.length ?? 0}`
    if (speechPlayback.status === 'checking') return '正在检测系统语音'
    if (speechPlayback.status === 'error') return speechPlayback.message
    return `本章 ${speechChapter?.segments.length ?? 0} 个朗读片段`
  }

  function renderSpeechActions() {
    return (
      <div className="speech-actions">
        {(speechPlayback.status === 'idle' || speechPlayback.status === 'error') && (
          <button type="button" onClick={() => void startSpeechReading()} disabled={!speechChapter?.segments.length}>语音阅读</button>
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
            <button type="button" onClick={() => void stopSpeechReading()}>停止</button>
          </>
        )}
        {speechAutoFollowSuspended && (
          <button type="button" onClick={followSpeechSegment}>跟随朗读</button>
        )}
      </div>
    )
  }

  async function updateTtsSettings(nextTts: MobileAppSettings['tts']) {
    setTtsSettingsMessage('')
    setTtsEngine(nextTts.engine)
    setTtsLocale(nextTts.locale)
    setTtsVoiceId(nextTts.voiceId)
    setTtsRate(nextTts.rate)
    setTtsPitch(nextTts.pitch)
    setTtsAutoFollow(nextTts.autoFollow)
    setTtsResumeFromProgress(nextTts.resumeFromProgress)
    await persistTtsSettings(nextTts)
  }

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return

    let cancelled = false
    const handles: Array<{ remove: () => Promise<void> }> = []

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
          saveCurrentSpeechProgress(segment, segmentIndex)
        }),
      )
      handles.push(
        await NovelReaderTts.addListener('utteranceDone', (event) => {
          if (cancelled || event.utteranceId !== currentUtteranceIdRef.current) return
          const current = speechPlaybackRef.current
          if (current.status === 'playing') {
            currentUtteranceIdRef.current = null
            speechUtteranceIndexRef.current.clear()
            setActiveSpeechSegmentId(null)
            setSpeechPlayback({ status: 'idle' })
          }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsLocale, ttsPitch, ttsRate, ttsVoiceId])

  useEffect(() => {
    return () => {
      if (speechFollowTimerRef.current != null) {
        window.clearTimeout(speechFollowTimerRef.current)
        speechFollowTimerRef.current = null
      }
      releaseChapterAudio()
      void NovelReaderTts.stop().catch(() => undefined)
    }
  }, [])

  function updateSearchInput(value: string) {
    setSearchInput(value)
    setSubmittedSearchQuery('')
    setRagResults([])
    setRagAnswer('')
    setRagError('')
    setHasRagSearched(false)
    setRagSearchStatus('')
    setRagGenerationStatus('')
  }

  function switchSearchMode(nextMode: SearchMode) {
    if (nextMode === searchMode) return
    setSearchMode(nextMode)
    setSubmittedSearchQuery('')
    setRagResults([])
    setRagAnswer('')
    setRagError('')
    setHasRagSearched(false)
    setRagSearchStatus('')
    setRagGenerationStatus('')
  }

  function submitSearch() {
    const query = searchInput.trim()
    if (!activePackage || !query) return

    setSubmittedSearchQuery(query)
    if (searchMode === 'rag') {
      void runRagSearch(query)
      return
    }

    setRagResults([])
    setRagAnswer('')
    setRagError('')
    setHasRagSearched(false)
    setRagSearchStatus('')
    setRagGenerationStatus('')
  }

  async function runRagSearch(queryOverride?: string) {
    const query = (queryOverride ?? searchInput).trim()
    if (!activePackage || !query) return

    setSubmittedSearchQuery(query)
    setIsRagSearching(true)
    setRagError('')
    setRagAnswer('')
    setRagGenerationStatus('')
    setHasRagSearched(true)
    setRagSearchStatus('正在检索本地正文、概要和 chunk...')

    try {
      const chapterById = new Map(activePackage.chapters.map((chapter) => [chapter.id, chapter]))
      const candidates = new Map<string, RagResult>()

      function addCandidate(result: RagResult) {
        const current = candidates.get(result.chapterId)
        if (!current || result.score > current.score) {
          candidates.set(result.chapterId, result)
        }
      }

      if (ragUseSemantic) {
        setRagSearchStatus('正在调用 Embedding 服务计算查询向量...')
        const queryEmbedding = await createQueryEmbedding(
          { baseUrl: embeddingBaseUrl, apiKey: embeddingApiKey, model: embeddingModel },
          query,
          client,
        )
        const indexedDimension = activePackage.embeddings.chunks.find((chunk) => chunk.embedding.length > 0)?.embedding.length
        if (indexedDimension && indexedDimension !== queryEmbedding.length) {
          throw new Error(`查询 embedding 维度 ${queryEmbedding.length} 与已同步 chunk 维度 ${indexedDimension} 不一致，请使用同一个 embedding 模型。`)
        }
        setRagSearchStatus(`正在计算语义相似度（${activePackage.embeddings.chunks.length} 个 chunk）...`)
        const semanticChunks = activePackage.embeddings.chunks
          .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 24)

        setRagSearchStatus(`语义召回 ${semanticChunks.length} 个 chunk，正在关联章节...`)
        for (const { chunk, score } of semanticChunks) {
          const chapter = chapterById.get(chunk.chapterId)
          if (!chapter) continue
          addCandidate({
            chapterId: chunk.chapterId,
            chapterIndex: chunk.chapterIndex,
            chapterTitle: chapter.title,
            snippet: findSnippet(chunk.text, query),
            source: 'chunk',
            score: score * 100,
          })
        }
      }

      const totalChunks = activePackage.embeddings.chunks.length
      let scannedChunks = 0
      for (const chunk of activePackage.embeddings.chunks) {
        scannedChunks++
        if (scannedChunks % 100 === 0 || scannedChunks === totalChunks) {
          setRagSearchStatus(`正在扫描 chunk 中...（${scannedChunks} / ${totalChunks}）`)
        }
        const score = scoreSearchText(chunk.text, query)
        if (!score) continue
        const chapter = chapterById.get(chunk.chapterId)
        if (!chapter) continue
        addCandidate({
          chapterId: chunk.chapterId,
          chapterIndex: chunk.chapterIndex,
          chapterTitle: chapter.title,
          snippet: findSnippet(chunk.text, query),
          source: 'chunk',
          score: score + 20,
        })
      }

      const totalSummaries = activePackage.summaries.length
      let scannedSummaries = 0
      for (const summary of activePackage.summaries) {
        scannedSummaries++
        if (scannedSummaries % 50 === 0 || scannedSummaries === totalSummaries) {
          setRagSearchStatus(`正在扫描概要中...（${scannedSummaries} / ${totalSummaries}）`)
        }
        const chapter = chapterById.get(summary.chapterId)
        if (!chapter) continue
        const haystack = [chapter.title, summary.short, summary.detail, summary.keyPoints.join(' ')].join('\n')
        const score = scoreSearchText(haystack, query)
        if (!score) continue
        addCandidate({
          chapterId: chapter.id,
          chapterIndex: chapter.index,
          chapterTitle: chapter.title,
          snippet: findSnippet(haystack, query),
          source: 'summary',
          score: score + 12,
        })
      }

      const totalChapters = activePackage.chapters.length
      let scannedChapters = 0
      for (const chapter of activePackage.chapters) {
        scannedChapters++
        if (scannedChapters % 100 === 0 || scannedChapters === totalChapters) {
          setRagSearchStatus(`正在扫描章节内容...（${scannedChapters} / ${totalChapters}）`)
        }
        const score = scoreSearchText(`${chapter.title}\n${chapter.content}`, query)
        if (!score) continue
        addCandidate({
          chapterId: chapter.id,
          chapterIndex: chapter.index,
          chapterTitle: chapter.title,
          snippet: findSnippet(chapter.content, query),
          source: 'chapter',
          score,
        })
      }

      const results = Array.from(candidates.values())
        .sort((a, b) => b.score - a.score || a.chapterIndex - b.chapterIndex)
        .slice(0, 20)

      setRagResults(results)
      setRagSearchStatus(`检索完成，召回 ${results.length} 个相关章节。`)
    } catch (error) {
      setRagError(error instanceof Error ? error.message : 'RAG 搜索失败。')
      setRagSearchStatus('')
    } finally {
      setIsRagSearching(false)
    }
  }

  function buildRagPrompt(): string {
    const context = ragResults
      .slice()
      .sort((a, b) => a.chapterIndex - b.chapterIndex)
      .map((result) => {
        const summary = activePackage?.summaries.find((item) => item.chapterId === result.chapterId)
        const lines = [`[第 ${result.chapterIndex} 章] ${result.chapterTitle}`]
        if (summary?.short) lines.push(`概要：${summary.short}`)
        if (summary?.detail) lines.push(`详情：${summary.detail}`)
        lines.push(`片段：${result.snippet}`)
        return lines.join('\n')
      })
      .join('\n\n')

    return `问题：${submittedSearchQuery.trim() || searchInput.trim()}

相关材料：
${context}

请基于材料回答问题。信息不足时请说明不足，不要编造。`
  }

  async function generateRagAnswer() {
    if (!ragResults.length) return

    setIsGeneratingAnswer(true)
    setRagError('')
    setRagGenerationStatus('')
    try {
      const chapterCount = ragResults.length
      setRagGenerationStatus(`正在构建 RAG 上下文（${chapterCount} 个相关章节）...`)
      const prompt = buildRagPrompt()
      setRagGenerationStatus(`已提交 ${chapterCount} 个章节，等待 LLM 响应...`)
      const answer = await generateAnswerWithExternalLlm(
        {
          baseUrl: llmBaseUrl,
          apiKey: llmApiKey,
          model: llmModel,
          temperature: llmTemperature,
          thinkingEnabled: false,
        },
        prompt,
      )
      setRagAnswer(answer || '外部 LLM 没有返回内容。')
      setRagGenerationStatus('')
    } catch (error) {
      setRagError(error instanceof Error ? error.message : '生成回答失败。')
      setRagGenerationStatus('')
    } finally {
      setIsGeneratingAnswer(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div>
          <h1>{activePackage?.book.title ?? 'Novel Reader Mobile'}</h1>
          <p>{activePackage ? `${activePackage.book.chapterCount} 章 · ${formatCount(activePackage.book.wordCount)} 字` : '离线阅读与同步'}</p>
        </div>
      </header>

      <main className="main-panel">
        {message && <div className="status-line">{message}</div>}

        {tab === 'library' && (
          <section>
            <h2>本地书架</h2>
            {localBooks.length === 0 ? (
              <div className="empty-state">
                <p>还没有离线书籍。</p>
                <button type="button" onClick={() => switchTab('sync')}>连接 PC 同步</button>
              </div>
            ) : (
              <div className="book-list">
                {localBooks.map((book) => (
                  <button className="book-row" key={book.id} type="button" onClick={() => void openLocalBook(book.id)}>
                    <span>
                      <strong>{book.title}</strong>
                      <small>
                        {book.chapterCount} 章 · 摘要 {book.summaryCount}/{book.chapterCount} ·
                        图谱 {book.entityCount} 实体/{book.relationCount} 关系
                      </small>
                    </span>
                    <small>已同步 {formatSyncDate(book.syncedAt)}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'sync' && (
          <section>
            <h2>设置</h2>
            <section className="settings-group">
              <h3>阅读设置</h3>
              <div className="reader-size-control" aria-label="字体大小">
                <button type="button" onClick={() => updateReaderFontSize(readerFontSize - 1)}>A-</button>
                <input
                  aria-label="字体大小"
                  max={28}
                  min={15}
                  type="range"
                  value={readerFontSize}
                  onChange={(event) => updateReaderFontSize(Number(event.target.value))}
                />
                <button type="button" onClick={() => updateReaderFontSize(readerFontSize + 1)}>A+</button>
                <span>{readerFontSize}px</span>
              </div>
              <div className="reader-background-control" aria-label="背景色">
                {(['paper', 'warm', 'green', 'dark'] as ReaderBackground[]).map((background) => (
                  <button
                    aria-label={backgroundLabel(background)}
                    className={`reader-swatch ${background} ${readerBackground === background ? 'active' : ''}`}
                    key={background}
                    type="button"
                    onClick={() => updateReaderBackground(background)}
                  />
                ))}
              </div>
            </section>
            <section className="settings-group">
              <h3>语音阅读</h3>
              <div className="segmented-control" aria-label="播放引擎">
                <button
                  className={ttsEngine === 'local-tts' ? 'active' : ''}
                  type="button"
                  onClick={() => void updateTtsSettings({ ...getCurrentTtsSettings(), engine: 'local-tts' })}
                >
                  本地 TTS
                </button>
                <button
                  className={ttsEngine === 'cloud-mp3' ? 'active' : ''}
                  type="button"
                  onClick={() => void updateTtsSettings({ ...getCurrentTtsSettings(), engine: 'cloud-mp3' })}
                >
                  云端 MP3
                </button>
              </div>
              <label className="field">
                <span>语言</span>
                <input
                  value={ttsLocale}
                  onChange={(event) => {
                    const locale = event.target.value
                    void updateTtsSettings({ ...getCurrentTtsSettings(), locale })
                  }}
                  placeholder="zh-CN"
                />
              </label>
              <label className="field">
                <span>音色</span>
                <select
                  value={ttsVoiceId}
                  onChange={(event) => {
                    void updateTtsSettings({ ...getCurrentTtsSettings(), voiceId: event.target.value })
                  }}
                >
                  <option value="">系统默认</option>
                  {ttsVoices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.name} · {voice.locale}{voice.requiresNetwork ? ' · 网络' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="settings-grid">
                <label className="field">
                  <span>语速 · {ttsRate.toFixed(ttsRate % 1 === 0 ? 0 : 2)}x</span>
                  <div className="rate-preset-grid" role="group" aria-label="语音朗读倍速">
                    {TTS_RATE_PRESETS.map((rate) => (
                      <button
                        type="button"
                        className={Math.abs(ttsRate - rate) < 0.001 ? 'active' : ''}
                        key={rate}
                        onClick={() => void updateTtsSettings({ ...getCurrentTtsSettings(), rate })}
                      >
                        {rate}x
                      </button>
                    ))}
                  </div>
                  <input
                    max={3}
                    min={0.5}
                    step={0.05}
                    type="number"
                    value={ttsRate}
                    onChange={(event) => {
                      const rate = Number(event.target.value)
                      void updateTtsSettings({ ...getCurrentTtsSettings(), rate })
                    }}
                  />
                </label>
                <label className="field">
                  <span>音调</span>
                  <input
                    max={2}
                    min={0.5}
                    step={0.05}
                    type="number"
                    value={ttsPitch}
                    onChange={(event) => {
                      const pitch = Number(event.target.value)
                      void updateTtsSettings({ ...getCurrentTtsSettings(), pitch })
                    }}
                  />
                </label>
              </div>
              <label className="inline-toggle">
                <input
                  checked={ttsAutoFollow}
                  type="checkbox"
                  onChange={(event) => {
                    void updateTtsSettings({ ...getCurrentTtsSettings(), autoFollow: event.target.checked })
                  }}
                />
                朗读时跟随正文
              </label>
              <label className="inline-toggle">
                <input
                  checked={ttsResumeFromProgress}
                  type="checkbox"
                  onChange={(event) => {
                    void updateTtsSettings({ ...getCurrentTtsSettings(), resumeFromProgress: event.target.checked })
                  }}
                />
                从上次语音进度继续
              </label>
              <div className="tts-action-panel">
                <button className="tts-primary-action" type="button" onClick={() => void refreshTtsAvailability()} disabled={isBusy}>
                  检测语音
                </button>
                <div className="tts-secondary-actions">
                  <button type="button" onClick={() => void saveTtsSettingsFromPanel()} disabled={isBusy}>保存配置</button>
                  <button type="button" onClick={() => void openSystemTtsSettings()}>系统语音设置</button>
                  <button type="button" onClick={() => void openSystemTtsDataCheck()}>安装语音包</button>
                </div>
              </div>
              {(ttsSettingsMessage || ttsStatusMessage) && <p className="tts-status-note">{ttsSettingsMessage || ttsStatusMessage}</p>}
            </section>
            <section className="settings-group">
              <h3>PC 同步</h3>
              <label className="field">
                <span>PC API 地址</span>
                <input
                  value={baseUrl}
                  onChange={(event) => {
                    setBaseUrl(event.target.value)
                    setSyncStatusMessage('')
                  }}
                  placeholder="http://192.168.1.8:5174"
                />
              </label>
              <label className="field">
                <span>同步 Token</span>
                <input
                  value={syncToken}
                  onChange={(event) => {
                    setSyncToken(event.target.value)
                    setSyncStatusMessage('')
                  }}
                  placeholder="开发期可为空"
                />
              </label>
              <div className="button-row">
                <button type="button" onClick={() => void persistSettings()} disabled={isBusy}>保存</button>
                <button type="button" onClick={() => void testConnection()} disabled={isBusy || !baseUrl}>测试连接</button>
                <button type="button" onClick={() => void loadRemoteBooks()} disabled={isBusy || !baseUrl}>读取书架</button>
              </div>
              {syncStatusMessage && <p className="inline-status">{syncStatusMessage}</p>}
              {remoteBooks.length > 0 && (
                <div className="book-list remote-book-list">
                  {remoteBooks.map((book) => {
                    const localBook = getLocalBook(book.id)
                    return (
                      <article className="remote-book" key={book.id}>
                        <div>
                          <h3>{book.title}</h3>
                          <p>
                            {book.chapterCount} 章 · 摘要 {book.summaryCoverage.completed}/{book.summaryCoverage.total} ·
                            图谱 {book.graphCoverage.entityCount} 实体/{book.graphCoverage.relationCount} 关系
                          </p>
                          <p>
                            Embedding {book.embeddingCoverage.embeddedSummaries}/{book.embeddingCoverage.totalSummaries} 概要，
                            {book.embeddingCoverage.embeddedChunks}/{book.embeddingCoverage.totalChunks} chunk
                          </p>
                          {localBook && (
                            <p>本地：已下载正文，chunk embedding {localBook.chunkEmbeddingCount}</p>
                          )}
                        </div>
                        <div className="remote-book-actions">
                          <button type="button" onClick={() => void downloadBook(book.id, { includeEmbeddings: false })} disabled={isBusy}>
                            {localBook ? '更新正文' : '下载正文'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void downloadBook(book.id, { includeEmbeddings: true })}
                            disabled={isBusy || !bookHasRemoteEmbeddings(book)}
                          >
                            {localBook ? '补 Embedding' : '含 Embedding'}
                          </button>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </section>
            <section className="settings-group">
              <h3>章节 MP3</h3>
              <p className="settings-note">PC Web 端为当前书配置音频目录后，可在这里同步到 Android 本机。</p>
              <div className="button-row two">
                <button type="button" onClick={() => void refreshBookAudio()} disabled={isBusy || !activePackage || !baseUrl}>
                  刷新音频
                </button>
                <button
                  type="button"
                  onClick={() => activeChapterAudio && void downloadChapterAudio(activeChapterAudio)}
                  disabled={isBusy || !activeChapterAudio}
                >
                  下载本章
                </button>
              </div>
              <p className="inline-status">
                已缓存 {cachedChapterAudioCount} 章
                {remoteChapterAudio.length ? ` · PC 可用 ${remoteChapterAudio.length} 章` : ' · 暂无 PC 音频清单'}
              </p>
              {remoteChapterAudio.length > 0 && (
                <div className="audio-sync-list">
                  {remoteChapterAudio.slice(0, 8).map((audio) => (
                    <button
                      className={audio.chapterId === activeChapterId ? 'audio-sync-row active' : 'audio-sync-row'}
                      key={audio.id}
                      type="button"
                      onClick={() => void downloadChapterAudio(audio)}
                      disabled={isBusy}
                    >
                      <span>
                        <strong>{audio.chapterIndex}. {audio.chapterTitle}</strong>
                        <small>{audio.filename} · {formatBytes(audio.bytes)}</small>
                      </span>
                      <span>下载</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section className="settings-group">
              <h3>外部 LLM</h3>
              <label className="field">
                <span>Base URL</span>
                <input
                  value={llmBaseUrl}
                  onChange={(event) => {
                    setLlmBaseUrl(event.target.value)
                    setLlmStatusMessage('')
                  }}
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="field">
                <span>API Key</span>
                <input
                  value={llmApiKey}
                  onChange={(event) => {
                    setLlmApiKey(event.target.value)
                    setLlmStatusMessage('')
                  }}
                  placeholder="可留空，按服务要求填写"
                  type="password"
                />
              </label>
              <div className="settings-grid">
                <label className="field">
                  <span>Model</span>
                  <input
                    value={llmModel}
                    onChange={(event) => {
                      setLlmModel(event.target.value)
                      setLlmStatusMessage('')
                    }}
                    placeholder="gpt-4.1-mini"
                  />
                </label>
                <label className="field">
                  <span>Temperature</span>
                  <input
                    max={2}
                    min={0}
                    step={0.1}
                    type="number"
                    value={llmTemperature}
                    onChange={(event) => {
                      setLlmTemperature(Number(event.target.value))
                      setLlmStatusMessage('')
                    }}
                  />
                </label>
              </div>
              <div className="button-row two">
                <button type="button" onClick={() => void persistSettings()} disabled={isBusy}>保存配置</button>
                <button type="button" onClick={() => void testExternalLlm()} disabled={isBusy}>测试 LLM</button>
              </div>
              {llmStatusMessage && <p className="inline-status">{llmStatusMessage}</p>}
            </section>
            <section className="settings-group">
              <h3>Embedding 服务</h3>
              <label className="field">
                <span>Base URL</span>
                <input
                  value={embeddingBaseUrl}
                  onChange={(event) => {
                    setEmbeddingBaseUrl(event.target.value)
                    setEmbeddingStatusMessage('')
                    setRagError('')
                  }}
                  placeholder="http://localhost:11434"
                />
              </label>
              <label className="field">
                <span>API Key</span>
                <input
                  value={embeddingApiKey}
                  onChange={(event) => {
                    setEmbeddingApiKey(event.target.value)
                    setEmbeddingStatusMessage('')
                    setRagError('')
                  }}
                  placeholder="可留空，按服务要求填写"
                  type="password"
                />
              </label>
              <label className="field">
                <span>Embedding Model</span>
                <input
                  value={embeddingModel}
                  onChange={(event) => {
                    setEmbeddingModel(event.target.value)
                    setEmbeddingStatusMessage('')
                    setRagError('')
                  }}
                  placeholder="bge-m3"
                />
              </label>
              <div className="button-row two">
                <button type="button" onClick={() => void persistSettings()} disabled={isBusy}>保存配置</button>
                <button type="button" onClick={() => void testEmbeddingService()} disabled={isBusy}>测试 Embedding</button>
              </div>
              {embeddingStatusMessage && <p className="inline-status">{embeddingStatusMessage}</p>}
            </section>
          </section>
        )}

        {tab === 'reader' && (
          <section>
            {!activePackage || !activeChapter ? (
              <div className="empty-state">
                <p>请选择一本本地书。</p>
                <button type="button" onClick={() => switchTab('library')}>回到书架</button>
              </div>
            ) : (
              <>
                <div className="chapter-toolbar">
                  <select value={activeChapter.id} onChange={(event) => openChapter(event.target.value)}>
                    {activePackage.chapters.map((chapter) => (
                      <option key={chapter.id} value={chapter.id}>
                        {chapter.index}. {chapter.title}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => switchTab('search')}>搜索</button>
                </div>
                <div className="chapter-nav-row">
                  <button type="button" onClick={() => changeChapter(previousChapter?.id ?? null)} disabled={!previousChapter}>上一章</button>
                  <button type="button" onClick={() => changeChapter(nextChapter?.id ?? null)} disabled={!nextChapter}>下一章</button>
                </div>
                <div className="speech-control-panel">
                  <div>
                    <strong>语音阅读</strong>
                    <span>{getSpeechPlaybackLabel()}</span>
                  </div>
                  {renderSpeechActions()}
                </div>
                {ttsStatusMessage && <p className="speech-status">{ttsStatusMessage}</p>}
                <article
                  className={`reader-card ${readerBackground}`}
                  onClick={handleReaderTap}
                  style={{ '--reader-font-size': `${readerFontSize}px` } as CSSProperties}
                >
                  <h2>{activeChapter.title}</h2>
                  <aside className={activeSummary ? 'summary-box' : 'summary-box summary-empty'}>
                    <strong>本章概要</strong>
                    {activeSummary ? (
                      <>
                        {activeSummary.short && <p className="summary-short">{activeSummary.short}</p>}
                        {activeSummary.detail && <p>{activeSummary.detail}</p>}
                        {activeSummary.keyPoints.length > 0 && (
                          <ul>
                            {activeSummary.keyPoints.map((point, index) => (
                              <li key={`${activeSummary.chapterId}-${index}`}>{point}</li>
                            ))}
                          </ul>
                        )}
                        {activeSummary.skippable && <p className="summary-skip">{activeSummary.skippable}</p>}
                      </>
                    ) : (
                      <p>
                        当前同步包没有这章的概要。本书本地概要 {activePackage.summaries.length}/{activePackage.chapters.length}，
                        可以回到同步页重新下载最新数据包。
                      </p>
                    )}
                  </aside>
                  <div className="chapter-text">
                    {speechChapter?.paragraphs.map((paragraph) => (
                      <p key={`${activeChapter.id}-${paragraph.paragraphIndex}`}>
                        {paragraph.segments.map((segment, index) => (
                          <span
                            className={segment.id === activeSpeechSegmentId ? 'speech-segment active' : 'speech-segment'}
                            data-speech-segment-id={segment.id}
                            key={segment.id}
                          >
                            {segment.text}
                            {index < paragraph.segments.length - 1 ? ' ' : ''}
                          </span>
                        ))}
                      </p>
                    ))}
                  </div>
                </article>
                <div className="chapter-nav-row bottom">
                  <button type="button" onClick={() => changeChapter(previousChapter?.id ?? null)} disabled={!previousChapter}>上一章</button>
                  <button type="button" onClick={() => changeChapter(nextChapter?.id ?? null)} disabled={!nextChapter}>下一章</button>
                </div>
              </>
            )}
          </section>
        )}

        {tab === 'search' && (
          <section>
            <div className="section-heading">
              <h2>搜索</h2>
              {activePackage && (
                <span>
                  chunk {activePackage.embeddings.chunks.length} · 图谱 {activePackage.knowledgeGraph.entities.length}/
                  {activePackage.knowledgeGraph.relations.length}
                </span>
              )}
            </div>
            {!activePackage ? (
              <div className="empty-state">
                <p>请选择一本本地书后再搜索。</p>
                <button type="button" onClick={() => switchTab('library')}>回到书架</button>
              </div>
            ) : (
              <>
                <div className="segmented-control" aria-label="搜索类型">
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
                  <button type="button" onClick={submitSearch} disabled={isRagSearching || !searchInput.trim()}>
                    {isRagSearching ? '检索中' : '检索'}
                  </button>
                </div>

                {searchMode === 'rag' && (
                  <>
                    <label className="inline-toggle">
                      <input checked={ragUseSemantic} onChange={(event) => setRagUseSemantic(event.target.checked)} type="checkbox" />
                      调用 Embedding 服务生成查询向量
                    </label>
                    {ragSearchStatus && <p className="muted search-status">{ragSearchStatus}</p>}
                    {ragError && <p className="error-text">{ragError}</p>}
                    {ragAnswer && <div className="answer-box">{ragAnswer}</div>}
                    {ragResults.length > 0 && (
                      <div className="result-actions">
                        <strong>相关章节 {ragResults.length}</strong>
                        <button type="button" onClick={() => void generateRagAnswer()} disabled={isGeneratingAnswer || !llmBaseUrl || !llmModel}>
                          {isGeneratingAnswer ? '生成中' : '生成回答'}
                        </button>
                      </div>
                    )}
                    {ragGenerationStatus && <p className="muted search-status">{ragGenerationStatus}</p>}
                    <div className="search-results">
                      {ragResults.map((result) => (
                        <button className="search-result" key={`${result.source}-${result.chapterId}`} type="button" onClick={() => openChapter(result.chapterId)}>
                          <strong>{result.chapterIndex}. {result.chapterTitle}</strong>
                          <small>{sourceLabel(result.source)} · score {result.score.toFixed(1)}</small>
                          <span>{result.snippet}</span>
                        </button>
                      ))}
                      {searchInput && !submittedSearchQuery && !hasRagSearched && !isRagSearching && ragResults.length === 0 && (
                        <p className="muted">点击检索开始搜索。</p>
                      )}
                      {submittedSearchQuery && hasRagSearched && !isRagSearching && ragResults.length === 0 && (
                        <p className="muted">没有召回相关章节。可以打开语义检索，或换一个更接近原文/概要的关键词。</p>
                      )}
                    </div>
                  </>
                )}

                {searchMode === 'graph' && (
                  <div className="search-results">
                    {graphResults.map((result) => {
                      if (result.kind === 'entity') {
                        return (
                          <article className="graph-result" key={`entity-${result.entity.id}`}>
                            <strong>{result.entity.name}</strong>
                            <small>
                              {result.entity.type} · 出现 {result.mentions} 次 · 关系 {result.relationCount} 条
                            </small>
                            {result.entity.aliases.length > 0 && <span>别名：{result.entity.aliases.join('、')}</span>}
                            <p>{result.snippet}</p>
                          </article>
                        )
                      }

                      if (result.kind === 'relation') {
                        return (
                          <article className="graph-result" key={`relation-${result.relation.id}`}>
                            <strong>{result.sourceName} → {result.targetName}</strong>
                            <small>{result.relation.type} · 证据 {result.mentions} 条</small>
                            <p>{result.snippet}</p>
                          </article>
                        )
                      }

                      return (
                        <button className="search-result" key={`evidence-${result.id}`} type="button" onClick={() => openChapter(result.chapterId)}>
                          <strong>{result.chapterIndex}. {result.title}</strong>
                          <small>图谱证据</small>
                          <span>{result.snippet}</span>
                        </button>
                      )
                    })}
                    {searchInput && !submittedSearchQuery && <p className="muted">点击检索开始搜索。</p>}
                    {submittedSearchQuery && graphResults.length === 0 && <p className="muted">没有匹配的实体、关系或证据。</p>}
                  </div>
                )}

                {searchMode === 'rag' && textSearchResults.length > 0 && ragResults.length === 0 && (
                  <div className="quick-hits">
                    <strong>快速命中</strong>
                    {textSearchResults.slice(0, 5).map((result) => (
                      <button className="search-result" key={`quick-${result.chapterId}`} type="button" onClick={() => openChapter(result.chapterId)}>
                        <strong>{result.chapterIndex}. {result.chapterTitle}</strong>
                        <span>{result.snippet}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </main>

      {tab === 'reader' && activePackage && activeChapter && readerMenuOpen && (
        <div className="reader-menu-overlay" role="presentation" onClick={() => setReaderMenuOpen(false)}>
          <section className="reader-menu-sheet" role="dialog" aria-modal="true" aria-label="阅读控制菜单" onClick={(event) => event.stopPropagation()}>
            <div className="reader-menu-header">
              <div>
                <strong>{activeChapter.title}</strong>
                <span>{activeChapter.index}/{activePackage.chapters.length}</span>
              </div>
              <button type="button" onClick={() => setReaderMenuOpen(false)}>关闭</button>
            </div>

            <div className="chapter-nav-row reader-menu-nav">
              <button type="button" onClick={() => changeChapter(previousChapter?.id ?? null)} disabled={!previousChapter}>上一章</button>
              <button type="button" onClick={() => changeChapter(nextChapter?.id ?? null)} disabled={!nextChapter}>下一章</button>
            </div>

            <div className="speech-control-panel reader-menu-group">
              <div>
                <strong>语音阅读</strong>
                <span>{getSpeechPlaybackLabel()}</span>
              </div>
              {renderSpeechActions()}
            </div>

            <div className="reader-settings reader-menu-group">
              <strong>阅读设置</strong>
              <div className="reader-size-control" aria-label="字体大小">
                <button type="button" onClick={() => updateReaderFontSize(readerFontSize - 1)}>A-</button>
                <input
                  aria-label="字体大小"
                  max={28}
                  min={15}
                  type="range"
                  value={readerFontSize}
                  onChange={(event) => updateReaderFontSize(Number(event.target.value))}
                />
                <button type="button" onClick={() => updateReaderFontSize(readerFontSize + 1)}>A+</button>
                <span>{readerFontSize}px</span>
              </div>
              <div className="reader-background-control" aria-label="背景色">
                {(['paper', 'warm', 'green', 'dark'] as ReaderBackground[]).map((background) => (
                  <button
                    aria-label={backgroundLabel(background)}
                    className={`reader-swatch ${background} ${readerBackground === background ? 'active' : ''}`}
                    key={background}
                    type="button"
                    onClick={() => updateReaderBackground(background)}
                  />
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      <nav className="bottom-nav">
        <button className={tab === 'library' ? 'active' : ''} type="button" onClick={() => switchTab('library')}>书架</button>
        <button className={tab === 'reader' ? 'active' : ''} type="button" onClick={() => switchTab('reader')}>阅读</button>
        <button className={tab === 'search' ? 'active' : ''} type="button" onClick={() => switchTab('search')}>搜索</button>
        <button className={tab === 'sync' ? 'active' : ''} type="button" onClick={() => switchTab('sync')}>设置</button>
      </nav>
    </div>
  )
}

export default App
