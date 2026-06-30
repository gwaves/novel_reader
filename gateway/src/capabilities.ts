export function buildCapabilities() {
  return {
    service: 'novel-reader-gateway',
    version: '0.1.0',
    auth: {
      requiredByDefault: true,
    },
    features: {
      books: {
        available: true,
      },
      progress: {
        available: false,
        reason: 'reading progress API is planned for Phase 3',
      },
      audio: {
        available: true,
        mode: 'local-directory',
      },
    },
  }
}
