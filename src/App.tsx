import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Chapter = {
  id: string
  index: number
  title: string
  content: string
  wordCount: number
}

type Book = {
  id: string
  title: string
  chapters: Chapter[]
  importedAt: string
}

type Summary = {
  short: string
  detail: string
  keyPoints: string[]
  skippable: string
  generatedBy: 'local' | 'ollama' | 'openai'
}

type StoredState = {
  book: Book | null
  activeChapterId: string | null
  summaries: Record<string, Summary>
  aiProvider: AIProvider
  ollamaModel: string
  ollamaTemperature: number
  ollamaConcurrency: number
  openaiConfigs: OpenAIConfig[]
  activeOpenAIConfigId: string
  thinkingEnabled: boolean
  importEncoding: ImportEncoding
  readerFontSize: number
}

type AIProvider = 'ollama' | 'openai'
type ImportEncoding = 'auto' | 'utf-8' | 'gb18030'
type AppView = 'home' | 'reader'
type OllamaModel = {
  name: string
}
type OpenAIConfig = {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  thinkingEnabled: boolean
  temperature: number
  concurrency: number
}
type ModelConfigDraft = Pick<
  StoredState,
  | 'aiProvider'
  | 'ollamaModel'
  | 'ollamaTemperature'
  | 'ollamaConcurrency'
  | 'openaiConfigs'
  | 'activeOpenAIConfigId'
  | 'thinkingEnabled'
>

const STORAGE_KEY = 'novel-reader-mvp-state'
const DB_NAME = 'novel-reader-mvp'
const DB_STORE = 'state'
const DB_VERSION = 1
const CHAPTERS_PER_PAGE = 100

const initialState: StoredState = {
  book: null,
  activeChapterId: null,
  summaries: {},
  aiProvider: 'ollama',
  ollamaModel: 'qwen2.5:7b',
  ollamaTemperature: 1,
  ollamaConcurrency: 1,
  openaiConfigs: [
    {
      id: 'default-openai',
      name: 'OpenAI 默认',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4.1-mini',
      thinkingEnabled: false,
      temperature: 1,
      concurrency: 3,
    },
  ],
  activeOpenAIConfigId: 'default-openai',
  thinkingEnabled: false,
  importEncoding: 'auto',
  readerFontSize: 18,
}

const OLLAMA_BASE_URL = 'http://localhost:11434'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_STORE)
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function loadStateFromDb(): Promise<StoredState | null> {
  const database = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, 'readonly')
    const store = transaction.objectStore(DB_STORE)
    const request = store.get(STORAGE_KEY)

    request.onsuccess = () => resolve((request.result as StoredState | undefined) ?? null)
    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => database.close()
  })
}

function normalizeStoredState(storedState: Partial<StoredState> & Record<string, unknown>): StoredState {
  const legacyTemperature =
    typeof storedState.temperature === 'number' && Number.isFinite(storedState.temperature)
      ? storedState.temperature
      : 1
  const legacyBaseUrl =
    typeof storedState.openaiBaseUrl === 'string'
      ? storedState.openaiBaseUrl
      : initialState.openaiConfigs[0].baseUrl
  const legacyApiKey =
    typeof storedState.openaiApiKey === 'string' ? storedState.openaiApiKey : ''
  const legacyModel =
    typeof storedState.openaiModel === 'string'
      ? storedState.openaiModel
      : initialState.openaiConfigs[0].model

  const openaiConfigs =
    Array.isArray(storedState.openaiConfigs) && storedState.openaiConfigs.length
      ? sanitizeOpenAIConfigs(
          storedState.openaiConfigs as OpenAIConfig[],
          Boolean(storedState.thinkingEnabled),
          legacyTemperature,
        )
      : [
          {
            id: 'migrated-openai',
            name: legacyModel || '外部模型',
            baseUrl: legacyBaseUrl,
            apiKey: legacyApiKey,
            model: legacyModel,
            thinkingEnabled: Boolean(storedState.thinkingEnabled),
            temperature: legacyTemperature,
            concurrency: 3,
          },
        ]

  const activeOpenAIConfigId =
    typeof storedState.activeOpenAIConfigId === 'string' &&
    openaiConfigs.some((config) => config.id === storedState.activeOpenAIConfigId)
      ? storedState.activeOpenAIConfigId
      : openaiConfigs[0].id

  return {
    ...initialState,
    ...storedState,
    openaiConfigs,
    activeOpenAIConfigId,
    ollamaTemperature:
      typeof storedState.ollamaTemperature === 'number' &&
      Number.isFinite(storedState.ollamaTemperature)
        ? storedState.ollamaTemperature
        : legacyTemperature,
    ollamaConcurrency: normalizeConcurrency(storedState.ollamaConcurrency, 1),
    readerFontSize:
      typeof storedState.readerFontSize === 'number' &&
      Number.isFinite(storedState.readerFontSize)
        ? storedState.readerFontSize
        : 18,
  }
}

function sanitizeOpenAIConfigs(
  configs: OpenAIConfig[],
  fallbackThinking = false,
  fallbackTemperature = 1,
): OpenAIConfig[] {
  const fallback = initialState.openaiConfigs[0]

  return configs.map((config, index) => ({
    id: config.id || crypto.randomUUID(),
    name: config.name || config.model || `外部模型 ${index + 1}`,
    baseUrl: config.baseUrl || fallback.baseUrl,
    apiKey: config.apiKey || '',
    model: config.model || fallback.model,
    thinkingEnabled:
      typeof config.thinkingEnabled === 'boolean' ? config.thinkingEnabled : fallbackThinking,
    temperature:
      typeof config.temperature === 'number' && Number.isFinite(config.temperature)
        ? config.temperature
        : fallbackTemperature,
    concurrency: normalizeConcurrency(config.concurrency, 3),
  }))
}

function normalizeConcurrency(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback

  return Math.max(1, Math.min(10, Math.floor(value)))
}

function getActiveOpenAIConfig(config: Pick<StoredState, 'openaiConfigs' | 'activeOpenAIConfigId'>) {
  return (
    config.openaiConfigs.find((item) => item.id === config.activeOpenAIConfigId) ??
    config.openaiConfigs[0]
  )
}

async function saveStateToDb(state: StoredState): Promise<void> {
  const database = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DB_STORE, 'readwrite')
    const store = transaction.objectStore(DB_STORE)
    const request = store.put(state, STORAGE_KEY)

    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => {
      database.close()
      resolve()
    }
    transaction.onerror = () => reject(transaction.error)
  })
}

function splitChapters(rawText: string): Chapter[] {
  const normalized = rawText.replace(/\r\n?/g, '\n').trim()
  const headingPattern =
    /^(?:\s*)(?:正文\s*)?(第\s*[零〇一二两三四五六七八九十百千万\d]+\s*(?:章|回|节|卷)|Chapter\s+\d+|CHAPTER\s+\d+)[^\n]{0,80}$/gm

  const matches = [...normalized.matchAll(headingPattern)]

  if (matches.length < 2) {
    return chunkFallback(normalized)
  }

  return matches.map((match, idx) => {
    const start = match.index ?? 0
    const nextStart = matches[idx + 1]?.index ?? normalized.length
    const block = normalized.slice(start, nextStart).trim()
    const [titleLine = `第${idx + 1}章`, ...bodyLines] = block.split('\n')
    const content = bodyLines.join('\n').trim()

    return {
      id: crypto.randomUUID(),
      index: idx + 1,
      title: titleLine.trim(),
      content,
      wordCount: countWords(content),
    }
  })
}

function chunkFallback(text: string): Chapter[] {
  const chunkSize = 6000
  const chunks: Chapter[] = []

  for (let start = 0; start < text.length; start += chunkSize) {
    const content = text.slice(start, start + chunkSize).trim()
    if (!content) continue

    chunks.push({
      id: crypto.randomUUID(),
      index: chunks.length + 1,
      title: `自动分段 ${chunks.length + 1}`,
      content,
      wordCount: countWords(content),
    })
  }

  return chunks
}

function countWords(text: string) {
  return text.replace(/\s/g, '').length
}

function inferTitle(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '') || '未命名小说'
}

async function decodeTextFile(file: File, encoding: ImportEncoding) {
  const buffer = await file.arrayBuffer()

  if (encoding !== 'auto') {
    return new TextDecoder(encoding).decode(buffer)
  }

  const utf8 = new TextDecoder('utf-8').decode(buffer)
  const gb18030 = new TextDecoder('gb18030').decode(buffer)

  return scoreDecodedText(gb18030) > scoreDecodedText(utf8) ? gb18030 : utf8
}

function scoreDecodedText(text: string) {
  const sample = text.slice(0, 20000)
  const replacementCount = (sample.match(/\uFFFD/g) ?? []).length
  const chineseCount = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length
  const chapterHeadingCount = (
    sample.match(/第\s*[零〇一二两三四五六七八九十百千万\d]+\s*章/g) ?? []
  ).length

  return chineseCount + chapterHeadingCount * 80 - replacementCount * 160
}

function makeLocalSummary(chapter: Chapter): Summary {
  const clean = chapter.content.replace(/\s+/g, ' ').trim()
  const firstSentence = clean.match(/^.{1,120}?[。！？.!?]/)?.[0] ?? clean.slice(0, 120)
  const keyPoints = clean
    .split(/[。！？.!?]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 24)
    .slice(0, 4)

  return {
    short: firstSentence || '这一章暂时没有可提取的正文。',
    detail:
      clean.length > 420
        ? `${clean.slice(0, 420)}...`
        : clean || '这一章暂时没有可提取的正文。',
    keyPoints: keyPoints.length ? keyPoints : ['本地摘要只能粗略截取正文，建议连接 Ollama 生成更准确概要。'],
    skippable:
      chapter.wordCount > 7000
        ? '可能适合略读：本章篇幅较长，建议先看概要再决定是否细读。'
        : '建议正常阅读：本章篇幅不长，先不标记为水章。',
    generatedBy: 'local',
  }
}

function buildSummaryPrompt(chapter: Chapter, thinkingEnabled: boolean) {
  const thinkingInstruction = thinkingEnabled
    ? '/think\n你可以在内部进行必要推理，但最终回复只能是 JSON，不要输出思考过程。'
    : '/no_think\n不要输出思考过程，不要输出分析步骤，直接输出 JSON。'

  return `${thinkingInstruction}

你是长篇网络小说陪读助手。请只基于下面这一章内容，输出 JSON，不要剧透后文。

JSON 格式：
{
  "short": "一句话概要",
  "detail": "200字以内详细概要",
  "keyPoints": ["必须知道的信息1", "必须知道的信息2", "必须知道的信息3"],
  "skippable": "是否适合跳读，以及原因"
}

章节标题：${chapter.title}
章节正文：
${chapter.content.slice(0, 6000)}`
}

async function generateWithOllama(
  chapter: Chapter,
  model: string,
  temperature: number,
  thinkingEnabled: boolean,
): Promise<Summary> {
  if (!model.trim()) {
    throw new Error('请先选择或填写一个 Ollama 模型。')
  }

  const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: buildSummaryPrompt(chapter, thinkingEnabled),
      stream: false,
      format: 'json',
      options: {
        temperature,
      },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Ollama 返回 ${response.status}：${body || '请求失败'}`)
  }

  const data = (await response.json()) as { response?: string }
  const parsed = parseOllamaSummary(data.response ?? '{}')

  return {
    short: parsed.short || 'Ollama 没有返回一句话概要。',
    detail: parsed.detail || 'Ollama 没有返回详细概要。',
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6) : [],
    skippable: parsed.skippable || '暂无跳读建议。',
    generatedBy: 'ollama',
  }
}

async function generateWithOpenAICompatible(
  chapter: Chapter,
  baseUrl: string,
  apiKey: string,
  model: string,
  temperature: number,
  thinkingEnabled: boolean,
): Promise<Summary> {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '')

  if (!normalizedBaseUrl) {
    throw new Error('请先填写 OpenAI-compatible Base URL。')
  }

  if (!model.trim()) {
    throw new Error('请先填写 OpenAI-compatible Model Name。')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }

  const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model.trim(),
      messages: [
        {
          role: 'system',
          content: '你是长篇网络小说陪读助手。你必须只输出符合要求的 JSON。',
        },
        {
          role: 'user',
          content: buildSummaryPrompt(chapter, thinkingEnabled),
        },
      ],
      temperature,
      response_format: { type: 'json_object' },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI-compatible 接口返回 ${response.status}：${body || '请求失败'}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content ?? '{}'
  const parsed = parseOllamaSummary(content)

  return {
    short: parsed.short || '模型没有返回一句话概要。',
    detail: parsed.detail || '模型没有返回详细概要。',
    keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6) : [],
    skippable: parsed.skippable || '暂无跳读建议。',
    generatedBy: 'openai',
  }
}

function parseOllamaSummary(raw: string): Partial<Summary> {
  const jsonText = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  try {
    return JSON.parse(jsonText) as Partial<Summary>
  } catch {
    return {
      short: 'Ollama 已返回内容，但不是标准 JSON。',
      detail: raw.slice(0, 600),
      keyPoints: [],
      skippable: '请重试，或换一个更擅长中文指令的模型。',
    }
  }
}

async function fetchOllamaModels(): Promise<OllamaModel[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`)

  if (!response.ok) {
    throw new Error(`无法连接 Ollama：${response.status}`)
  }

  const data = (await response.json()) as { models?: OllamaModel[] }
  return data.models ?? []
}

async function validateModelConfig(config: ModelConfigDraft): Promise<void> {
  if (config.aiProvider === 'ollama') {
    if (!config.ollamaModel.trim()) {
      throw new Error('请先选择或填写 Ollama 模型。')
    }

    if (!Number.isFinite(config.ollamaTemperature)) {
      throw new Error('Ollama Temperature 必须是数字。')
    }

    if (normalizeConcurrency(config.ollamaConcurrency, 1) !== config.ollamaConcurrency) {
      throw new Error('Ollama 并发度必须是 1 到 10 的整数。')
    }

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaModel.trim(),
        prompt: '/no_think\n只输出 JSON：{"ok":true}',
        stream: false,
        format: 'json',
        options: {
          temperature: config.ollamaTemperature,
        },
      }),
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Ollama 验证失败 ${response.status}：${body || '请求失败'}`)
    }

    return
  }

  const activeConfig = getActiveOpenAIConfig(config)

  if (!activeConfig) {
    throw new Error('请先新增一个外部模型配置。')
  }

  const normalizedBaseUrl = activeConfig.baseUrl.trim().replace(/\/+$/, '')

  if (!normalizedBaseUrl) {
    throw new Error('请填写 Base URL。')
  }

  if (!activeConfig.model.trim()) {
    throw new Error('请填写 Model Name。')
  }

  if (!Number.isFinite(activeConfig.temperature)) {
    throw new Error('当前外部模型的 Temperature 必须是数字。')
  }

  if (normalizeConcurrency(activeConfig.concurrency, 3) !== activeConfig.concurrency) {
    throw new Error('当前外部模型的并发度必须是 1 到 10 的整数。')
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (activeConfig.apiKey.trim()) {
    headers.Authorization = `Bearer ${activeConfig.apiKey.trim()}`
  }

  const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: activeConfig.model.trim(),
      messages: [
        {
          role: 'user',
          content: '/no_think\n只输出 JSON：{"ok":true}',
        },
      ],
      temperature: activeConfig.temperature,
      response_format: { type: 'json_object' },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI-compatible 验证失败 ${response.status}：${body || '请求失败'}`)
  }
}

function getModelConfigDraft(state: StoredState): ModelConfigDraft {
  return {
    aiProvider: state.aiProvider,
    ollamaModel: state.ollamaModel,
    ollamaTemperature: state.ollamaTemperature,
    ollamaConcurrency: state.ollamaConcurrency,
    openaiConfigs: state.openaiConfigs,
    activeOpenAIConfigId: state.activeOpenAIConfigId,
    thinkingEnabled: state.thinkingEnabled,
  }
}

function App() {
  const readerRef = useRef<HTMLElement | null>(null)
  const chapterListRef = useRef<HTMLDivElement | null>(null)
  const activeChapterButtonRef = useRef<HTMLButtonElement | null>(null)
  const [state, setState] = useState<StoredState>(initialState)
  const [view, setView] = useState<AppView>('home')
  const [chapterPage, setChapterPage] = useState(1)
  const [isHydrated, setIsHydrated] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [batchProgress, setBatchProgress] = useState('')
  const [isConfigOpen, setIsConfigOpen] = useState(false)
  const [modelConfigDraft, setModelConfigDraft] = useState<ModelConfigDraft>(() =>
    getModelConfigDraft(initialState),
  )
  const [isTestingConfig, setIsTestingConfig] = useState(false)
  const [configError, setConfigError] = useState('')
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])
  const [isCheckingOllama, setIsCheckingOllama] = useState(false)
  const [error, setError] = useState('')

  const activeChapter = useMemo(() => {
    if (!state.book || !state.activeChapterId) return null
    return state.book.chapters.find((chapter) => chapter.id === state.activeChapterId) ?? null
  }, [state.book, state.activeChapterId])

  const activeSummary = activeChapter ? state.summaries[activeChapter.id] : null
  const previousChapter =
    state.book && activeChapter && activeChapter.index > 1
      ? state.book.chapters[activeChapter.index - 2]
      : null
  const nextChapter =
    state.book && activeChapter && activeChapter.index < state.book.chapters.length
      ? state.book.chapters[activeChapter.index]
      : null
  const chapterPageCount = state.book
    ? Math.max(1, Math.ceil(state.book.chapters.length / CHAPTERS_PER_PAGE))
    : 1
  const pagedChapters = state.book
    ? state.book.chapters.slice(
        (chapterPage - 1) * CHAPTERS_PER_PAGE,
        chapterPage * CHAPTERS_PER_PAGE,
      )
    : []

  useEffect(() => {
    localStorage.removeItem(STORAGE_KEY)

    loadStateFromDb()
      .then((storedState) => {
        if (storedState) {
          setState(normalizeStoredState(storedState as Partial<StoredState> & Record<string, unknown>))
        }
      })
      .catch(() => {
        setError('读取本地书库失败，可以重新导入 txt。')
      })
      .finally(() => setIsHydrated(true))
  }, [])

  useEffect(() => {
    if (!isHydrated) return

    saveStateToDb(state).catch(() => {
      setError('保存到浏览器数据库失败，可能是浏览器存储空间不足。')
    })
  }, [isHydrated, state])

  useEffect(() => {
    if (!isHydrated) return

    setIsCheckingOllama(true)
    fetchOllamaModels()
      .then((models) => {
        setOllamaModels(models)

        if (models.length && !models.some((model) => model.name === state.ollamaModel)) {
          setState((current) => ({ ...current, ollamaModel: models[0].name }))
        }
      })
      .catch(() => {
        setOllamaModels([])
      })
      .finally(() => setIsCheckingOllama(false))
  }, [isHydrated])

  useEffect(() => {
    if (!activeChapter) return

    const activePage = Math.ceil(activeChapter.index / CHAPTERS_PER_PAGE)
    setChapterPage(activePage)
    readerRef.current?.scrollTo({ top: 0 })
  }, [activeChapter?.id])

  useEffect(() => {
    if (view !== 'reader' || !activeChapter) return

    window.requestAnimationFrame(() => {
      activeChapterButtonRef.current?.scrollIntoView({
        block: 'center',
        inline: 'nearest',
      })
    })
  }, [view, activeChapter?.id, chapterPage])

  useEffect(() => {
    if (view !== 'reader' || isConfigOpen) return

    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      const tagName = target?.tagName
      const isEditing =
        target?.isContentEditable ||
        tagName === 'INPUT' ||
        tagName === 'TEXTAREA' ||
        tagName === 'SELECT' ||
        tagName === 'BUTTON'

      if (isEditing) return

      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        navigateToPreviousChapter()
        return
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault()
        navigateToNextChapter()
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        readerRef.current?.scrollBy({ top: -Math.round(window.innerHeight * 0.72), behavior: 'smooth' })
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        readerRef.current?.scrollBy({ top: Math.round(window.innerHeight * 0.72), behavior: 'smooth' })
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [view, isConfigOpen, previousChapter?.id, nextChapter?.id])

  async function handleImport(file: File) {
    setError('')
    const text = await decodeTextFile(file, state.importEncoding)
    const chapters = splitChapters(text)

    if (!chapters.length) {
      setError('没有识别到正文内容，请换一个 txt 文件试试。')
      return
    }

    const book: Book = {
      id: crypto.randomUUID(),
      title: inferTitle(file.name),
      chapters,
      importedAt: new Date().toISOString(),
    }

    setState((current) => ({
      ...current,
      book,
      activeChapterId: chapters[0].id,
      summaries: {},
    }))
    setChapterPage(1)
    setView('reader')
  }

  async function handleGenerateSummary(useOllama: boolean) {
    if (!activeChapter) return

    setIsGenerating(true)
    setBatchProgress('')
    setError('')

    try {
      const summary = await generateChapterSummary(activeChapter, useOllama)

      setState((current) => ({
        ...current,
        summaries: {
          ...current.summaries,
          [activeChapter.id]: summary,
        },
      }))
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成概要失败。')
    } finally {
      setIsGenerating(false)
    }
  }

  async function generateChapterSummary(chapter: Chapter, useModel: boolean): Promise<Summary> {
    if (!useModel) {
      return makeLocalSummary(chapter)
    }

    if (state.aiProvider === 'openai') {
      const activeConfig = getActiveOpenAIConfig(state)

      return generateWithOpenAICompatible(
        chapter,
        activeConfig.baseUrl,
        activeConfig.apiKey,
        activeConfig.model,
        activeConfig.temperature,
        activeConfig.thinkingEnabled,
      )
    }

    return generateWithOllama(
      chapter,
      state.ollamaModel,
      state.ollamaTemperature,
      state.thinkingEnabled,
    )
  }

  async function handleBatchGenerateCurrentPage() {
    const pendingChapters = pagedChapters.filter((chapter) => !state.summaries[chapter.id])
    const concurrency = getActiveConcurrency()

    if (!pendingChapters.length) {
      setBatchProgress('当前章节页已经全部生成概要。')
      return
    }

    setIsGenerating(true)
    setError('')

    try {
      let nextIndex = 0
      let completedCount = 0

      async function worker() {
        while (nextIndex < pendingChapters.length) {
          const chapter = pendingChapters[nextIndex]
          nextIndex += 1
          setBatchProgress(
            `并发 ${concurrency}，正在生成 ${completedCount + 1}/${pendingChapters.length}：第 ${chapter.index} 章`,
          )
          const summary = await generateChapterSummary(chapter, true)
          completedCount += 1

          setState((current) => ({
            ...current,
            summaries: {
              ...current.summaries,
              [chapter.id]: summary,
            },
          }))
          setBatchProgress(
            `并发 ${concurrency}，已完成 ${completedCount}/${pendingChapters.length}`,
          )
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(concurrency, pendingChapters.length) }, () => worker()),
      )

      setBatchProgress(`本页 ${pendingChapters.length} 章概要已生成。`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '批量生成概要失败。')
    } finally {
      setIsGenerating(false)
    }
  }

  function getActiveConcurrency() {
    if (state.aiProvider === 'openai') {
      return normalizeConcurrency(getActiveOpenAIConfig(state)?.concurrency, 3)
    }

    return normalizeConcurrency(state.ollamaConcurrency, 1)
  }

  function updateActiveChapter(id: string) {
    setState((current) => ({ ...current, activeChapterId: id }))
  }

  function navigateToPreviousChapter() {
    if (!previousChapter) return

    updateActiveChapter(previousChapter.id)
  }

  function navigateToNextChapter() {
    if (!nextChapter) return

    updateActiveChapter(nextChapter.id)
  }

  function resetBook() {
    setState((current) => ({ ...current, book: null, activeChapterId: null, summaries: {} }))
    setView('home')
  }

  function openModelConfig() {
    setModelConfigDraft(getModelConfigDraft(state))
    setConfigError('')
    setIsConfigOpen(true)
  }

  function closeModelConfig() {
    if (isTestingConfig) return

    setConfigError('')
    setModelConfigDraft(getModelConfigDraft(state))
    setIsConfigOpen(false)
  }

  function updateActiveOpenAIConfig(updates: Partial<OpenAIConfig>) {
    setModelConfigDraft((current) => ({
      ...current,
      openaiConfigs: current.openaiConfigs.map((config) =>
        config.id === current.activeOpenAIConfigId ? { ...config, ...updates } : config,
      ),
    }))
  }

  function addOpenAIConfig() {
    const id = crypto.randomUUID()

    setModelConfigDraft((current) => ({
      ...current,
      aiProvider: 'openai',
        activeOpenAIConfigId: id,
        openaiConfigs: [
          ...current.openaiConfigs,
          {
            id,
            name: `外部模型 ${current.openaiConfigs.length + 1}`,
            baseUrl: 'https://api.openai.com/v1',
          apiKey: '',
          model: 'gpt-4.1-mini',
          thinkingEnabled: false,
          temperature: 1,
          concurrency: 3,
        },
      ],
    }))
  }

  function removeActiveOpenAIConfig() {
    setModelConfigDraft((current) => {
      if (current.openaiConfigs.length <= 1) return current

      const nextConfigs = current.openaiConfigs.filter(
        (config) => config.id !== current.activeOpenAIConfigId,
      )

      return {
        ...current,
        activeOpenAIConfigId: nextConfigs[0].id,
        openaiConfigs: nextConfigs,
      }
    })
  }

  async function saveModelConfig() {
    setIsTestingConfig(true)
    setConfigError('')

    try {
      await validateModelConfig(modelConfigDraft)
      const openaiConfigs = sanitizeOpenAIConfigs(modelConfigDraft.openaiConfigs).map((config) => ({
        ...config,
        baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
        apiKey: config.apiKey.trim(),
        model: config.model.trim(),
        temperature: Number.isFinite(config.temperature) ? config.temperature : 1,
        concurrency: normalizeConcurrency(config.concurrency, 3),
        name: config.name.trim() || config.model.trim() || '外部模型',
      }))
      const activeOpenAIConfigId = openaiConfigs.some(
        (config) => config.id === modelConfigDraft.activeOpenAIConfigId,
      )
        ? modelConfigDraft.activeOpenAIConfigId
        : openaiConfigs[0].id

      setState((current) => ({
        ...current,
        ...modelConfigDraft,
        openaiConfigs,
        activeOpenAIConfigId,
        ollamaTemperature: Number.isFinite(modelConfigDraft.ollamaTemperature)
          ? modelConfigDraft.ollamaTemperature
          : 1,
        ollamaConcurrency: normalizeConcurrency(modelConfigDraft.ollamaConcurrency, 1),
        ollamaModel: modelConfigDraft.ollamaModel.trim(),
      }))
      setIsConfigOpen(false)
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : '模型配置验证失败。')
    } finally {
      setIsTestingConfig(false)
    }
  }

  const processedCount = Object.keys(state.summaries).length
  const pageSummaryCount = pagedChapters.filter((chapter) => state.summaries[chapter.id]).length
  const currentProgressLabel = activeChapter
    ? `${activeChapter.title}（位置 ${activeChapter.index}/${state.book?.chapters.length ?? 0}）`
    : '未开始'
  const activeProviderLabel = state.aiProvider === 'openai' ? '外部模型' : 'Ollama'
  const activeOpenAIConfig = getActiveOpenAIConfig(state)
  const activeModelName =
    state.aiProvider === 'openai' ? activeOpenAIConfig?.name || activeOpenAIConfig?.model : state.ollamaModel
  const activeThinkingEnabled =
    state.aiProvider === 'openai'
      ? Boolean(activeOpenAIConfig?.thinkingEnabled)
      : state.thinkingEnabled
  const activeTemperature =
    state.aiProvider === 'openai'
      ? activeOpenAIConfig?.temperature ?? 1
      : state.ollamaTemperature
  const activeConcurrency = getActiveConcurrency()
  const draftActiveOpenAIConfig = getActiveOpenAIConfig(modelConfigDraft)
  const importedDate = state.book
    ? new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(state.book.importedAt))
    : ''

  if (!isHydrated) {
    return (
      <main className="app-shell">
        <section className="loading-panel">
          <p className="eyebrow">Novel Reader MVP 0.1</p>
          <h1>正在打开本地书库...</h1>
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Novel Reader MVP 0.1</p>
          <h1>长篇小说陪读助手</h1>
        </div>
        {state.book && view === 'reader' && (
          <button type="button" className="ghost-button home-button" onClick={() => setView('home')}>
            返回首页
          </button>
        )}
        <div className="model-status">
          <span>{activeProviderLabel}</span>
          <small>
            {activeModelName || '未配置'} · Temp {activeTemperature} · 并发 {activeConcurrency} · Thinking{' '}
            {activeThinkingEnabled ? '开' : '关'}
          </small>
          <button type="button" className="ghost-button" onClick={openModelConfig}>
            模型配置
          </button>
        </div>
      </header>

      {isConfigOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="config-modal" role="dialog" aria-modal="true" aria-labelledby="config-title">
            <div className="modal-heading">
              <div>
                <p className="eyebrow">AI 设置</p>
                <h2 id="config-title">模型配置</h2>
              </div>
              <button type="button" className="ghost-button" onClick={closeModelConfig}>
                取消
              </button>
            </div>

            <div className="config-form">
              <label htmlFor="draft-ai-provider">AI 提供商</label>
              <select
                id="draft-ai-provider"
                value={modelConfigDraft.aiProvider}
                disabled={isTestingConfig}
                onChange={(event) =>
                  setModelConfigDraft((current) => ({
                    ...current,
                    aiProvider: event.target.value as AIProvider,
                  }))
                }
              >
                <option value="ollama">Ollama 本地</option>
                <option value="openai">OpenAI-compatible</option>
              </select>

              {modelConfigDraft.aiProvider === 'ollama' ? (
                <>
                  <label htmlFor="draft-ollama-temperature">Ollama Temperature</label>
                  <input
                    id="draft-ollama-temperature"
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={modelConfigDraft.ollamaTemperature}
                    disabled={isTestingConfig}
                    onChange={(event) =>
                      setModelConfigDraft((current) => ({
                        ...current,
                        ollamaTemperature: Number(event.target.value),
                      }))
                    }
                  />
                  <small>默认 1。保存前会用当前值验证本地模型。</small>
                  <label htmlFor="draft-ollama-concurrency">Ollama 并发度</label>
                  <input
                    id="draft-ollama-concurrency"
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    value={modelConfigDraft.ollamaConcurrency}
                    disabled={isTestingConfig}
                    onChange={(event) =>
                      setModelConfigDraft((current) => ({
                        ...current,
                        ollamaConcurrency: Number(event.target.value),
                      }))
                    }
                  />
                  <small>默认 1。本地模型通常建议保持低并发。</small>
                  <label className="thinking-toggle" htmlFor="draft-thinking-enabled">
                    <input
                      id="draft-thinking-enabled"
                      type="checkbox"
                      checked={modelConfigDraft.thinkingEnabled}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          thinkingEnabled: event.target.checked,
                        }))
                      }
                    />
                    Thinking 模式
                  </label>
                  <small>
                    {modelConfigDraft.thinkingEnabled
                      ? '开启：适合本地推理模型，最终仍要求只输出 JSON'
                      : '关闭：会发送 /no_think，摘要更快更干净'}
                  </small>
                  <label htmlFor="draft-ollama-model">Ollama 模型</label>
                  {ollamaModels.length ? (
                    <select
                      id="draft-ollama-model"
                      value={modelConfigDraft.ollamaModel}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          ollamaModel: event.target.value,
                        }))
                      }
                    >
                      {ollamaModels.map((model) => (
                        <option key={model.name} value={model.name}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="draft-ollama-model"
                      value={modelConfigDraft.ollamaModel}
                      disabled={isTestingConfig}
                      placeholder={isCheckingOllama ? '正在读取模型...' : '例如 qwen2.5:7b'}
                      onChange={(event) =>
                        setModelConfigDraft((current) => ({
                          ...current,
                          ollamaModel: event.target.value,
                        }))
                      }
                    />
                  )}
                  <small>
                    {ollamaModels.length
                      ? `已发现 ${ollamaModels.length} 个本地模型。保存前会实际测试一次。`
                      : '未自动发现模型，可手动填写；保存前会实际测试一次。'}
                  </small>
                </>
              ) : (
                <>
                  <div className="external-model-row">
                    <label htmlFor="draft-openai-config">选择外部模型</label>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={isTestingConfig}
                      onClick={addOpenAIConfig}
                    >
                      新增模型
                    </button>
                  </div>
                  <select
                    id="draft-openai-config"
                    value={modelConfigDraft.activeOpenAIConfigId}
                    disabled={isTestingConfig}
                    onChange={(event) =>
                      setModelConfigDraft((current) => ({
                        ...current,
                        activeOpenAIConfigId: event.target.value,
                      }))
                    }
                  >
                    {modelConfigDraft.openaiConfigs.map((config) => (
                      <option key={config.id} value={config.id}>
                        {config.name || config.model || '未命名外部模型'}
                      </option>
                    ))}
                  </select>

                  <label htmlFor="draft-openai-name">配置名称</label>
                  <input
                    id="draft-openai-name"
                    value={draftActiveOpenAIConfig?.name ?? ''}
                    disabled={isTestingConfig}
                    placeholder="例如 Moonshot K2"
                    onChange={(event) => updateActiveOpenAIConfig({ name: event.target.value })}
                  />
                  <label htmlFor="draft-openai-base-url">Base URL</label>
                  <input
                    id="draft-openai-base-url"
                    value={draftActiveOpenAIConfig?.baseUrl ?? ''}
                    disabled={isTestingConfig}
                    placeholder="https://api.openai.com/v1"
                    onChange={(event) => updateActiveOpenAIConfig({ baseUrl: event.target.value })}
                  />
                  <label htmlFor="draft-openai-api-key">API Key</label>
                  <input
                    id="draft-openai-api-key"
                    type="password"
                    value={draftActiveOpenAIConfig?.apiKey ?? ''}
                    disabled={isTestingConfig}
                    placeholder="sk-..."
                    onChange={(event) => updateActiveOpenAIConfig({ apiKey: event.target.value })}
                  />
                  <label htmlFor="draft-openai-model">Model Name</label>
                  <input
                    id="draft-openai-model"
                    value={draftActiveOpenAIConfig?.model ?? ''}
                    disabled={isTestingConfig}
                    placeholder="gpt-4.1-mini"
                    onChange={(event) => updateActiveOpenAIConfig({ model: event.target.value })}
                  />
                  <label htmlFor="draft-openai-temperature">当前外部模型 Temperature</label>
                  <input
                    id="draft-openai-temperature"
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    value={draftActiveOpenAIConfig?.temperature ?? 1}
                    disabled={isTestingConfig}
                    onChange={(event) =>
                      updateActiveOpenAIConfig({ temperature: Number(event.target.value) })
                    }
                  />
                  <small>默认 1。部分兼容接口只接受特定值，保存前会用当前值验证。</small>
                  <label htmlFor="draft-openai-concurrency">当前外部模型并发度</label>
                  <input
                    id="draft-openai-concurrency"
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    value={draftActiveOpenAIConfig?.concurrency ?? 3}
                    disabled={isTestingConfig}
                    onChange={(event) =>
                      updateActiveOpenAIConfig({ concurrency: Number(event.target.value) })
                    }
                  />
                  <small>默认 3。批量生成当前章节页时会同时请求这么多章节。</small>
                  <label className="thinking-toggle" htmlFor="draft-openai-thinking-enabled">
                    <input
                      id="draft-openai-thinking-enabled"
                      type="checkbox"
                      checked={Boolean(draftActiveOpenAIConfig?.thinkingEnabled)}
                      disabled={isTestingConfig}
                      onChange={(event) =>
                        updateActiveOpenAIConfig({ thinkingEnabled: event.target.checked })
                      }
                    />
                    当前外部模型启用 Thinking
                  </label>
                  <small>
                    {draftActiveOpenAIConfig?.thinkingEnabled
                      ? '当前外部模型会发送 /think，但最终仍要求只输出 JSON'
                      : '当前外部模型会发送 /no_think，适合不需要思考模式的模型'}
                  </small>
                  <button
                    type="button"
                    className="ghost-button danger-button"
                    disabled={isTestingConfig || modelConfigDraft.openaiConfigs.length <= 1}
                    onClick={removeActiveOpenAIConfig}
                  >
                    删除当前外部模型
                  </button>
                  <small>支持 /chat/completions 兼容接口。保存前会实际测试一次。</small>
                </>
              )}

              {configError && <p className="error">{configError}</p>}
            </div>

            <div className="modal-actions">
              <button type="button" className="ghost-button" onClick={closeModelConfig} disabled={isTestingConfig}>
                取消
              </button>
              <button type="button" onClick={() => void saveModelConfig()} disabled={isTestingConfig}>
                {isTestingConfig ? '测试中...' : '测试并保存'}
              </button>
            </div>
          </section>
        </div>
      )}

      {view === 'home' ? (
        <section className="home-panel">
          <div className="import-copy">
            <p className="eyebrow">首页</p>
            <h2>{state.book ? '本地书架' : '导入一本 txt 小说'}</h2>
            <p>
              章节切分结果、当前阅读位置和已生成概要都会保存在本机浏览器数据库里。返回首页不会清空数据，只有重新导入会替换当前书籍。
            </p>
            <label className="encoding-field" htmlFor="import-encoding">
              文本编码
              <select
                id="import-encoding"
                value={state.importEncoding}
                onChange={(event) =>
                  setState((current) => ({
                    ...current,
                    importEncoding: event.target.value as ImportEncoding,
                  }))
                }
              >
                <option value="auto">自动识别</option>
                <option value="gb18030">GBK / GB18030</option>
                <option value="utf-8">UTF-8</option>
              </select>
            </label>
          </div>

          {state.book && (
            <div className="book-card">
              <p className="eyebrow">当前书籍</p>
              <h2>{state.book.title}</h2>
              <dl>
                <div>
                  <dt>章节</dt>
                  <dd>{state.book.chapters.length} 章</dd>
                </div>
                <div>
                  <dt>概要</dt>
                  <dd>{processedCount} 章</dd>
                </div>
                <div>
                  <dt>进度</dt>
                  <dd>{currentProgressLabel}</dd>
                </div>
                <div>
                  <dt>导入时间</dt>
                  <dd>{importedDate}</dd>
                </div>
              </dl>
              <div className="book-actions">
                <button type="button" onClick={() => setView('reader')}>
                  继续阅读
                </button>
                <button type="button" className="ghost-button" onClick={resetBook}>
                  清空并重新导入
                </button>
              </div>
            </div>
          )}

          <label className="upload-box">
            <input
              type="file"
              accept=".txt,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleImport(file)
              }}
            />
            <span>{state.book ? '导入新 txt 替换当前书' : '选择 txt 文件'}</span>
            <small>支持“第1章 / 第一章 / Chapter 1”等常见标题格式</small>
          </label>
          {error && <p className="error">{error}</p>}
        </section>
      ) : state.book ? (
        <section className="reader-layout">
          <aside className="chapter-list" aria-label="章节目录">
            <div className="book-status">
              <p className="eyebrow">书架</p>
              <h2>{state.book.title}</h2>
              <p>
                共 {state.book.chapters.length} 章，已生成概要 {processedCount} 章，当前：
                {activeChapter?.title ?? '未开始'}
              </p>
              <button type="button" className="ghost-button" onClick={resetBook}>
                重新导入
              </button>
            </div>

            <div className="chapter-pager">
              <button
                type="button"
                className="ghost-button"
                disabled={chapterPage <= 1}
                onClick={() => setChapterPage((page) => Math.max(1, page - 1))}
              >
                上 100 章
              </button>
              <label htmlFor="chapter-page">
                章节页
                <select
                  id="chapter-page"
                  value={chapterPage}
                  onChange={(event) => setChapterPage(Number(event.target.value))}
                >
                  {Array.from({ length: chapterPageCount }, (_, index) => {
                    const page = index + 1
                    const start = index * CHAPTERS_PER_PAGE + 1
                    const end = Math.min(page * CHAPTERS_PER_PAGE, state.book?.chapters.length ?? 0)

                    return (
                      <option key={page} value={page}>
                        {start}-{end} 章
                      </option>
                    )
                  })}
                </select>
              </label>
              <button
                type="button"
                className="ghost-button"
                disabled={chapterPage >= chapterPageCount}
                onClick={() => setChapterPage((page) => Math.min(chapterPageCount, page + 1))}
              >
                下 100 章
              </button>
            </div>

            <div className="chapter-scroll" ref={chapterListRef}>
              {pagedChapters.map((chapter) => (
                <button
                  key={chapter.id}
                  ref={chapter.id === activeChapter?.id ? activeChapterButtonRef : null}
                  type="button"
                  className={chapter.id === activeChapter?.id ? 'chapter active' : 'chapter'}
                  onClick={() => updateActiveChapter(chapter.id)}
                >
                  <span>{chapter.title}</span>
                  <small>
                    {chapter.wordCount} 字
                    {state.summaries[chapter.id] ? ' · 已概要' : ''}
                  </small>
                </button>
              ))}
            </div>
          </aside>

          <article className="chapter-reader" ref={readerRef}>
            {activeChapter && (
              <>
                <div className="chapter-heading">
                  <p className="eyebrow">
                    位置 {activeChapter.index}/{state.book.chapters.length}
                  </p>
                  <h2>{activeChapter.title}</h2>
                  <div className="chapter-nav">
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!previousChapter}
                      onClick={navigateToPreviousChapter}
                    >
                      上一章
                    </button>
                    <span>键盘：↑↓ 滚动，←→ 切换章节</span>
                    <button
                      type="button"
                      className="ghost-button"
                      disabled={!nextChapter}
                      onClick={navigateToNextChapter}
                    >
                      下一章
                    </button>
                  </div>
                  <div className="reader-controls">
                    <p>{activeChapter.wordCount} 字</p>
                    <label htmlFor="reader-font-size">
                      字号
                      <input
                        id="reader-font-size"
                        type="range"
                        min="14"
                        max="28"
                        step="1"
                        value={state.readerFontSize}
                        onChange={(event) =>
                          setState((current) => ({
                            ...current,
                            readerFontSize: Number(event.target.value),
                          }))
                        }
                      />
                      <span>{state.readerFontSize}px</span>
                    </label>
                  </div>
                </div>
                <div
                  className="chapter-content"
                  style={{ fontSize: `${state.readerFontSize}px` }}
                >
                  {activeChapter.content.split('\n').map((line, index) => (
                    <p key={`${activeChapter.id}-${index}`}>{line || ' '}</p>
                  ))}
                </div>
              </>
            )}
          </article>

          <aside className="ai-panel" aria-label="AI 辅助栏">
            <p className="eyebrow">AI 辅助栏</p>
            <h2>本章概要</h2>
            <div className="summary-actions">
              <button
                type="button"
                onClick={() => void handleGenerateSummary(true)}
                disabled={isGenerating}
              >
                {isGenerating
                  ? '生成中...'
                  : state.aiProvider === 'openai'
                    ? '用外部模型生成'
                    : '用 Ollama 生成'}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void handleGenerateSummary(false)}
                disabled={isGenerating}
              >
                本地粗略概要
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void handleBatchGenerateCurrentPage()}
                disabled={isGenerating}
              >
                批量生成本页缺失概要
              </button>
            </div>
            <p className="batch-status">
              本页已生成 {pageSummaryCount}/{pagedChapters.length} 章
              {batchProgress ? ` · ${batchProgress}` : ''}
            </p>

            {error && <p className="error">{error}</p>}

            {activeSummary ? (
              <div className="summary-card">
                <span className="tag">
                  {activeSummary.generatedBy === 'ollama'
                    ? 'Ollama'
                    : activeSummary.generatedBy === 'openai'
                      ? '外部模型'
                      : '本地'}{' '}
                  生成
                </span>
                <h3>一句话</h3>
                <p>{activeSummary.short}</p>
                <h3>详细概要</h3>
                <p>{activeSummary.detail}</p>
                <h3>必须知道</h3>
                <ul>
                  {activeSummary.keyPoints.map((point, index) => (
                    <li key={`${point}-${index}`}>{point}</li>
                  ))}
                </ul>
                <h3>跳读建议</h3>
                <p>{activeSummary.skippable}</p>
              </div>
            ) : (
              <div className="empty-summary">
                <p>这一章还没有概要。你可以先用本地粗略概要测试流程，再用 Ollama 生成更像样的版本。</p>
              </div>
            )}
          </aside>
        </section>
      ) : (
        <section className="home-panel">
          <div className="empty-summary">
            <p>还没有导入书籍，请先返回首页选择 txt 文件。</p>
            <button type="button" onClick={() => setView('home')}>
              返回首页
            </button>
          </div>
        </section>
      )}
    </main>
  )
}

export default App
