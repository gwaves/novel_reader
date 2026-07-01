import { describe, expect, it, vi } from 'vitest'
import {
  buildRagAnswerPrompt,
  createRagAnswerUpdate,
  type RagEntityMatch,
  type RagSearchResult,
} from '../../src/ragAnswer.ts'
import type { OpenAIConfig } from '../../src/hooks/useReaderState.ts'

describe('RAG answer helpers', () => {
  it('keeps retrieved results visible when answer generation fails', async () => {
    const results = sampleRagResults()
    const entityMatches = sampleEntityMatches()
    const generateOpenAI = vi.fn(async () => {
      throw new Error('OpenAI 返回 503：upstream timeout')
    })

    const update = await createRagAnswerUpdate({
      question: '少年林青第一次遇见了谁',
      results,
      entityMatches,
      aiProvider: 'openai',
      openAIConfig: sampleOpenAIConfig(),
      ollamaModel: 'qwen',
      ollamaTemperature: 0.2,
      generateOpenAI,
    })

    expect(update.answer).toBe('')
    expect(update.error).toBe('OpenAI 返回 503：upstream timeout')
    expect(update.results).toBe(results)
    expect(update.entityMatches).toBe(entityMatches)
    expect(generateOpenAI).toHaveBeenCalledTimes(1)
    expect(generateOpenAI.mock.calls[0][0]).toContain('少年林青第一次遇见了谁')
    expect(generateOpenAI.mock.calls[0][0]).toContain('[第 1 章] 第一章')
    expect(generateOpenAI.mock.calls[0][0]).toContain('与问题相关的别名：少年林青')
  })

  it('builds answer prompts in chapter order with snippets and entity aliases', () => {
    const prompt = buildRagAnswerPrompt(
      '少年林青第一次遇见了谁',
      sampleRagResults().toReversed(),
      sampleEntityMatches(),
    )

    expect(prompt.indexOf('[第 1 章] 第一章')).toBeLessThan(prompt.indexOf('[第 2 章] 第二章'))
    expect(prompt).toContain('原文片段：林青第一次离开山村')
    expect(prompt).toContain('相关实体：')
    expect(prompt).toContain('与问题相关的别名：少年林青')
  })
})

function sampleRagResults(): RagSearchResult[] {
  return [
    {
      chapterId: 'c1',
      chapterIndex: 1,
      chapterTitle: '第一章',
      summary: {
        short: '短概要',
        detail: '林青第一次离开山村，遇见白衣客。',
        keyPoints: ['林青离村'],
      },
      similarity: 0.98,
      matchType: 'both',
      matchedEntities: ['林青'],
      contentSnippet: '林青第一次离开山村，在渡口遇见白衣客。',
      chunkIndex: 0,
    },
    {
      chapterId: 'c2',
      chapterIndex: 2,
      chapterTitle: '第二章',
      summary: {
        short: '第二章短概要',
        detail: '林青抵达青州。',
        keyPoints: ['抵达青州'],
      },
      similarity: 0.72,
      matchType: 'vector',
      matchedEntities: [],
      contentSnippet: null,
      chunkIndex: null,
    },
  ]
}

function sampleEntityMatches(): RagEntityMatch[] {
  return [
    {
      entityId: 'entity-linqing',
      entityName: '林青',
      entityType: 'character',
      firstChapterIndex: 1,
      lastChapterIndex: 2,
      aliases: ['少年林青', '青衣少年'],
    },
  ]
}

function sampleOpenAIConfig(): OpenAIConfig {
  return {
    id: 'default',
    label: 'mock',
    baseUrl: 'http://mock-llm.test/v1',
    apiKey: 'token',
    model: 'mock-chat',
    temperature: 0.2,
    jsonMode: false,
    thinkingEnabled: false,
  }
}
