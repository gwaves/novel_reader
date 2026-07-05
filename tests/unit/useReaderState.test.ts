import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyChapterSummary,
  applyChapterTitleRepairSuggestions,
  buildMissingSummaryBatchConfirmation,
  chapterScrollPositionKey,
  countBookWords,
  detectChapterTitleAnomalies,
  formatWordCount,
  generateWithOpenAICompatible,
  getActiveOpenAIConfig,
  inferTitle,
  normalizeConcurrency,
  normalizeStoredState,
  parseImportedBook,
  readChapterScrollPosition,
  runMissingSummaryBatch,
  sanitizeEmbeddingConfig,
  selectSummaryGenerationChapters,
  splitChapters,
  validateModelConfig,
  type ModelConfigDraft,
} from '../../src/hooks/useReaderState.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('keeps prose out of a long classic chapter heading line', () => {
    const chapters = splitChapters(`
第二十五回\u3000镇元仙赶捉取经僧\u3000孙行者大闹五庄观却说他兄弟三众，到了殿上，对师父道："饭将熟了，叫我们怎的？"
三藏道："徒弟，不是问饭。"

第二十六回\u3000孙悟空三岛求方\u3000观世音甘泉活树
诗曰：处世须存心上刃。
`)

    expect(chapters).toHaveLength(2)
    expect(chapters[0].title).toBe('第二十五回\u3000镇元仙赶捉取经僧\u3000孙行者大闹五庄观')
    expect(chapters[0].content).toContain('却说他兄弟三众，到了殿上')
    expect(chapters[0].content).not.toContain('第二十五回')
  })

  it('detects title lines that should be reviewed by the language model', () => {
    const anomalies = detectChapterTitleAnomalies(`
第二十五回\u3000镇元仙赶捉取经僧\u3000孙行者大闹五庄观却说他兄弟三众，到了殿上，对师父道："饭将熟了，叫我们怎的？"
三藏道："徒弟，不是问饭。"

第二十六回\u3000孙悟空三岛求方\u3000观世音甘泉活树
诗曰：处世须存心上刃。
`)

    expect(anomalies).toHaveLength(1)
    expect(anomalies[0]).toMatchObject({
      chapterIndex: 1,
      suspectedTitle: '第二十五回\u3000镇元仙赶捉取经僧\u3000孙行者大闹五庄观',
      suspectedContentPrefix: expect.stringContaining('却说他兄弟三众'),
    })
  })

  it('applies validated language-model title repair suggestions', () => {
    const chapters = [
      {
        id: '1-bad',
        index: 1,
        title:
          '第二十五回　镇元仙赶捉取经僧　孙行者大闹五庄观却说他兄弟三众，到了殿上，对师父道："饭将熟了，叫我们怎的？"',
        content: '三藏道："徒弟，不是问饭。"',
        wordCount: 0,
      },
    ]

    const repaired = applyChapterTitleRepairSuggestions(chapters, [
      {
        chapterIndex: 1,
        isAnomaly: true,
        fixedTitle: '第二十五回　镇元仙赶捉取经僧　孙行者大闹五庄观',
        contentPrefix: '却说他兄弟三众，到了殿上',
        confidence: 0.95,
        reason: '从“却说”开始进入正文。',
      },
    ])

    expect(repaired[0].title).toBe('第二十五回　镇元仙赶捉取经僧　孙行者大闹五庄观')
    expect(repaired[0].content).toContain('却说他兄弟三众，到了殿上')
    expect(repaired[0].content).toContain('三藏道')
    expect(repaired[0].wordCount).toBeGreaterThan(0)
  })

  it('imports GB18030 TXT files without mojibake', async () => {
    const gb18030Bytes = new Uint8Array([
      181, 218, 210, 187, 213, 194, 32, 191, 170, 202, 188, 10, 213, 226, 192, 239, 202, 199,
      214, 208, 206, 196, 213, 253, 206, 196, 161, 163, 10, 10, 181, 218, 182, 254, 213, 194,
      32, 188, 204, 208, 248, 10, 208, 194, 181, 196, 207, 223, 203, 247, 179, 246, 207, 214,
      161, 163,
    ])

    const book = await parseImportedBook(new File([gb18030Bytes], 'gb18030-sample.txt', { type: 'text/plain' }))

    expect(book.title).toBe('gb18030-sample')
    expect(book.chapters).toHaveLength(2)
    expect(book.chapters[0]).toMatchObject({
      title: '第一章 开始',
      content: '这里是中文正文。',
    })
    expect(book.chapters[1]).toMatchObject({
      title: '第二章 继续',
      content: '新的线索出现。',
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
      chapterScrollPositions: { c1: -10, c2: 42, 'book-1:c1': 18, bad: Number.NaN },
    })

    expect(normalized.books).toHaveLength(1)
    expect(normalized.activeBookId).toBe('book-1')
    expect(normalized.book?.title).toBe('测试小说')
    expect(normalized.activeChapterId).toBe('c1')
    expect(normalized.summaries.c1?.short).toBe('短概要')
    expect(normalized.readerFontSize).toBe(28)
    expect(normalized.readerTheme).toBe('night')
    expect(normalized.chapterScrollPositions).toEqual({ c1: 0, c2: 42, 'book-1:c1': 18 })
  })

  it('keeps chapter scroll positions scoped by book id with legacy fallback', () => {
    const positions = {
      c1: 12,
      [chapterScrollPositionKey('book-a', 'c1')]: 120,
      [chapterScrollPositionKey('book-b', 'c1')]: 240,
    }

    expect(chapterScrollPositionKey('book-a', 'c1')).toBe('book-a:c1')
    expect(readChapterScrollPosition(positions, 'book-a', 'c1')).toBe(120)
    expect(readChapterScrollPosition(positions, 'book-b', 'c1')).toBe(240)
    expect(readChapterScrollPosition(positions, 'book-c', 'c1')).toBe(12)
    expect(readChapterScrollPosition(positions, 'book-a', 'missing')).toBe(0)
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

describe('summary generation helpers', () => {
  it('writes a generated single-chapter summary to the active library book only', () => {
    const state = normalizeStoredState({
      books: [
        {
          book: {
            id: 'book-1',
            title: '第一本',
            importedAt: '2026-07-01T00:00:00.000Z',
            chapters: [
              { id: 'c1', index: 1, title: '第一章', content: '正文一', wordCount: 3 },
              { id: 'c2', index: 2, title: '第二章', content: '正文二', wordCount: 3 },
            ],
          },
          activeChapterId: 'c1',
          summaries: {},
        },
        {
          book: {
            id: 'book-2',
            title: '第二本',
            importedAt: '2026-07-01T00:10:00.000Z',
            chapters: [{ id: 'c1', index: 1, title: '同名章节', content: '另一正文', wordCount: 4 }],
          },
          activeChapterId: 'c1',
          summaries: {
            c1: {
              short: '其他书概要',
              detail: '其他书详细概要',
              keyPoints: ['其他书要点'],
              skippable: '不可跳读',
              generatedBy: 'local',
            },
          },
        },
      ],
      activeBookId: 'book-1',
    })
    const summary = {
      short: '当前章概要',
      detail: '当前章详细概要',
      keyPoints: ['当前章要点'],
      skippable: '不可跳读',
      generatedBy: 'openai' as const,
    }

    const updated = applyChapterSummary(state, 'book-1', 'c1', summary)

    expect(updated.summaries.c1).toEqual(summary)
    expect(updated.books.find((book) => book.book.id === 'book-1')?.summaries.c1).toEqual(summary)
    expect(updated.books.find((book) => book.book.id === 'book-2')?.summaries.c1?.short).toBe('其他书概要')
  })

  it('generates a single-chapter summary with a mocked OpenAI-compatible model', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  short: '林青离村遇见白衣客。',
                  detail: '林青第一次离开山村，在渡口遇见白衣客，并得到后续线索。',
                  keyPoints: ['林青离村', '遇见白衣客', '获得线索'],
                  skippable: '不可跳读：主线人物登场。',
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const summary = await generateWithOpenAICompatible(
      { id: 'c1', index: 1, title: '第一章', content: '林青第一次离开山村。', wordCount: 10 },
      'https://llm.example.test/v1/',
      'secret-token',
      'summary-model',
      0.3,
      false,
    )

    expect(summary).toEqual({
      short: '林青离村遇见白衣客。',
      detail: '林青第一次离开山村，在渡口遇见白衣客，并得到后续线索。',
      keyPoints: ['林青离村', '遇见白衣客', '获得线索'],
      keyPointSources: [],
      skippable: '不可跳读：主线人物登场。',
      generatedBy: 'openai',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://llm.example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-token',
        },
      }),
    )
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body).toMatchObject({
      model: 'summary-model',
      temperature: 0.3,
      response_format: { type: 'json_object' },
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(body.messages[1].content).toContain('章节标题：第一章')
    expect(body.messages[1].content).toContain('林青第一次离开山村。')
  })

  it('selects only missing summaries by default and all chapters when overwrite is explicit', () => {
    const chapters = [
      { id: 'c1', index: 1, title: '第一章', content: '正文一', wordCount: 3 },
      { id: 'c2', index: 2, title: '第二章', content: '正文二', wordCount: 3 },
      { id: 'c3', index: 3, title: '第三章', content: '正文三', wordCount: 3 },
    ]
    const existingSummary = {
      short: '旧概要',
      detail: '旧详细概要',
      keyPoints: ['旧要点'],
      skippable: '不可跳读',
      generatedBy: 'openai' as const,
    }

    expect(selectSummaryGenerationChapters(chapters, { c1: existingSummary }).map((chapter) => chapter.id)).toEqual([
      'c2',
      'c3',
    ])
    expect(
      selectSummaryGenerationChapters(chapters, { c1: existingSummary }, { overwriteExisting: true }).map(
        (chapter) => chapter.id,
      ),
    ).toEqual(['c1', 'c2', 'c3'])
  })

  it('asks for confirmation only when a missing-summary batch is large', () => {
    expect(buildMissingSummaryBatchConfirmation(80, 50)).toBeNull()

    const message = buildMissingSummaryBatchConfirmation(80, 51)
    expect(message).toContain('全书共 80 章，其中 51 章缺少概要。')
    expect(message).toContain('批量生成将调用 AI 接口 51 次')
    expect(message).toContain('确定要继续吗？')
  })

  it('continues a missing-summary batch when one chapter fails and reports the failure count', async () => {
    const chapters = [
      { id: 'c1', index: 1, title: '第一章', content: '正文一', wordCount: 3 },
      { id: 'c2', index: 2, title: '第二章', content: '正文二', wordCount: 3 },
      { id: 'c3', index: 3, title: '第三章', content: '正文三', wordCount: 3 },
    ]
    const generated = new Map<string, string>()
    const attempted: string[] = []
    const failures: string[] = []
    const progressMessages: string[] = []

    const result = await runMissingSummaryBatch({
      pendingChapters: chapters,
      totalChapters: 5,
      concurrency: 2,
      onProgress: (message) => progressMessages.push(message),
      onSummary: (chapter, summary) => generated.set(chapter.id, summary.short),
      onFailure: (chapter) => failures.push(chapter.id),
      generateSummary: async (chapter) => {
        attempted.push(chapter.id)
        if (chapter.id === 'c2') throw new Error('mock summary failure')
        return {
          short: `概要 ${chapter.index}`,
          detail: `第 ${chapter.index} 章详细概要`,
          keyPoints: [`要点 ${chapter.index}`],
          skippable: '不可跳读',
          generatedBy: 'openai',
        }
      },
    })

    expect(result).toEqual({ completedCount: 2, failedCount: 1, missingCount: 3 })
    expect(attempted).toEqual(['c1', 'c2', 'c3'])
    expect([...generated.entries()]).toEqual([
      ['c1', '概要 1'],
      ['c3', '概要 3'],
    ])
    expect(failures).toEqual(['c2'])
    expect(progressMessages.at(-1)).toBe('并发 2，已完成 2/3（全书 4/5），失败 1 章')
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

  it('validates an available Ollama LLM and embedding configuration before saving', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: '{"ok":true}' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, dimension: 768 }), { status: 200 }))

    await expect(validateModelConfig(modelConfigDraft({
      aiProvider: 'ollama',
      ollamaModel: ' qwen3:8b ',
      ollamaTemperature: 0.1,
      ollamaConcurrency: 2,
      embeddingConfig: {
        provider: 'ollama',
        baseUrl: ' http://localhost:11434/ ',
        model: ' nomic-embed-text ',
        apiKey: '',
        concurrency: 2,
        dimension: 768,
      },
    }))).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:11434/api/generate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          model: 'qwen3:8b',
          prompt: '/no_think\n只输出 JSON：{"ok":true}',
          stream: false,
          format: 'json',
          options: { temperature: 0.1 },
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/rag/embeddings/validate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          provider: 'ollama',
          model: 'nomic-embed-text',
          baseUrl: 'http://localhost:11434',
          apiKey: '',
        }),
      }),
    )
  })

  it('validates OpenAI-compatible chat and embedding models before saving', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, dimension: 1024 }), { status: 200 }))

    await expect(validateModelConfig(modelConfigDraft())).resolves.toBeUndefined()

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://llm.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer llm-key',
        },
        body: JSON.stringify({
          model: 'chat-model',
          messages: [
            {
              role: 'user',
              content: '/no_think\n只输出 JSON：{"ok":true}',
            },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' },
          chat_template_kwargs: { enable_thinking: false },
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/rag/embeddings/validate',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          model: 'embed-model',
          baseUrl: 'https://embedding.example/v1',
          apiKey: 'embedding-key',
        }),
      }),
    )
  })

  it('rejects unreachable OpenAI-compatible LLM URLs before saving model config', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connect ECONNREFUSED'))

    await expect(validateModelConfig(modelConfigDraft())).rejects.toThrow(
      '[LLM] 无法连接 OpenAI-compatible Base URL：connect ECONNREFUSED',
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://llm.example/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('rejects OpenAI-compatible token errors before validating embeddings', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('invalid token', { status: 401, statusText: 'Unauthorized' }),
    )

    await expect(validateModelConfig(modelConfigDraft())).rejects.toThrow(
      '[LLM] OpenAI-compatible 验证失败 401：invalid token',
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects embedding dimension mismatch before saving model config', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: '向量维度不匹配：expected 1024, got 768' }), {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'Content-Type': 'application/json' },
        }),
      )

    await expect(validateModelConfig(modelConfigDraft())).rejects.toThrow(
      '[Embedding] 验证失败：向量维度不匹配：expected 1024, got 768',
    )

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/rag/embeddings/validate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          provider: 'openai',
          model: 'embed-model',
          baseUrl: 'https://embedding.example/v1',
          apiKey: 'embedding-key',
        }),
      }),
    )
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

function modelConfigDraft(overrides: Partial<ModelConfigDraft> = {}): ModelConfigDraft {
  return {
    aiProvider: 'openai',
    ollamaModel: '',
    ollamaTemperature: 0.7,
    ollamaConcurrency: 1,
    openaiConfigs: [
      {
        id: 'remote',
        name: 'Remote',
        baseUrl: 'https://llm.example/v1',
        apiKey: 'llm-key',
        model: 'chat-model',
        thinkingEnabled: false,
        temperature: 0.2,
        concurrency: 3,
      },
    ],
    activeOpenAIConfigId: 'remote',
    thinkingEnabled: false,
    embeddingConfig: {
      provider: 'openai',
      baseUrl: 'https://embedding.example/v1',
      model: 'embed-model',
      apiKey: 'embedding-key',
      concurrency: 2,
      dimension: 1024,
    },
    ...overrides,
  }
}
