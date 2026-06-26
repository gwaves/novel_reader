import type { GatewayConfig } from './config.js'
import { GatewayHttpError } from './errors.js'

export async function forwardChatCompletion(config: GatewayConfig, body: unknown) {
  const upstream = config.upstreams.ai
  if (!upstream.baseUrl || !upstream.apiKey) {
    throw new GatewayHttpError(503, 'ai_not_configured', 'OpenAI chat upstream is not configured.')
  }
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    throw new GatewayHttpError(400, 'invalid_ai_request', 'Chat request must include messages.')
  }

  return postOpenAiJson({
    baseUrl: upstream.baseUrl,
    apiKey: upstream.apiKey,
    path: '/chat/completions',
    body: withDefaultModel(body, upstream.model),
    timeoutMs: config.upstreamTimeoutMs,
    errorCode: 'ai_upstream_error',
  })
}

export async function forwardEmbeddings(config: GatewayConfig, body: unknown) {
  const upstream = config.upstreams.embeddings
  if (!upstream.baseUrl || !upstream.apiKey) {
    throw new GatewayHttpError(503, 'embeddings_not_configured', 'OpenAI embedding upstream is not configured.')
  }
  if (!isRecord(body) || body.input === undefined) {
    throw new GatewayHttpError(400, 'invalid_embedding_request', 'Embedding request must include input.')
  }

  return postOpenAiJson({
    baseUrl: upstream.baseUrl,
    apiKey: upstream.apiKey,
    path: '/embeddings',
    body: withDefaultModel(body, upstream.model),
    timeoutMs: config.upstreamTimeoutMs,
    errorCode: 'embedding_upstream_error',
  })
}

async function postOpenAiJson({
  baseUrl,
  apiKey,
  path,
  body,
  timeoutMs,
  errorCode,
}: {
  baseUrl: string
  apiKey: string
  path: string
  body: Record<string, unknown>
  timeoutMs: number
  errorCode: string
}) {
  const response = await fetch(joinUrl(baseUrl, path), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const responseBody = await readResponseBody(response)
  if (!response.ok) {
    throw new GatewayHttpError(502, errorCode, `OpenAI-compatible upstream returned HTTP ${response.status}.`)
  }
  return responseBody
}

function withDefaultModel(body: Record<string, unknown>, model: string | undefined) {
  if (!model || body.model) return body
  return {
    ...body,
    model,
  }
}

async function readResponseBody(response: Response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new GatewayHttpError(502, 'openai_upstream_invalid_json', 'OpenAI-compatible upstream returned invalid JSON.')
  }
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
