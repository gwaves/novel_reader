import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, vi } from 'vitest'
import App from './App'
import { adminTokenStorageKey } from './api'

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('Gateway 管理后台 UI', () => {
  it('展示总览指标、内容健康和最近事件', async () => {
    render(<App />)

    expect(screen.getByText('Novel Reader Gateway')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '总览' })).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByText('今日请求')).toBeInTheDocument()
    expect(screen.getByText('错误率')).toBeInTheDocument()
    expect(screen.getByText('内容健康')).toBeInTheDocument()
    expect(screen.getByText('最近事件')).toBeInTheDocument()
    expect(screen.getByText('导入《烬鳞纪》数据包成功')).toBeInTheDocument()
  })

  it('Gateway API 返回空事件时不回退到 mock 最近事件', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/admin/metrics') return jsonResponse({ requests: {}, downloads: {}, trends: { requests: [], downloads: [] } })
      if (url === '/admin/events') return jsonResponse({ events: [] })
      return jsonResponse({}, false, 503)
    })

    render(<App />)

    expect(await screen.findByText('最近 30 分钟暂无事件')).toBeInTheDocument()
    expect(screen.queryByText('导入《烬鳞纪》数据包成功')).not.toBeInTheDocument()
  })

  it('初次连接 Gateway API 时不在书籍页闪现 mock 数据', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async () => new Promise<Response>(() => {}))

    const user = userEvent.setup()
    render(<App />)

    expect(screen.getByText('连接中')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '书籍' }))

    expect(screen.getByRole('heading', { name: '书籍' })).toBeInTheDocument()
    expect(screen.getByText('正在加载后台数据')).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /烬鳞纪 青岚 trusted/ })).not.toBeInTheDocument()
  })

  it('从 Gateway 管理 API 加载书籍和设备数据', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/admin/books') {
        return jsonResponse({
          books: [
            {
              id: 'api-book',
              title: '接口书籍',
              author: '接口作者',
              chapterCount: 10,
              updatedAt: '2026-06-29T12:00:00.000Z',
              visibility: 'trusted',
              labels: ['private'],
              summaryCoverage: 0.8,
              kgCoverage: 0.7,
              embeddingCoverage: 0.6,
              audioChapterCount: 5,
            },
          ],
        })
      }
      if (url === '/admin/devices') {
        return jsonResponse({
          devices: [
            {
              id: 'api-device',
              name: '接口平板',
              model: 'Android Tablet',
              platform: 'android',
              appVersion: '0.1.0',
              pairingCode: '112233',
              role: 'trusted',
              firstSeenAt: '2026-06-29T10:00:00.000Z',
              lastSeenAt: '2026-06-29T12:00:00.000Z',
              lastIp: '192.168.88.66',
            },
          ],
        })
      }
      if (url === '/admin/metrics') {
        return jsonResponse({
          requests: {
            last15Minutes: 7,
            last24Hours: 42,
            errorRate: 0.125,
            p95Ms: 321,
          },
          downloads: {
            packageLast24Hours: 2,
            audioLast24Hours: 9,
          },
          process: {
            uptimeSeconds: 3600,
            heapUsedBytes: 64 * 1024 * 1024,
            rssBytes: 96 * 1024 * 1024,
            dataDirBytes: 342 * 1024 * 1024,
          },
          trends: {
            requests: [
              {
                startAt: '2026-06-29T12:25:00.000Z',
                requestCount: 7,
                errorCount: 1,
                p95Ms: 321,
              },
            ],
            downloads: [
              {
                startAt: '2026-06-29T12:25:00.000Z',
                packageDownloads: 2,
                audioDownloads: 9,
              },
            ],
          },
        })
      }
      if (url === '/admin/events') {
        return jsonResponse({
          events: [
            {
              time: '2026-06-29T12:34:00.000Z',
              level: 'warn',
              text: '接口事件',
            },
          ],
        })
      }
      if (url === '/admin/packages') {
        return jsonResponse({
          packages: [
            {
              bookId: 'api-book',
              title: '接口书籍',
              importStatus: 'imported',
              sizeBytes: 13_107_200,
              updatedAt: '2026-06-29T12:10:00.000Z',
              importedAt: '2026-06-29T12:10:00.000Z',
              chapterCount: 10,
              packageChapterCount: 10,
              summaryCoverage: 80,
              kgCoverage: 70,
              embeddingCoverage: 60,
            },
            {
              bookId: 'legacy-package',
              title: '旧数据包',
              importStatus: 'imported',
              sizeBytes: 1024,
              updatedAt: '2026-06-29T12:09:00.000Z',
              importedAt: '2026-06-29T12:09:00.000Z',
              chapterCount: 1,
              packageChapterCount: 1,
            },
          ],
        })
      }
      if (url === '/admin/audio') {
        return jsonResponse({
          audio: [
            {
              bookId: 'api-book',
              title: '接口书籍',
              chapterCount: 10,
              audioChapterCount: 6,
              coverage: 0.6,
              missingChapterIds: ['chapter-7', 'chapter-8', 'chapter-9', 'chapter-10'],
              totalSizeBytes: 93_113_549,
              updatedAt: '2026-06-29T12:11:00.000Z',
            },
          ],
        })
      }
      if (url === '/admin/requests') {
        return jsonResponse({
          requests: [
            {
              requestId: 'api-request',
              time: '2026-06-29T12:12:00.000Z',
              method: 'GET',
              url: '/mobile/books/api-book/package',
              statusCode: 503,
              durationMs: 777,
            },
          ],
        })
      }
      return jsonResponse({}, false, 404)
    })

    const user = userEvent.setup()
    render(<App />)

    expect((await screen.findAllByText(/已连接 Gateway 管理 API/)).length).toBeGreaterThan(0)
    expect(screen.getByText('实时')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('12.5%')).toBeInTheDocument()
    expect(screen.getByText('20:34')).toBeInTheDocument()
    expect(screen.getByText('接口事件')).toBeInTheDocument()
    expect(screen.queryByText('导入《烬鳞纪》数据包成功')).not.toBeInTheDocument()
    expect(screen.getByText('运行 / 内存 / 数据目录').closest('div')).toHaveTextContent('运行 1h 0m · heap 64.0 MB · RSS 96.0 MB · 数据目录 342.0 MB')
    expect(screen.getByText('在线设备').closest('div')).toHaveTextContent('1 台 · 受信 1 台 · 禁用 0 台')
    expect(document.querySelector('[title="20:25 请求 7 / 错误 1 / P95 321ms"]')).not.toBeNull()
    expect(document.querySelector('[title="20:25 package 2 / audio 9"]')).not.toBeNull()
    const healthPanel = screen.getByRole('heading', { name: '内容健康' }).closest('section')!
    expect(within(healthPanel).getByText('书籍').closest('div')).toHaveTextContent('1 本')
    expect(within(healthPanel).getByText('受限').closest('div')).toHaveTextContent('1 本')
    expect(within(healthPanel).getByText('隐藏').closest('div')).toHaveTextContent('0 本')
    expect(within(healthPanel).getByText('缺音频章节').closest('div')).toHaveTextContent('4')
    expect(within(healthPanel).getByText('异常数据包').closest('div')).toHaveTextContent('0')

    await user.click(screen.getByRole('button', { name: '书籍' }))
    expect(screen.getByRole('row', { name: /接口书籍 接口作者 trusted/ })).toBeInTheDocument()
    expect(screen.getByText('S 80% · KG 70% · E 60%')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '设备' }))
    expect(screen.getByRole('row', { name: /接口平板 112233 受信 192\.168\.88\.66/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '数据包' }))
    expect(screen.getByRole('row', { name: /接口书籍 2026-06-29 20:10 可发布 12\.5 MB/ })).toBeInTheDocument()
    expect(screen.getByText('S 80% · KG 70% · E 60%')).toBeInTheDocument()
    const legacyPackageRow = screen.getByRole('row', { name: /旧数据包/ })
    expect(within(legacyPackageRow).getByText('S - · KG - · E -')).toBeInTheDocument()
    expect(within(legacyPackageRow).getByText('无')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '音频' }))
    expect(screen.getByRole('row', { name: /接口书籍 部分缺失 60% 6\/10/ })).toBeInTheDocument()
    expect(screen.getByText('chapter-7、chapter-8、chapter-9、chapter-10')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '请求日志' }))
    expect(screen.getByRole('row', { name: /20:12 GET .*\/mobile\/books\/api-book\/package 503 777ms 未知设备/ })).toBeInTheDocument()
  })

  it('API 不可用时用 mock 数据展示数据包、音频和请求日志页面', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText(/API 不可用，正在显示 mock 数据/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '数据包' }))
    expect(screen.getByRole('heading', { name: '数据包' })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /夜航档案 2026\.06\.27-1820 需复查 18\.6 MB/ })).toBeInTheDocument()
    const packageMissingSummary = screen.getAllByText('缺失章节')[0].closest('div')!
    expect(packageMissingSummary).toHaveTextContent('51 章')
    expect(packageMissingSummary).toHaveAttribute('title', expect.stringContaining('夜航档案：章节文件缺失 3 章'))
    expect(document.querySelector('[title="章节文件缺失 3 章；Summary 缺 7 章；KG 缺 18 章；Embedding 缺 13 章"]')).toHaveTextContent('18 章')

    await user.click(screen.getByRole('button', { name: '音频' }))
    expect(screen.getByRole('heading', { name: '音频' })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /烬鳞纪 部分缺失 72% 134\/186/ })).toBeInTheDocument()
    expect(screen.getByText('茉莉')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '请求日志' }))
    expect(screen.getByRole('heading', { name: '请求日志' })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /GET .*\/mobile\/books\/jinlin\/audio\/088\.mp3 404 42ms 客厅小米平板/ })).toBeInTheDocument()
  })

  it('管理员未授权时显示安全失败状态，不伪装成 mock 数据', async () => {
    vi.spyOn(window, 'fetch').mockResolvedValue(jsonResponse({ error: 'unauthorized' }, false, 401))

    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText(/未授权：管理员 Token 无效或缺失/)).toBeInTheDocument()
    expect(screen.queryByText(/API 不可用，正在显示 mock 数据/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '设置' }))
    expect(screen.getByText('未授权：管理员 Token 无效或缺失')).toBeInTheDocument()
    expect(screen.getAllByText('未授权').length).toBeGreaterThan(0)
    expect(screen.getByText('需要有效管理员 Token')).toBeInTheDocument()
  })

  it('单个后台接口失败时显示 partial 状态，并保留其他 API 数据', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/admin/books') {
        return jsonResponse({
          books: [
            {
              id: 'partial-book',
              title: '部分接口书籍',
              author: '接口作者',
              chapterCount: 1,
              visibility: 'default',
            },
          ],
        })
      }
      if (url === '/admin/packages') return jsonResponse({ error: 'packages unavailable' }, false, 503)
      if (url === '/admin/devices') return jsonResponse({ devices: [] })
      if (url === '/admin/metrics') return jsonResponse({ requests: { last24Hours: 1 } })
      if (url === '/admin/events') return jsonResponse({ events: [] })
      if (url === '/admin/audio') return jsonResponse({ audio: [] })
      if (url === '/admin/requests') return jsonResponse({ requests: [] })
      return jsonResponse({}, false, 404)
    })

    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText(/部分后台接口失败/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '书籍' }))
    expect(screen.getByRole('row', { name: /部分接口书籍 接口作者 default/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '数据包' }))
    expect(screen.getByRole('region', { name: '数据包' })).toHaveTextContent('0 个')
    expect(screen.queryByRole('row', { name: /烬鳞纪 2026\.06\.29-1208 可发布/ })).not.toBeInTheDocument()
  })

  it('书籍列表展示可见范围和标签，并在详情抽屉同步编辑状态', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: '书籍' }))

    const row = screen.getByRole('row', { name: /烬鳞纪 青岚 trusted .*186/ })
    expect(within(row).getByText('trusted')).toBeInTheDocument()
    expect(within(row).getByText('少儿不宜')).toBeInTheDocument()
    expect(within(row).getByText('私有')).toBeInTheDocument()

    await user.click(row)
    expect(screen.getByRole('heading', { name: '烬鳞纪' })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('可见范围'), 'hidden')
    expect(within(row).getByText('hidden')).toBeInTheDocument()

    await user.click(screen.getByLabelText('测试'))
    expect(screen.getByText('当前标签：少儿不宜、私有、测试')).toBeInTheDocument()
    expect(within(row).getByText('测试')).toBeInTheDocument()
  })

  it('设备列表展示 pairing code 和角色，并在详情抽屉同步角色选择', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(screen.getByRole('button', { name: '设备' }))

    const row = screen.getByRole('row', { name: /客厅小米平板 428193 普通 192\.168\.88\.23 2分钟前/ })
    expect(within(row).getByText('428193')).toBeInTheDocument()
    expect(within(row).getByText('普通')).toBeInTheDocument()

    await user.click(row)
    expect(screen.getByRole('heading', { name: '客厅小米平板' })).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('设备角色'), 'trusted')
    expect(screen.getByText('当前角色：受信')).toBeInTheDocument()
    expect(within(row).getByText('受信')).toBeInTheDocument()
  })

  it('数据包下载操作成功和失败时显示行级状态，并携带管理员 Token', async () => {
    window.localStorage.setItem(adminTokenStorageKey, 'download-token')
    const authHeaders: string[] = []
    vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const authorization = init?.headers instanceof Headers ? init.headers.get('authorization') ?? '' : ''
      authHeaders.push(`${url}:${authorization}`)
      if (url === '/admin/books/jinlin/package/download') {
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob(['package']),
          json: async () => ({}),
        } as Response
      }
      if (url === '/admin/books/night-archive/package/download') {
        return jsonResponse({ error: 'unavailable' }, false, 503)
      }
      throw new TypeError('api offline')
    })

    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(/API 不可用，正在显示 mock 数据/)

    await user.click(screen.getByRole('button', { name: '数据包' }))
    await user.click(screen.getByRole('button', { name: '下载 烬鳞纪 package' }))
    expect(await screen.findByText('下载已就绪')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '下载 夜航档案 package' }))
    expect(await screen.findByText('下载失败：服务不可用')).toBeInTheDocument()
    expect(authHeaders).toContain('/admin/books/jinlin/package/download:Bearer download-token')
    expect(authHeaders).toContain('/admin/books/night-archive/package/download:Bearer download-token')
  })

  it('数据包重新导入成功后刷新行数据，无效 JSON 时显示失败状态', async () => {
    window.localStorage.setItem(adminTokenStorageKey, 'package-import-token')
    const requests: Array<{ url: string; method: string; authorization: string; body?: string }> = []
    let packageVersion = '2026-06-29T12:00:00.000Z'
    vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const authorization = init?.headers instanceof Headers ? init.headers.get('authorization') ?? '' : ''
      requests.push({
        url,
        method: init?.method ?? 'GET',
        authorization,
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      if (url === '/admin/books') {
        return jsonResponse({
          books: [
            {
              id: 'import-book',
              title: '导入书',
              author: '后台',
              chapterCount: 2,
              updatedAt: packageVersion,
              visibility: 'default',
            },
          ],
        })
      }
      if (url === '/admin/packages') {
        return jsonResponse({
          packages: [
            {
              bookId: 'import-book',
              title: '导入书',
              importStatus: 'imported',
              updatedAt: packageVersion,
              importedAt: packageVersion,
              sizeBytes: packageVersion.includes('13:00') ? 4096 : 2048,
              chapterCount: 2,
              packageChapterCount: 2,
            },
          ],
        })
      }
      if (url === '/admin/books/import-book/package' && init?.method === 'PUT') {
        packageVersion = '2026-06-29T13:00:00.000Z'
        return jsonResponse({ book: { id: 'import-book' } })
      }
      if (url === '/admin/devices') return jsonResponse({ devices: [] })
      if (url === '/admin/metrics') return jsonResponse({ requests: {}, downloads: {}, trends: { requests: [], downloads: [] } })
      if (url === '/admin/events') return jsonResponse({ events: [] })
      if (url === '/admin/audio') return jsonResponse({ audio: [] })
      if (url === '/admin/requests') return jsonResponse({ requests: [] })
      throw new TypeError(`unexpected request ${url}`)
    })

    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(/已连接 Gateway 管理 API/)

    await user.click(screen.getByRole('button', { name: '数据包' }))
    expect(screen.getByRole('row', { name: /导入书 2026-06-29 20:00 可发布/ })).toBeInTheDocument()

    await user.upload(
      screen.getByLabelText('重新导入 导入书 package'),
      new File([
        JSON.stringify({
          schemaVersion: 1,
          book: { id: 'import-book', title: '导入书', chapterCount: 2, updatedAt: '2026-06-29T13:00:00.000Z' },
          chapters: [{ id: 'chapter-1' }, { id: 'chapter-2' }],
        }),
      ], 'import-book-package.json', { type: 'application/json' }),
    )

    expect(await screen.findByText('重新导入完成')).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /导入书 2026-06-29 21:00 可发布/ })).toBeInTheDocument()
    expect(requests).toContainEqual(expect.objectContaining({
      url: '/admin/books/import-book/package',
      method: 'PUT',
      authorization: 'Bearer package-import-token',
    }))

    await user.upload(
      screen.getByLabelText('重新导入 导入书 package'),
      new File(['not json'], 'broken-package.json', { type: 'application/json' }),
    )

    expect(await screen.findByText('重新导入失败：JSON 无效')).toBeInTheDocument()
  })

  it('音频页按真实 audio summary 显示完整、部分缺失和缺失状态', async () => {
    vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url === '/admin/audio') {
        return jsonResponse({
          audio: [
            {
              bookId: 'ready-book',
              title: '完整音频书',
              status: 'ready',
              chapterCount: 3,
              audioChapterCount: 3,
              coverage: 1,
              missingChapterIds: [],
              totalDuration: '03:00:00',
              totalSizeBytes: 3145728,
              updatedAt: '2026-06-29T12:00:00.000Z',
              voice: '茉莉',
              downloads24h: 5,
            },
            {
              bookId: 'partial-book',
              title: '部分音频书',
              chapterCount: 4,
              audioChapterCount: 2,
              coverage: 0.5,
              missingChapterIds: ['chapter-3', 'chapter-4'],
              totalSizeBytes: 2097152,
              updatedAt: '2026-06-29T11:00:00.000Z',
              voice: '冰糖',
              downloads24h: 7,
            },
            {
              bookId: 'missing-book',
              title: '缺失音频书',
              chapterCount: 2,
              audioChapterCount: 0,
              missingChapterIds: ['chapter-1', 'chapter-2'],
              totalSizeBytes: 0,
              voice: '默认',
            },
          ],
        })
      }
      if (url === '/admin/books') return jsonResponse({ books: [] })
      if (url === '/admin/packages') return jsonResponse({ packages: [] })
      if (url === '/admin/devices') return jsonResponse({ devices: [] })
      if (url === '/admin/metrics') return jsonResponse({ requests: {}, downloads: {}, trends: { requests: [], downloads: [] } })
      if (url === '/admin/events') return jsonResponse({ events: [] })
      if (url === '/admin/requests') return jsonResponse({ requests: [] })
      throw new TypeError(`unexpected request ${url}`)
    })

    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(/已连接 Gateway 管理 API/)

    await user.click(screen.getByRole('button', { name: '音频' }))
    expect(screen.getByRole('region', { name: '音频' })).toHaveTextContent('50%')
    expect(screen.getByRole('region', { name: '音频' })).toHaveTextContent('4 章')
    expect(screen.getByRole('row', { name: /完整音频书 完整 100% 3\/3 无 03:00:00 3\.0 MB 茉莉/ })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /部分音频书 部分缺失 50% 2\/4 chapter-3、chapter-4 .*冰糖/ })).toBeInTheDocument()
    expect(screen.getByRole('row', { name: /缺失音频书 缺失 0% 0\/2 chapter-1、chapter-2/ })).toBeInTheDocument()
  })

  it('音频刷新和清理操作更新当前行状态，清理前需要确认', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    let jinlinRefreshAttempts = 0
    vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/admin/books/jinlin/audio/refresh' && init?.method === 'POST') {
        jinlinRefreshAttempts += 1
        if (jinlinRefreshAttempts === 2) return jsonResponse({ error: 'failed' }, false, 503)
        return jsonResponse({
          audio: {
            id: 'audio-jinlin',
            bookId: 'jinlin',
            bookTitle: '烬鳞纪',
            status: 'ready',
            chapterCount: 186,
            availableChapters: 186,
            coverage: 1,
            missingChapters: [],
            totalDuration: '46:20:18',
            sizeMb: 1840,
            lastGeneratedAt: '2026-06-29T12:30:00.000Z',
            voice: '茉莉',
            downloads24h: 412,
          },
        })
      }
      if (url === '/admin/books/jinlin/audio' && init?.method === 'DELETE') {
        return jsonResponse({
          audio: {
            id: 'audio-jinlin',
            bookId: 'jinlin',
            bookTitle: '烬鳞纪',
            status: 'missing',
            chapterCount: 186,
            availableChapters: 0,
            coverage: 0,
            missingChapters: [1, 2, 3],
            totalDuration: '-',
            sizeMb: 0,
            lastGeneratedAt: '-',
            voice: '茉莉',
            downloads24h: 0,
          },
        })
      }
      throw new TypeError('api offline')
    })

    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(/API 不可用，正在显示 mock 数据/)

    await user.click(screen.getByRole('button', { name: '音频' }))
    await user.click(screen.getByRole('button', { name: '刷新 烬鳞纪 音频状态' }))
    expect(await screen.findByRole('row', { name: /烬鳞纪 完整 100% 186\/186/ })).toBeInTheDocument()
    expect(screen.getByText('刷新完成')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '清理 烬鳞纪 音频' }))
    expect(confirmSpy).toHaveBeenCalledWith('确认清理《烬鳞纪》的音频文件？')
    expect(await screen.findByRole('row', { name: /烬鳞纪 缺失 0% 0\/186/ })).toBeInTheDocument()
    expect(screen.getByText('已清理音频')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '刷新 烬鳞纪 音频状态' }))
    expect(await screen.findByText('刷新失败：服务不可用')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新 烬鳞纪 音频状态' })).not.toBeDisabled()
  })

  it('书籍详情支持删除整本书并同步移除书籍、数据包和音频行', async () => {
    window.localStorage.setItem(adminTokenStorageKey, 'delete-token')
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const authHeaders: string[] = []
    vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const authorization = init?.headers instanceof Headers ? init.headers.get('authorization') ?? '' : ''
      authHeaders.push(`${url}:${init?.method ?? 'GET'}:${authorization}`)
      if (url === '/admin/books') {
        return jsonResponse({
          books: [
            {
              id: 'delete-book',
              title: '待删除书',
              author: '测试作者',
              chapterCount: 2,
              updatedAt: '2026-06-29T12:00:00.000Z',
              visibility: 'default',
              labels: ['test'],
              audioChapterCount: 1,
            },
            {
              id: 'keep-book',
              title: '保留书',
              author: '测试作者',
              chapterCount: 1,
              updatedAt: '2026-06-28T12:00:00.000Z',
              visibility: 'default',
              labels: [],
              audioChapterCount: 0,
            },
          ],
        })
      }
      if (url === '/admin/packages') {
        return jsonResponse({
          packages: [
            {
              bookId: 'delete-book',
              title: '待删除书',
              importStatus: 'imported',
              sizeBytes: 2048,
              chapterCount: 2,
              packageChapterCount: 2,
            },
          ],
        })
      }
      if (url === '/admin/audio') {
        return jsonResponse({
          audio: [
            {
              bookId: 'delete-book',
              title: '待删除书',
              chapterCount: 2,
              audioChapterCount: 1,
              coverage: 0.5,
              missingChapterIds: ['chapter-2'],
              totalSizeBytes: 1024,
            },
          ],
        })
      }
      if (url === '/admin/metrics') return jsonResponse({ requests: {}, downloads: {} })
      if (url === '/admin/events') return jsonResponse({ events: [] })
      if (url === '/admin/devices') return jsonResponse({ devices: [] })
      if (url === '/admin/requests') return jsonResponse({ requests: [] })
      if (url === '/admin/books/delete-book' && init?.method === 'DELETE') {
        return jsonResponse({
          deleted: {
            bookId: 'delete-book',
            title: '待删除书',
            removed: true,
            packageRemoved: true,
            audioRemoved: true,
          },
        })
      }
      throw new TypeError(`unexpected request ${url}`)
    })

    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(/实时/)

    await user.click(screen.getByRole('button', { name: '数据包' }))
    expect(screen.getByRole('row', { name: /待删除书 .*可发布/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '音频' }))
    expect(screen.getByRole('row', { name: /待删除书 部分缺失 50% 1\/2/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '书籍' }))
    await user.click(screen.getByRole('row', { name: /待删除书/ }))
    await user.click(screen.getByRole('button', { name: '删除 待删除书' }))

    expect(confirmSpy).toHaveBeenCalledWith('确认删除《待删除书》？这会同时删除 package、音频和相关清单。')
    expect(await screen.findByText(/已删除书籍/)).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /待删除书/ })).not.toBeInTheDocument()
    expect(screen.getByRole('row', { name: /保留书/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '数据包' }))
    expect(screen.queryByRole('row', { name: /待删除书/ })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '数据包' })).toHaveTextContent('0 个')
    await user.click(screen.getByRole('button', { name: '音频' }))
    expect(screen.queryByRole('row', { name: /待删除书/ })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: '音频' })).toHaveTextContent('0%')
    expect(authHeaders).toContain('/admin/books/delete-book:DELETE:Bearer delete-token')
  })

  it('书籍和设备编辑失败时回滚并提供重试', async () => {
    window.localStorage.setItem(adminTokenStorageKey, 'retry-token')
    let visibilityAttempts = 0
    vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/admin/books/jinlin/visibility' && init?.method === 'PATCH') {
        visibilityAttempts += 1
        if (visibilityAttempts === 1) return jsonResponse({ error: 'failed' }, false, 503)
        return jsonResponse({})
      }
      throw new TypeError('api offline')
    })

    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(/API 不可用，正在显示 mock 数据/)

    await user.click(screen.getByRole('button', { name: '书籍' }))
    const row = screen.getByRole('row', { name: /烬鳞纪 青岚 trusted/ })
    await user.click(row)
    await user.selectOptions(screen.getByLabelText('可见范围'), 'hidden')

    expect(await screen.findByText('保存失败，已回滚')).toBeInTheDocument()
    expect(within(row).getByText('trusted')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试保存可见范围' }))
    expect(await screen.findByText('保存成功')).toBeInTheDocument()
    expect(within(row).getByText('hidden')).toBeInTheDocument()
  })

  it('设备角色保存失败时回滚，重试成功后同步列表和详情', async () => {
    window.localStorage.setItem(adminTokenStorageKey, 'device-retry-token')
    const roleRequests: Array<{ body: string; authorization: string }> = []
    let roleAttempts = 0
    let rejectFirstRoleSave: (() => void) | undefined
    vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url === '/admin/devices/device-living-room-pad' && init?.method === 'PATCH') {
        roleAttempts += 1
        const authorization = init.headers instanceof Headers ? init.headers.get('authorization') ?? '' : ''
        roleRequests.push({
          body: String(init.body),
          authorization,
        })
        if (roleAttempts === 1) {
          return new Promise<Response>((resolve) => {
            rejectFirstRoleSave = () => resolve(jsonResponse({ error: 'failed' }, false, 503))
          })
        }
        return jsonResponse({})
      }
      throw new TypeError('api offline')
    })

    const user = userEvent.setup()
    render(<App />)
    await screen.findByText(/API 不可用，正在显示 mock 数据/)

    await user.click(screen.getByRole('button', { name: '设备' }))
    const row = screen.getByRole('row', { name: /客厅小米平板 428193 普通 192\.168\.88\.23/ })
    await user.click(row)

    await user.selectOptions(screen.getByLabelText('设备角色'), 'disabled')
    await waitFor(() => expect(screen.getByLabelText('设备角色')).toBeDisabled())
    rejectFirstRoleSave?.()
    expect(await screen.findByText('保存失败，已回滚')).toBeInTheDocument()
    expect(within(row).getByText('普通')).toBeInTheDocument()
    expect(screen.getByText('当前角色：普通')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试保存设备角色' }))
    expect(await screen.findByText('保存成功')).toBeInTheDocument()
    expect(within(row).getByText('禁用')).toBeInTheDocument()
    expect(screen.getByText('当前角色：禁用')).toBeInTheDocument()
    expect(roleRequests).toEqual([
      {
        body: JSON.stringify({ role: 'disabled' }),
        authorization: 'Bearer device-retry-token',
      },
      {
        body: JSON.stringify({ role: 'disabled' }),
        authorization: 'Bearer device-retry-token',
      },
    ])
  })

  it('在设置页保存管理员 Token，并用它刷新后台数据', async () => {
    const authHeaders: string[] = []
    vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      const authorization = init?.headers instanceof Headers ? init.headers.get('authorization') ?? '' : ''
      authHeaders.push(`${url}:${authorization}`)
      if (authorization !== 'Bearer saved-token') {
        return jsonResponse({ error: 'unauthorized' }, false, 401)
      }
      if (url === '/admin/books') {
        return jsonResponse({
          books: [
            {
              id: 'token-book',
              title: 'Token 书籍',
              author: '后台',
              chapterCount: 3,
              updatedAt: '2026-06-29T12:00:00.000Z',
              visibility: 'admin',
              labels: ['private'],
              summaryCoverage: 1,
              kgCoverage: 1,
              embeddingCoverage: 1,
              audioChapterCount: 3,
            },
          ],
        })
      }
      if (url === '/admin/devices') return jsonResponse({ devices: [] })
      if (url === '/admin/metrics') {
        return jsonResponse({
          requests: { last15Minutes: 1, last24Hours: 9, errorRate: 0, p95Ms: 45 },
          downloads: { packageLast24Hours: 1, audioLast24Hours: 2 },
        })
      }
      if (url === '/admin/events') return jsonResponse({ events: [] })
      if (url === '/admin/packages') {
        return jsonResponse({
          packages: [
            {
              id: 'token-package',
              bookId: 'token-book',
              bookTitle: 'Token 书籍',
              version: 'token-package-v1',
              status: 'ready',
              sizeMb: 9,
              updatedAt: '2026-06-29T12:01:00.000Z',
              chapterCount: 3,
              summaryCoverage: 1,
              kgCoverage: 1,
              embeddingCoverage: 1,
              missingChapters: [],
              checksum: 'sha256:token',
            },
          ],
        })
      }
      if (url === '/admin/audio') {
        return jsonResponse({
          audio: [
            {
              id: 'token-audio',
              bookId: 'token-book',
              bookTitle: 'Token 书籍',
              status: 'ready',
              chapterCount: 3,
              availableChapters: 3,
              coverage: 1,
              missingChapters: [],
              totalDuration: '00:30:00',
              sizeMb: 20,
              lastGeneratedAt: '2026-06-29T12:02:00.000Z',
              voice: 'Token 音色',
              downloads24h: 2,
            },
          ],
        })
      }
      if (url === '/admin/requests') {
        return jsonResponse({
          requests: [
            {
              id: 'token-request',
              time: '2026-06-29T12:03:00.000Z',
              method: 'GET',
              path: '/admin/packages',
              statusCode: 200,
              durationMs: 33,
              deviceName: 'Gateway Admin',
              deviceId: 'admin-ui',
              ip: '127.0.0.1',
            },
          ],
        })
      }
      return jsonResponse({}, false, 404)
    })

    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByText(/未授权：管理员 Token 无效或缺失/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '设置' }))
    await user.type(screen.getByLabelText('管理员 Token'), 'saved-token')
    await user.click(screen.getByRole('button', { name: '保存 Token' }))

    expect(window.localStorage.getItem(adminTokenStorageKey)).toBe('saved-token')

    await user.click(screen.getByRole('button', { name: '刷新后台数据' }))

    expect((await screen.findAllByText(/已连接 Gateway 管理 API/)).length).toBeGreaterThan(0)
    expect(screen.getByText('Gateway 管理 API')).toBeInTheDocument()
    expect(authHeaders).toContain('/admin/books:Bearer saved-token')
    expect(authHeaders).toContain('/admin/packages:Bearer saved-token')
    expect(authHeaders).toContain('/admin/audio:Bearer saved-token')
    expect(authHeaders).toContain('/admin/requests:Bearer saved-token')

    await user.click(screen.getByRole('button', { name: '书籍' }))
    expect(screen.getByRole('row', { name: /Token 书籍 后台 admin/ })).toBeInTheDocument()
  })
})

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response
}
