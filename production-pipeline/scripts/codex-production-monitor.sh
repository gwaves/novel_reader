#!/bin/zsh

set -u

export PATH="/Users/gwaves/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO_ROOT="${REPO_ROOT:-/Users/gwaves/Documents/novel_reader}"
REMOTE_HOST="${REMOTE_HOST:-192.168.88.100}"
JOB_ID="${1:-}"
STATE_ROOT="${CODEX_MONITOR_STATE_ROOT:-$HOME/.novel_reader/production-monitor}"
LOG_ROOT="${CODEX_MONITOR_LOG_ROOT:-$STATE_ROOT/logs}"
CODEX_BIN="${CODEX_BIN:-/Users/gwaves/.npm-global/bin/codex}"

if [[ -z "$JOB_ID" ]]; then
  print -u2 "usage: $0 <production-job-id>"
  exit 2
fi

mkdir -p "$STATE_ROOT" "$LOG_ROOT"
LOCK_DIR="$STATE_ROOT/$JOB_ID.lock"
STATE_FILE="$STATE_ROOT/$JOB_ID.state.json"
SNAPSHOT_FILE="$STATE_ROOT/$JOB_ID.snapshot.json"
COMPLETED_FILE="$STATE_ROOT/$JOB_ID.completed"
RUN_LOG="$LOG_ROOT/$JOB_ID.log"
CODEX_LOG="$LOG_ROOT/$JOB_ID-codex.log"

if [[ -f "$COMPLETED_FILE" ]]; then
  exit 0
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  lock_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
    printf '%s monitor already running pid=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$lock_pid" >> "$RUN_LOG"
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi
print -r -- "$$" > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT INT TERM

snapshot="$({
  /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE_HOST" \
    "docker exec -e WATCH_JOB_ID='$JOB_ID' novel-reader-production-service node -e 'const id=process.env.WATCH_JOB_ID;(async()=>{const headers={authorization:\"Bearer \"+process.env.PRODUCTION_PIPELINE_CONSOLE_TOKEN};const health=await fetch(\"http://127.0.0.1:6290/health\").then(r=>r.json());const response=await fetch(\"http://127.0.0.1:6290/api/jobs/\"+encodeURIComponent(id),{headers});if(!response.ok)throw new Error(\"job API \"+response.status);const body=await response.json();const run=body.productionRun||{};const metrics=run.metrics||{};const stages=metrics.stages||{};const progress=Object.fromEntries(Object.entries(stages).map(([name,value])=>[name,{done:Number(value.latest?.done||0),failed:Number(value.latest?.failed||0),total:Number(value.latest?.total||0),rate15m:Number(value.rates?.[\"15m\"]?.perMinute||0)}]));console.log(JSON.stringify({checkedAt:new Date().toISOString(),serviceHealth:health.status||health,job:{id:body.job?.id,title:body.job?.title,status:body.job?.status,attempts:body.job?.attempts,automaticRetryCount:body.job?.automaticRetryCount,nextAttemptAt:body.job?.nextAttemptAt,error:body.job?.error||null},run:{status:run.runJson?.status,runDir:run.runDir,stages:Object.fromEntries(Object.entries(run.runJson?.stages||{}).map(([name,value])=>[name,value.status])),percent:Number(metrics.progress?.percent||0),completedStages:Number(metrics.progress?.completedStages||0),totalStages:Number(metrics.progress?.totalStages||0),progress}}));})().catch(error=>{console.error(error.message);process.exit(1)})'"
} 2>&1)"
snapshot_status=$?

if (( snapshot_status != 0 )); then
  snapshot="$(printf '{\"checkedAt\":\"%s\",\"serviceHealth\":\"unreachable\",\"snapshotError\":%s,\"job\":{\"id\":%s}}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$snapshot")" "$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$JOB_ID")")"
fi
print -r -- "$snapshot" > "$SNAPSHOT_FILE"

decision="$(node - "$STATE_FILE" "$SNAPSHOT_FILE" <<'NODE'
const fs = require('fs')
const [statePath, snapshotPath] = process.argv.slice(2)
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
let previous = {}
try { previous = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch {}
const progress = snapshot.run?.progress || {}
const signature = JSON.stringify({
  status: snapshot.job?.status || snapshot.serviceHealth,
  runStatus: snapshot.run?.status || '',
  stages: snapshot.run?.stages || {},
  done: Object.fromEntries(Object.entries(progress).map(([name, value]) => [name, [value.done, value.failed]])),
})
const active = ['running', 'queued', 'retrying'].includes(snapshot.job?.status)
const staleChecks = active && signature === previous.signature ? Number(previous.staleChecks || 0) + 1 : 0
const failed = snapshot.job?.status === 'failed' || snapshot.run?.status === 'failed'
const unhealthy = snapshot.serviceHealth !== 'ok'
const issue = unhealthy || failed || (active && staleChecks >= 2)
const reason = unhealthy ? 'service_unhealthy' : failed ? 'job_failed' : issue ? 'no_progress_for_two_checks' : 'healthy'
fs.writeFileSync(statePath, JSON.stringify({ checkedAt: snapshot.checkedAt, signature, staleChecks, reason }, null, 2) + '\n')
process.stdout.write(JSON.stringify({ issue, reason, staleChecks, status: snapshot.job?.status || 'unknown', title: snapshot.job?.title || '' }))
NODE
)"

printf '%s snapshot=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$decision" >> "$RUN_LOG"

issue="$(node -e 'process.stdout.write(String(Boolean(JSON.parse(process.argv[1]).issue)))' "$decision")"
status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).status)' "$decision")"
if [[ "$status" == "completed" ]]; then
  print -r -- "$(date '+%Y-%m-%dT%H:%M:%S%z')" > "$COMPLETED_FILE"
  printf '%s production completed; future cron checks are disabled by marker\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" >> "$RUN_LOG"
  exit 0
fi
if [[ "$issue" != "true" ]]; then
  exit 0
fi

if [[ "${CODEX_MONITOR_DRY_RUN:-0}" == "1" ]]; then
  printf '%s dry-run: Codex escalation skipped\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" >> "$RUN_LOG"
  exit 0
fi

reason="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).reason)' "$decision")"
prompt_file="$STATE_ROOT/$JOB_ID.prompt.txt"
cat > "$prompt_file" <<EOF
你正在执行 Novel Reader 生产巡检。目标是 192.168.88.100 上的生产任务 $JOB_ID，触发原因：$reason。

必须先直接检查当前生产事实，不要仅依赖快照：控制台 job API、run.json、最近日志、进程、阶段计数和产物增长。当前快照位于：$SNAPSHOT_FILE。

职责边界：
1. 健康或仍有真实进展：不要修改代码、不要打断任务，只记录证据。
2. 普通可恢复故障应由 production-pipeline 自带的自动 retry/resume 先处理。
3. 任务失败或疑似停滞时，重点审查 Hermes 的处理是否闭环：systemd 服务、policy、目标 job 最新 incident、prompt.txt、hermes.log、result.json、verify/deploy 日志以及是否成功 retry/resume。
4. 如果 Hermes 已正确处理，验证生产恢复并继续观察，不重复修复。
5. 如果 Hermes 没处理好，定位其根因，改进 production-pipeline/scripts/hermes-rescue-worker.mjs、相关策略/文档/测试；先做针对性代码审查和测试，再提交并推送 agent-assist，部署到 88.100，重启 Hermes Worker，重新执行救援并验证目标任务恢复。
6. 不暴露任何 Token/API Key；不修改小说正文、主库数据或已完成音频；不使用 git reset/checkout 等破坏性操作；不碰无关模块；不要 merge PR。
7. 只有验证/部署成功后才能触发生产 retry；优先 resume，禁止整本重做。

结束时把本轮状态、问题证据、Hermes 表现、采取的改进、测试/部署/恢复结果写入最终答复；这是 cron 日志，不需要向用户提问。
EOF

{
  printf '\n===== %s escalation reason=%s =====\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$reason"
  "$CODEX_BIN" exec --ephemeral --sandbox danger-full-access -c 'approval_policy="never"' -C "$REPO_ROOT" - < "$prompt_file"
} >> "$CODEX_LOG" 2>&1
