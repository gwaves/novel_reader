import { describe, expect, it } from 'vitest'
import { buildAudioChapterStatusRows, resolveCurrentAudio, type AudioChapter } from './App'

const cachedChapter: AudioChapter = {
  chapterId: 'chapter-46',
  fileName: 'chapter-46.mp3',
  sizeBytes: 1024,
  updatedAt: '2026-06-30T00:00:00.000Z',
}

describe('reader audio playback availability', () => {
  it('uses cached MP3 metadata when the remote audio catalog is not loaded', () => {
    expect(resolveCurrentAudio('chapter-46', [], cachedChapter)).toEqual(cachedChapter)
  })

  it('prefers the cloud catalog entry when both cloud and cached metadata exist', () => {
    const cloudChapter: AudioChapter = {
      chapterId: 'chapter-46',
      fileName: 'chapter-46-new.mp3',
      sizeBytes: 2048,
      updatedAt: '2026-06-30T01:00:00.000Z',
    }

    expect(resolveCurrentAudio('chapter-46', [cloudChapter], cachedChapter)).toEqual(cloudChapter)
  })

  it('does not use cached metadata from another chapter', () => {
    expect(resolveCurrentAudio('chapter-47', [], cachedChapter)).toBeNull()
  })

  it('builds visible MP3 cache status for every chapter', () => {
    const rows = buildAudioChapterStatusRows(
      [
        { id: 'chapter-44', title: '第四十四章' },
        { id: 'chapter-45', title: '第四十五章' },
        { id: 'chapter-46', title: '第四十六章' },
        { id: 'chapter-47', title: '第四十七章' },
      ],
      [
        { chapterId: 'chapter-44', fileName: 'chapter-44.mp3' },
        { chapterId: 'chapter-45', fileName: 'chapter-45.mp3' },
        { chapterId: 'chapter-46', fileName: 'chapter-46.mp3' },
      ],
      new Set(['chapter-44', 'chapter-46']),
      'chapter-46',
    )

    expect(rows).toEqual([
      expect.objectContaining({ chapterId: 'chapter-44', cached: true, hasAudio: true, isCurrent: false, audioChapter: expect.objectContaining({ chapterId: 'chapter-44' }) }),
      expect.objectContaining({ chapterId: 'chapter-45', cached: false, hasAudio: true, isCurrent: false, audioChapter: expect.objectContaining({ chapterId: 'chapter-45' }) }),
      expect.objectContaining({ chapterId: 'chapter-46', cached: true, hasAudio: true, isCurrent: true, audioChapter: expect.objectContaining({ chapterId: 'chapter-46' }) }),
      expect.objectContaining({ chapterId: 'chapter-47', cached: false, hasAudio: false, isCurrent: false, audioChapter: null }),
    ])
  })
})
