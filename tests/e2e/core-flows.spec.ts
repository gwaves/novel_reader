import { expect, test, type Page } from '@playwright/test'

const sampleNovel = `
第一章 初入江湖
少年林青第一次离开山村，遇见了神秘的白衣客。

第二章 雨夜传书
白衣客留下密信，林青决定前往青州。

第三章 青州旧友
林青在城中遇见旧友阿梨，二人发现密信另有玄机。
`

type ZipSourceEntry = {
  path: string
  content: string
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  crcTable[index] = value >>> 0
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function uint16(value: number) {
  return [value & 0xff, (value >>> 8) & 0xff]
}

function uint32(value: number) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]
}

function makeStoredZip(entries: ZipSourceEntry[]) {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const centralDirectory: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path)
    const data = encoder.encode(entry.content)
    const checksum = crc32(data)
    const localHeader = new Uint8Array([
      ...uint32(0x04034b50),
      ...uint16(20),
      ...uint16(0x0800),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(checksum),
      ...uint32(data.byteLength),
      ...uint32(data.byteLength),
      ...uint16(nameBytes.byteLength),
      ...uint16(0),
      ...nameBytes,
    ])

    chunks.push(localHeader, data)
    centralDirectory.push(
      new Uint8Array([
        ...uint32(0x02014b50),
        ...uint16(20),
        ...uint16(20),
        ...uint16(0x0800),
        ...uint16(0),
        ...uint16(0),
        ...uint16(0),
        ...uint32(checksum),
        ...uint32(data.byteLength),
        ...uint32(data.byteLength),
        ...uint16(nameBytes.byteLength),
        ...uint16(0),
        ...uint16(0),
        ...uint16(0),
        ...uint16(0),
        ...uint32(0),
        ...uint32(offset),
        ...nameBytes,
      ]),
    )
    offset += localHeader.byteLength + data.byteLength
  }

  const centralDirectoryOffset = offset
  const centralDirectorySize = centralDirectory.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const endOfCentralDirectory = new Uint8Array([
    ...uint32(0x06054b50),
    ...uint16(0),
    ...uint16(0),
    ...uint16(entries.length),
    ...uint16(entries.length),
    ...uint32(centralDirectorySize),
    ...uint32(centralDirectoryOffset),
    ...uint16(0),
  ])
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) + centralDirectorySize + endOfCentralDirectory.byteLength
  const zip = new Uint8Array(size)
  let cursor = 0

  for (const chunk of [...chunks, ...centralDirectory, endOfCentralDirectory]) {
    zip.set(chunk, cursor)
    cursor += chunk.byteLength
  }

  return zip
}

function makeSpineOrderEpub() {
  return makeStoredZip([
    {
      path: 'mimetype',
      content: 'application/epub+zip',
    },
    {
      path: 'META-INF/container.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    },
    {
      path: 'OEBPS/content.opf',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>spine-order-sample</dc:title>
  </metadata>
  <manifest>
    <item id="chapter-one" href="chapter-01.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-three" href="chapter-03.xhtml" media-type="application/xhtml+xml"/>
    <item id="chapter-two" href="chapter-02.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter-two"/>
    <itemref idref="chapter-one"/>
    <itemref idref="chapter-three"/>
  </spine>
</package>`,
    },
    {
      path: 'OEBPS/chapter-01.xhtml',
      content: '<html><body><h1>第一章 后到章节</h1><p>第一章正文应当排在第二位。</p></body></html>',
    },
    {
      path: 'OEBPS/chapter-02.xhtml',
      content: '<html><body><h1>第二章 先行章节</h1><p>第二章正文应当按 spine 排在第一位。</p></body></html>',
    },
    {
      path: 'OEBPS/chapter-03.xhtml',
      content: '<html><body><h1>第三章 终章线索</h1><p>第三章正文应当排在最后。</p></body></html>',
    },
  ])
}

async function mockLocalServices(page: Page) {
  let storedState: unknown = null

  await page.route('**/api/state**', async (route) => {
    if (route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON() as { state?: unknown }
      storedState = payload.state ?? null
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ state: storedState }),
    })
  })

  await page.route('**/api/rag/embeddings/status**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        embeddedChapters: 0,
        totalChapters: 3,
        missingChapters: 3,
        summarizedChapters: 0,
        embeddedChunks: 0,
        totalChunks: 3,
        missingChunks: 3,
        dimension: null,
      }),
    })
  })

  await page.route('**/api/rag/search', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            chapterId: '1-第一章 初入江湖',
            chapterIndex: 1,
            chapterTitle: '第一章 初入江湖',
            summary: {
              short: '林青离村遇见白衣客。',
              detail: '少年林青第一次离开山村，遇见神秘的白衣客。',
            },
            score: 0.87,
            contentSnippet: '少年林青第一次离开山村',
            matchedEntities: ['林青'],
            matchType: 'chunk',
          },
        ],
        entityMatches: [],
      }),
    })
  })

  await page.route('http://localhost:11434/**', async (route) => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/api/generate')) {
      await route.fulfill({
        status: 503,
        contentType: 'text/plain',
        body: 'upstream timeout',
      })
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    })
  })
}

test.beforeEach(async ({ page }) => {
  await mockLocalServices(page)
})

test('imports a TXT novel and opens the reader flow', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: '导入第一本小说，按步骤启用 AI' })).toBeVisible()

  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'agent-smoke-novel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sampleNovel),
  })

  await expect(page.getByRole('heading', { name: '第一章 初入江湖' })).toBeVisible()
  const chapterList = page.getByRole('complementary', { name: '章节目录' })
  await expect(chapterList).toContainText('agent-smoke-novel')
  await expect(chapterList.getByRole('button', { name: /第二章 雨夜传书/ })).toBeVisible()

  await page.locator('.chapter-heading').getByRole('button', { name: '下一章', exact: true }).click()
  await expect(page.getByRole('heading', { name: '第二章 雨夜传书' })).toBeVisible()

  await page.getByLabel('搜索章节').fill('青州')
  await expect(page.getByText('找到 1 章')).toBeVisible()
  await chapterList.getByRole('button', { name: /第三章 青州旧友/ }).click()
  await expect(page.getByRole('heading', { name: '第三章 青州旧友' })).toBeVisible()
})

test('imports and scrolls a very long single-chapter TXT novel', async ({ page }) => {
  const longChapterParagraphs = Array.from(
    { length: 260 },
    (_, index) => `超长章节段落 ${index + 1}。林青沿着山路记录线索，确认这一段正文可以稳定渲染和滚动。`,
  )

  await page.goto('/')
  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'long-single-chapter.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`第一章 漫长旅途\n${longChapterParagraphs.join('\n')}`),
  })

  await expect(page.getByRole('heading', { name: '第一章 漫长旅途' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '章节目录' })).toContainText('long-single-chapter')
  await expect(page.locator('.chapter-content')).toContainText('超长章节段落 1。')
  await expect(page.locator('.chapter-content')).toContainText('超长章节段落 260。')

  const reader = page.locator('.chapter-reader')
  await expect
    .poll(() =>
      reader.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      })),
    )
    .toEqual(expect.objectContaining({ clientHeight: expect.any(Number), scrollHeight: expect.any(Number) }))
  await expect.poll(() => reader.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)

  await reader.evaluate((element) => {
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
  })
  await expect
    .poll(() => reader.evaluate((element) => Math.round(element.scrollTop + element.clientHeight)))
    .toBeGreaterThanOrEqual(await reader.evaluate((element) => Math.round(element.scrollHeight) - 2))
})

test('imports EPUB chapters in OPF spine order', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"][accept*=".epub"]').setInputFiles({
    name: 'spine-order-sample.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(makeSpineOrderEpub()),
  })

  await expect(page.getByRole('heading', { name: '第二章 先行章节' })).toBeVisible()
  const chapterList = page.getByRole('complementary', { name: '章节目录' })
  await expect(chapterList).toContainText('spine-order-sample')
  await expect(chapterList.getByRole('button', { name: /第二章 先行章节/ })).toBeVisible()
  await expect(chapterList.getByRole('button', { name: /第一章 后到章节/ })).toBeVisible()
  await expect(chapterList.getByRole('button', { name: /第三章 终章线索/ })).toBeVisible()
  await expect(page.locator('.chapter-content')).toContainText('第二章正文应当按 spine 排在第一位。')

  await page.locator('.chapter-heading').getByRole('button', { name: '下一章', exact: true }).click()
  await expect(page.getByRole('heading', { name: '第一章 后到章节' })).toBeVisible()
  await expect(page.locator('.chapter-content')).toContainText('第一章正文应当排在第二位。')

  await page.locator('.chapter-heading').getByRole('button', { name: '下一章', exact: true }).click()
  await expect(page.getByRole('heading', { name: '第三章 终章线索' })).toBeVisible()
  await expect(page.locator('.chapter-content')).toContainText('第三章正文应当排在最后。')
})

test('persists reader preferences after page reload', async ({ page }) => {
  let persistedState: Record<string, unknown> | null = null

  await page.unroute('**/api/state**')
  await page.route('**/api/state**', async (route) => {
    if (route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON() as { state?: Record<string, unknown> }
      persistedState = payload.state ?? null
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ state: persistedState }),
    })
  })
  await page.route('**/api/books/**', async (route) => {
    const books = Array.isArray(persistedState?.books) ? (persistedState.books as Array<{ book?: { chapters?: unknown[] } }>) : []
    const libraryBook = books[0] ?? null
    const chapters = Array.isArray(books[0]?.book?.chapters) ? books[0].book.chapters : []
    if (route.request().url().includes('/library-state')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ libraryBook }),
      })
      return
    }

    if (!route.request().url().includes('/chapters')) {
      await route.fallback()
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ chapters }),
    })
  })

  await page.goto('/')
  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'reader-preferences.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sampleNovel),
  })

  await expect(page.getByRole('heading', { name: '第一章 初入江湖' })).toBeVisible()
  async function setRangeValue(selector: string, value: string) {
    await page.locator(selector).evaluate((input, nextValue) => {
      const element = input as HTMLInputElement
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      valueSetter?.call(element, nextValue)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }, value)
  }

  await setRangeValue('#reader-font-size', '24')
  await setRangeValue('#reader-line-height', '2.4')
  await setRangeValue('#reader-content-width', '960')
  await setRangeValue('#reader-paragraph-spacing', '1.6')

  await page.locator('#reader-theme').selectOption('night')

  await expect
    .poll(() => {
      const books = Array.isArray(persistedState?.books) ? persistedState.books : []
      return {
        bookCount: books.length,
        fontSize: persistedState?.readerFontSize,
        lineHeight: persistedState?.readerLineHeight,
        contentWidth: persistedState?.readerContentWidth,
        paragraphSpacing: persistedState?.readerParagraphSpacing,
        theme: persistedState?.readerTheme,
      }
    })
    .toEqual({
      bookCount: 1,
      fontSize: 24,
      lineHeight: 2.4,
      contentWidth: 960,
      paragraphSpacing: 1.6,
      theme: 'night',
    })

  await page.reload()

  await expect(page.getByRole('heading', { name: 'reader-preferences' }).first()).toBeVisible()
  await page.getByRole('button', { name: '继续阅读' }).first().click()
  await expect(page.getByRole('heading', { name: '第一章 初入江湖' })).toBeVisible()
  await expect(page.locator('#reader-font-size')).toHaveValue('24')
  await expect(page.locator('#reader-line-height')).toHaveValue('2.4')
  await expect(page.locator('#reader-content-width')).toHaveValue('960')
  await expect(page.locator('#reader-paragraph-spacing')).toHaveValue('1.6')
  await expect(page.locator('#reader-theme')).toHaveValue('night')
  await expect(page.locator('.chapter-reader')).toHaveClass(/reader-theme-night/)
  await expect(page.locator('.chapter-content')).toHaveCSS('font-size', '24px')
})

test('generates the current chapter summary with a mocked local model', async ({ page }) => {
  await page.unroute('http://localhost:11434/**')
  await page.route('http://localhost:11434/**', async (route) => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/api/generate')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          response: JSON.stringify({
            short: '林青初入江湖。',
            detail: '少年林青第一次离开山村，遇见神秘的白衣客，并由此踏入新的旅程。',
            keyPoints: ['林青离开山村', '白衣客登场', '主线旅程开启'],
            skippable: '不可跳读：主角和关键人物首次相遇。',
          }),
        }),
      })
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }),
    })
  })

  await page.goto('/')
  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'agent-smoke-novel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sampleNovel),
  })

  await expect(page.getByRole('heading', { name: '第一章 初入江湖' })).toBeVisible()
  await page.getByRole('button', { name: '生成本章概要' }).click()

  await expect(page.getByText('林青初入江湖。')).toBeVisible()
  await expect(page.getByText('少年林青第一次离开山村，遇见神秘的白衣客，并由此踏入新的旅程。')).toBeVisible()
  await expect(page.getByText('白衣客登场')).toBeVisible()
  await expect(page.getByText('不可跳读：主角和关键人物首次相遇。')).toBeVisible()
})

test('generates missing summaries for the whole book from the bookshelf', async ({ page }) => {
  const generatedPrompts: string[] = []

  await page.unroute('http://localhost:11434/**')
  await page.route('http://localhost:11434/**', async (route) => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/api/generate')) {
      const body = route.request().postDataJSON() as { prompt?: string }
      generatedPrompts.push(body.prompt ?? '')
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          response: JSON.stringify({
            short: `批量概要 ${generatedPrompts.length}`,
            detail: `第 ${generatedPrompts.length} 章批量详细概要。`,
            keyPoints: [`批量要点 ${generatedPrompts.length}`],
            skippable: '不可跳读：批量生成验证。',
          }),
        }),
      })
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }),
    })
  })

  await page.goto('/')
  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'agent-smoke-novel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sampleNovel),
  })

  await page.getByRole('button', { name: '返回书架' }).click()
  const currentBookCard = page.locator('.book-card').filter({
    has: page.getByRole('heading', { level: 2, name: 'agent-smoke-novel' }),
  })
  await currentBookCard.getByRole('button', { name: '生成概要 (3)' }).click()

  await expect(currentBookCard.getByRole('button', { name: '概要已生成' })).toBeVisible()
  await expect(page.getByText(/概要\s+3\s+章/)).toBeVisible()
  expect(generatedPrompts).toHaveLength(3)
  expect(generatedPrompts[0]).toContain('章节标题：第一章 初入江湖')
  expect(generatedPrompts[1]).toContain('章节标题：第二章 雨夜传书')
  expect(generatedPrompts[2]).toContain('章节标题：第三章 青州旧友')
})

test('shows failed chapters while generating summaries for the current page', async ({ page }) => {
  let requestCount = 0

  await page.unroute('http://localhost:11434/**')
  await page.route('http://localhost:11434/**', async (route) => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/api/generate')) {
      requestCount += 1
      if (requestCount === 2) {
        await route.fulfill({
          status: 503,
          contentType: 'text/plain',
          body: 'summary timeout',
        })
        return
      }

      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          response: JSON.stringify({
            short: `当前页概要 ${requestCount}`,
            detail: `当前页第 ${requestCount} 个成功概要。`,
            keyPoints: [`当前页要点 ${requestCount}`],
            skippable: '不可跳读：当前页验证。',
          }),
        }),
      })
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }),
    })
  })

  await page.goto('/')
  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'agent-smoke-novel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sampleNovel),
  })

  await page.getByRole('button', { name: '生成当前页概要 (3)' }).click()

  await expect(page.getByText('当前页生成结束，成功 2 章，失败 1 章。')).toBeVisible()
  await expect(page.getByText('失败章节：第二章 雨夜传书')).toBeVisible()
  const chapterList = page.getByRole('complementary', { name: '章节目录' })
  await expect(chapterList.getByRole('button', { name: /第一章 初入江湖.*已概要/ })).toBeVisible()
  await expect(chapterList.getByRole('button', { name: /第三章 青州旧友.*已概要/ })).toBeVisible()
  await expect(chapterList.getByRole('button', { name: /第二章 雨夜传书/ })).not.toContainText('已概要')
})

test('keeps reading scroll positions isolated across books with matching chapter ids', async ({ page }) => {
  const repeatedA = Array.from({ length: 80 }, (_, index) => `甲书段落 ${index + 1}。少年在山路上继续前行。`).join('\n')
  const repeatedB = Array.from({ length: 80 }, (_, index) => `乙书段落 ${index + 1}。旅人在海边继续观察。`).join('\n')
  const reader = page.locator('.chapter-reader')

  await page.route('**/api/books/*/chapters?*', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        chapters: [
          {
            id: '1-第一章 相同标题',
            index: 1,
            title: '第一章 相同标题',
            content: Array.from({ length: 80 }, (_, index) => `缓存章节段落 ${index + 1}。用于验证滚动恢复。`).join('\n'),
            wordCount: 1200,
          },
        ],
      }),
    })
  })

  await page.goto('/')

  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'scroll-book-a.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`第一章 相同标题\n${repeatedA}`),
  })
  await expect(page.getByRole('heading', { name: '第一章 相同标题' })).toBeVisible()
  await reader.evaluate((element) => {
    element.scrollTop = 360
    element.dispatchEvent(new Event('scroll'))
  })
  await page.getByRole('button', { name: '返回书架' }).click()

  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'scroll-book-b.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(`第一章 相同标题\n${repeatedB}`),
  })
  await expect(page.getByRole('heading', { name: '第一章 相同标题' })).toBeVisible()
  await reader.evaluate((element) => {
    element.scrollTop = 760
    element.dispatchEvent(new Event('scroll'))
  })
  await page.getByRole('button', { name: '返回书架' }).click()

  await page.locator('.book-row').filter({ hasText: 'scroll-book-a' }).getByRole('button', { name: /打开|继续阅读/ }).click()
  await expect(page.getByRole('heading', { name: '第一章 相同标题' })).toBeVisible()
  await expect.poll(() => reader.evaluate((element) => Math.round(element.scrollTop))).toBeGreaterThanOrEqual(300)
  await expect.poll(() => reader.evaluate((element) => Math.round(element.scrollTop))).toBeLessThan(650)

  await page.getByRole('button', { name: '返回书架' }).click()
  await page.locator('.book-row').filter({ hasText: 'scroll-book-b' }).getByRole('button', { name: /打开|继续阅读/ }).click()
  await expect.poll(() => reader.evaluate((element) => Math.round(element.scrollTop))).toBeGreaterThanOrEqual(700)
})

test('opens smart search and renders mocked RAG results', async ({ page }) => {
  await page.goto('/')
  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'agent-smoke-novel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sampleNovel),
  })

  await page.getByRole('button', { name: '智能搜索' }).click()

  await expect(page.getByRole('heading', { name: 'agent-smoke-novel' })).toBeVisible()
  await expect(page.getByText('Embedding 覆盖：0/3 章')).toBeVisible()

  await page.getByPlaceholder('例如：某某功法第一次出现在哪里').fill('林青在哪里遇见白衣客')
  await page.getByRole('button', { name: '搜索', exact: true }).click()

  await expect(page.getByText('第一章 初入江湖')).toBeVisible()
  await expect(page.getByText('少年林青第一次离开山村，遇见神秘的白衣客。')).toBeVisible()

  await page.getByRole('button', { name: '生成答案' }).click()
  await expect(page.getByText('Ollama 返回 503：upstream timeout')).toBeVisible()
  await expect(page.getByRole('heading', { name: '相关章节（1）' })).toBeVisible()
  await expect(page.getByText('第一章 初入江湖')).toBeVisible()
})

test('generates a RAG answer while keeping retrieved source chapters visible', async ({ page }) => {
  await page.unroute('http://localhost:11434/**')
  await page.route('http://localhost:11434/**', async (route) => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/api/generate')) {
      const body = route.request().postDataJSON() as { prompt?: string }
      expect(body.prompt).toContain('[第 1 章] 第一章 初入江湖')
      expect(body.prompt).toContain('少年林青第一次离开山村，遇见神秘的白衣客。')
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          response: '林青是在第 1 章遇见白衣客的。来源是相关章节中的《第一章 初入江湖》。',
        }),
      })
      return
    }

    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ models: [{ name: 'qwen2.5:7b' }] }),
    })
  })

  await page.goto('/')
  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'agent-smoke-novel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sampleNovel),
  })

  await page.getByRole('button', { name: '智能搜索' }).click()
  await page.getByPlaceholder('例如：某某功法第一次出现在哪里').fill('林青在哪里遇见白衣客')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByRole('heading', { name: '相关章节（1）' })).toBeVisible()

  await page.getByRole('button', { name: '生成答案' }).click()

  await expect(page.getByText('AI 回答')).toBeVisible()
  await expect(page.getByText('林青是在第 1 章遇见白衣客的。来源是相关章节中的《第一章 初入江湖》。')).toBeVisible()
  await expect(page.getByRole('heading', { name: '相关章节（1）' })).toBeVisible()
  await expect(page.getByRole('button', { name: '第 1 章：第一章 初入江湖' })).toBeVisible()
  await expect(page.getByText('少年林青第一次离开山村，遇见神秘的白衣客。')).toBeVisible()
})

test('renders cross-chapter RAG search results with entity-enhanced evidence', async ({ page }) => {
  await page.route('**/api/rag/search', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            chapterId: '1-第一章 初入江湖',
            chapterIndex: 1,
            chapterTitle: '第一章 初入江湖',
            summary: {
              short: '林青离村遇见白衣客。',
              detail: '少年林青第一次离开山村，遇见神秘的白衣客。',
            },
            similarity: 0.91,
            contentSnippet: '少年林青第一次离开山村',
            matchedEntities: ['林青'],
            matchType: 'both',
          },
          {
            chapterId: '3-第三章 青州旧友',
            chapterIndex: 3,
            chapterTitle: '第三章 青州旧友',
            summary: {
              short: '林青在青州遇见阿梨。',
              detail: '林青在城中遇见旧友阿梨，二人发现密信另有玄机。',
            },
            similarity: 0.76,
            contentSnippet: '林青在城中遇见旧友阿梨',
            matchedEntities: ['林青', '阿梨'],
            matchType: 'entity',
          },
        ],
        entityMatches: [
          {
            entityId: 'entity-linqing',
            entityName: '林青',
            entityType: 'character',
            firstChapterIndex: 1,
            lastChapterIndex: 3,
            aliases: ['少年林青'],
          },
        ],
      }),
    })
  })

  await page.goto('/')
  await page.locator('input[type="file"][accept*=".txt"]').setInputFiles({
    name: 'agent-smoke-novel.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sampleNovel),
  })

  await page.getByRole('button', { name: '智能搜索' }).click()
  await page.getByPlaceholder('例如：某某功法第一次出现在哪里').fill('林青和阿梨相关章节')
  await page.getByRole('button', { name: '搜索', exact: true }).click()

  await expect(page.getByText('识别到实体：')).toBeVisible()
  await expect(page.locator('.entity-tags').first().getByText('林青')).toBeVisible()
  await expect(page.getByRole('heading', { name: '相关章节（2）' })).toBeVisible()
  await expect(page.getByRole('button', { name: '第 1 章：第一章 初入江湖' })).toBeVisible()
  await expect(page.getByRole('button', { name: '第 3 章：第三章 青州旧友' })).toBeVisible()
  await expect(page.locator('.match-type').filter({ hasText: '混合' })).toBeVisible()
  await expect(page.locator('.match-type').filter({ hasText: /^实体$/ })).toBeVisible()
  await expect(page.getByText('少年林青第一次离开山村，遇见神秘的白衣客。')).toBeVisible()
  await expect(page.getByText('林青在城中遇见旧友阿梨，二人发现密信另有玄机。')).toBeVisible()
  await expect(page.getByText('林青在城中遇见旧友阿梨...')).toBeVisible()
})
