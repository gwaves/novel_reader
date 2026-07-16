import { randomUUID } from 'node:crypto'

const VOLCENGINE_TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'

export async function synthesizeVolcengineSegment({ tts, segment, style, fetchImpl = fetch, requestId = randomUUID() }) {
  const apiKey = resolveApiKey(tts)
  if (!apiKey) {
    throw new Error(`缺少火山引擎 TTS API key。请在配置文件 tts.apiKey 中填写，或设置环境变量 ${tts.apiKeyEnv}。`)
  }

  const sampleRate = positiveInteger(tts.sampleRate, 24_000)
  const startedAt = Date.now()
  const response = await fetchImpl(tts.baseUrl || VOLCENGINE_TTS_URL, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': tts.resourceId || tts.model || 'seed-tts-2.0',
      'X-Api-Request-Id': requestId,
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
    },
    body: JSON.stringify({
      req_params: {
        text: segment.text,
        speaker: segment.voice,
        audio_params: {
          format: 'pcm',
          sample_rate: sampleRate,
          speech_rate: finiteInteger(tts.speechRate, 0),
          loudness_rate: finiteInteger(tts.loudnessRate, 0),
        },
        additions: JSON.stringify({
          disable_markdown_filter: true,
          disable_emoji_filter: true,
          explicit_language: 'zh-cn',
        }),
        ...(style ? { context_texts: [style] } : {}),
      },
    }),
  })
  const requestMs = Date.now() - startedAt
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`火山引擎 TTS 返回 ${response.status}：${raw.slice(0, 1000)}`)
  }

  const pcm = parseVolcengineChunkedAudio(raw)
  return {
    audio: pcmToWav(pcm, { sampleRate }),
    requestMs,
    responseBytes: Buffer.byteLength(raw),
  }
}

export function parseVolcengineChunkedAudio(raw) {
  const chunks = parseJsonChunks(raw)
  const audio = []
  let lastError = ''
  for (const chunk of chunks) {
    if (typeof chunk?.data === 'string' && chunk.data) {
      audio.push(Buffer.from(chunk.data, 'base64'))
    }
    if (chunk?.message && !chunk?.data) lastError = String(chunk.message)
  }
  if (!audio.length) {
    throw new Error(`火山引擎 TTS 响应缺少音频数据${lastError ? `：${lastError}` : ''}。`)
  }
  return Buffer.concat(audio)
}

export function pcmToWav(pcm, { sampleRate = 24_000, channels = 1, bitsPerSample = 16 } = {}) {
  const payload = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm)
  const header = Buffer.alloc(44)
  const byteRate = sampleRate * channels * bitsPerSample / 8
  const blockAlign = channels * bitsPerSample / 8
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + payload.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(payload.length, 40)
  return Buffer.concat([header, payload])
}

function parseJsonChunks(raw) {
  const lines = String(raw || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (!lines.length) return []
  try {
    return lines.map(line => JSON.parse(line))
  } catch (error) {
    try {
      return [JSON.parse(String(raw))]
    } catch {
      throw new Error(`火山引擎 TTS 返回了无法解析的分块响应：${error.message}`)
    }
  }
}

function resolveApiKey(tts) {
  if (typeof tts.apiKey === 'string' && tts.apiKey.trim()) return tts.apiKey.trim()
  if (typeof tts.apiKeyEnv === 'string' && tts.apiKeyEnv.trim()) {
    return String(process.env[tts.apiKeyEnv.trim()] || '').trim()
  }
  return ''
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function finiteInteger(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : fallback
}
