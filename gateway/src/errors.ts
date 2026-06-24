export class GatewayHttpError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'GatewayHttpError'
    this.code = code
    this.statusCode = statusCode
  }
}

export function isGatewayHttpError(error: unknown): error is GatewayHttpError {
  return error instanceof GatewayHttpError
}
