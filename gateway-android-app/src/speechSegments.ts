export type SpeechSegment = {
  id: string
  bookId: string
  chapterId: string
  chapterIndex: number
  paragraphIndex: number
  sentenceIndex: number
  text: string
  startChar: number
  endChar: number
}

export type SpeechParagraph = {
  paragraphIndex: number
  segments: SpeechSegment[]
}

export type SpeechChapter = {
  paragraphs: SpeechParagraph[]
  segments: SpeechSegment[]
}

export type SegmentableChapter = {
  id: string
  bookId: string
  index: number
  content: string
}

const MIN_SEGMENT_LENGTH = 40
const MAX_SEGMENT_LENGTH = 300
const HARD_CHUNK_LENGTH = 220

function splitLongFragment(fragment: string): string[] {
  const chunks: string[] = []
  let cursor = 0
  while (cursor < fragment.length) {
    chunks.push(fragment.slice(cursor, cursor + HARD_CHUNK_LENGTH).trim())
    cursor += HARD_CHUNK_LENGTH
  }
  return chunks.filter(Boolean)
}

function splitParagraph(paragraph: string): string[] {
  const normalized = paragraph.replace(/\s+/g, ' ').trim()
  if (!normalized) return []

  const fragments = normalized
    .match(/[^。！？；.!?;]+[。！？；.!?;”’」』）】》]*|.+$/g)
    ?.map((fragment) => fragment.trim())
    .filter(Boolean) ?? [normalized]

  const merged: string[] = []
  for (const fragment of fragments) {
    const pieces = fragment.length > MAX_SEGMENT_LENGTH ? splitLongFragment(fragment) : [fragment]
    for (const piece of pieces) {
      const previousIndex = merged.length - 1
      if (previousIndex >= 0 && merged[previousIndex].length < MIN_SEGMENT_LENGTH) {
        merged[previousIndex] = `${merged[previousIndex]}${piece}`
      } else {
        merged.push(piece)
      }
    }
  }

  return merged.flatMap((segment) => (segment.length > MAX_SEGMENT_LENGTH ? splitLongFragment(segment) : [segment]))
}

export function createSpeechChapter(chapter: SegmentableChapter): SpeechChapter {
  const paragraphs = chapter.content
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  const speechParagraphs: SpeechParagraph[] = []
  const allSegments: SpeechSegment[] = []
  let cursor = 0

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const texts = splitParagraph(paragraph)
    const segments = texts.map((text, sentenceIndex) => {
      const sourceIndex = chapter.content.indexOf(text, cursor)
      const startChar = sourceIndex >= 0 ? sourceIndex : cursor
      const endChar = startChar + text.length
      cursor = endChar
      return {
        id: `${chapter.id}-p${paragraphIndex}-s${sentenceIndex}`,
        bookId: chapter.bookId,
        chapterId: chapter.id,
        chapterIndex: chapter.index,
        paragraphIndex,
        sentenceIndex,
        text,
        startChar,
        endChar,
      }
    })

    if (segments.length) {
      speechParagraphs.push({ paragraphIndex, segments })
      allSegments.push(...segments)
    }
  })

  return { paragraphs: speechParagraphs, segments: allSegments }
}

