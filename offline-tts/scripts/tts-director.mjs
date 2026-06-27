#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

const DEFAULT_CONFIG_PATH = join(homedir(), '.novel_reader', 'tts-director.config.json')
const DEFAULT_MAIN_DB_PATH = join(homedir(), '.novel_reader', 'novel_reader.sqlite')
const SCRIPT_KIND = 'novel-reader-tts-director-script'
const ALLOWED_SEGMENT_TYPES = new Set(['narration', 'dialogue', 'thought', 'stage'])
const DEFAULT_TTS_MAX_CHARACTERS_PER_REQUEST = 120

function printHelp() {
  console.log(`
Novel Reader 离线多角色 TTS 导演脚本工具

用法:
  node offline-tts/scripts/tts-director.mjs <command> [options]

命令:
  help                         显示帮助
  config                       显示当前配置
  test-model                   测试配置的 OpenAI-compatible 模型
  list-books                   列出主数据库中的书籍
  inspect-chapter              查看章节元信息与正文预览
  draft-script                 调用模型生成导演脚本 JSON
  audit-script                 生成导演脚本质量报告
  validate-script              校验已有导演脚本 JSON
  synth                        按导演脚本调用 MIMO TTS，输出 MP3
  batch-pipeline               按流水线批量生成多章音频：LLM 可配并发，TTS 并行

参数:
  --config <path>              配置文件路径，默认 ~/.novel_reader/tts-director.config.json
  --book-id <id>               书籍 ID
  --chapter <number>           章节序号，从 1 开始
  --chapters <list>            batch-pipeline 章节列表，如 19,21-24
  --limit <number>             只处理章节前 N 个字符；仅用于调试，必须同时传 --allow-partial
  --allow-partial              允许 draft-script/synth/batch-pipeline 处理非全章脚本
  --out <path>                 draft-script 输出路径
  --out-root <path>            batch-pipeline 输出根目录
  --script <path>              validate-script 输入路径
  --out-dir <path>             synth 输出目录，默认与脚本同目录下的 audio/
  --resume                     batch-pipeline 断点续跑，跳过已完成脚本或 MP3
  --concurrency <number>       draft-script 的 LLM 并发数，或 synth 的 TTS 并发数，覆盖配置文件
  --batch-size <number>        draft-script 每批提交给模型的预切分片段数
  --director-concurrency <n>   batch-pipeline 单章 LLM 批次并发，默认取 director.concurrency
  --llm-chapters <number>      batch-pipeline 同时进行 LLM 导演脚本生成的章节数，默认 1
  --min-batch-size <number>    batch-pipeline LLM 失败降级后的最小批大小，默认 6
  --tts-concurrency <number>   batch-pipeline 单章 TTS 片段并发，默认取 tts.concurrency
  --tts-chapters <number>      batch-pipeline 同时进行 TTS 的章节数，默认 2

示例:
  node offline-tts/scripts/tts-director.mjs --config offline-tts/config.example.json test-model
  node offline-tts/scripts/tts-director.mjs --config offline-tts/config.example.json list-books
  node offline-tts/scripts/tts-director.mjs --config offline-tts/config.example.json inspect-chapter --book-id <id> --chapter 1
  node offline-tts/scripts/tts-director.mjs --config offline-tts/config.example.json draft-script --book-id <id> --chapter 1 --allow-partial --limit 2000 --out tmp/tts/ch001.script.json
  MIMO_API_KEY=... node offline-tts/scripts/tts-director.mjs --config offline-tts/config.example.json synth --script tmp/tts/ch001.script.json
`)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
      continue
    }
    args[key] = next
    index += 1
  }
  return args
}

function expandHome(value) {
  if (!value) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function optionalString(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed && trimmed !== 'null' ? trimmed : ''
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function loadConfig(configPath) {
  const path = resolve(expandHome(configPath || process.env.TTS_DIRECTOR_CONFIG || DEFAULT_CONFIG_PATH))
  if (!existsSync(path)) {
    throw new Error(`找不到配置文件：${path}\n请先复制 offline-tts/config.example.json 到该路径。`)
  }

  const config = JSON.parse(readFileSync(path, 'utf8'))
  const llm = config.llm || {}
  const model = optionalString(llm.model_name) || optionalString(llm.modelName) || optionalString(llm.model)
  const baseUrl = optionalString(llm.base_url) || optionalString(llm.baseUrl)
  if (!baseUrl || !model) {
    throw new Error('配置文件必须包含 llm.baseUrl/base_url 和 llm.model/model_name。')
  }

  const database = config.database || {}
  const apiKeyEnv = optionalString(llm.apiKeyEnv)
  const inlineApiKey = optionalString(llm.apiKey)
  return {
    ...config,
    configPath: path,
    llm: {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      model,
      apiKey: inlineApiKey,
      apiKeyEnv,
      temperature: finiteNumber(llm.temperature, 0.2),
      timeoutMs: finiteNumber(llm.timeoutMs, 180_000),
      maxTokens: finiteNumber(llm.maxTokens, 8192),
      responseFormatJson: llm.responseFormatJson === true,
    },
    database: {
      mainDbPath: resolve(expandHome(database.mainDbPath || process.env.NOVEL_READER_DB_PATH || DEFAULT_MAIN_DB_PATH)),
    },
    director: {
      defaultNarrator: {
        speaker: '旁白',
        voice: '白桦',
        style: '中文武侠小说男声旁白，低沉、清晰、平静，保留悬疑感和章回小说的停顿。',
        ...(config.director?.defaultNarrator || {}),
      },
      performanceStyle: optionalString(config.director?.performanceStyle),
      maxCharactersPerRequest: finiteNumber(config.director?.maxCharactersPerRequest, 3000),
      segmentBatchSize: Math.max(1, Math.floor(finiteNumber(config.director?.segmentBatchSize, 30))),
      concurrency: Math.max(1, Math.floor(finiteNumber(config.director?.concurrency, 1))),
    },
    batchPipeline: {
      ttsChapterConcurrency: Math.max(1, Math.floor(finiteNumber(config.batchPipeline?.ttsChapterConcurrency, 2))),
      minBatchSize: Math.max(1, Math.floor(finiteNumber(config.batchPipeline?.minBatchSize, 6))),
      maxDraftAttempts: Math.max(1, Math.floor(finiteNumber(config.batchPipeline?.maxDraftAttempts, 3))),
    },
    voices: {
      characters: Array.isArray(config.voices?.characters) ? config.voices.characters : [],
    },
    tts: {
      provider: config.tts?.provider || 'mimo',
      model: config.tts?.model || 'mimo-v2.5-tts',
      apiKey: optionalString(config.tts?.apiKey),
      apiKeyEnv: config.tts?.apiKeyEnv || 'MIMO_API_KEY',
      format: config.tts?.format || 'wav',
      finalFormat: config.tts?.finalFormat || 'mp3',
      mp3Bitrate: config.tts?.mp3Bitrate || '96k',
      silenceSeconds: finiteNumber(config.tts?.silenceSeconds, 0.35),
      maxSilenceSeconds: finiteNumber(config.tts?.maxSilenceSeconds, 8),
      maxSecondsPerCharacter: finiteNumber(config.tts?.maxSecondsPerCharacter, 0.8),
      concurrency: Math.max(1, Math.floor(finiteNumber(config.tts?.concurrency, 1))),
      keepIntermediateWav: Boolean(config.tts?.keepIntermediateWav),
      maxCharactersPerRequest: Math.max(
        40,
        Math.floor(finiteNumber(config.tts?.maxCharactersPerRequest, DEFAULT_TTS_MAX_CHARACTERS_PER_REQUEST)),
      ),
    },
  }
}

function getApiKey(config) {
  if (config.llm.apiKey) return config.llm.apiKey
  if (config.llm.apiKeyEnv) return optionalString(process.env[config.llm.apiKeyEnv])
  return ''
}

function getTtsApiKey(config) {
  if (config.tts.apiKey) return config.tts.apiKey
  if (config.tts.apiKeyEnv) return optionalString(process.env[config.tts.apiKeyEnv])
  return ''
}

function openMainDb(config) {
  if (!existsSync(config.database.mainDbPath)) {
    throw new Error(`找不到主数据库：${config.database.mainDbPath}`)
  }
  return new DatabaseSync(config.database.mainDbPath, { readOnly: true })
}

function listBooks(config) {
  const db = openMainDb(config)
  try {
    return db.prepare(`
      SELECT id, title, chapter_count, imported_at
      FROM books
      ORDER BY imported_at DESC
    `).all()
  } finally {
    db.close()
  }
}

function getChapter(config, bookId, chapterIndex) {
  const db = openMainDb(config)
  try {
    const book = db.prepare(`
      SELECT id, title, chapter_count, imported_at
      FROM books
      WHERE id = ?
    `).get(bookId)
    if (!book) throw new Error(`找不到书籍：${bookId}`)

    const chapter = db.prepare(`
      SELECT id, book_id, chapter_index, title, content, word_count
      FROM chapters
      WHERE book_id = ? AND chapter_index = ?
    `).get(bookId, chapterIndex)
    if (!chapter) throw new Error(`找不到章节：book=${bookId}, chapter=${chapterIndex}`)
    return { book, chapter }
  } finally {
    db.close()
  }
}

function getKgCharacterCandidates(config, bookId, chapterIndex) {
  const db = openMainDb(config)
  try {
    try {
      const rows = db.prepare(`
        SELECT id, name, type, aliases_json, description, confidence, first_chapter_index, last_chapter_index
        FROM kg_entities
        WHERE book_id = ?
          AND type = 'character'
          AND (first_chapter_index IS NULL OR first_chapter_index <= ?)
          AND (last_chapter_index IS NULL OR last_chapter_index >= ?)
        ORDER BY confidence DESC, name ASC
        LIMIT 100
      `).all(bookId, chapterIndex, chapterIndex)

      return rows.map(row => ({
        id: row.id,
        name: row.name,
        type: row.type,
        aliases: parseJsonArray(row.aliases_json),
        description: row.description || '',
        confidence: Number(row.confidence ?? 0),
        firstChapterIndex: row.first_chapter_index ?? null,
        lastChapterIndex: row.last_chapter_index ?? null,
      }))
    } catch (error) {
      console.warn(`⚠️  读取知识图谱候选角色失败，将只使用配置角色：${error.message}`)
      return []
    }
  } finally {
    db.close()
  }
}

function parseJsonArray(value) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : []
  } catch {
    return []
  }
}

function preSegmentText(text, limit, maxChars = DEFAULT_TTS_MAX_CHARACTERS_PER_REQUEST) {
  const sourceLimit = getSafeSourceLimit(text, limit)
  const source = text.slice(0, sourceLimit)
  const segments = []
  const quoteRegex = /[「『“‘\"']([^」』”’\"']{1,1200})[」』”’\"']/g
  let cursor = 0
  let match

  while ((match = quoteRegex.exec(source))) {
    const fullQuote = match[0]
    const quoteText = match[1]
    if (!isLikelyDialogueQuote(quoteText)) {
      continue
    }
    if (match.index > cursor) {
      pushNonDialogueSegments(segments, source.slice(cursor, match.index), cursor, maxChars)
    }
    const contextBefore = source.slice(Math.max(0, match.index - 24), match.index)
    const hint = inferQuoteTypeHint(contextBefore, quoteText)
    pushSegment(segments, hint, quoteText, match.index + fullQuote.indexOf(quoteText), match.index + fullQuote.indexOf(quoteText) + quoteText.length, maxChars)
    cursor = match.index + fullQuote.length
  }
  if (cursor < source.length) {
    pushNonDialogueSegments(segments, source.slice(cursor), cursor, maxChars)
  }

  return segments.map((segment, index) => ({
    ...segment,
    contextBefore: source.slice(Math.max(0, segment.sourceStart - 80), segment.sourceStart).replace(/\s+/g, ' ').trim(),
    contextAfter: source.slice(segment.sourceEnd, Math.min(source.length, segment.sourceEnd + 80)).replace(/\s+/g, ' ').trim(),
    id: `pre-${String(index + 1).padStart(4, '0')}`,
  }))
}

function inferQuoteTypeHint(contextBefore, quoteText) {
  if (isNarrativeCitationContext(contextBefore)) return 'narration'
  if (/[道曰说问答叫喊喝笑骂叹][：:]?\s*$/.test(contextBefore) || isLikelyDialogueQuote(quoteText)) return 'dialogue'
  return 'narration'
}

function isNarrativeCitationContext(contextBefore) {
  return /(诗曰|赋曰|词曰|赞曰|古云|古语云|有诗为证|有词为证|易曰|历曰|邵康节曰|正是|但见|那|这)\s*[：:]?\s*$/.test(contextBefore)
}

function getSafeSourceLimit(text, requestedLimit) {
  const limit = Math.min(text.length, requestedLimit)
  if (limit >= text.length) {
    return text.length
  }
  const preview = text.slice(0, limit)
  const lastOpen = preview.lastIndexOf('「')
  const lastClose = preview.lastIndexOf('」')
  if (lastOpen > lastClose) {
    return Math.max(0, lastOpen)
  }
  return limit
}

function parseDraftLimit(args) {
  if (args.limit === undefined) return null
  const limit = Number(args.limit)
  if (!Number.isInteger(limit) || limit < 100) {
    throw new Error('--limit 必须是大于等于 100 的整数。')
  }
  return limit
}

function getDraftSourceLimit(chapter, requestedLimit, allowPartial) {
  if (requestedLimit == null) return chapter.content.length
  const safeLimit = getSafeSourceLimit(chapter.content, requestedLimit)
  if (safeLimit < chapter.content.length && !allowPartial) {
    throw new Error(
      `--limit 会只生成章节前 ${safeLimit}/${chapter.content.length} 个字符的部分音频。正式生产请移除 --limit；调试时请显式添加 --allow-partial。`,
    )
  }
  return safeLimit
}

function isPartialDirectorScript(script) {
  const sourceLimit = Number(script?.source?.sourceLimit)
  const chapterCharLength = Number(script?.source?.chapterCharLength)
  return Number.isFinite(sourceLimit) && Number.isFinite(chapterCharLength) && sourceLimit < chapterCharLength
}

function assertFullDirectorScript(script, allowPartial) {
  if (!isPartialDirectorScript(script) || allowPartial) return
  throw new Error(
    `导演脚本只覆盖章节前 ${script.source.sourceLimit}/${script.source.chapterCharLength} 个字符。正式生产请重新生成全章脚本；调试合成请显式添加 --allow-partial。`,
  )
}

function isLikelyDialogueQuote(text) {
  const value = text.trim()
  if (!value) return false
  if (value.length <= 6 && !/[。！？!?……]/.test(value)) return false
  return /[。！？!?……]/.test(value) || /[我你他她咱俺本姑娘本门]/.test(value)
}

function pushNonDialogueSegments(segments, rawText, baseStart, maxChars = DEFAULT_TTS_MAX_CHARACTERS_PER_REQUEST) {
  const thoughtRegex = /(——[^。！？!?]*?心里想。|（[^）]+）|\([^）)]+\))/g
  let cursor = 0
  let match

  while ((match = thoughtRegex.exec(rawText))) {
    if (match.index > cursor) {
      pushSegment(segments, 'narration', rawText.slice(cursor, match.index), baseStart + cursor, baseStart + match.index, maxChars)
    }
    pushSegment(segments, 'thought', match[0], baseStart + match.index, baseStart + match.index + match[0].length, maxChars)
    cursor = match.index + match[0].length
  }

  if (cursor < rawText.length) {
    pushSegment(segments, 'narration', rawText.slice(cursor), baseStart + cursor, baseStart + rawText.length, maxChars)
  }
}

function pushSegment(segments, type, rawText, start, end, maxChars = DEFAULT_TTS_MAX_CHARACTERS_PER_REQUEST) {
  for (const chunk of splitRawTextForTts(rawText, maxChars)) {
    const text = chunk.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    segments.push({
      id: '',
      typeHint: type,
      text,
      sourceStart: start + chunk.start,
      sourceEnd: start + chunk.end,
    })
  }
}

function splitRawTextForTts(rawText, maxChars) {
  if (rawText.length <= maxChars) {
    return [{ text: rawText, start: 0, end: rawText.length }]
  }

  const chunks = []
  let cursor = 0
  while (cursor < rawText.length) {
    const hardEnd = Math.min(rawText.length, cursor + maxChars)
    let end = hardEnd
    if (hardEnd < rawText.length) {
      const window = rawText.slice(cursor, hardEnd)
      const punctuationIndex = Math.max(
        window.lastIndexOf('。'),
        window.lastIndexOf('！'),
        window.lastIndexOf('？'),
        window.lastIndexOf('；'),
        window.lastIndexOf(';'),
        window.lastIndexOf('，'),
        window.lastIndexOf(','),
      )
      if (punctuationIndex >= Math.floor(maxChars * 0.45)) {
        end = cursor + punctuationIndex + 1
      }
    }
    const text = rawText.slice(cursor, end)
    chunks.push({ text, start: cursor, end })
    cursor = end
  }
  return chunks
}

function buildVoiceCandidates(config, kgCandidates) {
  const byName = new Map()
  for (const candidate of kgCandidates) {
    byName.set(candidate.name, {
      name: candidate.name,
      characterId: candidate.id,
      aliases: candidate.aliases,
      voice: null,
      style: candidate.description || '',
      source: 'kg',
    })
  }

  for (const entry of config.voices.characters) {
    const existing = byName.get(entry.name) || {}
    byName.set(entry.name, {
      ...existing,
      name: entry.name,
      characterId: existing.characterId || null,
      aliases: uniqueStrings([...(existing.aliases || []), ...(entry.aliases || [])]),
      voice: entry.voice || existing.voice || null,
      style: entry.style || existing.style || '',
      source: existing.source ? `${existing.source}+config` : 'config',
    })
  }

  return Array.from(byName.values())
}

function filterVoiceCandidates(candidates, sourceText, maxCount = 30) {
  const scored = candidates.map(candidate => {
    const aliases = [candidate.name, ...(candidate.aliases || [])].filter(Boolean)
    const appears = aliases.some(alias => sourceText.includes(alias))
    const configured = String(candidate.source || '').includes('config')
    return {
      candidate,
      score: (configured ? 100 : 0) + (appears ? 50 : 0) + (candidate.characterId ? 5 : 0),
    }
  })

  return scored
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.name.localeCompare(b.candidate.name, 'zh-Hans-CN'))
    .slice(0, maxCount)
    .map(entry => entry.candidate)
}

function uniqueStrings(values) {
  return Array.from(new Set(values.filter(Boolean).map(String)))
}

function compactPreSegments(preSegments) {
  return preSegments.map(segment => ({
    id: segment.id,
    typeHint: segment.typeHint,
    text: segment.text,
    contextBefore: segment.contextBefore,
    contextAfter: segment.contextAfter,
  }))
}

function buildDirectorPrompt({ config, book, chapter, preSegments, characterCandidates }) {
  return `你是长篇中文小说的多角色有声书导演脚本标注器。你的任务是给预切分片段判定朗读角色和表演提示。

只输出严格 JSON，不要输出 Markdown，不要解释，不要输出思考过程。

重要约束：
1. 输入片段已经由程序切好，禁止合并、拆分、改写片段。
2. 你不需要回填原文全文，只输出每个 preSegment 的判定结果。
3. type 只能是 narration、dialogue、thought、stage。
4. typeHint=dialogue 的片段通常是引号内对白，必须判断 speaker。
5. narration 必须使用 speaker="旁白"，voice="${config.director.defaultNarrator.voice}"。
6. speaker 只能来自候选角色、"旁白" 或 "未知角色"。
7. 不确定说话人时用 speaker="未知角色"，confidence 不得超过 0.45。
8. 角色内心独白可标为 thought；纯叙述不可误标为角色对白。
9. evidence 必须说明依据，例如上下文中的“某某道”“被唤作某某”、候选角色别名或无法判断。

输出 JSON 结构必须是：
{
  "decisions": [
    {
      "preSegmentId": "pre-0001",
      "type": "narration|dialogue|thought|stage",
      "speaker": "旁白|角色名|未知角色",
      "characterId": null,
      "voice": "音色名或null",
      "style": "简短导演提示",
      "confidence": 0.0,
      "evidence": "简短依据"
    }
  ]
}

书籍：${book.title}
章节：第 ${chapter.chapter_index} 章 ${chapter.title}

默认旁白：
${JSON.stringify(config.director.defaultNarrator, null, 2)}

候选角色与音色：
${JSON.stringify(characterCandidates, null, 2)}

预切分片段：
${JSON.stringify(compactPreSegments(preSegments), null, 2)}
`
}

async function callOpenAICompatible(config, messages) {
  const apiKey = getApiKey(config)
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const body = {
    model: config.llm.model,
    messages,
    temperature: config.llm.temperature,
    max_tokens: config.llm.maxTokens,
  }
  if (config.llm.responseFormatJson) {
    body.response_format = { type: 'json_object' }
  }

  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.llm.timeoutMs),
  })

  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`模型返回 ${response.status}：${raw.slice(0, 1000)}`)
  }

  const json = JSON.parse(raw)
  const content = json?.choices?.[0]?.message?.content
  if (!content) {
    throw new Error(`模型响应缺少 choices[0].message.content：${raw.slice(0, 1000)}`)
  }
  try {
    return parseJsonObject(content)
  } catch (error) {
    throw new Error(`模型没有返回合法 JSON：${error.message}\n响应片段：${content.slice(0, 1200)}`)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function callOpenAICompatibleWithRetry(config, messages, label, maxAttempts = 3, stats = null) {
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (stats) stats.attempts += 1
    try {
      return await callOpenAICompatible(config, messages)
    } catch (error) {
      lastError = error
      if (stats) {
        stats.failures += 1
        stats.errors.push({
          label,
          attempt,
          message: error.message.split('\n')[0],
        })
      }
      if (attempt >= maxAttempts) break
      if (stats) stats.retries += 1
      const delayMs = 1000 * attempt
      console.warn(`⚠️  ${label} 第 ${attempt} 次失败：${error.message.split('\n')[0]}，${delayMs}ms 后重试。`)
      await sleep(delayMs)
    }
  }
  throw lastError
}

function parseJsonObject(raw) {
  const text = String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
  try {
    return JSON.parse(text)
  } catch {
    const objectText = extractFirstJsonObject(text)
    if (!objectText) throw new Error('模型没有返回 JSON 对象。')
    return JSON.parse(objectText)
  }
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

function buildDirectorScript({ config, book, chapter, preSegments, decisions, characterCandidates, sourceLimit }) {
  const decisionMap = new Map()
  for (const decision of Array.isArray(decisions?.decisions) ? decisions.decisions : []) {
    if (decision?.preSegmentId) decisionMap.set(decision.preSegmentId, decision)
  }

  const characterByName = new Map(characterCandidates.map(character => [character.name, character]))
  const segments = preSegments.map((preSegment, index) => {
    const decision = decisionMap.get(preSegment.id) || {}
    const type = ALLOWED_SEGMENT_TYPES.has(decision.type) ? decision.type : preSegment.typeHint
    const rawSpeaker = typeof decision.speaker === 'string' && decision.speaker.trim() ? decision.speaker.trim() : defaultSpeaker(type)
    const inferredCharacter = inferCharacterFromContext(preSegment, characterCandidates)
    const speaker = rawSpeaker === '未知角色' && type === 'thought' && inferredCharacter
      ? inferredCharacter.name
      : rawSpeaker
    const character = characterByName.get(speaker)
    const isNarration = type === 'narration'
    const voice = isNarration
      ? config.director.defaultNarrator.voice
      : optionalString(decision.voice) || character?.voice || null
    const style = isNarration
      ? config.director.defaultNarrator.style
      : optionalString(decision.style) || character?.style || ''

    const confidence = inferredCharacter && rawSpeaker === '未知角色' && type === 'thought'
      ? Math.max(normalizeConfidence(decision.confidence, 0), 0.75)
      : normalizeConfidence(decision.confidence, isNarration ? 1 : 0)

    return {
      id: `ch${String(chapter.chapter_index).padStart(3, '0')}-s${String(index + 1).padStart(4, '0')}`,
      preSegmentId: preSegment.id,
      type,
      speaker: isNarration ? '旁白' : speaker,
      characterId: isNarration ? null : (decision.characterId || character?.characterId || null),
      voice,
      style,
      text: preSegment.text,
      sourceStart: preSegment.sourceStart,
      sourceEnd: preSegment.sourceEnd,
      confidence: speaker === '未知角色' ? Math.min(confidence, 0.45) : confidence,
      evidence: inferredCharacter && rawSpeaker === '未知角色' && type === 'thought'
        ? `程序根据上下文中的角色名或别名推断为 ${inferredCharacter.name}。`
        : optionalString(decision.evidence) || (isNarration ? '规则切分：引号外旁白。' : '模型未提供依据。'),
    }
  })

  return {
    kind: SCRIPT_KIND,
    version: 1,
    source: {
      bookId: book.id,
      bookTitle: book.title,
      chapterId: chapter.id,
      chapterIndex: chapter.chapter_index,
      chapterTitle: chapter.title,
      sourceLimit: sourceLimit ?? preSegments.at(-1)?.sourceEnd ?? 0,
      chapterCharLength: chapter.content.length,
    },
    segments,
  }
}

function inferCharacterFromContext(preSegment, characterCandidates) {
  const context = `${preSegment.contextBefore || ''}${preSegment.contextAfter || ''}`
  if (!context) return null
  for (const candidate of characterCandidates) {
    const names = [candidate.name, ...(candidate.aliases || [])].filter(Boolean)
    if (names.some(name => name.length >= 2 && context.includes(name))) {
      return candidate
    }
  }
  return null
}

function defaultSpeaker(type) {
  return type === 'narration' ? '旁白' : '未知角色'
}

function normalizeConfidence(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(1, number))
}

function validateDirectorScript(script, preSegments = null) {
  const errors = []
  const warnings = []
  if (script?.kind !== SCRIPT_KIND) {
    errors.push(`kind 必须是 ${SCRIPT_KIND}。`)
  }
  if (!Array.isArray(script?.segments)) {
    errors.push('segments 必须是数组。')
    return { errors, warnings }
  }
  if (preSegments && script.segments.length !== preSegments.length) {
    errors.push(`片段数量不一致：预切分 ${preSegments.length}，脚本 ${script.segments.length}。`)
  }

  const ids = new Set()
  for (let index = 0; index < script.segments.length; index += 1) {
    const segment = script.segments[index]
    if (!segment.id || ids.has(segment.id)) errors.push(`第 ${index + 1} 段缺少 id 或 id 重复。`)
    ids.add(segment.id)
    if (!ALLOWED_SEGMENT_TYPES.has(segment.type)) errors.push(`${segment.id}: type 非法：${segment.type}`)
    if (!segment.text) errors.push(`${segment.id}: text 为空。`)
    if (typeof segment.confidence !== 'number') errors.push(`${segment.id}: confidence 必须是数字。`)
    if (segment.type === 'narration' && segment.speaker !== '旁白') {
      errors.push(`${segment.id}: narration 的 speaker 必须是旁白。`)
    }
    if (segment.type === 'narration' && segment.voice !== '白桦') {
      warnings.push(`${segment.id}: 当前默认策略期望旁白使用男声白桦，实际为 ${segment.voice || '空'}。`)
    }
    if (segment.speaker === '未知角色' && segment.confidence > 0.45) {
      errors.push(`${segment.id}: 未知角色 confidence 不应超过 0.45。`)
    }
    const source = preSegments?.find(item => item.id === segment.preSegmentId) || preSegments?.[index]
    if (source && segment.text !== source.text) {
      errors.push(`${segment.id}: text 与预切分原文不一致。`)
    }
  }
  return { errors, warnings }
}

function diagnosticsFor({ config, preSegments, kgCandidates, characterCandidates, validation, batchSize, directorConcurrency, llmBatchStats = null }) {
  return {
    generatedAt: new Date().toISOString(),
    configPath: config.configPath,
    llm: {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      hasApiKey: Boolean(getApiKey(config)),
    },
    preSegmentCount: preSegments.length,
    batchSize,
    directorConcurrency,
    kgCandidateCount: kgCandidates.length,
    characterCandidateCount: characterCandidates.length,
    llmBatchStats,
    validationErrors: validation.errors,
    validationWarnings: validation.warnings,
  }
}

async function runDraftScript(config, args) {
  const bookId = args['book-id']
  const chapterIndex = Number(args.chapter)
  if (!bookId || !Number.isInteger(chapterIndex) || chapterIndex < 1) {
    throw new Error('draft-script 需要 --book-id 和 --chapter。')
  }

  const requestedLimit = parseDraftLimit(args)
  const batchSize = args['batch-size']
    ? Math.max(1, Math.floor(Number(args['batch-size'])))
    : config.director.segmentBatchSize
  if (!Number.isFinite(batchSize) || batchSize < 1) {
    throw new Error('--batch-size 必须是大于等于 1 的整数。')
  }
  const directorConcurrency = args.concurrency
    ? Math.max(1, Math.floor(Number(args.concurrency)))
    : config.director.concurrency
  if (!Number.isFinite(directorConcurrency) || directorConcurrency < 1) {
    throw new Error('--concurrency 必须是大于等于 1 的整数。')
  }

  const { book, chapter } = getChapter(config, bookId, chapterIndex)
  const kgCandidates = getKgCharacterCandidates(config, bookId, chapterIndex)
  const sourceLimit = getDraftSourceLimit(chapter, requestedLimit, args['allow-partial'] === true)
  const preSegments = preSegmentText(chapter.content, sourceLimit, config.tts.maxCharactersPerRequest)
  const sourceText = chapter.content.slice(0, sourceLimit)
  const characterCandidates = filterVoiceCandidates(buildVoiceCandidates(config, kgCandidates), sourceText)
  const batches = []
  for (let start = 0; start < preSegments.length; start += batchSize) {
    batches.push({
      index: batches.length,
      start,
      segments: preSegments.slice(start, start + batchSize),
    })
  }
  const batchResults = new Array(batches.length)
  const llmBatchStats = { attempts: 0, retries: 0, failures: 0, errors: [] }
  console.log(`🚀 导演脚本 LLM 并发：${directorConcurrency}，批次：${batches.length}`)
  await runConcurrent(batches, directorConcurrency, async (batchInfo) => {
    const currentBatch = batchInfo.index + 1
    const batch = batchInfo.segments
    console.log(`🧾 生成导演判定 ${currentBatch}/${batches.length}，片段 ${batchInfo.start + 1}-${batchInfo.start + batch.length}/${preSegments.length}`)
    const prompt = buildDirectorPrompt({ config, book, chapter, preSegments: batch, characterCandidates })
    const batchDecisions = await callOpenAICompatibleWithRetry(config, [
      { role: 'system', content: '你只输出严格 JSON，不输出 Markdown，不输出思考过程。' },
      { role: 'user', content: prompt },
    ], `第 ${currentBatch} 批导演判定`, 3, llmBatchStats)
    if (!Array.isArray(batchDecisions?.decisions)) {
      throw new Error(`第 ${currentBatch} 批模型输出缺少 decisions 数组。`)
    }
    batchResults[batchInfo.index] = batchDecisions.decisions
    console.log(`✅ 导演判定完成 ${currentBatch}/${batches.length}`)
  })
  const allDecisions = batchResults.flat()
  const decisions = { decisions: allDecisions }
  const script = buildDirectorScript({ config, book, chapter, preSegments, decisions, characterCandidates, sourceLimit })
  const validation = validateDirectorScript(script, preSegments)
  script.diagnostics = diagnosticsFor({ config, preSegments, kgCandidates, characterCandidates, validation, batchSize, directorConcurrency, llmBatchStats })

  const outputPath = args.out
    ? resolve(args.out)
    : resolve(`tmp/tts/${safeFilePart(book.title)}/ch${String(chapterIndex).padStart(3, '0')}/director-script.json`)
  const diagnosticsPath = outputPath.replace(/\.json$/i, '.diagnostics.json')
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(script, null, 2)}\n`, 'utf8')
  writeFileSync(diagnosticsPath, `${JSON.stringify(script.diagnostics, null, 2)}\n`, 'utf8')

  console.log(`✅ 导演脚本已生成：${outputPath}`)
  console.log(`   诊断文件：${diagnosticsPath}`)
  console.log(`   书籍：${book.title}`)
  console.log(`   章节：${chapter.chapter_index} ${chapter.title}`)
  console.log(`   预切分片段：${preSegments.length}`)
  console.log(`   KG 候选角色：${kgCandidates.length}`)
  console.log(`   校验错误：${validation.errors.length}`)
  console.log(`   校验警告：${validation.warnings.length}`)
  for (const error of validation.errors.slice(0, 8)) console.log(`   - ${error}`)
  return { book, chapter, script, outputPath, diagnosticsPath, validation, batchSize, directorConcurrency, llmBatchStats }
}

function safeFilePart(value) {
  return String(value || 'book')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'book'
}

function parseChapterList(value) {
  const chapters = new Set()
  for (const part of String(value || '').split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const range = trimmed.match(/^(\d+)-(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error(`非法章节范围：${trimmed}`)
      }
      for (let chapter = start; chapter <= end; chapter += 1) chapters.add(chapter)
      continue
    }
    const chapter = Number(trimmed)
    if (!Number.isInteger(chapter) || chapter < 1) {
      throw new Error(`非法章节序号：${trimmed}`)
    }
    chapters.add(chapter)
  }
  return Array.from(chapters).sort((a, b) => a - b)
}

function makeChapterArgs(baseArgs, chapterIndex, scriptPath = null, audioDir = null) {
  const args = { ...baseArgs, chapter: String(chapterIndex) }
  if (scriptPath) args.out = scriptPath
  if (audioDir) args['out-dir'] = audioDir
  return args
}

function editDistance(a, b) {
  const left = Array.from(String(a || ''))
  const right = Array.from(String(b || ''))
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0))
  for (let i = 0; i <= left.length; i += 1) dp[i][0] = i
  for (let j = 0; j <= right.length; j += 1) dp[0][j] = j
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[left.length][right.length]
}

function auditDirectorScript(config, script) {
  const chapterIndex = Number(script?.source?.chapterIndex)
  const bookId = script?.source?.bookId
  const kgCandidates = bookId && Number.isInteger(chapterIndex)
    ? getKgCharacterCandidates(config, bookId, chapterIndex)
    : []
  const candidates = buildVoiceCandidates(config, kgCandidates)
  const canonicalNames = new Set(candidates.map(candidate => candidate.name).filter(Boolean))
  const aliasToName = new Map()
  for (const candidate of candidates) {
    for (const alias of candidate.aliases || []) {
      if (alias && !aliasToName.has(alias)) aliasToName.set(alias, candidate.name)
    }
  }

  const speakerCounts = {}
  const defaultVoiceSegments = []
  const unknownSegments = []
  const aliasSpeakers = []
  const suspiciousSpeakers = []
  const seenSuspicious = new Set()

  for (const segment of script.segments || []) {
    speakerCounts[segment.speaker] = (speakerCounts[segment.speaker] || 0) + 1
    if (segment.speaker === '未知角色') unknownSegments.push(segment.id)
    if (segment.type !== 'narration' && !segment.voice) defaultVoiceSegments.push(segment.id)
    if (segment.speaker && aliasToName.has(segment.speaker)) {
      aliasSpeakers.push({ speaker: segment.speaker, canonical: aliasToName.get(segment.speaker), segmentId: segment.id })
    }
    if (
      segment.speaker &&
      segment.speaker !== '旁白' &&
      segment.speaker !== '未知角色' &&
      !canonicalNames.has(segment.speaker) &&
      !aliasToName.has(segment.speaker)
    ) {
      let best = null
      for (const name of canonicalNames) {
        const distance = editDistance(segment.speaker, name)
        if (!best || distance < best.distance) best = { name, distance }
      }
      const key = `${segment.speaker}:${best?.name || ''}`
      if (best && best.distance <= 2 && !seenSuspicious.has(key)) {
        suspiciousSpeakers.push({ speaker: segment.speaker, maybe: best.name, distance: best.distance, segmentId: segment.id })
        seenSuspicious.add(key)
      }
    }
  }

  const total = script.segments?.length || 0
  const warnings = []
  if (unknownSegments.length) warnings.push(`未知角色 ${unknownSegments.length}/${total}`)
  if (defaultVoiceSegments.length) warnings.push(`默认音色角色片段 ${defaultVoiceSegments.length}/${total}`)
  if (aliasSpeakers.length) warnings.push(`speaker 使用别名 ${aliasSpeakers.length} 处`)
  if (suspiciousSpeakers.length) warnings.push(`疑似错别字 speaker ${suspiciousSpeakers.length} 个`)

  return {
    kind: 'novel-reader-tts-director-audit',
    generatedAt: new Date().toISOString(),
    source: script.source,
    segmentCount: total,
    speakerCounts,
    unknown: {
      count: unknownSegments.length,
      ratio: total ? unknownSegments.length / total : 0,
      sampleSegmentIds: unknownSegments.slice(0, 20),
    },
    defaultVoice: {
      count: defaultVoiceSegments.length,
      ratio: total ? defaultVoiceSegments.length / total : 0,
      sampleSegmentIds: defaultVoiceSegments.slice(0, 20),
    },
    aliasSpeakers: aliasSpeakers.slice(0, 50),
    suspiciousSpeakers,
    warnings,
  }
}

function writeAuditReport(config, scriptPath, script) {
  const audit = auditDirectorScript(config, script)
  const auditPath = scriptPath.replace(/\.json$/i, '.audit.json')
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8')
  console.log(`🩺 脚本质检：未知角色 ${audit.unknown.count}，默认音色 ${audit.defaultVoice.count}，疑似错别字 ${audit.suspiciousSpeakers.length}`)
  console.log(`   质检文件：${auditPath}`)
  return { audit, auditPath }
}

async function runValidateScript(args) {
  const scriptPath = args.script ? resolve(args.script) : null
  if (!scriptPath) throw new Error('validate-script 需要 --script。')
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'))
  const validation = validateDirectorScript(script)
  console.log(`校验文件：${scriptPath}`)
  console.log(`错误：${validation.errors.length}`)
  console.log(`警告：${validation.warnings.length}`)
  for (const error of validation.errors) console.log(`- ${error}`)
  for (const warning of validation.warnings) console.log(`- ${warning}`)
  if (validation.errors.length) process.exitCode = 1
}

async function runAuditScript(config, args) {
  const scriptPath = args.script ? resolve(args.script) : null
  if (!scriptPath) throw new Error('audit-script 需要 --script。')
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'))
  const { audit } = writeAuditReport(config, scriptPath, script)
  console.log(JSON.stringify({
    segmentCount: audit.segmentCount,
    unknown: audit.unknown,
    defaultVoice: audit.defaultVoice,
    suspiciousSpeakers: audit.suspiciousSpeakers,
    warnings: audit.warnings,
  }, null, 2))
}

function segmentCacheKey(segment) {
  return createHash('sha256')
    .update(JSON.stringify({
      id: segment.id,
      text: segment.text,
      voice: segment.voice,
      style: segment.style,
      performanceStyle: segment.performanceStyle || '',
    }))
    .digest('hex')
    .slice(0, 16)
}

function getSegmentTtsStyle(config, segment) {
  return [config.director.performanceStyle, segment.style || '自然清晰的中文小说朗读。']
    .filter(Boolean)
    .join('\n')
}

async function synthSegmentWithMimo(config, segment, outputPath) {
  const apiKey = getTtsApiKey(config)
  if (!apiKey) {
    throw new Error(`缺少 MIMO API key。请在配置文件 tts.apiKey 中填写，或设置环境变量 ${config.tts.apiKeyEnv}。`)
  }
  const response = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.tts.model,
      messages: [
        { role: 'user', content: getSegmentTtsStyle(config, segment) },
        { role: 'assistant', content: segment.text },
      ],
      audio: {
        format: config.tts.format,
        voice: segment.voice || 'mimo_default',
      },
    }),
  })

  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`MIMO TTS 返回 ${response.status}：${raw.slice(0, 1000)}`)
  }
  const json = JSON.parse(raw)
  const data = json?.choices?.[0]?.message?.audio?.data
  if (!data) {
    throw new Error(`MIMO TTS 响应缺少 audio.data：${raw.slice(0, 1000)}`)
  }
  writeFileSync(outputPath, Buffer.from(data, 'base64'))
}

function runFfmpeg(args, label) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${label} 失败：${result.stderr || result.stdout || 'ffmpeg exited with error'}`)
  }
}

function probeAudioDurationSeconds(filePath) {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`读取音频时长失败：${result.stderr || result.stdout || filePath}`)
  }
  const duration = Number(result.stdout.trim())
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`音频时长无效：${filePath}`)
  }
  return duration
}

function detectLongSilences(filePath, maxSilenceSeconds) {
  if (!Number.isFinite(maxSilenceSeconds) || maxSilenceSeconds <= 0) return []
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      filePath,
      '-af',
      `silencedetect=noise=-45dB:d=${Math.max(0.5, maxSilenceSeconds)}`,
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  )
  const output = `${result.stderr || ''}\n${result.stdout || ''}`
  const silences = []
  for (const match of output.matchAll(/silence_start:\s*([0-9.]+)[\s\S]*?silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/g)) {
    silences.push({
      start: Number(match[1]),
      end: Number(match[2]),
      duration: Number(match[3]),
    })
  }
  return silences.filter(item => Number.isFinite(item.duration) && item.duration >= maxSilenceSeconds)
}

function validateSynthesizedAudio(config, item) {
  const duration = probeAudioDurationSeconds(item.wav)
  const textLength = Array.from(String(item.text || '')).length
  const maxDuration = Math.max(12, textLength * config.tts.maxSecondsPerCharacter)
  if (duration > maxDuration) {
    throw new Error(`${item.id} 音频时长异常：${duration.toFixed(2)}s / ${textLength} 字，超过 ${maxDuration.toFixed(2)}s。`)
  }
  const longSilences = detectLongSilences(item.wav, config.tts.maxSilenceSeconds)
  if (longSilences.length) {
    const longest = longSilences.reduce((best, item) => item.duration > best.duration ? item : best, longSilences[0])
    throw new Error(`${item.id} 含异常长静音：${longest.duration.toFixed(2)}s。`)
  }
  return duration
}

async function synthSegmentWithValidation(config, item, attempts = 3) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (existsSync(item.wav)) rmSync(item.wav, { force: true })
      await synthSegmentWithMimo(config, item.segment, item.wav)
      validateSynthesizedAudio(config, item)
      return
    } catch (error) {
      lastError = error
      if (existsSync(item.wav)) rmSync(item.wav, { force: true })
      if (attempt < attempts) {
        console.warn(`⚠️  ${item.id} TTS 片段异常，重试 ${attempt + 1}/${attempts}：${error.message}`)
      }
    }
  }
  throw lastError
}

async function runConcurrent(items, workerCount, worker) {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(workerCount, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      await worker(items[currentIndex], currentIndex)
    }
  })
  await Promise.all(workers)
}

async function runSynth(config, args) {
  if (config.tts.provider !== 'mimo') {
    throw new Error(`暂不支持 TTS provider：${config.tts.provider}`)
  }
  const scriptPath = args.script ? resolve(args.script) : null
  if (!scriptPath) throw new Error('synth 需要 --script。')
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'))
  const validation = validateDirectorScript(script)
  if (validation.errors.length) {
    throw new Error(`导演脚本校验失败，不能合成：${validation.errors[0]}`)
  }
  assertFullDirectorScript(script, args['allow-partial'] === true)

  const outDir = args['out-dir'] ? resolve(args['out-dir']) : join(dirname(scriptPath), 'audio')
  const concurrency = args.concurrency
    ? Math.max(1, Math.floor(Number(args.concurrency)))
    : config.tts.concurrency
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new Error('--concurrency 必须是大于等于 1 的整数。')
  }
  const segmentDir = join(outDir, 'segments')
  const workDir = join(outDir, 'work')
  mkdirSync(segmentDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })

  const manifest = {
    kind: 'novel-reader-tts-audio-manifest',
    version: 2,
    timelineVersion: 1,
    sourceScript: scriptPath,
    generatedAt: new Date().toISOString(),
    tts: {
      provider: config.tts.provider,
      model: config.tts.model,
      finalFormat: config.tts.finalFormat,
      mp3Bitrate: config.tts.mp3Bitrate,
      concurrency,
    },
    segments: [],
  }

  const ttsSegments = expandLongSegmentsForTts(script.segments, config.tts.maxCharactersPerRequest)
  manifest.segments = ttsSegments.map((segment) => {
    const key = segmentCacheKey({ ...segment, performanceStyle: config.director.performanceStyle })
    const wavPath = join(segmentDir, `${segment.id}-${key}.wav`)
    return {
      id: segment.id,
      speaker: segment.speaker,
      voice: segment.voice,
      text: segment.text,
      sourceStart: segment.sourceStart,
      sourceEnd: segment.sourceEnd,
      textHash: key,
      wav: wavPath,
      segment,
    }
  })

  const segmentsToSynthesize = []
  for (const item of manifest.segments) {
    if (!existsSync(item.wav)) {
      segmentsToSynthesize.push(item)
      continue
    }
    try {
      validateSynthesizedAudio(config, item)
    } catch (error) {
      console.warn(`⚠️  缓存音频异常，将重新合成 ${item.id}：${error.message}`)
      rmSync(item.wav, { force: true })
      segmentsToSynthesize.push(item)
    }
  }
  if (segmentsToSynthesize.length) {
    console.log(`🚀 TTS 并发：${concurrency}，待合成片段：${segmentsToSynthesize.length}`)
  }
  await runConcurrent(segmentsToSynthesize, concurrency, async (item) => {
    console.log(`🎙️  合成 ${item.id} ${item.speaker} ${item.voice || '默认音色'}`)
    await synthSegmentWithValidation(config, item)
  })

  for (const item of manifest.segments) {
    if (!existsSync(item.wav)) {
      throw new Error(`缺少合成后的 WAV：${item.wav}`)
    }
    console.log(`✅ 片段就绪 ${item.id}`)
  }
  manifest.segments = manifest.segments.map(({ segment, ...item }) => item)

  const concatEntries = []
  const timeline = []
  let timelineCursor = 0
  for (let index = 0; index < manifest.segments.length; index += 1) {
    const item = manifest.segments[index]
    const normalized = join(workDir, `${String(index + 1).padStart(4, '0')}-${item.id}.wav`)
    runFfmpeg(['-i', item.wav, '-ar', '24000', '-ac', '1', '-sample_fmt', 's16', normalized], `标准化 ${item.id}`)
    const speechDuration = probeAudioDurationSeconds(normalized)
    const startTime = timelineCursor
    const endTime = startTime + speechDuration
    concatEntries.push(normalized)
    timelineCursor = endTime
    let trailingSilence = 0
    if (index < manifest.segments.length - 1 && config.tts.silenceSeconds > 0) {
      const silence = join(workDir, `${String(index + 1).padStart(4, '0')}-silence.wav`)
      runFfmpeg(['-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(config.tts.silenceSeconds), '-sample_fmt', 's16', silence], '生成静音')
      trailingSilence = probeAudioDurationSeconds(silence)
      concatEntries.push(silence)
      timelineCursor += trailingSilence
    }
    timeline.push({
      id: item.id,
      speaker: item.speaker,
      voice: item.voice,
      text: item.text,
      sourceStart: item.sourceStart,
      sourceEnd: item.sourceEnd,
      startTime,
      endTime,
      speechDuration,
      trailingSilence,
      nextStartTime: timelineCursor,
      wav: item.wav,
    })
  }

  const concatFile = join(workDir, 'concat.txt')
  writeFileSync(concatFile, concatEntries.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
  const chapterWav = join(workDir, 'chapter.wav')
  runFfmpeg(['-f', 'concat', '-safe', '0', '-i', concatFile, '-c', 'copy', chapterWav], '拼接 WAV')

  const finalPath = join(outDir, `chapter.${config.tts.finalFormat}`)
  if (config.tts.finalFormat === 'mp3') {
    runFfmpeg(['-i', chapterWav, '-codec:a', 'libmp3lame', '-b:a', config.tts.mp3Bitrate, finalPath], '编码 MP3')
  } else {
    runFfmpeg(['-i', chapterWav, finalPath], `编码 ${config.tts.finalFormat}`)
  }
  manifest.output = finalPath
  manifest.duration = probeAudioDurationSeconds(finalPath)
  manifest.timeline = timeline
  const manifestPath = join(outDir, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(`✅ 音频已生成：${finalPath}`)
  console.log(`   Manifest：${manifestPath}`)
  if (!config.tts.keepIntermediateWav) {
    console.log('   中间 WAV 保留在 work/，后续会增加清理策略。')
  }
}

function expandLongSegmentsForTts(segments, maxChars) {
  return segments.flatMap((segment) => {
    if (!segment.text || segment.text.length <= maxChars) return [segment]
    const chunks = splitRawTextForTts(segment.text, maxChars)
    return chunks.map((chunk, index) => {
      const ratioStart = segment.text.length > 0 ? chunk.start / segment.text.length : 0
      const ratioEnd = segment.text.length > 0 ? chunk.end / segment.text.length : 1
      const sourceLength = Math.max(0, Number(segment.sourceEnd ?? 0) - Number(segment.sourceStart ?? 0))
      return {
        ...segment,
        id: `${segment.id}-p${String(index + 1).padStart(2, '0')}`,
        text: chunk.text.replace(/\s+/g, ' ').trim(),
        sourceStart: Math.round(Number(segment.sourceStart ?? 0) + sourceLength * ratioStart),
        sourceEnd: Math.round(Number(segment.sourceStart ?? 0) + sourceLength * ratioEnd),
      }
    })
  })
}

function getChapterOutputPaths(outRoot, chapterIndex, finalFormat = 'mp3') {
  const chapterDir = join(outRoot, `ch${String(chapterIndex).padStart(3, '0')}-full`)
  return {
    chapterDir,
    scriptPath: join(chapterDir, 'director-script.json'),
    audioDir: join(chapterDir, 'audio'),
    finalAudioPath: join(chapterDir, 'audio', `chapter.${finalFormat}`),
  }
}

function loadValidScript(scriptPath) {
  if (!existsSync(scriptPath)) return null
  try {
    const script = JSON.parse(readFileSync(scriptPath, 'utf8'))
    const validation = validateDirectorScript(script)
    if (validation.errors.length) return null
    return { script, validation }
  } catch {
    return null
  }
}

async function runBatchPipeline(config, args) {
  const bookId = args['book-id']
  const chapters = parseChapterList(args.chapters)
  if (!bookId || chapters.length === 0) {
    throw new Error('batch-pipeline 需要 --book-id 和 --chapters。')
  }

  const requestedLimit = parseDraftLimit(args)
  const initialBatchSize = args['batch-size']
    ? Math.max(1, Math.floor(Number(args['batch-size'])))
    : config.director.segmentBatchSize
  const initialDirectorConcurrency = args['director-concurrency']
    ? Math.max(1, Math.floor(Number(args['director-concurrency'])))
    : config.director.concurrency
  const minBatchSize = args['min-batch-size']
    ? Math.max(1, Math.floor(Number(args['min-batch-size'])))
    : config.batchPipeline.minBatchSize
  const ttsConcurrency = args['tts-concurrency']
    ? Math.max(1, Math.floor(Number(args['tts-concurrency'])))
    : config.tts.concurrency
  const ttsChapterConcurrency = args['tts-chapters']
    ? Math.max(1, Math.floor(Number(args['tts-chapters'])))
    : config.batchPipeline.ttsChapterConcurrency
  const llmChapterConcurrency = args['llm-chapters']
    ? Math.max(1, Math.floor(Number(args['llm-chapters'])))
    : 1

  const resume = args.resume === true
  if (!Number.isFinite(initialBatchSize) || initialBatchSize < 1) throw new Error('--batch-size 必须是大于等于 1 的整数。')
  if (!Number.isFinite(initialDirectorConcurrency) || initialDirectorConcurrency < 1) throw new Error('--director-concurrency 必须是大于等于 1 的整数。')
  if (!Number.isFinite(minBatchSize) || minBatchSize < 1) throw new Error('--min-batch-size 必须是大于等于 1 的整数。')
  if (!Number.isFinite(ttsConcurrency) || ttsConcurrency < 1) throw new Error('--tts-concurrency 必须是大于等于 1 的整数。')
  if (!Number.isFinite(ttsChapterConcurrency) || ttsChapterConcurrency < 1) throw new Error('--tts-chapters 必须是大于等于 1 的整数。')
  if (!Number.isFinite(llmChapterConcurrency) || llmChapterConcurrency < 1) throw new Error('--llm-chapters 必须是大于等于 1 的整数。')

  const firstChapter = getChapter(config, bookId, chapters[0])
  const outRoot = args['out-root']
    ? resolve(args['out-root'])
    : resolve(`tmp/tts/${safeFilePart(firstChapter.book.title)}`)
  const startedAt = Date.now()
  const results = []
  const audits = []
  const synthPromises = []
  let activeSynthCount = 0
  const synthQueue = []
  let adaptiveBatchSize = initialBatchSize
  let adaptiveDirectorConcurrency = initialDirectorConcurrency

  console.log(`🚂 批量流水线启动：章节 ${chapters.join(', ')}`)
  console.log(`   LLM 阶段：章节并发 ${llmChapterConcurrency}，单章批次并发 ${initialDirectorConcurrency}，batchSize ${initialBatchSize}`)
  console.log(`   TTS 阶段：章节并发 ${ttsChapterConcurrency}，单章片段并发 ${ttsConcurrency}`)
  if (resume) console.log('   断点续跑：已完成 MP3 会跳过，已通过校验脚本会复用。')

  const acquireSynthSlot = async () => {
    if (activeSynthCount < ttsChapterConcurrency) {
      activeSynthCount += 1
      return
    }
    await new Promise(resolve => synthQueue.push(resolve))
    activeSynthCount += 1
  }

  const releaseSynthSlot = () => {
    activeSynthCount -= 1
    const next = synthQueue.shift()
    if (next) next()
  }

  const launchSynth = (chapterIndex, scriptPath, audioDir) => {
    const started = Date.now()
    const synthPromise = (async () => {
      await acquireSynthSlot()
      console.log(`🎧 第 ${chapterIndex} 章进入 TTS 阶段`)
      await runSynth(config, {
        script: scriptPath,
        'out-dir': audioDir,
        concurrency: String(ttsConcurrency),
        ...(args['allow-partial'] === true ? { 'allow-partial': true } : {}),
      })
      const elapsedSeconds = Math.round((Date.now() - started) / 1000)
      results.push({ chapterIndex, scriptPath, audioDir, elapsedSeconds, status: 'synthesized' })
      console.log(`✅ 第 ${chapterIndex} 章 TTS 完成，用时 ${elapsedSeconds}s`)
      return { ok: true }
    })()
      .catch(error => {
        error.message = `第 ${chapterIndex} 章 TTS 失败：${error.message}`
        return { ok: false, error }
      })
      .finally(releaseSynthSlot)
    synthPromises.push(synthPromise)
  }

  const draftWithFallback = async (chapterIndex, scriptPath) => {
    let lastError = null
    for (let attempt = 1; attempt <= config.batchPipeline.maxDraftAttempts; attempt += 1) {
      try {
        const result = await runDraftScript(config, makeChapterArgs({
          'book-id': bookId,
          ...(requestedLimit == null ? {} : { limit: String(requestedLimit) }),
          ...(args['allow-partial'] === true ? { 'allow-partial': true } : {}),
          'batch-size': String(adaptiveBatchSize),
          concurrency: String(adaptiveDirectorConcurrency),
        }, chapterIndex, scriptPath))
        if (result.validation.errors.length) {
          throw new Error(`导演脚本校验失败：${result.validation.errors[0]}`)
        }
        return result
      } catch (error) {
        lastError = error
        if (attempt >= config.batchPipeline.maxDraftAttempts) break
        adaptiveBatchSize = Math.max(minBatchSize, Math.floor(adaptiveBatchSize * 0.7))
        adaptiveDirectorConcurrency = Math.max(1, adaptiveDirectorConcurrency - 1)
        console.warn(`⚠️  第 ${chapterIndex} 章 LLM 失败：${error.message.split('\n')[0]}`)
        console.warn(`   降级重试 ${attempt + 1}/${config.batchPipeline.maxDraftAttempts}：batchSize=${adaptiveBatchSize}, concurrency=${adaptiveDirectorConcurrency}`)
      }
    }
    throw lastError
  }

  await runConcurrent(chapters, llmChapterConcurrency, async (chapterIndex) => {
    const { scriptPath, audioDir, finalAudioPath } = getChapterOutputPaths(outRoot, chapterIndex, config.tts.finalFormat)
    if (resume && existsSync(finalAudioPath)) {
      console.log(`⏭️  第 ${chapterIndex} 章已存在 MP3，跳过：${finalAudioPath}`)
      results.push({ chapterIndex, scriptPath, audioDir, status: 'skipped-audio-exists', elapsedSeconds: 0 })
      return
    }

    let script = null
    const existing = resume ? loadValidScript(scriptPath) : null
    if (existing) {
      script = existing.script
      console.log(`♻️  第 ${chapterIndex} 章复用已有导演脚本：${scriptPath}`)
    } else {
      const draftStarted = Date.now()
      console.log(`\n🎬 第 ${chapterIndex} 章进入 LLM 阶段`)
      const draftResult = await draftWithFallback(chapterIndex, scriptPath)
      script = draftResult.script
      const draftElapsed = Math.round((Date.now() - draftStarted) / 1000)
      console.log(`✅ 第 ${chapterIndex} 章 LLM 阶段完成，用时 ${draftElapsed}s，进入 TTS 阶段`)
    }
    const auditResult = writeAuditReport(config, scriptPath, script)
    audits.push({ chapterIndex, auditPath: auditResult.auditPath, warnings: auditResult.audit.warnings })
    launchSynth(chapterIndex, scriptPath, audioDir)
  })

  console.log('\n⏳ 所有章节已完成 LLM 阶段，等待剩余 TTS 收尾。')
  const outcomes = await Promise.all(synthPromises)
  const failed = outcomes.find(outcome => !outcome.ok)
  if (failed) throw failed.error
  results.sort((a, b) => a.chapterIndex - b.chapterIndex)
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
  const summary = {
    kind: 'novel-reader-tts-batch-pipeline-summary',
    generatedAt: new Date().toISOString(),
    elapsedSeconds,
    bookId,
    chapters,
    outRoot,
    director: { limit: requestedLimit, allowPartial: args['allow-partial'] === true, initialBatchSize, initialConcurrency: initialDirectorConcurrency, finalBatchSize: adaptiveBatchSize, finalConcurrency: adaptiveDirectorConcurrency, minBatchSize, chapterConcurrency: llmChapterConcurrency },
    tts: { segmentConcurrency: ttsConcurrency, chapterConcurrency: ttsChapterConcurrency },
    results,
    audits,
  }
  const summaryPath = join(outRoot, `batch-pipeline-${chapters[0]}-${chapters.at(-1)}.summary.json`)
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  console.log(`✅ 批量流水线完成，总用时 ${elapsedSeconds}s`)
  console.log(`   汇总文件：${summaryPath}`)
}

async function runTestModel(config) {
  const result = await callOpenAICompatible(config, [
    { role: 'system', content: '你只输出严格 JSON。' },
    { role: 'user', content: '输出 {"ok": true, "message": "模型可用"}' },
  ])
  console.log(JSON.stringify(result, null, 2))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] || 'help'

  if (command === 'help') {
    printHelp()
    return
  }

  const config = loadConfig(args.config)

  if (command === 'config') {
    console.log(JSON.stringify({
      configPath: config.configPath,
      llm: {
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
        apiKeyEnv: config.llm.apiKeyEnv,
        hasApiKey: Boolean(getApiKey(config)),
        temperature: config.llm.temperature,
        timeoutMs: config.llm.timeoutMs,
        maxTokens: config.llm.maxTokens,
        responseFormatJson: config.llm.responseFormatJson,
      },
      database: config.database,
      director: config.director,
      batchPipeline: config.batchPipeline,
      tts: {
        provider: config.tts.provider,
        model: config.tts.model,
        finalFormat: config.tts.finalFormat,
        mp3Bitrate: config.tts.mp3Bitrate,
        concurrency: config.tts.concurrency,
        apiKeyEnv: config.tts.apiKeyEnv,
        hasApiKey: Boolean(getTtsApiKey(config)),
      },
      voiceCount: config.voices.characters.length,
    }, null, 2))
    return
  }

  if (command === 'test-model') {
    await runTestModel(config)
    return
  }

  if (command === 'list-books') {
    const books = listBooks(config)
    for (const book of books) {
      console.log(`${book.id} | ${book.title} | ${book.chapter_count} 章 | ${book.imported_at}`)
    }
    return
  }

  if (command === 'inspect-chapter') {
    const chapterIndex = Number(args.chapter)
    const { book, chapter } = getChapter(config, args['book-id'], chapterIndex)
    const kgCandidates = getKgCharacterCandidates(config, args['book-id'], chapterIndex)
    console.log(JSON.stringify({
      book,
      chapter: {
        id: chapter.id,
        chapterIndex: chapter.chapter_index,
        title: chapter.title,
        wordCount: chapter.word_count,
        preview: chapter.content.slice(0, 800),
      },
      kgCandidateCount: kgCandidates.length,
      kgCandidates: kgCandidates.slice(0, 12),
    }, null, 2))
    return
  }

  if (command === 'draft-script') {
    await runDraftScript(config, args)
    return
  }

  if (command === 'validate-script') {
    await runValidateScript(args)
    return
  }

  if (command === 'audit-script') {
    await runAuditScript(config, args)
    return
  }

  if (command === 'synth') {
    await runSynth(config, args)
    return
  }

  if (command === 'batch-pipeline') {
    await runBatchPipeline(config, args)
    return
  }

  throw new Error(`未知命令：${command}`)
}

main().catch(error => {
  console.error(`❌ ${error.message}`)
  process.exit(1)
})
