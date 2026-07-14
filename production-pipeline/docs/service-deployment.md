# 内容生产常驻服务部署

内容生产服务复用 `production-pipeline/src/service.mjs` 和现有 CLI。服务层只负责持久任务队列、并发调度、进程管理、恢复和可观测性，具体生产阶段仍由 CLI 执行，因此 `run.json`、`items.sqlite`、阶段日志和幂等恢复语义保持兼容。

## 常驻服务能力

- `jobs.json` 持久化任务队列。
- `PRODUCTION_PIPELINE_MAX_CONCURRENT_JOBS` 控制全局同时运行任务数，默认 1。
- 服务重启后，原 `running/stopping` 任务重新进入队列，并优先通过 `resume --run <run.json>` 恢复。
- 生产子进程非零退出后，服务默认按 30 秒起步的指数退避自动 `resume`，最多 5 次；已完成章节和阶段不会重做。达到上限后才标记为需要人工处理。
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
chown -R "$(id -u):$(id -g)" data runs jobs sources backups /home/gwaves/.novel_reader /home/gwaves/novel-reader-gateway
docker compose --env-file production-pipeline/deploy/.env -f production-pipeline/deploy/compose.yml config --quiet
docker compose --env-file production-pipeline/deploy/.env -f production-pipeline/deploy/compose.yml up -d --build
```

管理入口为 `http://192.168.88.100:6290`，只允许内网访问。Token 只保存在远端 `.env`，不提交 Git。

管理页的“Job 模板”区域提供可视化构建器：选择上传文件或主库书籍、勾选生产阶段并填写模型地址后，先生成 JSON，再执行服务端校验和保存。模型密钥使用 `LLM_API_KEY`、`EMBEDDING_API_KEY` 等远端环境变量，页面和模板详情不会返回真实密钥。

容器内生产数据库和 TTS 配置统一使用 `/home/node/.novel_reader/` 绝对路径，不要在服务模板中使用 `~/.novel_reader`，因为容器进程用户的 home 目录可能不同。

## 运行用户和文件权限

生产服务会把 Gateway 目录挂载到容器内，并可能通过 `publish.gatewayDataDir` / `publish.gatewayAudioDir` 直接写入 `/home/gwaves/novel-reader-gateway/data` 和 `/home/gwaves/novel-reader-gateway/audio`。容器必须使用与宿主机 Gateway 目录所有者一致的 UID/GID 运行；88.100 上固定为 `gwaves:gwaves`，即 `1000:1000`。

88.100 这种 Production Pipeline 和 Gateway 在同一台机器上的部署，不应通过 SSH 发布到 `gwaves@192.168.88.100`。Gateway 根目录已经挂载进容器，job 只需要配置 `gateway.root: "/home/gwaves/novel-reader-gateway"`；生产流水线会自动使用本地 `data/` 和 `audio/` 目录发布。只有 Gateway 部署在另一台机器、容器内无法看到 Gateway 根目录时，才使用 `gateway.host` / `gateway.user` 的远程 SSH 发布。

`production-pipeline/deploy/compose.yml` 默认通过 `PRODUCTION_PIPELINE_SERVICE_UID=1000` 和 `PRODUCTION_PIPELINE_SERVICE_GID=1000` 运行生产服务。不要把常驻生产服务改回 root。root 容器直接发布到 Gateway 挂载目录时，会生成 `root:root` 的 `package.json`、`audio.json` 或章节音频目录，后续 Gateway 管理后台、发布脚本和普通用户进程可能无法更新这些文件。

部署或排查权限问题时，用下面的命令确认：

```bash
docker compose --env-file production-pipeline/deploy/.env -f production-pipeline/deploy/compose.yml exec production-service id
find /home/gwaves/novel-reader-gateway/data/books /home/gwaves/novel-reader-gateway/audio/books -maxdepth 2 \( -user root -o -group root \) -print | head
```

第一条应显示 `uid=1000` / `gid=1000`。第二条应没有输出；如果发现 root-owned 产物，应先修正宿主机文件所有者，再恢复或重跑发布。

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

自动恢复由以下环境变量控制：

```dotenv
PRODUCTION_PIPELINE_AUTO_RETRY_FAILURES=true
PRODUCTION_PIPELINE_MAX_AUTOMATIC_RETRIES=5
PRODUCTION_PIPELINE_AUTOMATIC_RETRY_BASE_DELAY_MS=30000
PRODUCTION_PIPELINE_AUTOMATIC_RETRY_MAX_DELAY_MS=600000
```

自动重试只会在已经产生可用 `run.json` 时启用。没有持久运行状态的配置错误仍会直接失败，避免重复执行可能不幂等的首次启动命令。
