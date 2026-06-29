import type { FastifyRequest } from 'fastify'
import type { GatewayConfig } from './config.js'
import { GatewayHttpError } from './errors.js'

export type GatewayAuthContext = {
  mode: 'development-static-token'
  deviceId?: string
  deviceName?: string
  deviceModel?: string
  devicePlatform?: string
  appVersion?: string
}

export function requireGatewayAuth(config: GatewayConfig, request: FastifyRequest): GatewayAuthContext {
  if (!config.auth.devAccessToken) {
    throw new GatewayHttpError(
      503,
      'auth_not_configured',
      'Gateway authentication is not configured. Set GATEWAY_DEV_ACCESS_TOKEN for protected routes.',
    )
  }

  const token = parseBearerToken(request.headers.authorization)
  if (!token) {
    throw new GatewayHttpError(401, 'missing_authorization', 'Missing bearer token.')
  }

  if (token !== config.auth.devAccessToken) {
    throw new GatewayHttpError(401, 'invalid_token', 'Bearer token is invalid.')
  }

  return {
    mode: 'development-static-token',
    deviceId: parseHeaderValue(request.headers['x-device-id'], 120),
    deviceName: parseHeaderValue(request.headers['x-device-name'], 80),
    deviceModel: parseHeaderValue(request.headers['x-device-model'], 120),
    devicePlatform: parseHeaderValue(request.headers['x-device-platform'], 40),
    appVersion: parseHeaderValue(request.headers['x-app-version'], 40),
  }
}

function parseBearerToken(authorization: string | undefined) {
  if (!authorization) return null

  const [scheme, token, extra] = authorization.trim().split(/\s+/)
  if (extra || scheme?.toLowerCase() !== 'bearer' || !token) {
    return null
  }

  return token
}

function parseHeaderValue(value: string | string[] | undefined, maxLength: number) {
  const rawValue = Array.isArray(value) ? value[0] : value
  const normalized = rawValue?.trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}
