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
