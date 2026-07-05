export function normalizeSummaryKeyPointSources(value, keyPoints = []) {
  const rawSources = Array.isArray(value) ? value : []
  return rawSources
    .map((source, sourceIndex) => normalizeSummaryKeyPointSource(source, keyPoints, sourceIndex))
    .filter(Boolean)
}

export function normalizeSummaryKeyPointSource(source, keyPoints = [], sourceIndex = 0) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const index = readNonNegativeInteger(source.index)
  const keyPointIndex = index ?? sourceIndex
  const text = readNonEmptyString(source.text) || readNonEmptyString(keyPoints[keyPointIndex])
  const startOffset = readNonNegativeInteger(source.startOffset)
  const endOffset = readNonNegativeInteger(source.endOffset)
  if (!text || startOffset == null || endOffset == null || endOffset <= startOffset) return null
  return {
    index: keyPointIndex,
    text,
    startOffset,
    endOffset,
    quote: readNonEmptyString(source.quote),
    confidence: readRatio(source.confidence) ?? 1,
    locator: readNonEmptyString(source.locator) || 'quote',
  }
}

export function locateSummaryKeyPointSources(chapterContent, keyPoints, hints = []) {
  const content = String(chapterContent || '')
  if (!content || !Array.isArray(keyPoints)) return []
  return keyPoints.map((point, index) => {
    const text = readNonEmptyString(point)
    if (!text) return null
    const hint = Array.isArray(hints) ? hints.find((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false
      const candidateIndex = readNonNegativeInteger(candidate.index)
      return candidateIndex === index || readNonEmptyString(candidate.text) === text
    }) : null
    const quoteCandidates = uniqueStrings([
      readNonEmptyString(hint?.quote),
      ...readStringArray(hint?.quotes),
      text,
    ])
    for (const quote of quoteCandidates) {
      const located = locateQuoteInText(content, quote)
      if (located) {
        return {
          index,
          text,
          startOffset: located.startOffset,
          endOffset: located.endOffset,
          quote: content.slice(located.startOffset, located.endOffset),
          confidence: located.confidence,
          locator: located.locator,
        }
      }
    }
    const fallback = locateKeyPointByTerms(content, text)
    if (fallback) {
      return {
        index,
        text,
        startOffset: fallback.startOffset,
        endOffset: fallback.endOffset,
        quote: content.slice(fallback.startOffset, fallback.endOffset),
        confidence: fallback.confidence,
        locator: fallback.locator,
      }
    }
    return null
  }).filter(Boolean)
}

export function locateQuoteInText(text, quote) {
  const content = String(text || '')
  const needle = readNonEmptyString(quote)
  if (!content || !needle) return null

  const directIndex = content.indexOf(needle)
  if (directIndex >= 0) {
    return {
      startOffset: directIndex,
      endOffset: directIndex + needle.length,
      confidence: 1,
      locator: 'exact',
    }
  }

  const normalized = normalizeWithMap(content)
  const normalizedNeedle = normalizeTextForLocation(needle)
  if (!normalized.normalized || !normalizedNeedle) return null
  const normalizedIndex = normalized.normalized.indexOf(normalizedNeedle)
  if (normalizedIndex < 0) return null

  const startOffset = normalized.map[normalizedIndex]
  const lastNormalizedIndex = normalizedIndex + normalizedNeedle.length - 1
  const lastOriginalIndex = normalized.map[lastNormalizedIndex]
  if (startOffset == null || lastOriginalIndex == null) return null
  return {
    startOffset,
    endOffset: lastOriginalIndex + 1,
    confidence: 0.86,
    locator: 'normalized',
  }
}

export function summarizeKeyPointSourceCoverage(summaries) {
  let keyPointCount = 0
  let keyPointSourceCount = 0
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    const keyPoints = readStringArray(summary?.keyPoints)
    const sources = normalizeSummaryKeyPointSources(summary?.keyPointSources, keyPoints)
    keyPointCount += keyPoints.length
    keyPointSourceCount += sources.length
  }
  return {
    keyPointCount,
    keyPointSourceCount,
    keyPointSourceCoverage: keyPointCount > 0 ? keyPointSourceCount / keyPointCount : 1,
    unlocatedKeyPointCount: Math.max(0, keyPointCount - keyPointSourceCount),
  }
}

function locateKeyPointByTerms(content, keyPoint) {
  const terms = extractKeyPointTerms(keyPoint)
  if (terms.length === 0) return null
  const paragraphs = splitParagraphRanges(content)
  let best = null

  for (const paragraph of paragraphs) {
    const normalizedParagraph = normalizeTextForLocation(paragraph.text)
    if (!normalizedParagraph) continue
    let score = 0
    let matched = 0
    for (const term of terms) {
      if (!normalizedParagraph.includes(term.normalized)) continue
      matched += 1
      score += term.weight
    }
    if (matched === 0) continue
    const coverage = matched / terms.length
    const normalizedScore = score + coverage * 2 - Math.min(1.5, paragraph.text.length / 420)
    if (!best || normalizedScore > best.score) {
      best = { paragraph, score: normalizedScore, coverage, matched }
    }
  }

  if (!best || best.coverage < 0.05 || best.matched < 1) return null
  const quote = trimQuoteRange(best.paragraph.text)
  return {
    startOffset: best.paragraph.startOffset + quote.start,
    endOffset: best.paragraph.startOffset + quote.end,
    confidence: Math.max(0.45, Math.min(0.78, 0.42 + best.coverage * 0.4)),
    locator: 'terms',
  }
}

function extractKeyPointTerms(keyPoint) {
  const text = readNonEmptyString(keyPoint)
  if (!text) return []
  const candidates = []
  const quoted = text.match(/[「『“《](.*?)[」』”》]/gu) || []
  for (const value of quoted) candidates.push(value.slice(1, -1))
  for (const part of text.split(/[：:，,。；;、（）()\/\s]+/u)) {
    if (part.length >= 2) candidates.push(part)
    if (part.length > 6) {
      for (let index = 0; index <= part.length - 4; index += 2) {
        candidates.push(part.slice(index, index + 4))
      }
    }
  }
  const terms = []
  const seen = new Set()
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/^(关键|主要|暗示|显示|体现|任务|身份|冲突|悬念|铺垫|背景|登场|对决|危机)/u, '')
    if (cleaned.length < 2 || isGenericTerm(cleaned)) continue
    const normalized = normalizeTextForLocation(cleaned)
    if (normalized.length < 2 || seen.has(normalized)) continue
    seen.add(normalized)
    terms.push({
      text: cleaned,
      normalized,
      weight: Math.min(6, Math.max(1, normalized.length / 2)),
    })
  }
  return terms
    .sort((left, right) => right.weight - left.weight)
    .slice(0, 14)
}

function splitParagraphRanges(content) {
  const ranges = []
  const lines = String(content || '').split('\n')
  let offset = 0
  for (const line of lines) {
    const normalized = line.replace(/\r$/, '')
    const trimmed = normalized.trim()
    if (trimmed) {
      const trimStart = normalized.indexOf(trimmed)
      const startOffset = offset + Math.max(0, trimStart)
      ranges.push({
        text: trimmed,
        startOffset,
        endOffset: startOffset + trimmed.length,
      })
    }
    offset += line.length + 1
  }
  return ranges
}

function trimQuoteRange(text) {
  const value = String(text || '')
  if (value.length <= 180) return { start: 0, end: value.length }
  return { start: 0, end: 180 }
}

function isGenericTerm(value) {
  return /^(本章|人物|身份|危机|冲突|铺垫|显示|暗示|体现|事件|关键|主要|相关|不明|强敌|敌人|高手|门派|少女|少年|巨汉|怪物|任务|物品|背景)$/u.test(value)
}

function normalizeWithMap(value) {
  const map = []
  let normalized = ''
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const normalizedChar = normalizeChar(char)
    if (!normalizedChar) continue
    normalized += normalizedChar
    map.push(index)
  }
  return { normalized, map }
}

function normalizeTextForLocation(value) {
  let normalized = ''
  for (const char of String(value || '')) {
    normalized += normalizeChar(char)
  }
  return normalized
}

function normalizeChar(char) {
  if (!char || /\s/u.test(char)) return ''
  return char.normalize('NFKC').toLowerCase()
}

function readStringArray(value) {
  return Array.isArray(value) ? value.map(readNonEmptyString).filter(Boolean) : []
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map(readNonEmptyString).filter(Boolean)))
}

function readNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function readNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null
}

function readRatio(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null
}
