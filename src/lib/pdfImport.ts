type PdfTextItem = {
  str: string
  hasEOL?: boolean
  transform?: number[]
}

export type PdfExtractedSection = { title: string; content: string }
export type PdfExtraction = { text: string; title?: string; sections: PdfExtractedSection[] }
type PdfOutlineItem = { title: string; dest: unknown; items?: PdfOutlineItem[] }
type PdfDestinationRef = { num: number; gen: number }

export async function extractPdfDocument(buffer: ArrayBuffer): Promise<PdfExtraction> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (typeof window !== 'undefined') {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString()
  }
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true })

  try {
    const document = await loadingTask.promise
    const pages: string[] = []

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      pages.push(renderPdfTextItems(content.items as PdfTextItem[]))
      page.cleanup()
    }

    const text = pages.filter(Boolean).join('\n\n').trim()
    if (!text) {
      throw new Error('PDF 中没有可提取的文字；如果这是扫描件，请先进行 OCR 后再导入。')
    }
    const metadata = await document.getMetadata().catch(() => null)
    const outline = await document.getOutline().catch(() => null) as PdfOutlineItem[] | null
    const sections = await buildOutlineSections(document, outline, pages)
    const metadataTitle = metadata?.info && 'Title' in metadata.info ? String(metadata.info.Title || '').trim() : ''
    return { text, title: metadataTitle || undefined, sections }
  } finally {
    await loadingTask.destroy()
  }
}

async function buildOutlineSections(
  document: { getDestination: (name: string) => Promise<unknown>; getPageIndex: (ref: PdfDestinationRef) => Promise<number> },
  outline: PdfOutlineItem[] | null,
  pages: string[],
): Promise<PdfExtractedSection[]> {
  const flattened = flattenOutline(outline ?? [])
  const starts = (await Promise.all(flattened.map(async (item) => {
    const destination = typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest
    if (!Array.isArray(destination) || !destination[0]) return null
    const pageIndex = await document.getPageIndex(destination[0] as PdfDestinationRef).catch(() => -1)
    return pageIndex >= 0 ? { title: item.title.trim(), pageIndex } : null
  }))).filter((item): item is { title: string; pageIndex: number } => Boolean(item?.title))

  if (starts.length < 2) return []
  starts.sort((a, b) => a.pageIndex - b.pageIndex)
  return starts.map((start, index) => {
    const endPage = starts[index + 1]?.pageIndex ?? pages.length
    const content = pages.slice(start.pageIndex, Math.max(start.pageIndex + 1, endPage)).join('\n\n').trim()
    return { title: start.title, content: stripRepeatedTitle(content, start.title) }
  }).filter((section) => section.content.replace(/\s+/g, '').length >= 20)
}

function flattenOutline(items: PdfOutlineItem[]): PdfOutlineItem[] {
  return items.flatMap((item) => [item, ...flattenOutline(item.items ?? [])])
}

function stripRepeatedTitle(content: string, title: string): string {
  const lines = content.split('\n')
  const normalizedTitle = title.replace(/\s+/g, '')
  const matchIndex = lines.slice(0, 6).findIndex((line) => line.replace(/\s+/g, '').includes(normalizedTitle))
  if (matchIndex >= 0) lines.splice(matchIndex, 1)
  return lines.join('\n').trim()
}

function renderPdfTextItems(items: PdfTextItem[]): string {
  const lines: string[] = []
  let currentLine = ''
  let previousY: number | null = null

  const flushLine = () => {
    const line = currentLine.trim()
    if (line) lines.push(line)
    currentLine = ''
  }

  for (const item of items) {
    if (!item.str) continue
    const y = item.transform?.[5]
    if (previousY !== null && typeof y === 'number' && Math.abs(y - previousY) > 2) flushLine()
    currentLine += item.str
    if (item.hasEOL) flushLine()
    if (typeof y === 'number') previousY = y
  }
  flushLine()

  return lines.join('\n')
}
