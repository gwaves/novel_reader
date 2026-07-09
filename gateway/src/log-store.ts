import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { GatewayConfig } from './config.js'

export const structuredLogKinds = ['requests', 'mobile'] as const

export type StructuredLogKind = (typeof structuredLogKinds)[number]

export type StructuredLogRecord = Record<string, unknown> & {
  schemaVersion: 1
  kind: string
  receivedAt: string
}

export type StructuredLogFileSummary = {
  kind: StructuredLogKind
  date: string
  fileName: string
  relativePath: string
  sizeBytes: number
}

type ReadStructuredLogOptions = {
  kinds?: StructuredLogKind[]
  since?: Date
  maxRecords?: number
}

const dayMs = 24 * 60 * 60 * 1000

export async function appendStructuredLogRecords(
  config: GatewayConfig,
  kind: StructuredLogKind,
  records: StructuredLogRecord[],
) {
  if (records.length === 0) return
  const now = new Date()
  await pruneOldStructuredLogs(config, kind, now)

  for (const record of records) {
    const receivedAt = normalizeIsoDate(record.receivedAt) ?? now.toISOString()
    const date = receivedAt.slice(0, 10)
    const line = `${JSON.stringify({ ...record, receivedAt })}\n`
    const filePath = await chooseStructuredLogFile(config, kind, date, Buffer.byteLength(line, 'utf8'))
    await appendFile(filePath, line, 'utf8')
  }
}

export async function readStructuredLogRecords(
  config: GatewayConfig,
  options: ReadStructuredLogOptions = {},
): Promise<StructuredLogRecord[]> {
  const files = await listStructuredLogFiles(config, options.kinds)
  const sinceTime = options.since?.getTime()
  const records: StructuredLogRecord[] = []

  for (const file of files) {
    if (sinceTime !== undefined && Date.parse(file.date) + dayMs < sinceTime) continue
    const content = await readFile(join(config.logs.dir, file.relativePath), 'utf8').catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return ''
      throw error
    })
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      const record = parseStructuredLogRecord(line)
      if (!record) continue
      const receivedTime = Date.parse(record.receivedAt)
      if (sinceTime !== undefined && (Number.isNaN(receivedTime) || receivedTime < sinceTime)) continue
      records.push(record)
    }
  }

  records.sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
  return typeof options.maxRecords === 'number' ? records.slice(0, options.maxRecords) : records
}

export async function listStructuredLogFiles(config: GatewayConfig, kinds: StructuredLogKind[] = [...structuredLogKinds]) {
  const summaries: StructuredLogFileSummary[] = []
  for (const kind of kinds) {
    const kindDir = join(config.logs.dir, kind)
    const dateDirs = await readdir(kindDir, { withFileTypes: true }).catch((error: unknown) => {
      if (isNodeError(error) && error.code === 'ENOENT') return []
      throw error
    })
    for (const dateDir of dateDirs) {
      if (!dateDir.isDirectory() || !isLogDate(dateDir.name)) continue
      const date = dateDir.name
      const dirPath = join(kindDir, date)
      const entries = await readdir(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !isStructuredLogFileName(kind, date, entry.name)) continue
        const filePath = join(dirPath, entry.name)
        const fileStat = await stat(filePath)
        summaries.push({
          kind,
          date,
          fileName: entry.name,
          relativePath: relative(config.logs.dir, filePath),
          sizeBytes: fileStat.size,
        })
      }
    }
  }
  return summaries.sort((left, right) => {
    const dateOrder = left.date.localeCompare(right.date)
    if (dateOrder !== 0) return dateOrder
    const kindOrder = left.kind.localeCompare(right.kind)
    if (kindOrder !== 0) return kindOrder
    return left.fileName.localeCompare(right.fileName)
  })
}

async function chooseStructuredLogFile(config: GatewayConfig, kind: StructuredLogKind, date: string, incomingBytes: number) {
  const dirPath = join(config.logs.dir, kind, date)
  await mkdir(dirPath, { recursive: true })
  const entries = await readdir(dirPath, { withFileTypes: true })
  const indexes = entries
    .filter((entry) => entry.isFile() && isStructuredLogFileName(kind, date, entry.name))
    .map((entry) => Number(entry.name.match(/-(\d{3})\.jsonl$/)?.[1] ?? 0))
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((left, right) => left - right)
  const latestIndex = indexes.at(-1) ?? 0
  const latestPath = logFilePath(dirPath, kind, date, latestIndex)
  const latestSize = await stat(latestPath).then((entry) => entry.size).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return 0
    throw error
  })

  const shouldRotate = latestSize > 0 && latestSize + incomingBytes > config.logs.rotateBytes
  return shouldRotate ? logFilePath(dirPath, kind, date, latestIndex + 1) : latestPath
}

async function pruneOldStructuredLogs(config: GatewayConfig, kind: StructuredLogKind, now: Date) {
  const cutoff = new Date(now.getTime() - config.logs.retentionDays * dayMs).toISOString().slice(0, 10)
  const kindDir = join(config.logs.dir, kind)
  const dateDirs = await readdir(kindDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  })
  await Promise.all(
    dateDirs
      .filter((entry) => entry.isDirectory() && isLogDate(entry.name) && entry.name < cutoff)
      .map((entry) => rm(join(kindDir, entry.name), { recursive: true, force: true })),
  )
}

function parseStructuredLogRecord(line: string): StructuredLogRecord | null {
  try {
    const value = JSON.parse(line) as unknown
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== 'string' || typeof value.receivedAt !== 'string') {
      return null
    }
    return value as StructuredLogRecord
  } catch {
    return null
  }
}

function logFilePath(dirPath: string, kind: StructuredLogKind, date: string, index: number) {
  return join(dirPath, `${kind}-${date}-${String(index).padStart(3, '0')}.jsonl`)
}

function isStructuredLogFileName(kind: StructuredLogKind, date: string, fileName: string) {
  return new RegExp(`^${kind}-${date}-\\d{3}\\.jsonl$`).test(fileName)
}

function isLogDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function normalizeIsoDate(value: unknown) {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
