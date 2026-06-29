import { describe, expect, it } from 'vitest'
import { bookCachedAudioCount, mergeLocalBooksWithCloudMetadata } from './App'

const updatedAt = '2026-06-29T00:00:00.000Z'

describe('library audio counts', () => {
  it('keeps local cached counts separate from cloud audio totals for each book', () => {
    const merged = mergeLocalBooksWithCloudMetadata(
      [
        {
          id: 'sanguo',
          title: '三国演义',
          chapterCount: 120,
          audioChapterCount: 20,
          updatedAt,
        },
        {
          id: 'yaodao',
          title: '妖刀记',
          chapterCount: 293,
          audioChapterCount: 27,
          updatedAt,
        },
      ],
      [
        {
          id: 'sanguo',
          title: '三国演义',
          chapterCount: 120,
          audioChapterCount: 120,
          updatedAt,
        },
        {
          id: 'yaodao',
          title: '妖刀记',
          chapterCount: 293,
          audioChapterCount: 293,
          updatedAt,
        },
      ],
    )

    expect(merged.find((book) => book.id === 'sanguo')).toMatchObject({
      audioChapterCount: 120,
      localAudioChapterCount: 20,
    })
    expect(merged.find((book) => book.id === 'yaodao')).toMatchObject({
      audioChapterCount: 293,
      localAudioChapterCount: 27,
    })
    expect(bookCachedAudioCount(merged.find((book) => book.id === 'sanguo'))).toBe(20)
    expect(bookCachedAudioCount(merged.find((book) => book.id === 'yaodao'))).toBe(27)
  })
})
