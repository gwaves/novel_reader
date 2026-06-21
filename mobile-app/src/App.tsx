import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import {
  MobileApiClient,
  type MobileBookListItem,
  type MobileBookPackage,
  type MobileKgEntity,
  type MobileKgRelation,
} from './lib/mobileApi'
import {
  getBookPackage,
  getReadingProgress,
  listLocalBooks,
  loadSettings,
  saveBookPackage,
  saveReadingProgress,
  saveSettings,
  type MobileAppSettings,
  type ReaderBackground,
  type LocalBook,
} from './lib/localLibrary'

type Tab = 'library' | 'sync' | 'reader' | 'search'
type SearchMode = 'rag' | 'graph'

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
}, query: string): Promise<number[]> {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '')
  const model = settings.model.trim()
  if (!baseUrl || !model) {
    throw new Error('请先在同步页配置 Embedding 服务的 Base URL 和模型名。')
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (settings.apiKey.trim()) {
    headers.Authorization = `Bearer ${settings.apiKey.trim()}`
  }

  const openAiResponse = await fetch(`${baseUrl}/embeddings`, {
    body: JSON.stringify({ model, input: query }),
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

  if (shouldTryOllama) {
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

  throw new Error(`查询 embedding 失败 ${openAiResponse.status}：${openAiBody || '请求失败'}`)
}

async function testEmbeddingServiceConfig(settings: {
  baseUrl: string
  apiKey: string
  model: string
}): Promise<number> {
  const embedding = await createQueryEmbedding(settings, 'ping')
  return embedding.length
}

async function generateAnswerWithExternalLlm(settings: {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
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

  const response = await fetch(`${baseUrl}/chat/completions`, {
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是长篇小说阅读助手。请只根据给定材料回答，并引用章节号。' },
        { role: 'user', content: prompt },
      ],
      temperature: settings.temperature,
    }),
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
  const [hasRagSearched, setHasRagSearched] = useState(false)
  const [ragSearchStatus, setRagSearchStatus] = useState('')
  const [readerFontSize, setReaderFontSize] = useState(19)
  const [readerBackground, setReaderBackground] = useState<ReaderBackground>('paper')
  const pendingRestoreScrollRef = useRef<number | null>(null)
  const progressSaveTimerRef = useRef<number | null>(null)

  const client = useMemo(() => new MobileApiClient({ baseUrl, syncToken }), [baseUrl, syncToken])

  const activeChapter = useMemo(() => {
    if (!activePackage || !activeChapterId) return null
    return activePackage.chapters.find((chapter) => chapter.id === activeChapterId) ?? null
  }, [activeChapterId, activePackage])

  const activeSummary = activeChapter ? activePackage?.summaries.find((summary) => summary.chapterId === activeChapter.id) : null

  const activeChapterPosition = useMemo(() => {
    if (!activePackage || !activeChapterId) return -1
    return activePackage.chapters.findIndex((chapter) => chapter.id === activeChapterId)
  }, [activeChapterId, activePackage])

  const previousChapter = activePackage && activeChapterPosition > 0 ? activePackage.chapters[activeChapterPosition - 1] : null
  const nextChapter =
    activePackage && activeChapterPosition >= 0 && activeChapterPosition < activePackage.chapters.length - 1
      ? activePackage.chapters[activeChapterPosition + 1]
      : null

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

  useEffect(() => {
    void hydrate()
  }, [])

  useEffect(() => {
    if (tab !== 'reader' || !activePackage || !activeChapterId) return
    const pendingScroll = pendingRestoreScrollRef.current
    if (pendingScroll == null) return
    pendingRestoreScrollRef.current = null
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: pendingScroll })
    })
  }, [activeChapterId, activePackage, tab])

  useEffect(() => {
    if (tab !== 'reader' || !activePackage || !activeChapterId) return

    function scheduleSaveProgress() {
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
    scheduleSaveProgress()

    return () => {
      window.removeEventListener('scroll', scheduleSaveProgress)
      if (progressSaveTimerRef.current != null) {
        window.clearTimeout(progressSaveTimerRef.current)
        progressSaveTimerRef.current = null
      }
      void saveReadingProgress({
        bookId: activePackage.book.id,
        chapterId: activeChapterId,
        scrollY: window.scrollY,
      })
    }
  }, [activeChapterId, activePackage, tab])

  async function hydrate() {
    const [settings, books] = await Promise.all([loadSettings(), listLocalBooks()])
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
    setLocalBooks(books)
  }

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

  async function testExternalLlm() {
    setIsBusy(true)
    setMessage('')
    try {
      await testExternalLlmConfig({
        baseUrl: llmBaseUrl,
        apiKey: llmApiKey,
        model: llmModel,
        temperature: llmTemperature,
      })
      setMessage('外部 LLM 测试通过。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '外部 LLM 测试失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function testEmbeddingService() {
    setIsBusy(true)
    setMessage('')
    try {
      const dimension = await testEmbeddingServiceConfig({
        baseUrl: embeddingBaseUrl,
        apiKey: embeddingApiKey,
        model: embeddingModel,
      })
      setMessage(`Embedding 服务测试通过，维度 ${dimension}。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Embedding 服务测试失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function testConnection() {
    setIsBusy(true)
    setMessage('')
    try {
      const manifest = await client.getManifest()
      setMessage(`连接成功：schema v${manifest.schemaVersion}，服务时间 ${new Date(manifest.generatedAt).toLocaleString()}。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '连接失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function loadRemoteBooks() {
    setIsBusy(true)
    setMessage('')
    try {
      await persistSettings()
      const books = await client.listBooks()
      setRemoteBooks(books)
      setMessage(`发现 ${books.length} 本可同步书籍。`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '读取 PC 书架失败。')
    } finally {
      setIsBusy(false)
    }
  }

  async function downloadBook(bookId: string) {
    setIsBusy(true)
    setMessage('')
    try {
      const pkg = await client.downloadBookPackage(bookId)
      await saveBookPackage(pkg)
      setLocalBooks(await listLocalBooks())
      setActivePackage(pkg)
      setActiveChapterId(pkg.chapters[0]?.id ?? null)
      pendingRestoreScrollRef.current = 0
      if (pkg.chapters[0]) {
        void saveReadingProgress({ bookId: pkg.book.id, chapterId: pkg.chapters[0].id, scrollY: 0 })
      }
      setMessage('')
      setTab('reader')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '同步书籍失败。')
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
    pendingRestoreScrollRef.current = progress?.chapterId === progressChapter ? progress.scrollY : 0
    setMessage('')
    setTab('reader')
  }

  function openChapter(chapterId: string) {
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
    const distance = Math.max(320, window.innerHeight * 0.82)
    window.scrollBy({
      top: direction === 'down' ? distance : -distance,
      behavior: 'smooth',
    })
  }

  function handleReaderTap(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement
    if (target.closest('button, input, select, textarea, a, label')) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const isLeftSide = event.clientX - bounds.left < bounds.width / 2
    scrollReaderPage(isLeftSide ? 'up' : 'down')
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
    if (nextTab !== tab) {
      setMessage('')
    }
    setTab(nextTab)
  }

  function updateSearchInput(value: string) {
    setSearchInput(value)
    setSubmittedSearchQuery('')
    setRagResults([])
    setRagAnswer('')
    setRagError('')
    setHasRagSearched(false)
    setRagSearchStatus('')
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
  }

  async function runRagSearch(queryOverride?: string) {
    const query = (queryOverride ?? searchInput).trim()
    if (!activePackage || !query) return

    setSubmittedSearchQuery(query)
    setIsRagSearching(true)
    setRagError('')
    setRagAnswer('')
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
        const queryEmbedding = await createQueryEmbedding(
          { baseUrl: embeddingBaseUrl, apiKey: embeddingApiKey, model: embeddingModel },
          query,
        )
        const indexedDimension = activePackage.embeddings.chunks.find((chunk) => chunk.embedding.length > 0)?.embedding.length
        if (indexedDimension && indexedDimension !== queryEmbedding.length) {
          throw new Error(`查询 embedding 维度 ${queryEmbedding.length} 与已同步 chunk 维度 ${indexedDimension} 不一致，请使用同一个 embedding 模型。`)
        }
        const semanticChunks = activePackage.embeddings.chunks
          .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 24)

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

      for (const chunk of activePackage.embeddings.chunks) {
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

      for (const summary of activePackage.summaries) {
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

      for (const chapter of activePackage.chapters) {
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
    try {
      const answer = await generateAnswerWithExternalLlm(
        {
          baseUrl: llmBaseUrl,
          apiKey: llmApiKey,
          model: llmModel,
          temperature: llmTemperature,
        },
        buildRagPrompt(),
      )
      setRagAnswer(answer || '外部 LLM 没有返回内容。')
    } catch (error) {
      setRagError(error instanceof Error ? error.message : '生成回答失败。')
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
            <h3 className="settings-subheading">PC 同步</h3>
            <label className="field">
              <span>PC API 地址</span>
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="http://192.168.1.8:5174" />
            </label>
            <label className="field">
              <span>同步 Token</span>
              <input value={syncToken} onChange={(event) => setSyncToken(event.target.value)} placeholder="开发期可为空" />
            </label>
            <div className="button-row">
              <button type="button" onClick={() => void persistSettings()} disabled={isBusy}>保存</button>
              <button type="button" onClick={() => void testConnection()} disabled={isBusy || !baseUrl}>测试连接</button>
              <button type="button" onClick={() => void loadRemoteBooks()} disabled={isBusy || !baseUrl}>读取书架</button>
            </div>
            <section className="settings-group">
              <h3>外部 LLM</h3>
              <label className="field">
                <span>Base URL</span>
                <input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
              </label>
              <label className="field">
                <span>API Key</span>
                <input value={llmApiKey} onChange={(event) => setLlmApiKey(event.target.value)} placeholder="可留空，按服务要求填写" type="password" />
              </label>
              <div className="settings-grid">
                <label className="field">
                  <span>Model</span>
                  <input value={llmModel} onChange={(event) => setLlmModel(event.target.value)} placeholder="gpt-4.1-mini" />
                </label>
                <label className="field">
                  <span>Temperature</span>
                  <input
                    max={2}
                    min={0}
                    step={0.1}
                    type="number"
                    value={llmTemperature}
                    onChange={(event) => setLlmTemperature(Number(event.target.value))}
                  />
                </label>
              </div>
              <div className="button-row two">
                <button type="button" onClick={() => void persistSettings()} disabled={isBusy}>保存配置</button>
                <button type="button" onClick={() => void testExternalLlm()} disabled={isBusy}>测试 LLM</button>
              </div>
            </section>
            <section className="settings-group">
              <h3>Embedding 服务</h3>
              <label className="field">
                <span>Base URL</span>
                <input
                  value={embeddingBaseUrl}
                  onChange={(event) => {
                    setEmbeddingBaseUrl(event.target.value)
                    setMessage('')
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
                    setMessage('')
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
                    setMessage('')
                    setRagError('')
                  }}
                  placeholder="bge-m3"
                />
              </label>
              <div className="button-row two">
                <button type="button" onClick={() => void persistSettings()} disabled={isBusy}>保存配置</button>
                <button type="button" onClick={() => void testEmbeddingService()} disabled={isBusy}>测试 Embedding</button>
              </div>
            </section>
            <div className="book-list">
              {remoteBooks.map((book) => (
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
                  </div>
                  <button type="button" onClick={() => void downloadBook(book.id)} disabled={isBusy}>下载</button>
                </article>
              ))}
            </div>
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
                    {activeChapter.content.split(/\n+/).map((paragraph, index) => (
                      <p key={`${activeChapter.id}-${index}`}>{paragraph}</p>
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
