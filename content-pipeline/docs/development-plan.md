# 内容生产流水线开发计划

## Phase 0：规划与骨架

- [x] 新建 `content-pipeline/` 目录。
- [x] 编写设计文档、开发计划和示例配置。
- [x] 新增 `content-pipeline/scripts/content-pipeline.mjs`。
- [x] 定义第一版 `production-manifest.json`。
- [x] 在根 `package.json` 增加 `content:pipeline` 脚本。
- [x] 支持 `--config` / `CONTENT_PIPELINE_CONFIG` 读取默认路径、Gateway 地址和脚本位置。
- [x] 失败时把阶段错误写回 manifest，避免长任务失败后丢失诊断。

验收标准：

- [x] 可以创建 manifest。
- [x] 可以查看 manifest 状态。
- [x] 可以 dry-run 执行生产步骤。
- [x] `node --check` 通过。

## Phase 1：已有书籍生产编排

- [x] `run --steps import,scan,export` 调用离线扫描器完成 summary 和 kg。
- [x] `run --steps audio` 调用 TTS batch-pipeline。
- [x] `run --steps publish-package,publish-audio` 调用 Gateway 发布脚本。
- [x] 每个阶段写入开始时间、结束时间、错误、产物路径和命令摘要。
- [x] `scan` 前默认从 PC 主数据库同步当前大模型配置，避免离线配置陈旧。
- [x] 用真实主数据库书籍跑通不触发模型的 `import` 和 `status`。
- [x] 用真实已完成音频目录跑通 `publish-audio`。
- [x] 在确认成本和模型服务状态后跑真实 `scan` 或 `audio`。

验收标准：

- 对主数据库已有书籍可完成 package 发布闭环。
- 对已有 TTS 输出可完成 audio 发布闭环。
- 阶段失败后 manifest 保留失败原因，重新执行不会丢失历史。
- 新导入小书可完成 `ingest -> import -> scan summary -> export -> embedding -> publish-package` 验证闭环。

## Phase 2：导入层接入

- [x] 抽出 TXT/EPUB 导入能力供 CLI 调用。
- [x] 支持 `ingest --file <path>`，生成或返回 `bookId`。
- [x] 文件 hash 进入 manifest，用于重复提交去重。
- PDF 先只支持文本型 PDF，扫描件 OCR 单列后续阶段。

验收标准：

- [x] TXT 和 EPUB 可以从命令行导入并进入生产流水线。
- [x] 重复导入同一文件可以识别 hash。
- [x] 导入失败时保留错误与原始文件信息。

## Phase 3：embedding 独立生产

- [x] 梳理当前 embedding 生成入口。
- [x] 新增独立 CLI 或本地 API 批量触发能力。
- [x] 将 summary embedding 和 chapter chunk embedding 生产状态写入 manifest。

验收标准：

- [x] 不打开前端也能批量生成移动端所需 embedding。
- [x] manifest 可显示 embedding 模型、维度、覆盖率。

## Phase 4：Gateway 任务化

- Gateway 增加上传入口，保存原始文件与任务记录。
- Gateway 任务状态与 production manifest 对齐。
- 生产进程可轮询或接收 Gateway job。
- 移动端新增提交入口和任务状态页。

验收标准：

- 移动端可上传文件到 Gateway。
- Gateway 返回任务 ID。
- 生产完成后移动端可在书库看到新书。
