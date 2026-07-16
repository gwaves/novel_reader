import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseVolcengineChunkedAudio, pcmToWav, synthesizeVolcengineSegment } from '../src/tts-provider.mjs'

test('joins base64 audio from Volcengine HTTP chunks', () => {
  const raw = [
    JSON.stringify({ code: 0, data: Buffer.from([1, 2]).toString('base64') }),
    JSON.stringify({ code: 0, data: Buffer.from([3, 4]).toString('base64') }),
    JSON.stringify({ code: 0, message: 'done' }),
  ].join('\n')
  assert.deepEqual(parseVolcengineChunkedAudio(raw), Buffer.from([1, 2, 3, 4]))
})

test('wraps mono PCM in a valid WAV header', () => {
  const wav = pcmToWav(Buffer.from([0, 0, 1, 0]), { sampleRate: 24_000 })
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE')
  assert.equal(wav.readUInt32LE(24), 24_000)
  assert.equal(wav.readUInt32LE(40), 4)
  assert.deepEqual(wav.subarray(44), Buffer.from([0, 0, 1, 0]))
})

test('sends Volcengine speaker and director style and returns WAV audio', async () => {
  let request
  const result = await synthesizeVolcengineSegment({
    tts: { apiKey: 'test-key', model: 'seed-tts-2.0', sampleRate: 24_000 },
    segment: { text: '测试文本', voice: 'zh_male_m191_uranus_bigtts' },
    style: '沉稳清晰地讲述。',
    requestId: 'test-request-id',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) }
      return new Response(`${JSON.stringify({ code: 0, data: Buffer.from([0, 0]).toString('base64') })}\n`)
    },
  })

  assert.equal(request.options.headers['X-Api-Resource-Id'], 'seed-tts-2.0')
  assert.equal(request.options.headers['X-Api-Request-Id'], 'test-request-id')
  assert.equal(request.body.req_params.speaker, 'zh_male_m191_uranus_bigtts')
  assert.deepEqual(request.body.req_params.context_texts, ['沉稳清晰地讲述。'])
  assert.equal(request.body.req_params.audio_params.format, 'pcm')
  assert.equal(result.audio.subarray(0, 4).toString(), 'RIFF')
})

test('reports Volcengine application errors without audio', () => {
  assert.throws(
    () => parseVolcengineChunkedAudio(JSON.stringify({ code: 45000010, message: 'Invalid X-Api-Key' })),
    /Invalid X-Api-Key/,
  )
})
