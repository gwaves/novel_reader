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

  async downloadBookPackage(bookId: string): Promise<MobileBookPackage> {
    return readJson<MobileBookPackage>(await this.fetch(`/api/mobile/books/${encodeURIComponent(bookId)}/package`))
  }

  private fetch(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    if (this.syncToken) {
      headers.set('Authorization', `Bearer ${this.syncToken}`)
    }
    return fetch(`${this.baseUrl}${path}`, { ...init, headers })
  }
}
