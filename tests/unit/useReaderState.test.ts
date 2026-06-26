import { describe, expect, it } from 'vitest'
import {
  countBookWords,
  formatWordCount,
  getActiveOpenAIConfig,
  inferTitle,
  normalizeConcurrency,
  normalizeStoredState,
  sanitizeEmbeddingConfig,
  splitChapters,
} from '../../src/hooks/useReaderState.ts'

describe('chapter splitting', () => {
  it('splits common Chinese chapter headings and normalizes leading body markers', () => {
    const chapters = splitChapters(`
正文 第一回 宴桃园豪杰三结义
刘备、关羽、张飞相遇。

正文 第二回 张翼德怒鞭督邮
三人继续奔走。
`)

    expect(chapters).toHaveLength(2)
    expect(chapters[0]).toMatchObject({
      index: 1,
      title: '第一回 宴桃园豪杰三结义',
      wordCount: 11,
    })
    expect(chapters[1].title).toBe('第二回 张翼德怒鞭督邮')
  })

  it('falls back to one readable chapter when headings are absent', () => {
    const chapters = splitChapters('没有章节标题的短篇正文。\n第二段继续正文。')

    expect(chapters).toHaveLength(1)
    expect(chapters[0]).toMatchObject({
      index: 1,
      title: '正文开始',
      content: '没有章节标题的短篇正文。\n第二段继续正文。',
    })
  })
})

describe('stored state normalization', () => {
  it('migrates a legacy single-book state into the library shape', () => {
    const normalized = normalizeStoredState({
      book: {
        id: 'book-1',
        title: '测试小说',
        importedAt: '2026-06-24T00:00:00.000Z',
        chapters: [
          { id: 'c1', index: 1, title: '第一章', content: '正文', wordCount: 2 },
        ],
      },
      activeChapterId: 'c1',
      summaries: {
        c1: {
          short: '短概要',
          detail: '详细概要',
          keyPoints: ['要点'],
          skippable: '不可跳读',
          generatedBy: 'local',
        },
      },
      readerFontSize: 99,
      readerTheme: 'night',
      chapterScrollPositions: { c1: -10, c2: 42, bad: Number.NaN },
    })

    expect(normalized.books).toHaveLength(1)
    expect(normalized.activeBookId).toBe('book-1')
    expect(normalized.book?.title).toBe('测试小说')
    expect(normalized.activeChapterId).toBe('c1')
    expect(normalized.summaries.c1?.short).toBe('短概要')
    expect(normalized.readerFontSize).toBe(28)
    expect(normalized.readerTheme).toBe('night')
    expect(normalized.chapterScrollPositions).toEqual({ c1: 0, c2: 42 })
  })

  it('keeps active book and OpenAI config consistent when stored ids are stale', () => {
    const normalized = normalizeStoredState({
      books: [
        {
          book: {
            id: 'book-1',
            title: '测试小说',
            importedAt: '2026-06-24T00:00:00.000Z',
            chapters: [
              { id: 'c1', index: 1, title: '第一章', content: '正文', wordCount: 2 },
            ],
          },
          activeChapterId: 'c1',
          summaries: {},
        },
      ],
      activeBookId: 'missing-book',
      aiProvider: 'openai',
      openaiConfigs: [
        {
          id: 'remote',
          name: 'Remote',
          baseUrl: 'https://example.test/v1',
          apiKey: '',
          model: 'model-a',
          thinkingEnabled: true,
          temperature: 0.5,
          concurrency: 4,
        },
      ],
      activeOpenAIConfigId: 'missing-config',
    })

    expect(normalized.activeBookId).toBe('book-1')
    expect(normalized.activeOpenAIConfigId).toBe('remote')
    expect(getActiveOpenAIConfig(normalized)?.model).toBe('model-a')
  })
})

describe('configuration helpers', () => {
  it('sanitizes embedding config and clamps concurrency', () => {
    expect(
      sanitizeEmbeddingConfig({
        provider: 'openai',
        baseUrl: '  https://embedding.example/v1  ',
        model: ' bge-m3 ',
        apiKey: 'secret',
        concurrency: 99,
        dimension: 1024,
      }),
    ).toEqual({
      provider: 'openai',
      baseUrl: 'https://embedding.example/v1',
      model: 'bge-m3',
      apiKey: 'secret',
      concurrency: 10,
      dimension: 1024,
    })

    expect(normalizeConcurrency('3.9', 1)).toBe(3)
    expect(normalizeConcurrency('bad', 7)).toBe(7)
  })

  it('formats titles and word counts used by the bookshelf', () => {
    const book = {
      chapters: [
        { id: 'c1', index: 1, title: '一', content: 'abc', wordCount: 3 },
        { id: 'c2', index: 2, title: '二', content: 'defg', wordCount: 4 },
      ],
    }

    expect(inferTitle('凡人修仙传.txt')).toBe('凡人修仙传')
    expect(formatWordCount(9999)).toBe('9999 字')
    expect(formatWordCount(10000)).toBe('1.00 万字')
    expect(countBookWords(book)).toBe(7)
  })
})
