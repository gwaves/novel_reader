import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChunkEmbeddingId,
  buildSummaryText,
  isRetryableEmbeddingError,
  l2Normalize,
  normalizeChunkText,
  retryEmbeddingRequest,
  splitChapterIntoChunks,
} from '../src/embedding-utils.mjs'

describe('embedding utils', () => {
  it('normalizes whitespace for chunk text', () => {
    assert.equal(normalizeChunkText('  第一段\r\n\r\n\r\n第二段\t  继续  '), '第一段\n\n第二段 继续')
  })

  it('splits Chinese chapter text with overlap', () => {
    const content = [
      '第一段' + '甲'.repeat(35),
      '第二段' + '乙'.repeat(35),
      '第三段' + '丙'.repeat(35),
    ].join('\n\n')

    const chunks = splitChapterIntoChunks(
      {
        id: 'chapter-1',
        bookId: 'book-1',
        chapterIndex: 1,
        content,
      },
      { targetChars: 50, overlapChars: 10 },
    )

    assert.equal(chunks.length, 3)
    assert.equal(chunks[0].id, 'chapter-1:chunk:0')
    assert.equal(chunks[0].chapterId, 'chapter-1')
    assert.equal(chunks[0].chapterIndex, 1)
    assert.equal(chunks[1].chunkIndex, 1)
    assert.equal(chunks[0].text.slice(-10), chunks[1].text.slice(0, 10))
    assert.equal(chunks[1].text.slice(-10), chunks[2].text.slice(0, 10))
    assert.ok(chunks[1].startOffset < chunks[0].endOffset)
  })

  it('builds chunk embedding ids that vary by model', () => {
    const bgeId = buildChunkEmbeddingId('chapter-1:chunk:0', 'bge-m3')
    const otherId = buildChunkEmbeddingId('chapter-1:chunk:0', 'other-model')

    assert.match(bgeId, /^chapter-1:chunk:0:model:[0-9a-f]{12}$/)
    assert.notEqual(bgeId, otherId)
    assert.equal(buildChunkEmbeddingId('chapter-1:chunk:0', 'bge-m3'), bgeId)
  })

  it('L2 normalizes vectors and keeps zero vectors unchanged', () => {
    assert.deepEqual(l2Normalize([3, 4]), [0.6, 0.8])
    assert.deepEqual(l2Normalize([0, 0]), [0, 0])
    assert.deepEqual(l2Normalize([]), [])
  })

  it('builds summary embedding text from camel and snake case key points', () => {
    assert.equal(
      buildSummaryText({
        short: '短摘要',
        detail: '详细摘要',
        keyPointsJson: JSON.stringify(['要点一', '要点二']),
      }),
      '短摘要 详细摘要 要点一 要点二',
    )
    assert.equal(
      buildSummaryText({
        short: '短摘要',
        key_points_json: JSON.stringify(['蛇形要点']),
      }),
      '短摘要 蛇形要点',
    )
  })

  it('detects retryable embedding failures', () => {
    assert.equal(isRetryableEmbeddingError({ status: 502 }), true)
    assert.equal(isRetryableEmbeddingError({ statusCode: 429 }), true)
    assert.equal(isRetryableEmbeddingError(Object.assign(new Error('Bad Gateway'), { status: 502 })), true)
    assert.equal(isRetryableEmbeddingError(Object.assign(new Error('aborted'), { name: 'AbortError' })), true)
    assert.equal(isRetryableEmbeddingError(new Error('connect ECONNRESET')), true)
    assert.equal(isRetryableEmbeddingError(new Error('request timeout')), true)
    assert.equal(isRetryableEmbeddingError({ status: 404 }), false)
    assert.equal(isRetryableEmbeddingError(new Error('invalid api key')), false)
  })

  it('retries transient failures with a pluggable delay', async () => {
    const attempts = []
    const result = await retryEmbeddingRequest(
      async (attempt) => {
        attempts.push(attempt)
        if (attempt < 3) {
          throw Object.assign(new Error('502 Bad Gateway'), { status: 502 })
        }
        return 'ok'
      },
      { delay: () => 0 },
    )

    assert.equal(result, 'ok')
    assert.deepEqual(attempts, [1, 2, 3])
  })
})
