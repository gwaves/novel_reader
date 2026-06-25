2026-06-25 更新：Gateway 移动书库索引 API 已进入最小可用形态。
- 产品边界补充：后续面向 Gateway 的 Android 移动端应单独新建应用目录/工程，保持现有 `mobile-app/` 不变，避免影响当前已可用的局域网/离线移动端。
- 新增独立 `gateway-android-app/` 客户端工程骨架，使用 Capacitor-ready React/Vite，不修改旧 `mobile-app/`；第一版支持配置 Gateway 地址、token、设备名，验证会话，拉取书库并读取单书 package。
- `gateway-android-app/` 已支持将单书 package 缓存到本地，离线/请求失败时优先回退到缓存；可从 package 中识别章节列表，选择章节并阅读正文。
- `gateway-android-app/` 已接入 Gateway 音频接口：打开书籍时同步 `/mobile/books/:bookId/audio`，当前章节有音频时可通过受保护下载接口加载并播放 MP3。
- 新增 Gateway Docker 部署材料：`gateway/Dockerfile`、`gateway/docker-compose.yml` 和 `gateway/docs/deployment.md`，优先支持云服务器/VPS 或家里机器公网映射部署。
- 新增第一版设备名记录：受保护请求可携带 `X-Device-Name`，`GET /auth/session` 会登记设备到 `GATEWAY_DATA_DIR/devices.json`，`GET /auth/devices` 可查看已登记设备。
- 新增 `GATEWAY_DATA_DIR` 配置，默认使用用户目录下的 `.novel_reader_gateway`，第一版从 `books.json` 读取书库索引。
- `GET /mobile/books` 已从占位接口升级为受保护的书库列表接口；缺少 `books.json` 时返回空书库，存在时校验 schema 并按更新时间排序。
- 新增 `GET /mobile/books/:bookId`，从同一书库索引返回单书摘要，未知书籍返回稳定 `book_not_found` 错误。
- 新增 `GET /mobile/books/:bookId/package`，从 `GATEWAY_DATA_DIR/books/<bookId>/package.json` 返回完整移动数据包；当前只校验 `schemaVersion` 和 `book.id`，其余内容先透明透传。
- 新增 `PUT /admin/books/:bookId/package`，支持 PC 端或工具上传移动数据包到 Gateway，并自动维护 `books.json` 书库索引。
- 新增 OpenAI-compatible 转发入口：`POST /ai/chat` 和 `POST /ai/embeddings`，移动端只访问 Gateway，服务端负责注入上游 API Key 和默认模型。
- 新增本地 MP3 受保护访问：`GET /mobile/books/:bookId/audio` 读取 `GATEWAY_AUDIO_DIR/books/<bookId>/audio.json`，`GET /mobile/books/:bookId/audio/:chapterId/download` 负责鉴权后下载音频文件。
- `/capabilities` 现在会标记 books API 可用；README 补充了 `books.json` 第一版格式。

2026-06-25 更新：Gateway 开始补齐开发期鉴权与受保护路由基础。
- 新增 Gateway 结构化 HTTP 错误与 dev bearer token 鉴权模块，`GATEWAY_DEV_ACCESS_TOKEN` 可用于保护后续移动端数据、AI 和音频接口。
- 新增 `GET /auth/session` 作为鉴权验证入口，新增受保护占位接口 `GET /mobile/books`，确保移动数据 API 在真实实现前也不会裸露。
- Gateway 测试覆盖未配置鉴权、缺少 token、错误 token、正确 token，以及受保护移动数据路由的占位行为。

2026-06-24 更新：云端 Gateway 方向已启动，新增 `codex/cloud-gateway` 分支与 `gateway/` 工作目录。
- 目标：让移动客户端默认连接固定公有域名，通过云端 Gateway 获取书籍数据、阅读进度、AI 检索、embedding 转发和 MP3 播放资源，减少用户手动配置局域网 IP、LLM、embedding 与音频后端的成本。
- 架构原则：Gateway 作为独立云端服务，不直接把现有本地 SQLite API 暴露到公网；公网接口默认鉴权、限流和审计，移动端不保存上游模型或对象存储密钥。
- 已新增 `gateway/README.md` 与 `gateway/docs/development-plan.md`，记录产品目标、模块边界、API 草案、安全要求、阶段计划和近期任务。
- 后续优先级：先搭建最小 Gateway 服务骨架（健康检查、版本、能力接口、配置加载、统一错误格式），再接入鉴权、移动端默认域名、书库同步、AI/embedding 转发和 MP3 资源分发。

2026-06-23 更新：PC 端离线多角色 TTS 方向已启动，先落地本地 Node.js 目录与文档。
- Android App 高质量 MP3 播放方向已另立 `codex/mobile-mp3-playback` 分支开发：PC Web 端新增当前书“章节 MP3 目录”配置入口，本地服务持久化目录并通过 `/api/mobile/books/:bookId/audio` 暴露移动端音频清单。
- PC 端章节 MP3 目录规范：推荐根目录直接放 `ch001.mp3`、`ch002.mp3`；兼容 `001-章节标题.mp3`；兼容现有 TTS 批量产物 `ch001/audio/chapter.mp3` 或 `ch001-full/audio/chapter.mp3`。
- Android App 语音阅读新增播放引擎选择：可在“本地 TTS”和“云端 MP3”之间切换；同步页可刷新 PC 音频清单并下载当前章节 MP3 到 IndexedDB `chapterAudio` 缓存。
- Android App 章节 MP3 下载 UI 已优化：按章节显示“已下载 / 未下载 / 需更新”状态，移除前 8 条截断，新增“全部下载”入口，可一次下载所有可下载但尚未缓存的章节，并在下载过程中显示章节进度。
- PC Web 端章节 MP3 目录预览已改为完整滚动列表，不再截断前 10 条，便于确认最新生成的章节音频。
- Android 云端 MP3 播放已同步语速设置：启动播放与播放中调整倍速都会更新 HTMLAudioElement 的播放速度。
- Android 语音阅读设置已按播放引擎分菜单：本地 TTS 显示语言、音色、音调和系统语音检测；云端 MP3 显示倍速和章节 MP3 同步下载。
- Android MP3 播放已接入章节正文高亮/滚动：使用整章 MP3 播放，按语音片段文本长度估算时间轴，`timeupdate` 驱动当前片段高亮、自动滚动和独立语音进度保存。
- 新增 `offline-tts/` 作为独立工作目录，集中放置多角色 TTS 的设计文档、开发计划、示例配置和 Node.js CLI 脚本。
- 技术选型确定：主流程使用 Node.js，本地程序通过配置文件调用第三方 OpenAI-compatible 模型生成导演脚本 JSON；Codex 不参与批量大模型推理。
- 第一阶段目标不是直接合成整章音频，而是先把小说章节转换为可检查的导演脚本，严格分离旁白、对白、内心独白，并结合知识图谱与角色音色绑定做 speaker 判定。
- 初始脚本 `offline-tts/scripts/tts-director.mjs` 已具备配置读取、列书、章节检查、规则预切分、KG 候选角色读取和 `draft-script` 调用形态。
- 补充音频输出策略：离线多角色 TTS 可用 WAV 作为中间缓存，但最终章节/整书音频默认编码为 MP3，减少磁盘占用。
- 移动端线上朗读倍速扩展：系统 TTS 语速支持到 3x，设置页新增 0.75x、1x、1.25x、1.5x、2x、3x 快捷档位。
- 已接入可用第三方模型配置：`http://192.168.88.24:30000/v1` + `qwen3.6-27b`，API key 为空时不带鉴权头。
- `draft-script` 已完成第一轮功能验证：对《妖刀记》第 1 章前约 1000 字生成导演脚本，输出 16 个片段，校验 0 错误 0 警告；旁白、采蓝、黄缨和黄缨内心独白均能分离。
- 预切分规则已修正：短名称引号（如「黄缨」「水月停轩」）不再误拆为对白；`心里想` 和括号心理活动会单独切为 `thought`；切片边界会避开未闭合对白引号。
- `synth` 命令已接入初版 MIMO TTS：读取导演脚本逐段合成 WAV 缓存，使用 ffmpeg 标准化、插入停顿、拼接并默认输出 `chapter.mp3`。
- TTS 合成已支持 `director.performanceStyle` 公共表演提示，用于统一中文有声小说语速、节奏和角色表演风格。
- 根据试听反馈，女性角色音色提示已加强“少女声线、清亮轻盈、避免成熟御姐感”的约束，用于改善采蓝和黄缨的年龄感。
- TTS 合成已支持并发控制：`tts.concurrency` 或 `synth --concurrency` 控制缺失缓存片段的并发合成，拼接与 MP3 编码仍保持顺序串行。
- 并发 3 已完成实测：16 个片段完整合成、拼接、MP3 编码约 27 秒，输出 `tmp/tts/yaodao/ch001/audio-concurrency-3/chapter.mp3`。
- 已确认 MIMO `mimo-v2.5-tts-voicedesign` 可用于音色设计实验，但不是当前预置音色 voice id 的直接替代；后续应先做采蓝/黄缨小样本 A/B，验证跨片段声线一致性。
- 整章导演脚本生成已改为分批模式：`director.segmentBatchSize` 或 `draft-script --batch-size` 控制每批预切分片段数，避免整章单请求超时。
- 《妖刀记》第 1 章完整功能验证已跑通：分批生成 206 段导演脚本，校验 0 错误 0 警告；TTS 并发 3 合成并编码为 MP3，用时约 325 秒，输出 `tmp/tts/yaodao/ch001-full/audio/chapter.mp3`，成品约 55 分钟、39.6 MB、96 kbps。
- 导演脚本生成已支持 LLM 批次并发：`director.concurrency` 或 `draft-script --concurrency` 控制并发数，结果按原始批次顺序合并。第 20 章实测并发 10 时 7 个批次约 66 秒生成 188 段脚本，校验 0 错误 0 警告。
- 《妖刀记》第 20 章完整语音已生成：TTS 并发 3 合成并编码为 MP3，用时约 263 秒，输出 `tmp/tts/yaodao/ch020-full/audio/chapter.mp3`，成品约 40 分 50 秒、29.4 MB、96 kbps。
- 多 agent 并发生成第 19、21、22、23、24 章时观察到：多个章节同时进入高并发 LLM 阶段会造成内网模型超时或卡顿；已新增 `batch-pipeline` 命令，采用章节级流水线，LLM 阶段串行、TTS 阶段并行，推荐后续批量生成整本时使用。

2026-06-21 最新状态：main 已同步到 PR #21 和 PR #22。

2026-06-21 更新：`mobile-app-dev` 分支已推进到可安装 Android 调试包。
- `mobile-app` 已生成 Capacitor Android 工程，并可通过 Gradle 编译 `app-debug.apk`。
- 本机 Android 构建环境已验证：Homebrew `openjdk@21`、`android-commandlinetools`、Android 36 platform/build tools。
- PC 端 `/api/mobile/*` 同步接口已可返回真实书架和单书完整数据包；后端可用 `NOVEL_READER_API_HOST=0.0.0.0 npm run api` 监听局域网。
- Android App 已修复 LAN HTTP 同步限制和系统状态栏覆盖问题：允许 cleartext HTTP，并通过 Capacitor StatusBar + CSS safe-area 处理顶部布局。

2026-06-21 更新：独立 Android 移动端方向已确定，并新增 PC 端配套计划。
- 移动端将作为独立 `mobile-app` workspace 开发，定位为离线可用的完整数据消费端，而不是 PC 局域网 API 的实时面板。
- PC 端继续负责书籍导入、概要、知识图谱、正文 chunk embedding 和概要 embedding 生成；移动端不生成书籍/章节/chunk embedding。
- PC 端后续需要提供 `/api/mobile/manifest`、`/api/mobile/books`、`/api/mobile/books/:bookId/package` 等同步接口，导出单书完整移动数据包。
- 第一版移动数据包使用 JSON 验证端到端流程，包含章节、概要、图谱证据和 PC 端已生成 embedding；不包含 LLM API Key 或桌面端敏感模型配置。
- 移动端离线 RAG 第一版应优先使用本地 FTS/摘要/图谱匹配构造上下文，再调用移动端配置的公共 LLM 生成回答。

本轮合入内容：
- PR #21：离线扫描数据包导入闭环完成。离线扫描器可按书导出 JSON 数据包，首页可导入单书概要与知识图谱数据；导入时有阶段提示和忙碌进度，章节扫描 UI 改为更紧凑的范围选择和并发 worker 进度列表。
- PR #22：长章节 RAG embedding 策略完成 v1。新增 `chapter_chunk_embeddings`，搜索融合章节概要向量、正文 chunk 向量和知识图谱实体召回，避免 2 万字长章节被压成单个向量。

进入后续阶段：质量评估、审计与回滚。
- 目标 1：建立可重复的质量评估面板，覆盖概要、知识图谱抽取、实体共指、RAG 搜索命中率和耗时。
- 目标 2：为高风险图谱操作建立审计日志和回滚能力，覆盖共指合并、实体/关系批量删除、覆盖重扫、离线数据包导入。
- 目标 3：继续增强搜索体验，在 chunk RAG 基础上增加召回解释、章节范围过滤、实体类型过滤，并评估是否引入 FTS5。

2026-06-20 更新：开始 Reader UX polish 分支开发（`codex/reader-ux-polish`）。

采纳的阅读交互方向：
- 阅读设置面板：主题、字号、行高、段距、正文宽度等长期阅读参数。
- 阅读进度与恢复：显示章节内进度，并持久化每章滚动位置，回到章节时恢复上次读到的位置。
- 正文手势与快捷键：桌面扩展 Space/J/K/PageUp/PageDown/`[`/`]`，移动端增加正文左右点击翻屏。
- 阅读中轻量 AI：优先做选中文本后的轻量操作入口，将文本带入智能搜索；后续再扩展为段落解释、人物/道具追踪和本段关联图谱。

本分支第一批实现目标：
- 扩展共享阅读偏好状态，并让桌面/移动端共用。
- 桌面阅读页增加主题、行高、正文宽度、段距控件和章节进度条。
- 桌面/移动端保存并恢复章节内滚动位置。
- 移动端阅读页增加进度条、主题样式和正文点击翻屏。
- 桌面端选中文本后提供“搜索”入口，作为轻量 AI 的第一步。

2026-06-20 更新：EPUB 导入 v1 已开始。
- 目标：在现有本地书架中直接导入 `.epub`，复用已有阅读、概要、RAG 和知识图谱流程。
- 实现策略：浏览器端解析 EPUB zip，不新增运行时依赖；读取 `META-INF/container.xml` 定位 OPF，按 manifest/spine 顺序读取 XHTML 章节。
- 当前范围：先将 XHTML 正文转为纯文本章节导入，不保留原 EPUB 图片、CSS、脚注跳转和复杂排版。
- UI：桌面端和移动端文件选择器支持 `.txt` / `.epub`。

2026-06-20 最新状态：main 已同步到 PR #18 之后，知识图谱/RAG 的核心闭环已进入可用增强阶段。

已完成并合入 main：
- Phase 3 图可视化：实体一跳关系图、全局筛选图、实体名称/别名定位、核心节点数量控制、图例和节点可读性优化。
- Phase 4 图谱维护：实体编辑/合并/批量合并/拆分/删除，关系类型和源/目标端点修正，低置信度复审队列。
- Phase 4+ 共指清洗：新增全局 LLM coreference pass，按疑似人物组件调用模型判断同一身份并自动合并实体、别名、证据和冲突关系。
- Phase 5 图谱搜索与导出：证据搜索、JSON/GraphML 导出。
- RAG 搜索：章节概要 embedding、正文 chunk embedding、向量召回 + 图谱实体增强、搜索结果答案生成。
- RAG 配置：embedding 配置已从生成模型配置中解耦，保存配置时分别校验 LLM 与 embedding；embedding 校验改由本地后端代理，避免浏览器 CORS 问题，并记录向量维度。
- 数据管理：完整 SQLite 数据库备份/恢复，书名可在书架和当前书详情中编辑。
- 复审队列：支持批量标记已审/忽略，也支持按实体或关系批量删除。

当前建议的下一步：
1. 优先做“质量评估与回归测试面板”：为概要、图谱抽取、重扫、共指合并和 RAG 搜索建立可重复的样例书/章节测试集，记录准确率、误合并、漏合并、搜索命中率和耗时。
2. 然后做“图谱/RAG 操作审计与回滚”：共指合并、批量删除、重扫覆盖都已经具备较大破坏力，下一步应给这些操作增加变更记录和一键撤销/恢复能力。
3. 再考虑“搜索体验增强”：把图谱证据 LIKE 搜索升级为 FTS5，RAG 搜索增加按章节范围/实体类型过滤，并展示召回解释。

2026-06-20 更新：长章节 embedding 策略 v1 已完成。
- 后端：新增 `chapter_chunk_embeddings`，正文按段落切为约 1200 字 chunk 并带少量 overlap，避免 2 万字长章节被压成单个向量。
- RAG：搜索时融合章节概要向量、每章最佳正文 chunk 向量和知识图谱实体召回，结果片段优先展示命中的正文 chunk。
- UI：桌面端和移动端 embedding 覆盖率增加正文片段计数，生成进度显示已处理章节和 chunk 数。

判断：继续堆新功能前，最值得开发的是测试评估 + 可回滚的清洗流程。现在图谱维护能力已经很强，下一阶段的风险不在“能不能改”，而在“改错了能不能发现和恢复”。

按路线文档对照，现在我们已经超出 Phase 1，进入 Phase 2 后段了。
已完成：
SQLite 图谱表
图谱 API
章节级 extraction 保存
当前章节/范围/全书扫描
并发控制（默认并发 10）
跳过已扫描章节
已扫描章节列表
实体列表 + 名称/别名搜索 + 类型筛选
实体详情（出现次数、关系数、first/last seen、证据章节跳转）
关系列表 + 类型筛选
关系详情（源/目标实体、证据章节列表、跳转阅读器）
扫描任务持久化与刷新后恢复
实体编辑（名称、类型、别名、描述）
实体合并（选择主实体、合并别名和关系）
实体删除
关系删除
实体拆分（支持拆到新实体/已有实体、迁移别名/出现章节/关系）
启动后自动检查并恢复 pending 扫描任务
关系类型编辑（支持从关系详情修改类型和描述，含冲突检测）
批量合并实体（实体列表多选后一次性合并到主实体）
低置信度标记与复审队列（自动标记可疑实体/关系，支持批量审核）
阅读器批量生成全书缺失概要

接下来最该做的是 Phase 4 的实体消歧/纠错补完：
实体按类型筛选：人物、门派、道具、功法、地点、灵兽（已完成）
实体名称/别名搜索（已完成）
关系按类型筛选（已完成）
实体详情里显示 first/last seen、出现次数、关系次数（已完成）
实体编辑/合并/删除 v1（已完成）
实体拆分（已完成）
启动后自动恢复 pending 扫描任务（已完成）
关系类型编辑（已完成）
批量合并实体（已完成）

然后可以继续做：
低置信度标记与复审队列 ✅ 已完成
关系源/目标实体切换 ✅ 已完成

现在 Phase 4 的清洗与纠错闭环已经补齐，可以开始 Phase 3 图可视化。优先做实体一跳关系图，暂不渲染全书大图。

2026-06-18 更新：低置信度标记与复审队列已合并到 main。
- DB：kg_entities / kg_relations 新增 review_status 列（NULL/approved/ignored）。
- API：新增 GET /api/kg/review-queue、POST /api/kg/review-queue/mark。
- 启发规则：实体置信度 < 0.6、类型为 other、名称过短、别名可疑、缺少描述；关系置信度 < 0.6、类型为 related_to、缺少描述、自环。
- UI：知识图谱页面新增“待复审”统计按钮与复审队列面板，支持按实体/关系筛选、批量选择、标记已审/忽略/删除/编辑。
- 编辑/合并实体或关系后会自动重置 review_status 为 NULL，以便重新评估。

2026-06-18 更新：性能优化与 bug 修复（已提交 PR，待合并）。
- PR #5：为 kg_entity_mentions、kg_relation_mentions 增加 chapter_id 索引，并为 kg_chapter_extractions 增加 book_id 索引。知识图谱“已扫描章节”接口从 ~8.3s 降至 ~0.02s。
- PR #6：阅读器切换章节后自动滚动到章节顶部，修复方向键/按钮翻页后阅读位置不重置的问题。
- PR #7：修复自动恢复扫描时会重复扫描已完成章节的 bug。恢复前会先拉取最新已扫描章节列表，确保只扫真正 pending 的章节。

2026-06-18 更新：修复恢复扫描仍从已扫描章节重复开始的问题，并新增停止扫描按钮。
- 修复根因：`resumeKnowledgeGraphScan` 调用 `fetchKgScannedChapters()` 后，旧代码立即读取 `kgScannedChapters` 这个 React state 闭包，导致拿到的是刷新前的空数组，从而把全书都当成 pending。现在 `fetchKgScannedChapters()` 返回最新已扫描章节列表，恢复扫描时直接用返回结果计算 pending 章节。
- 新增停止扫描：扫描过程中显示「停止扫描」按钮，设置 `shouldStopScanningRef` 标志让并发 worker 在处理完当前章节后退出，任务状态记为 `cancelled`，UI 显示「已停止」。
- 清理了数据库中遗留的 `running` 扫描任务，避免启动后仍显示旧任务。

2026-06-18 更新：阅读器新增「批量生成全书缺失概要」。
- `useReaderState` 新增 `handleBatchGenerateAllMissingSummaries()`：过滤全书中没有概要的章节，使用现有并发设置批量调用 AI 生成，并逐章保存到 state/summaries 表。
- 缺失章节 >50 时弹出确认对话框，避免误触产生大量模型调用。
- 单个章节失败不会中断整批任务，最后会报告成功/失败数量。
- 桌面端 AI 面板和移动端概要页均新增按钮，状态栏同时显示全书和本页概要进度。

当前已知问题（非本功能引入）：
- npm run lint 存在 7 个 pre-existing error/warning，集中在 useReaderState.ts 和 App.tsx 的 useEffect 依赖/setState 模式。TypeScript 编译和 vite build 均通过。

已完成：
- 关系源/目标实体切换（关系纠错）
现在可以在关系详情中把 source 或 target 改成另一个实体，解决抽取时端点错误的问题。

2026-06-19 更新：修复离线扫描器偶发 `fetch failed` 并支持断点续传时重试失败章节。
- `scripts/offline-scanner/llm.mjs`：新增 `fetchWithRetry`，对 `TypeError: fetch failed`、`AbortError`、`ECONNRESET`、`ETIMEDOUT`、`ECONNREFUSED` 等瞬态网络错误最多重试 3 次，退避间隔 500ms/1000ms/2000ms；单次请求默认超时 5 分钟（可通过 `OFFLINE_REQUEST_TIMEOUT_MS` 覆盖）。
- `scripts/offline-scanner/scanner.mjs` + `db.mjs`：`resume` 恢复任务时自动将 `failed` 章节重置为 `pending`，避免失败章节被跳过。
- 更新 `README.md`、新增 `README.zh-CN.md`，新增 `docs/development.md`、`docs/development.zh-CN.md` 完善开发文档。

2026-06-19 更新：关系源/目标实体切换已完成。
- API：`PUT /api/kg/relations/:id` 支持同时更新 `sourceId`、`targetId`、`type`、`description`。
- 冲突处理：如果新端点 + 关系类型已存在，会把当前关系的证据迁移到已有关系，删除旧关系，并重新计算关系 first/last seen。
- 校验：禁止自环端点，禁止跨书实体作为关系端点，端点实体不存在时返回错误。
- UI：关系编辑弹窗新增源实体/目标实体搜索选择，保存后刷新关系列表、关系详情和复审队列。
- 复审：关系编辑或端点切换后会重置 review_status，方便重新进入启发式复审判断。

接下来建议：
- 章节重扫与图谱重建
允许对单章或章节范围重新抽取，并从保存的 raw extraction 重放图谱写入。这样可以在提示词、模型或人工修正策略变更后，有控制地刷新局部图谱数据。

2026-06-19 更新：Phase 3 图可视化 v1 已完成。
- 目标：先做实体一跳关系图，不渲染全书大图。
- 后端：新增实体 neighborhood 查询，返回中心实体、邻居实体和一跳关系。
- UI：实体详情新增“关系图”，使用 React Flow 展示一跳关系，并支持实体类型/关系类型过滤。

2026-06-19 更新：Phase 3 全局筛选图 v1 已完成。
- 后端：新增 `GET /api/kg/graph`，按书籍、实体类型、关系类型和限量返回可控规模的关系图。
- UI：知识图谱统计区新增“图谱视图”，默认展示人物图，可切换人物、门派、道具、功法、地点、灵兽、事件和关系类型。
- 渲染策略：仍避免无限全书大图，按高证据关系限量取图，并支持点击节点/边跳转实体详情或关系详情。

2026-06-19 更新：Phase 5 图谱证据搜索 v1 已完成。
- 后端：新增 `GET /api/kg/search`，支持搜索实体出现证据、关系证据、实体/关系描述、实体名称和章节标题。
- UI：知识图谱统计区新增“证据搜索”，可搜索全部/实体/关系证据，并从结果跳转实体详情、关系详情或阅读器章节。
- 策略：先使用 SQLite LIKE 查询，不新增迁移；后续数据量继续扩大时可替换为 FTS5。

2026-06-19 更新：Phase 5 图谱导出 v1 已完成。
- 后端：新增 `GET /api/kg/export`，支持导出完整知识图谱 JSON 或 GraphML。
- JSON：包含书籍信息、实体、关系和章节级证据 mentions，便于备份或后续二次处理。
- GraphML：导出节点/边及 label、type、description、confidence、mentionCount、first/last chapter 等属性，可导入 Gephi 等图分析工具。

2026-06-19 更新：数据库整体备份/恢复 v1 已完成。
- 后端：新增 `GET /api/database/export`，使用 SQLite `VACUUM INTO` 生成一致性 `.sqlite` 备份下载。
- 后端：新增 `POST /api/database/import`，上传 `.sqlite` 后校验完整性和关键表，先备份当前数据库，再把恢复文件排队到下次服务启动替换。
- UI：首页新增“数据库备份”，支持备份完整数据库和选择备份文件恢复；恢复会提示重启本地数据库服务后生效。

2026-06-20 更新：离线扫描单书数据包导入 v1 已完成。
- CLI：`node scripts/offline-scanner.mjs bundle <bookId> [path]` 可把某本书的概要、章节级 KG extraction、实体、关系和证据导出为 JSON 数据包。
- 后端：新增 `POST /api/offline/import`，校验数据包格式、书籍 ID 与章节归属后，将该书概要 upsert，并全量替换该书知识图谱数据。
- UI：首页新增“离线扫描数据”入口，可选择单书 JSON 数据包导入，导入后刷新书架概要快照和当前图谱统计。

2026-06-19 更新：章节图谱 diff 预览 v1 已完成。
- 后端：新增章节 extraction diff 预览接口，对比当前章节已写入图谱证据和候选 extraction JSON。
- UI：手动保存当前章节 JSON 前会先显示新增/移除/不变实体和关系证据，确认后才写入。
- UI：覆盖重扫 10 章以内会先生成 extraction 并汇总 diff，确认后应用，避免局部重建直接覆盖。

2026-06-19 更新：章节重扫与 raw extraction 重放已完成。
- 后端：`PUT /api/kg/chapters/:id/extraction` 覆盖保存时会重写该章节图谱证据，并重新计算受影响实体/关系的 first/last seen。
- 后端：新增 `POST /api/kg/chapters/:id/replay`，可从 `kg_chapter_extractions.extraction_json` 重放写入图谱，不重新调用模型。
- 清理：重写章节后会删除没有证据的空关系，以及没有出现章节和关系的空实体，避免局部重建后留下陈旧节点。
- UI：章节扫描面板新增“覆盖已完成章节”，可对当前章节/当前页/指定范围/全书重新抽取。
- UI：章节扫描面板新增“重放已保存 JSON”，用于按当前选择范围从已有 raw extraction 重建图谱。
- 验证：`npm run build` 通过；使用临时 SQLite 数据库走通保存 extraction、replay、覆盖为空后清理旧实体/关系。`npm run lint` 仍为既有 7 个 error/10 个 warning，集中在 React hooks 和正则 escape。

2026-06-19 更新：实体拆分已完成。
- API：新增 `POST /api/kg/entities/:id/split`，可从源实体拆出新实体，或拆到已有实体。
- 数据迁移：支持迁移选中的 `kg_entity_mentions`，并重新计算源实体和新实体 first/last seen。
- 关系迁移：支持迁移选中的相关关系，把关系端点从源实体切到新实体；如果迁移后撞到已有同类型同端点关系，会合并证据并删除旧关系。
- 别名迁移：支持把源实体的选中别名迁到新实体或已有实体，并从源实体别名中移除。
- 校验：新实体名称不能为空，不能与同书同类型实体重名；已有目标实体不能是源实体且必须同书；被迁移的出现章节和关系必须属于源实体。
- UI：实体详情新增“拆分”按钮，弹窗内可选择拆到新实体或已有实体，填写新实体信息/搜索已有实体，并勾选要迁出的别名、出现章节和关系。
- 复审：拆分后重置源实体、新实体和迁移关系的 review_status，便于后续重新复审。

2026-06-19 更新：图谱视图展示优化已完成。
- UI：全书图谱新增实体名称/别名定位，命中后只展示匹配实体及其一跳邻居，便于从大图中快速聚焦。
- UI：全书图谱新增核心节点数量控制，默认展示核心 80 个节点，可切换核心 40/140 或全部。
- 渲染：节点宽度和关系线宽会按出现次数调整，匹配节点高亮，图例展示当前可见节点/关系数量。
- 视觉：图谱节点支持自动换行、阴影和更稳定的尺寸，减少长名称挤压和大图混乱感。
- 页面：移除底部重复实体列表，将当前章节手动 JSON 保存入口收进章节扫描的折叠高级操作，减少主页面干扰。

2026-06-26 更新：Gateway 数据发布脚本已完成。
- 新增 `gateway/scripts/publish-package.mjs`，可从 PC 本地 `/api/mobile/books/:bookId/package` 读取移动端完整数据包，并上传到 Gateway 的 `PUT /admin/books/:bookId/package`。
- 根脚本新增 `npm run gateway:publish-package`，支持 `GATEWAY_BASE_URL`、`GATEWAY_DEV_ACCESS_TOKEN`、`NOVEL_READER_API_BASE_URL`、`NOVEL_READER_SYNC_TOKEN` 等环境变量，也支持 `--source-file` 和 `--dry-run`。
- Gateway 导入移动端数据包时兼容本地 API 的数字 book id，并在 package 缺少 `book.updatedAt` 时用 `generatedAt` 或 `book.importedAt` 回填书库索引更新时间。
- README 与 Gateway 开发计划已补充脚本发布路径，PC 端暂不新增发布 UI，后续 MP3 产物也优先按脚本化发布路线推进。
