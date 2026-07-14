#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_file="$root_dir/.env"

if [[ -e "$env_file" ]]; then
  echo "Refusing to overwrite existing $env_file" >&2
  exit 1
fi

umask 077
cat >"$env_file" <<EOF
PRODUCTION_PIPELINE_CONSOLE_TOKEN=$(openssl rand -hex 32)
PRODUCTION_PIPELINE_CONSOLE_VIEWER_TOKEN=$(openssl rand -hex 32)
PRODUCTION_PIPELINE_BIND_ADDRESS=192.168.88.100
PRODUCTION_PIPELINE_MAX_CONCURRENT_JOBS=1
PRODUCTION_PIPELINE_AUTO_RESUME_INTERRUPTED=true
PRODUCTION_PIPELINE_AUTO_RETRY_FAILURES=true
PRODUCTION_PIPELINE_MAX_AUTOMATIC_RETRIES=5
PRODUCTION_PIPELINE_AUTOMATIC_RETRY_BASE_DELAY_MS=30000
PRODUCTION_PIPELINE_AUTOMATIC_RETRY_MAX_DELAY_MS=600000
PRODUCTION_PIPELINE_HOST_ROOT=/home/gwaves/production-pipeline-service
# Must match the host user that owns the Gateway bind mount. On 88.100 this is gwaves:gwaves.
PRODUCTION_PIPELINE_SERVICE_UID=1000
PRODUCTION_PIPELINE_SERVICE_GID=1000
# Provider and Gateway credentials are optional until their stages are enabled.
LLM_API_KEY=
EMBEDDING_API_KEY=
GATEWAY_TOKEN=
GATEWAY_ADMIN_TOKEN=
EOF

echo "Created $env_file with mode 600"
