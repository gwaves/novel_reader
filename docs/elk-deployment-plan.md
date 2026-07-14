# 88.100 ELK 日志平台部署计划

> 实施状态：2026-07-11 已完成阶段 A-C 和基础运维验收。Elasticsearch、Kibana、Filebeat 已部署到 88.100，三类 Gateway 日志已入库；跨主机生产流水线采集不再单独扩展，下一阶段将生产流水线改造成常驻服务后直接接入同一平台。

## 1. 目标

在 `192.168.88.100` 上部署一套自托管、单节点的 Elastic 日志平台，集中管理 Novel Reader 的 Gateway、移动端诊断和生产流水线日志，同时保留现有 JSONL、阶段日志和 `run.json` 作为原始运行记录。

第一阶段采用精简 ELK 路线：

- Elasticsearch：日志存储、检索、聚合和生命周期管理。
- Kibana：Discover、仪表盘、告警和平台管理。
- Filebeat：采集 88.100 上的容器日志和 Gateway JSONL。
- 暂不部署 Logstash；只有出现复杂多路转换或外部消息队列需求时再引入。

## 2. 真实环境基线

2026-07-11 对 88.100 进行了只读检查：

| 项目 | 当前状态 |
| --- | --- |
| 主机 | `evo2`，Linux x86_64 |
| CPU | 32 核 |
| 内存 | 62 GiB，总可用约 55 GiB |
| Swap | 8 GiB，当前未使用 |
| 系统盘 | 953 GiB XFS，约 614 GiB 可用 |
| Docker | Engine 28.3.3，Compose 2.39.1 |
| Elasticsearch 前置参数 | `vm.max_map_count=1048576`，满足要求 |
| 已用端口 | 6180、8888、11434 |
| ELK 常用端口 | 5601、9200、9300、5044 当前未占用 |
| Gateway 部署目录 | `/home/gwaves/novel-reader-gateway` |
| Gateway 结构化日志 | `/home/gwaves/novel-reader-gateway/data/logs`，当前约 2.2 MiB |
| 生产流水线日志 | 不在 88.100；主要位于实际任务执行机的 `tmp/production-pipeline/runs` |

## 3. 目标拓扑

```text
88.100 Gateway stdout ─┐
Gateway requests JSONL ├─> 88.100 Filebeat ─┐
Gateway mobile JSONL ──┘                    │
                                            ├─> Elasticsearch ─> Kibana
生产任务执行机 runs/**/logs ─> Filebeat ────┘
```

部署目录建议固定为：

```text
/home/gwaves/elastic-observability/
  compose.yml
  .env
  config/
    elasticsearch.yml
    kibana.yml
    filebeat.yml
  data/
    elasticsearch/
    filebeat/
  snapshots/
```

ELK 与 Gateway 使用不同 Compose 项目，避免日志平台升级或重启影响读书服务。

## 4. 网络与安全设计

- 固定使用同一版本的 Elasticsearch、Kibana 和 Filebeat；首版计划锁定 `9.4.2`，实施前再次核对官方当前补丁版本。
- 开启 Elastic Security，不使用匿名访问，不关闭 Elasticsearch HTTPS。
- 不向公网发布 9200、9300、5601 或 5044。
- 9300 不映射到宿主机；单节点内部通信只留在 Compose 网络。
- 9200 只允许 88.100 本机以及明确的内网/VPN 日志采集机访问。
- 5601 首选绑定 `192.168.88.100:5601`，并通过主机防火墙限制为管理网段；公网路由器不得新增端口映射。
- 如果主机防火墙规则不能可靠限制来源，则退回 `127.0.0.1:5601`，通过 SSH 隧道访问 Kibana。
- Filebeat 使用独立最小权限写入账号/API Key；日常 Kibana 管理账号不用于采集。
- `.env`、密码、CA 私钥和 API Key 只保存在 88.100，权限设为仅部署用户可读，不提交仓库。
- Gateway 日志已有 Authorization/Cookie 脱敏；采集规则继续删除或屏蔽 token、cookie、API key 和可能出现的正文大字段。

## 5. 容量和保留策略

首版资源上限：

| 服务 | 资源建议 |
| --- | --- |
| Elasticsearch | 8 GiB 容器内存，使用容器感知的自动 JVM 堆设置 |
| Kibana | 2 GiB 容器内存 |
| Filebeat | 512 MiB 容器内存 |

首版只建立一个 Elasticsearch 节点，因此索引副本数设为 `0`。这是可接受的单机方案，但不是高可用方案。

数据生命周期策略：

- `logs-novel-gateway-*`：30 天。
- `logs-novel-mobile-*`：30 天；如移动端日志增长明显，调整为 14 天。
- `logs-novel-pipeline-*`：90 天，便于追溯生产失败。
- 使用 data stream + ILM rollover，避免长期写入单个大索引。
- 首版设置总数据软警戒线 80 GiB，磁盘使用超过 70% 告警；不得依赖手工删除索引作为日常保留方式。

快照先落在 `/home/gwaves/elastic-observability/snapshots`，用于误删和升级回退；由于它与主数据位于同一块磁盘，后续应增加到 NAS 或另一台主机的异机快照。

## 6. 日志模型与采集范围

统一关键字段：

- `service.name`：`novel-gateway`、`novel-mobile`、`production-pipeline`。
- `event.dataset`：`gateway.request`、`mobile.diagnostic`、`pipeline.stage`、`container.stdout`。
- `log.level`、`message`、`host.name`、`container.name`。
- 业务关联字段：`request_id`、`run_id`、`book_id`、`stage`、`device_id`。
- HTTP 字段按 ECS 归一为 `http.request.*`、`http.response.status_code`、`url.path` 和 `event.duration`。

第一阶段采集：

1. Gateway 容器标准输出，覆盖启动错误、Fastify/Pino 请求上下文和运行异常。
2. `/home/gwaves/novel-reader-gateway/data/logs/requests/**/*.jsonl`。
3. `/home/gwaves/novel-reader-gateway/data/logs/mobile/**/*.jsonl`。

第二阶段采集：

1. 在生产流水线实际执行机安装独立 Filebeat。
2. 采集 `tmp/production-pipeline/runs/**/logs/*.log`。
3. 不持续 tail `run.json`；由轻量采集脚本在状态变化时生成一条规范化事件，避免同一 JSON 文件反复重采。
4. 如果商业生产平台是任务入口，再为其任务状态和平台日志建立独立 dataset，不与 Gateway 请求日志混写。

## 7. Kibana 首版交付物

- 三个 Data View：Gateway、移动端、生产流水线。
- “Novel Reader 日志总览”仪表盘：日志速率、错误数、HTTP 状态码、慢请求、设备上报量、生产阶段失败数。
- 保存查询：
  - 最近 24 小时错误。
  - 按 `request_id` 串联一次请求。
  - 按 `run_id + stage + book_id` 定位生产失败。
  - 按 `device_id` 查看移动端诊断。
- 告警：
  - Gateway 5xx 在 5 分钟窗口内达到阈值。
  - `publish`、`verify`、TTS、LLM 阶段失败。
  - Elasticsearch 集群非 green、磁盘超过阈值、Filebeat 停止上报。

## 8. 分阶段实施

### 阶段 A：部署材料与静态验证

1. 在仓库新增 `observability/elastic/`，包含 Compose、配置模板、初始化和验收脚本。
2. 固定镜像版本，不使用 `latest`。
3. 配置健康检查、数据卷、资源上限、日志轮转和 restart policy。
4. 用 `docker compose config` 验证配置，并检查仓库不包含真实凭据。

### 阶段 B：88.100 基础平台部署

1. 在 `/home/gwaves/elastic-observability` 创建部署目录和备份目录。
2. 初始化密码、CA、Kibana 服务账号和 Filebeat 写入凭据。
3. 启动 Elasticsearch，确认集群健康和持久化目录权限。
4. 启动 Kibana，确认登录、Data View 和重启后保存对象仍存在。

### 阶段 C：Gateway 日志接入

1. Filebeat 只读挂载 Docker 日志目录和 Gateway `data/logs`。
2. 验证 JSON 字段解析、时间字段、dataset、敏感字段过滤和读取位置持久化。
3. 重启 Filebeat，确认不会批量重复采集。
4. 建立 ILM、索引模板、Data View、仪表盘和首批告警。

### 阶段 D：生产流水线跨主机接入

1. 明确长期运行生产任务的主机。
2. 在该主机部署 Filebeat，并只允许其通过内网/VPN TLS 连接 88.100:9200。
3. 加入 `run_id`、`book_id`、`stage` 字段提取和 `run.json` 状态事件转换。
4. 用一次真实或受控失败任务验证端到端检索。

### 阶段 E：运维收口

1. 验证 ILM rollover、30/90 天删除策略和磁盘告警。
2. 执行快照、删除测试索引、恢复测试索引的演练。
3. 补充升级、密码轮换、证书续期、磁盘满和采集停止的运维手册。
4. 更新 `docs/current_progress.md` 和测试矩阵，记录真实环境验收结果。

## 9. 验收标准

- Elasticsearch、Kibana、Filebeat 三个服务健康，主机重启后自动恢复。
- 9200、5601、9300 不可从公网访问，允许的管理端和采集端可以正常连接。
- Kibana 能查到 Gateway stdout、requests JSONL 和 mobile JSONL，字段解析正确。
- 使用 `request_id`、`device_id`、`book_id`、`run_id` 和 `stage` 能定位对应事件。
- 人工制造一条无敏感信息的测试错误后，查询和告警都能命中。
- Filebeat 重启后不产生明显重复数据。
- ILM、磁盘阈值、快照和恢复均有自动化或可重复验收记录。
- ELK 停止时不影响 Gateway 服务；ELK 恢复后 Filebeat 能继续补传尚未被轮转删除的日志。

## 10. 实施前最后确认项

以下两项在进入阶段 D 前确认，不阻塞阶段 A-C：

1. 生产流水线长期运行在哪台主机；当前确认它不在 88.100。
2. Kibana 管理入口采用“内网直连 5601”还是“仅本机监听 + SSH 隧道”。默认先采用内网直连并配合来源限制，若防火墙不满足则自动收紧为 SSH 隧道。
