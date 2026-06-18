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
启动后自动恢复 pending 扫描任务（已完成）
关系类型编辑（已完成）
批量合并实体（已完成）

然后可以继续做：
低置信度标记与复审队列 ✅ 已完成
关系源/目标实体切换

我不建议马上做 Phase 3 图可视化。现在数据还没清洗，直接画图会很热闹，但会把错误放大。先把查询、筛选、纠错做起来，图谱会更扎实。

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

接下来建议：
- 关系源/目标实体切换（关系纠错）
允许在关系详情中把 source 或 target 改成另一个实体，解决抽取时端点错误的问题。

做完这个，关系纠错能力会进一步提升，为后续图可视化打下更干净的数据基础。

2026-06-19 更新：修复离线扫描器偶发 `fetch failed` 并支持断点续传时重试失败章节。
- `scripts/offline-scanner/llm.mjs`：新增 `fetchWithRetry`，对 `TypeError: fetch failed`、`AbortError`、`ECONNRESET`、`ETIMEDOUT`、`ECONNREFUSED` 等瞬态网络错误最多重试 3 次，退避间隔 500ms/1000ms/2000ms；单次请求默认超时 5 分钟（可通过 `OFFLINE_REQUEST_TIMEOUT_MS` 覆盖）。
- `scripts/offline-scanner/scanner.mjs` + `db.mjs`：`resume` 恢复任务时自动将 `failed` 章节重置为 `pending`，避免失败章节被跳过。
- 更新 `README.md`、新增 `README.zh-CN.md`，新增 `docs/development.md`、`docs/development.zh-CN.md` 完善开发文档。
