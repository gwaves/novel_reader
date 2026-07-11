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
PRODUCTION_PIPELINE_HOST_ROOT=/home/gwaves/production-pipeline-service
# Provider and Gateway credentials are optional until their stages are enabled.
LLM_API_KEY=
EMBEDDING_API_KEY=
GATEWAY_TOKEN=
GATEWAY_ADMIN_TOKEN=
EOF

echo "Created $env_file with mode 600"
