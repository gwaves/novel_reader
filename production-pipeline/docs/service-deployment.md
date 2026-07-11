# 内容生产常驻服务部署

内容生产服务复用 `production-pipeline/src/service.mjs` 和现有 CLI。服务层只负责持久任务队列、并发调度、进程管理、恢复和可观测性，具体生产阶段仍由 CLI 执行，因此 `run.json`、`items.sqlite`、阶段日志和幂等恢复语义保持兼容。

## 常驻服务能力

- `jobs.json` 持久化任务队列。
- `PRODUCTION_PIPELINE_MAX_CONCURRENT_JOBS` 控制全局同时运行任务数，默认 1。
- 服务重启后，原 `running/stopping` 任务重新进入队列，并优先通过 `resume --run <run.json>` 恢复。
- `POST /api/jobs/:jobId/retry` 可将失败或已停止任务重新排队。
- `POST /api/jobs/:jobId/stop` 停止排队或运行任务。
- `events.jsonl` 输出结构化任务生命周期事件，包含 `job_id`、`book_id`、状态和尝试次数。
- `/health` 返回调度器运行数、排队数、并发上限和是否继续接收任务。
- `POST /api/sources` 上传 TXT、EPUB、PDF、MOBI、AZW/AZW3，`GET /api/sources` 查看服务端源文件。
- `POST /api/templates` 保存服务端 job 模板，`POST /api/templates/:name/start` 直接提交模板任务。
- `POST /api/backups` 使用 Node SQLite backup API 创建在线一致性主库备份；备份可列表和下载。

## 88.100 部署目录

部署目录固定为：

```text
/home/gwaves/production-pipeline-service/
  package.json
  package-lock.json
  production-pipeline/
    deploy/
      compose.yml
      Dockerfile
      .env
  data/
  runs/
  jobs/
  sources/
  backups/
```

首次部署：

```bash
cd /home/gwaves/production-pipeline-service
chmod +x production-pipeline/deploy/generate-env.sh
production-pipeline/deploy/generate-env.sh
mkdir -p data runs jobs sources backups
docker compose --env-file production-pipeline/deploy/.env -f production-pipeline/deploy/compose.yml config --quiet
docker compose --env-file production-pipeline/deploy/.env -f production-pipeline/deploy/compose.yml up -d --build
```

管理入口为 `http://192.168.88.100:6290`，只允许内网访问。Token 只保存在远端 `.env`，不提交 Git。

管理页的“Job 模板”区域提供可视化构建器：选择上传文件或主库书籍、勾选生产阶段并填写模型地址后，先生成 JSON，再执行服务端校验和保存。模型密钥使用 `LLM_API_KEY`、`EMBEDDING_API_KEY` 等远端环境变量，页面和模板详情不会返回真实密钥。

容器内生产数据库和 TTS 配置统一使用 `/home/node/.novel_reader/` 绝对路径，不要在服务模板中使用 `~/.novel_reader`，因为容器进程用户的 home 目录可能不同。

## 路径约定

容器中的 job JSON 必须使用容器路径：

- 主数据库：`/home/node/.novel_reader/novel_reader.sqlite`
- job 配置：`/app/jobs/*.json`
- 待导入源文件：`/app/sources/*`
- run 根目录：`/app/runs`
- Gateway 本机发布目录：`/home/gwaves/novel-reader-gateway`

从 macOS 迁移的 job JSON 不能继续引用 `/Users/gwaves/...`。部署前应生成服务专用 job 配置，不修改原有本地生产配置。

88.100 上的 `/home/gwaves/.novel_reader/novel_reader.sqlite` 从服务上线后视为生产主库。不要同时在 macOS 本地主库和88.100主库上执行会写数据的生产任务，否则两份SQLite会产生分叉。迁移完成后的常规生产应通过常驻服务提交；本机只用于开发测试或显式的数据迁移。

管理界面可以直接上传源文件、保存/启动模板、创建和下载主库备份。模板中的 `source.file` 只填写已上传文件名，服务保存时会转换为 `/app/sources/<文件名>`；`mainDbPath` 会强制使用生产主库，不能由模板改写到任意路径。

## 更新和验收

```bash
docker compose --env-file production-pipeline/deploy/.env -f production-pipeline/deploy/compose.yml config --quiet
docker compose --env-file production-pipeline/deploy/.env -f production-pipeline/deploy/compose.yml up -d --build
docker compose --env-file production-pipeline/deploy/.env -f production-pipeline/deploy/compose.yml ps
curl http://127.0.0.1:6290/health
```

升级或重启时，运行任务会收到终止信号并保留为可恢复状态；新容器启动后由调度器继续执行。
