import { getConfig } from './config.mjs'

// ========================
// 网络请求重试与超时
// ========================

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 500
const DEFAULT_TIMEOUT_MS = Number(process.env.OFFLINE_REQUEST_TIMEOUT_MS) || 300_000 // 本地大模型推理可能较慢，默认 5 分钟

function isRetryableError(error) {
  if (!error) return false
  const message = error.message || ''
  return (
    (error.name === 'TypeError' && message.includes('fetch failed')) ||
    error.name === 'AbortError' ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ECONNREFUSED')
  )
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithRetry(
  url,
  options,
  { maxRetries = DEFAULT_MAX_RETRIES, retryDelay = DEFAULT_RETRY_DELAY_MS, timeout = DEFAULT_TIMEOUT_MS } = {},
) {
  let lastError
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeout),
      })
      return response
    } catch (error) {
      lastError = error
      const isLast = attempt === maxRetries
      if (isLast || !isRetryableError(error)) {
        throw error
      }
      const delay = retryDelay * 2 ** attempt
      console.warn(`  ⚠️  请求失败 (${error.message})，${delay}ms 后重试 (${attempt + 1}/${maxRetries})...`)
      await sleep(delay)
    }
  }
  // 逻辑上不会到达这里，但为了类型安全保留
  throw lastError
}

// ========================
// Summary Prompt（与主项目完全一致）
// ========================

function buildSummaryPrompt(chapter, thinkingEnabled) {
  const thinkingInstruction = thinkingEnabled
    ? '请先用 /think 进行推理，但最终输出必须是 JSON，不要输出任何其他内容。'
    : '请直接输出 JSON，不要输出任何推理过程。'

  return `${thinkingInstruction}

你是资深网络小说阅读助手。请严格根据下面这一章的内容生成一份概要 JSON，JSON 字段如下：
- short: 一句话概括本章核心情节（不超过 60 字）。
- detail: 详细概要，包含起因、经过、结果（150-300 字）。
- keyPoints: 字符串数组，列出本章 3-6 个必须记住的关键信息点。
- skippable: 判断本章是否可跳读。如果是过渡章、纯回忆、重复描写，返回"可跳读：简要说明原因"；否则返回"不可跳读：简要说明原因"。

只返回 JSON，不要加 markdown 代码块，不要解释。

章节标题：${chapter.title}
章节字数：${chapter.word_count}

正文：
${chapter.content.slice(0, 12000)}`
}

// ========================
// Knowledge Graph Prompt（与主项目完全一致）
// ========================

function buildKnowledgeGraphPrompt(chapter) {
  return `你是长篇小说知识图谱抽取器。请从章节中抽取人物、门派/组织、道具/法宝、功法/法术、地点、灵兽/妖兽、重要事件，以及它们之间的关系。

只输出 JSON，不要输出 Markdown，不要解释。

JSON 结构必须是：
{
  "entities": [
    {
      "name": "实体名",
      "type": "character|sect|item|skill|location|beast|event|other",
      "aliases": ["别名"],
      "description": "只基于本章的简短描述",
      "confidence": 0.0到1.0,
      "evidence": ["1到3条原文短证据"]
    }
  ],
  "relations": [
    {
      "source": "实体名",
      "target": "实体名",
      "type": "knows|ally_of|enemy_of|master_of|disciple_of|member_of|belongs_to|owns|uses|learns|created_by|located_in|appears_with|transforms_into|related_to",
      "description": "只基于本章的关系描述",
      "confidence": 0.0到1.0,
      "evidence": ["1到3条原文短证据"]
    }
  ]
}

要求：
1. source 和 target 必须出现在 entities 中。
2. 不确定的实体 type 用 other，不确定的关系 type 用 related_to。
3. evidence 必须来自原文短句，不要编造。
4. 同一实体不要重复输出。

章节标题：${chapter.title}
章节序号：${chapter.chapter_index}
章节正文：
${chapter.content.slice(0, 16000)}`
}

// ========================
// JSON 解析（与主项目一致）
// ========================

function parseJsonObject(text) {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('模型没有返回 JSON 对象。')
    return JSON.parse(match[0])
  }
}

function parseSummaryResponse(raw) {
  const jsonText = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()

  try {
    const parsed = JSON.parse(jsonText)
    return {
      short: parsed.short || '模型没有返回一句话概要。',
      detail: parsed.detail || '模型没有返回详细概要。',
      keyPoints: Array.isArray(parsed.keyPoints) ? parsed.keyPoints.slice(0, 6) : [],
      skippable: parsed.skippable || '暂无跳读建议。',
    }
  } catch {
    return {
      short: '模型已返回内容，但不是标准 JSON。',
      detail: raw.slice(0, 600),
      keyPoints: [],
      skippable: '请重试，或换一个更擅长中文指令的模型。',
    }
  }
}

// ========================
// Ollama API 调用
// ========================

async function callOllamaGenerate(prompt, model, temperature, format = 'json') {
  const config = getConfig()
  const response = await fetchWithRetry(`${config.baseUrl.trim()}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model.trim(),
      prompt,
      stream: false,
      format,
      options: { temperature },
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Ollama 返回 ${response.status}：${body || '请求失败'}`)
  }

  const data = await response.json()
  return data.response || ''
}

async function callOllamaChat(messages, model, temperature, responseFormat = null) {
  const config = getConfig()
  const body = {
    model: model.trim(),
    messages,
    stream: false,
    options: { temperature },
  }
  if (responseFormat) {
    body.format = responseFormat
  }

  const response = await fetchWithRetry(`${config.baseUrl.trim()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Ollama 返回 ${response.status}：${text || '请求失败'}`)
  }

  const data = await response.json()
  return data.message?.content || ''
}

// ========================
// OpenAI-compatible API 调用
// ========================

async function callOpenAIChat(messages, config, responseFormat = null) {
  const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, '')
  const headers = { 'Content-Type': 'application/json' }
  if (config.apiKey.trim()) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`
  }

  const body = {
    model: config.model.trim(),
    messages,
    temperature: config.temperature,
  }

  if (responseFormat) {
    body.response_format = responseFormat
  }
  if (!config.thinkingEnabled) {
    body.chat_template_kwargs = { enable_thinking: false }
  }

  const response = await fetchWithRetry(`${normalizedBaseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`OpenAI 返回 ${response.status}：${text || '请求失败'}`)
  }

  const data = await response.json()
  return data.choices?.[0]?.message?.content || ''
}

// ========================
// 生成 Summary
// ========================

export async function generateSummary(chapter, config) {
  if (config.provider === 'ollama') {
    const raw = await callOllamaGenerate(
      buildSummaryPrompt(chapter, config.thinkingEnabled),
      config.model,
      config.temperature,
      'json',
    )
    const parsed = parseSummaryResponse(raw)
    return { ...parsed, generatedBy: 'ollama' }
  }

  const raw = await callOpenAIChat(
    [
      { role: 'system', content: '你是长篇网络小说陪读助手。你必须只输出符合要求的 JSON。' },
      { role: 'user', content: buildSummaryPrompt(chapter, config.thinkingEnabled) },
    ],
    config,
    { type: 'json_object' },
  )
  const parsed = parseSummaryResponse(raw)
  return { ...parsed, generatedBy: 'openai' }
}

// ========================
// 生成 Knowledge Graph Extraction
// ========================

export async function generateKgExtraction(chapter, config) {
  let raw
  if (config.provider === 'ollama') {
    raw = await callOllamaGenerate(
      buildKnowledgeGraphPrompt(chapter),
      config.model,
      config.temperature,
      'json',
    )
  } else {
    raw = await callOpenAIChat(
      [
        { role: 'user', content: buildKnowledgeGraphPrompt(chapter) },
      ],
      config,
      { type: 'json_object' },
    )
  }
  return parseJsonObject(raw)
}

// ========================
// 验证模型可用性
// ========================

export async function validateModel() {
  const config = getConfig()
  if (config.provider === 'ollama') {
    // 检查 Ollama 是否可用
    const response = await fetchWithRetry(`${config.baseUrl.trim()}/api/tags`, { method: 'GET' })
    if (!response.ok) throw new Error(`无法连接 Ollama：${response.status}`)
    const data = await response.json()
    const models = data.models || []
    if (!models.some(m => m.name === config.model || m.model === config.model)) {
      console.warn(`⚠️  Ollama 中没有找到模型 "${config.model}"。可用模型：${models.map(m => m.name || m.model).join(', ')}`)
    }
    // 简单验证调用
    await callOllamaGenerate('/no_think\n只输出 JSON：{"ok":true}', config.model, config.temperature, 'json')
    return { provider: 'ollama', model: config.model, ok: true }
  }

  // OpenAI 验证
  await callOpenAIChat(
    [{ role: 'user', content: '/no_think\n只输出 JSON：{"ok":true}' }],
    config,
    { type: 'json_object' },
  )
  return { provider: 'openai', model: config.model, ok: true }
}
