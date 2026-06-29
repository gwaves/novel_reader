import {
  deviceRoleLabel,
  errorMessage,
  isDeviceAccessBlockedError,
  type GatewaySession,
} from './deviceIdentity'

export type BookSummary = {
  id: string
  title: string
  author?: string
  chapterCount: number
  wordCount?: number
  summaryCoverage?: number
  kgCoverage?: number
  embeddingCoverage?: number
  audioChapterCount?: number
  localAudioChapterCount?: number
  updatedAt: string
}

export type GatewayLibrarySyncState =
  | { status: 'never' }
  | { status: 'syncing' }
  | { status: 'synced'; at: string; bookCount: number }
  | { status: 'blocked'; message: string }
  | { status: 'error'; message: string }

export function mergeLocalBooksWithCloudMetadata(localBooks: BookSummary[], cloudBooks: BookSummary[]) {
  return localBooks.map((localBook) => {
    const cloudBook = cloudBooks.find((book) => book.id === localBook.id)
    const localAudioChapterCount = bookCachedAudioCount(localBook)
    if (!cloudBook) {
      return {
        ...localBook,
        localAudioChapterCount,
      }
    }
    return {
      ...localBook,
      title: cloudBook.title || localBook.title,
      author: cloudBook.author || localBook.author,
      chapterCount: cloudBook.chapterCount || localBook.chapterCount,
      wordCount: cloudBook.wordCount ?? localBook.wordCount,
      summaryCoverage: cloudBook.summaryCoverage ?? localBook.summaryCoverage,
      kgCoverage: cloudBook.kgCoverage ?? localBook.kgCoverage,
      embeddingCoverage: cloudBook.embeddingCoverage ?? localBook.embeddingCoverage,
      audioChapterCount: cloudBook.audioChapterCount ?? localBook.audioChapterCount,
      localAudioChapterCount,
      updatedAt: cloudBook.updatedAt || localBook.updatedAt,
    }
  })
}

export function bookCachedAudioCount(book: Pick<BookSummary, 'audioChapterCount' | 'localAudioChapterCount'> | null | undefined) {
  return book?.localAudioChapterCount ?? book?.audioChapterCount ?? 0
}

export function libraryVisibilityNotice(session: GatewaySession | null, bookCount: number) {
  if (!session) return '刷新授权状态后会显示当前设备可见范围。'
  if (session.auth.role === 'disabled') return '设备已禁用，本地缓存仍可读，云端同步已禁用。请在管理后台启用后再刷新授权状态。'
  if (session.auth.role === 'trusted') {
    return `受信设备可看到默认书库和受信书库，当前云端可见 ${bookCount} 本。`
  }
  if (bookCount === 0) return '普通设备仅默认书库；如果后台只有受信书，当前设备不会显示为服务器没数据。'
  return `普通设备仅显示默认书库，当前云端可见 ${bookCount} 本；后台可将设备设为受信后显示更多书。`
}

export function gatewaySyncBlockedReason(session: GatewaySession | null) {
  if (session?.auth.role === 'disabled') return '设备已禁用，本地缓存仍可读，云端同步已禁用。'
  return null
}

export function cloudActionBlockedReason(session: GatewaySession | null, action: string) {
  if (session?.auth.role === 'disabled') return `设备已禁用，不能${action}。本地缓存仍可读，云端同步已禁用。`
  return null
}

export function localCacheReadableWhenDisabled(session: GatewaySession | null, hasLocalCache: boolean) {
  return session?.auth.role !== 'disabled' || hasLocalCache
}

export function roleChangeNotice(previousSession: GatewaySession | null, nextSession: GatewaySession | null, previousBookCount: number, nextBookCount: number) {
  const previousRole = previousSession?.auth.role
  const nextRole = nextSession?.auth.role
  if (!previousRole || !nextRole || previousRole === nextRole) return null
  if (previousRole === 'default' && nextRole === 'trusted') {
    const countPhrase =
      nextBookCount > previousBookCount
        ? `，可见书从 ${previousBookCount} 本增加到 ${nextBookCount} 本`
        : `，当前云端可见 ${nextBookCount} 本`
    return `授权已更新：受信设备可看到默认书库和受信书库${countPhrase}。`
  }
  if (nextRole === 'disabled') {
    return '授权已更新：设备已禁用。本地缓存仍可读，云端同步已禁用。'
  }
  return `授权已更新：当前角色为${deviceRoleLabel(nextRole)}。`
}

export function blockedGatewaySyncMessage(error: unknown) {
  if (isDeviceAccessBlockedError(error)) return errorMessage(error)
  return null
}

export function syncStatusLabel(syncState: GatewayLibrarySyncState) {
  if (syncState.status === 'syncing') return '正在同步'
  if (syncState.status === 'synced') return `${formatDate(syncState.at)}，云端可见 ${syncState.bookCount} 本`
  if (syncState.status === 'blocked') return `同步被阻止：${syncState.message}`
  if (syncState.status === 'error') return `同步失败：${syncState.message}`
  return '尚未同步'
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}
