import type { FastifyRequest } from 'fastify'
import type { GatewayConfig } from './config.js'
import { GatewayHttpError } from './errors.js'

export type GatewayAuthContext = {
  mode: 'development-static-token'
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
