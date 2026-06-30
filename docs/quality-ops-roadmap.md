# 正规化测试与运维规划

更新时间：2026-06-30

快速开发阶段已经基本收束。接下来进入“产品规格 -> 测试设计 -> 系统性 Code Review -> 可运维性建设 -> 发布治理”的正规化阶段。本规划用于指导后续开发顺序和验收标准。

## 1. 阶段目标

- 把已实现能力沉淀为可维护的产品功能规格。
- 按功能规格设计完整测试用例矩阵。
- 用系统性 Code Review 找出数据一致性、安全边界、错误处理、性能和可维护性风险。
- 补齐 Gateway、Admin、Android、production-pipeline 的监控、日志、指标和运维手册。
- 建立可重复的发布、验证和回滚流程。

## 2. 工作原则

- 先固化规格，再补测试，再做运维增强。
- 新增测试优先覆盖高风险流程：数据破坏、鉴权越权、进度丢失、缓存串书、发布失败和模型调用失败。
- Code Review 不只看代码风格，重点看契约、边界、失败路径和恢复能力。
- 可运维性开发必须能落到指标、日志、事件、脚本、手册或告警阈值上。
- 每一阶段结束都更新 `docs/current_progress.md`，避免下一轮计划漂移。

## 3. 里程碑计划

### Phase 0：规格与入口文档

状态：已启动。

交付物：

- `docs/product-spec.md`：正式产品功能说明书。
- `README.md`：增加规格、测试与运维规划入口。
- `docs/current_progress.md`：记录正规化阶段计划。

验收标准：

- README 能让新开发者知道系统有哪些主功能和后续质量入口。
- 产品规格覆盖 PC、AI、知识图谱、RAG、生产流水线、Gateway、Admin UI、Android App。

### Phase 1：测试用例矩阵

目标：从产品规格拆出完整测试设计，先形成文档，再逐步自动化。

交付物：

- `docs/test-case-matrix.md`。
- 按功能域列出用例编号、前置条件、步骤、期望结果、自动化层级、风险等级和当前覆盖状态。
- 标记必须真机/真实 Gateway 验证的用例。

建议覆盖：

| 功能域 | 高优先级用例 |
|--------|--------------|
| PC 阅读器 | txt/epub 导入、章节拆分、多书进度、备份恢复 |
| AI 概要 | 单章/批量生成、失败重试、覆盖策略、模型配置错误 |
| 知识图谱 | 扫描、续扫、重扫预览、合并、拆分、删除、共指、复审队列 |
| RAG | embedding 覆盖率、chunk 召回、图谱增强、答案生成失败 |
| production-pipeline | job 校验、阶段续跑、子 run、publish、verify |
| Gateway API | admin/mobile 鉴权、书库可见性、package、audio、AI/RAG、downloads |
| Admin UI | 总览真实数据、书籍/设备操作、失败回滚、mock fallback 边界 |
| Android App | 首次连接、离线阅读、MP3 缓存、角色变化、阅读进度、应用更新 |

验收标准：

- 每个核心功能至少有一条正向用例和一条失败路径用例。
- 每个高风险操作都有回归用例编号。
- 明确哪些用例已自动化、哪些仍需手工或真机验证。

### Phase 2：自动化测试补齐

目标：把 Phase 1 的高价值用例转为可重复执行的自动化测试。

交付物：

- 根项目单元/浏览器 E2E 测试补强。
- `gateway/` 接口测试补强。
- `gateway/admin-ui/` UI 测试补强。
- `gateway-android-app/` 逻辑测试补强，真机验证清单文档化。
- `production-pipeline/` 阶段、续跑、发布校验测试补强。

优先级：

1. 鉴权与可见性：admin/mobile token、设备角色、书籍 visibility。
2. 数据一致性：多书阅读进度、图谱合并拆分、package 覆盖率、音频目录。
3. 失败路径：接口 401/403/404/500、模型失败、下载失败、缓存损坏。
4. 发布验证：package/audio/APK 发布后 Gateway 实际可见。

验收标准：

- 形成一组可作为 CI 候选的 smoke/regression 命令。
- 测试失败能定位到具体功能域和用例编号。
- 重要手工验证边界写入文档，不混入自动化假象。

### Phase 3：系统性 Code Review

目标：按模块进行结构化评审，输出可执行问题清单。

交付物：

- `docs/code-review-checklist.md`。
- 分模块 review 记录：PC Web/API、Gateway、Admin UI、Android App、production-pipeline、offline-tts。
- 问题分级：P0 数据/安全风险、P1 用户主流程风险、P2 可维护性/性能风险。

Review 重点：

- API 契约和错误格式是否稳定。
- 鉴权、设备角色和书籍可见性是否一致。
- 大文件 package/audio 是否存在重复解析、内存膨胀或阻塞。
- 批处理任务是否可恢复、可重试、可定位失败。
- 图谱高风险操作是否可审计、可回滚。
- 前端是否正确区分空数据、接口失败、未授权和 mock fallback。

验收标准：

- 每个 P0/P1 问题都有修复任务或明确暂缓理由。
- Review 结论能反向补充测试用例矩阵。

### Phase 4：可观测性与运维能力

目标：让系统在真实使用和发布时可定位、可监控、可恢复。

交付物：

- `docs/operations-runbook.md`。
- Gateway 指标与事件补强：请求量、错误率、P95、下载、设备、数据目录大小、package/audio 健康。
- production-pipeline 运行状态、阶段耗时、失败原因和发布验证结果可查询。
- Admin UI 运维态补强：真实数据优先、空状态明确、失败可重试。
- 日志规范和常见故障排查路径。

建议监控项：

| 对象 | 指标/事件 |
|------|-----------|
| Gateway | request count、error rate、P95、auth failures、download failures |
| 内容数据 | book count、package readiness、coverage、missing audio chapters |
| 设备 | total/trusted/disabled、最近连接、角色变化 |
| 发布 | package/audio/APK version、publish time、verify result |
| production-pipeline | run status、stage duration、failed item count、resume count |

验收标准：

- 线上问题能从 Admin UI 或日志快速判断是鉴权、数据、下载、模型还是发布问题。
- 运维手册包含启动、部署、发布、验证、回滚和常见故障处理。

### Phase 5：发布治理与回归节奏

目标：把发布前检查和回归测试变成固定流程。

交付物：

- `docs/release-checklist.md` 或更新现有 `docs/release-policy.md`。
- 发布前命令清单、手工验证清单、真机验证清单。
- PR 模板或 checklist，要求说明测试范围和运维影响。

验收标准：

- 每次发布都能回答：改了什么、测了什么、没测什么、如何回滚、如何确认线上健康。
- Gateway Android APK、package、audio 发布都有版本和验证记录。

## 4. 推荐执行顺序

1. 完成 Phase 0 文档入口。
2. 编写 `docs/test-case-matrix.md`，先只做设计，不急于写代码。
3. 按测试矩阵补最小高价值自动化测试。
4. 开展第一轮系统性 Code Review，并把发现的问题回填测试矩阵。
5. 补 Gateway/production-pipeline/Admin UI 的运维指标和 runbook。
6. 整理发布 checklist，把测试、监控和回滚串成固定流程。

## 5. 当前待办

- [ ] 建立完整测试用例矩阵。
- [ ] 标注现有测试覆盖与缺口。
- [ ] 选择第一批必须自动化的 P0/P1 用例。
- [ ] 制定系统性 Code Review checklist。
- [ ] 梳理 Gateway 与 production-pipeline 的运维指标缺口。
- [ ] 更新发布检查流程。
