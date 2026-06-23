import { Capacitor, CapacitorHttp } from '@capacitor/core'

export type MobileManifest = {
  serverVersion: string
  schemaVersion: number
  capabilities: Array<'full-book-package' | 'reading-progress' | 'incremental-sync' | 'compressed-package'>
  generatedAt: string
}

export type MobileBookListItem = {
  id: string
  title: string
  importedAt: string
  updatedAt: string | null
  chapterCount: number
  wordCount: number
  summaryCoverage: { completed: number; total: number }
  graphCoverage: {
    scannedChapters: number
    totalChapters: number
    entityCount: number
    relationCount: number
  }
  embeddingCoverage: {
    model: string | null
    dimension: number | null
    embeddedSummaries: number
    totalSummaries: number
    embeddedChunks: number
    totalChunks: number
  }
  packageVersion: string
}

export type MobileChapter = {
  id: string
  bookId: string
  index: number
  title: string
  content: string
  wordCount: number
  updatedAt: string | null
}

export type MobileSummary = {
  chapterId: string
  short: string
  detail: string
  keyPoints: string[]
  skippable: string
  generatedBy: 'local' | 'ollama' | 'openai'
  updatedAt: string | null
}

export type MobileKgEntity = {
  id: string
  bookId: string
  type: string
  name: string
  normalizedName: string
  aliases: string[]
  description: string | null
  confidence: number
  firstChapterIndex: number | null
  lastChapterIndex: number | null
  reviewStatus: string | null
  updatedAt: string | null
}

export type MobileKgEntityMention = {
  id: string
  entityId: string
  bookId: string
  chapterId: string
  chapterIndex: number
  evidence: string | null
  confidence: number
}

export type MobileKgRelation = {
  id: string
  bookId: string
  sourceEntityId: string
  targetEntityId: string
  type: string
  description: string | null
  confidence: number
  firstChapterIndex: number | null
  lastChapterIndex: number | null
  reviewStatus: string | null
  updatedAt: string | null
}

export type MobileKgRelationMention = {
  id: string
  relationId: string
  bookId: string
  chapterId: string
  chapterIndex: number
  evidence: string | null
  confidence: number
}

export type MobileSummaryEmbedding = {
  chapterId: string
  bookId: string
  model: string
  dimension: number
  embedding: number[]
  generatedAt: string
}

export type MobileChunkEmbedding = {
  id: string
  bookId: string
  chapterId: string
  chapterIndex: number
  chunkIndex: number
  startOffset: number
  endOffset: number
  text: string
  model: string
  dimension: number
  embedding: number[]
  generatedAt: string
}

export type MobileBookPackage = {
  schemaVersion: number
  packageVersion: string
  generatedAt: string
  book: {
    id: string
    title: string
    importedAt: string
    chapterCount: number
    wordCount: number
  }
  chapters: MobileChapter[]
  summaries: MobileSummary[]
  knowledgeGraph: {
    entities: MobileKgEntity[]
    entityMentions: MobileKgEntityMention[]
    relations: MobileKgRelation[]
    relationMentions: MobileKgRelationMention[]
  }
  embeddings: {
    summaries: MobileSummaryEmbedding[]
    chunks: MobileChunkEmbedding[]
  }
  integrity: {
    contentHash: string | null
    algorithm: 'sha256' | null
  }
}

export type MobileApiSettings = {
  baseUrl: string
  syncToken: string
}

export type MobileEmbeddingProxyRequest = {
  baseUrl: string
  apiKey: string
  model: string
  input: string
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as T | { error?: string } | null
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? payload.error : ''
    throw new Error(message || `请求失败：${response.status}`)
  }
  return payload as T
}

export class MobileApiClient {
  private readonly baseUrl: string
  private readonly syncToken: string

  constructor(settings: MobileApiSettings) {
    this.baseUrl = normalizeBaseUrl(settings.baseUrl)
    this.syncToken = settings.syncToken.trim()
  }

  async getManifest(): Promise<MobileManifest> {
    return readJson<MobileManifest>(await this.fetch('/api/mobile/manifest'))
  }

  async listBooks(): Promise<MobileBookListItem[]> {
    const payload = await readJson<{ books: MobileBookListItem[] }>(await this.fetch('/api/mobile/books'))
    return payload.books
  }

  async downloadBookPackage(bookId: string, options: { includeEmbeddings?: boolean } = {}): Promise<MobileBookPackage> {
    const search = options.includeEmbeddings === false ? '?embeddings=none' : ''
    return readJson<MobileBookPackage>(await this.fetch(`/api/mobile/books/${encodeURIComponent(bookId)}/package${search}`))
  }

  async createEmbedding(payload: MobileEmbeddingProxyRequest): Promise<{ data?: Array<{ embedding?: number[] }> }> {
    if (!this.baseUrl) {
      throw new Error('Web 调试外部 Embedding 需要先配置 PC API 地址，用 PC 后端代理以绕过浏览器 CORS。')
    }
    return readJson<{ data?: Array<{ embedding?: number[] }> }>(
      await this.fetch('/api/mobile/proxy/embeddings', {
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    )
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const headers = new Headers(init?.headers)
    if (this.syncToken) {
      headers.set('Authorization', `Bearer ${this.syncToken}`)
    }

    if (Capacitor.isNativePlatform()) {
      const response = await CapacitorHttp.request({
        url,
        method: (init?.method || 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS',
        headers: Object.fromEntries(headers.entries()),
        data: init?.body,
      })

      const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      return new Response(body, {
        status: response.status,
        headers: new Headers(response.headers),
      })
    }

    return fetch(url, { ...init, headers })
  }
}
