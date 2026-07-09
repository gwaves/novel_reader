import { describe, expect, it } from 'vitest'
import { formatLocalBookMeta } from './App'
import { bookCachedAudioCount, mergeLocalBooksWithCloudMetadata } from './libraryState'

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
        {
          id: 'old-xunqinji',
          title: '寻秦记',
          chapterCount: 291,
          audioChapterCount: 0,
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
        {
          id: 'daf59e90-2ca0-461b-85c3-95acb1ecf700',
          title: '寻秦记',
          chapterCount: 291,
          audioChapterCount: 291,
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
    expect(merged.find((book) => book.id === 'old-xunqinji')).toMatchObject({
      id: 'old-xunqinji',
      title: '寻秦记',
      audioChapterCount: 291,
      localAudioChapterCount: 0,
    })
    expect(bookCachedAudioCount(merged.find((book) => book.id === 'sanguo'))).toBe(20)
    expect(bookCachedAudioCount(merged.find((book) => book.id === 'yaodao'))).toBe(27)
  })

  it('labels local cached audio counts separately from cloud cacheable counts', () => {
    expect(
      formatLocalBookMeta({
        id: 'sanguo',
        title: '三国演义',
        chapterCount: 120,
        audioChapterCount: 120,
        localAudioChapterCount: 4,
        updatedAt,
      }),
    ).toBe('120 章 · 4 已缓存音频')

    expect(
      formatLocalBookMeta({
        id: 'jinlin',
        title: '金麟外传',
        chapterCount: 231,
        audioChapterCount: 50,
        localAudioChapterCount: 0,
        updatedAt,
      }),
    ).toBe('231 章 · 50 可缓存音频')
  })
})
