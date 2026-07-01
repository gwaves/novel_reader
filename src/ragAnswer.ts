import type { AIProvider, OpenAIConfig } from './hooks/useReaderState.ts'

export type RagSearchResult = {
  chapterId: string
  chapterIndex: number
  chapterTitle: string
  summary: {
    short: string
    detail: string
    keyPoints: string[]
  }
  similarity: number
  matchType: 'vector' | 'chunk' | 'entity' | 'both' | 'entity-first'
  matchedEntities: string[]
  contentSnippet: string | null
  chunkIndex?: number | null
}

export type RagEntityMatch = {
  entityId: string
  entityName: string
  entityType: string
  firstChapterIndex: number | null
  lastChapterIndex: number | null
  aliases?: string[]
}

export type RagAnswerUpdate = {
  answer: string
  error: string
  results: RagSearchResult[]
  entityMatches: RagEntityMatch[]
}

type RagAnswerGenerator = (prompt: string) => Promise<string>

export function getKgEntityTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    beast: '灵兽',
    character: '人物',
    event: '事件',
    item: '道具',
    location: '地点',
    other: '其他',
    sect: '组织',
    skill: '功法',
  }
  return labels[type] ?? type
}

export function normalizeGraphSearch(value: string): string {
  return value.trim().replace(/\s+/g, '').toLowerCase()
}

export function buildRagAnswerPrompt(
  question: string,
  results: RagSearchResult[],
  entityMatches: RagEntityMatch[] = [],
): string {
  const sorted = [...results].sort((a, b) => a.chapterIndex - b.chapterIndex)
  const normalizedQuestion = normalizeGraphSearch(question)

  const entitySection =
    entityMatches.length > 0
      ? `相关实体：\n${entityMatches
          .map((entity) => {
            const parts = [
              `- ${entity.entityName}（${getKgEntityTypeLabel(entity.entityType)}）`,
            ]
            if (entity.firstChapterIndex != null) {
              parts.push(`首次出现：第 ${entity.firstChapterIndex} 章`)
            }
            if (
              entity.lastChapterIndex != null &&
              entity.lastChapterIndex !== entity.firstChapterIndex
            ) {
              parts.push(`末次出现：第 ${entity.lastChapterIndex} 章`)
            }
            const relevantAliases = (entity.aliases || [])
              .filter((alias) => {
                const normalizedAlias = normalizeGraphSearch(alias)
                return (
                  normalizedAlias.length >= 2 &&
                  (normalizedQuestion.includes(normalizedAlias) ||
                    normalizedAlias.includes(normalizedQuestion))
                )
              })
              .slice(0, 5)
            if (relevantAliases.length > 0) {
              parts.push(`与问题相关的别名：${relevantAliases.join('、')}`)
            }
            return parts.join('，')
          })
          .join('\n')}\n\n`
      : ''

  const context = sorted
    .map((result) => {
      const lines = [`[第 ${result.chapterIndex} 章] ${result.chapterTitle}`]
      if (result.summary.detail) lines.push(`摘要：${result.summary.detail}`)
      if (result.contentSnippet) lines.push(`原文片段：${result.contentSnippet}`)
      return lines.join('\n')
    })
    .join('\n\n')

  return `你是长篇小说阅读助手。请根据以下按章节顺序排列的相关内容回答问题。回答要简洁准确，并引用章节号。如果信息不足，请明确说明。

问题：${question}

${entitySection}相关内容：
${context}

请给出回答：`
}

export async function generateRagAnswerWithOllama(
  prompt: string,
  model: string,
  temperature: number,
): Promise<string> {
  const response = await fetch('http://localhost:11434/api/generate', {
    body: JSON.stringify({
      model: model.trim(),
      prompt,
      stream: false,
      options: { temperature },
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Ollama 返回 ${response.status}：${body || '请求失败'}`)
  }

  const data = (await response.json()) as { response?: string }
  return (data.response ?? '').trim()
}

export async function generateRagAnswerWithOpenAI(
  prompt: string,
  config: OpenAIConfig,
): Promise<string> {
  const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, '')
  if (!normalizedBaseUrl) throw new Error('请先填写 OpenAI-compatible Base URL。')
  if (!config.model.trim()) throw new Error('请先填写 OpenAI-compatible Model Name。')

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`
  }

  const requestBody: Record<string, unknown> = {
    model: config.model.trim(),
    messages: [
      { role: 'system', content: '你是长篇网络小说陪读助手。请直接回答问题，不需要输出 JSON。' },
      { role: 'user', content: prompt },
    ],
    temperature: config.temperature,
  }

  if (!config.thinkingEnabled) {
    requestBody.chat_template_kwargs = { enable_thinking: false }
  }

  const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
    body: JSON.stringify(requestBody),
    headers,
    method: 'POST',
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI 返回 ${response.status}：${body || '请求失败'}`)
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
  return (data.choices?.[0]?.message?.content ?? '').trim()
}

export async function createRagAnswerUpdate({
  question,
  results,
  entityMatches,
  aiProvider,
  openAIConfig,
  ollamaModel,
  ollamaTemperature,
  generateOpenAI = (prompt, config) => generateRagAnswerWithOpenAI(prompt, config),
  generateOllama = (prompt) => generateRagAnswerWithOllama(prompt, ollamaModel, ollamaTemperature),
}: {
  question: string
  results: RagSearchResult[]
  entityMatches: RagEntityMatch[]
  aiProvider: AIProvider
  openAIConfig: OpenAIConfig | null
  ollamaModel: string
  ollamaTemperature: number
  generateOpenAI?: (prompt: string, config: OpenAIConfig) => Promise<string>
  generateOllama?: RagAnswerGenerator
}): Promise<RagAnswerUpdate> {
  try {
    const prompt = buildRagAnswerPrompt(question, results, entityMatches)
    const answer =
      aiProvider === 'openai'
        ? await generateOpenAI(prompt, requireOpenAIConfig(openAIConfig))
        : await generateOllama(prompt)

    return { answer, error: '', results, entityMatches }
  } catch (error) {
    return {
      answer: '',
      error: error instanceof Error ? error.message : '生成答案失败。',
      results,
      entityMatches,
    }
  }
}

function requireOpenAIConfig(config: OpenAIConfig | null): OpenAIConfig {
  if (!config) throw new Error('请先配置外部模型。')
  return config
}
