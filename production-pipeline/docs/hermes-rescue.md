# Hermes Agent 生产故障救援

`hermes-rescue-worker.mjs` 运行在 Gateway / Production Pipeline 所在宿主机，监听最终进入 `failed` 的托管生产任务。普通故障仍先由服务自身的指数退避 `resume` 处理；只有任务最终失败后，Worker 才生成脱敏现场并调用 Hermes Agent。

## 安全模型

- Hermes 只在独立 Git checkout 中修改代码，不直接修改 `/home/gwaves/production-pipeline-service` 在线目录。
- 现场快照包含任务状态、`run.json` 和有限数量的近期日志，并按凭据字段和常见 Token 形态脱敏。
- Hermes 子进程只继承 `HOME`、`PATH`、locale 和 `HERMES_HOME` 等基础环境，不继承 Production Pipeline Token、LLM Key 或 Gateway Token。
- Hermes 只开放 `terminal,file` toolsets，Prompt 禁止 commit、push、PR、部署、服务重启和生产 API 写入。
- Worker 不执行 Hermes 输出的任意命令。验证与部署命令只能来自静态策略文件。
- 每轮默认只处理一个 24 小时内的最新失败；实际代码改动必须位于 `allowedPathPrefixes` 白名单内。
- 默认 `autoDeploy=false`、`autoRetryJob=false`。先观察现场与补丁质量，再逐步启用自动部署。

Prompt 约束不是操作系统级沙箱。若要进一步隔离，可把 Hermes 的 terminal backend 配置为 Docker，并只挂载代码工作区与 incident 目录；不要向 Hermes 容器挂载 Docker socket、生产数据库或 Gateway 数据目录。

## 88.100 初始化

88.100 已安装 Hermes Agent，入口为 `/home/gwaves/.local/bin/hermes`。先确认：

```bash
ssh gwaves@192.168.88.100 'bash -lc "~/.local/bin/hermes doctor"'
```

创建独立代码工作区，不要复用 rsync 部署目录：

```bash
cd /home/gwaves
git clone https://github.com/gwaves/novel_reader.git novel-reader-agent-workspace
cd novel-reader-agent-workspace
git switch -c agent-assist origin/main
```

安装策略与专用环境文件：

```bash
cd /home/gwaves/production-pipeline-service
cp production-pipeline/config/hermes-rescue-policy.example.json production-pipeline/config/hermes-rescue-policy.json
cp production-pipeline/deploy/hermes-rescue.env.example production-pipeline/deploy/hermes-rescue.env
chmod 600 production-pipeline/deploy/hermes-rescue.env
```

将现有 Console Token 写入 `hermes-rescue.env`，不要提交该文件。初次运行保持：

```json
{
  "enabled": true,
  "repair": {
    "autoDeploy": false,
    "autoRetryJob": false
  }
}
```

单次演练：

```bash
node production-pipeline/scripts/hermes-rescue-worker.mjs \
  --policy production-pipeline/config/hermes-rescue-policy.json \
  --once
```

Incident 默认写入：

```text
/home/gwaves/production-pipeline-service/data/hermes-incidents/<job-id>/<incident-id>/
  incident.json
  prompt.txt
  hermes.log
  result.json
  verify-*.log
  deploy-*.log
```

## systemd 用户服务

```bash
mkdir -p ~/.config/systemd/user
cp production-pipeline/deploy/hermes-rescue.service.example ~/.config/systemd/user/novel-reader-hermes-rescue.service
systemctl --user daemon-reload
systemctl --user enable --now novel-reader-hermes-rescue.service
systemctl --user status novel-reader-hermes-rescue.service
journalctl --user -u novel-reader-hermes-rescue.service -f
```

## 自动部署与恢复

观察模式稳定后，可以在策略中配置固定的 `deployCommands`，再启用 `autoDeploy`。命令必须是 `command + args` 数组，不经过 shell，也不能由 Agent 动态生成。

只有以下情况 Worker 才会自动调用 `POST /api/jobs/:jobId/retry`：

1. `autoRetryJob=true` 且已完成策略内的自动部署；或
2. Agent 没有修改代码，并明确建议 `resume`。

任何验证或部署命令失败都会停止自动恢复，保留 incident 供人工检查。
