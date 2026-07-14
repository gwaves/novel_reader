#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$root_dir/.env"

if [[ -e "$env_file" ]]; then
  echo "Refusing to overwrite existing $env_file" >&2
  exit 1
fi

random_secret() {
  openssl rand -hex 32
}

umask 077
cat >"$env_file" <<EOF
ELASTIC_VERSION=9.4.2
ELASTIC_PASSWORD=$(random_secret)
KIBANA_SYSTEM_PASSWORD=$(random_secret)
FILEBEAT_INTERNAL_PASSWORD=$(random_secret)
KIBANA_ENCRYPTION_KEY=$(random_secret)
KIBANA_REPORTING_ENCRYPTION_KEY=$(random_secret)
KIBANA_SECURITY_ENCRYPTION_KEY=$(random_secret)
ELASTICSEARCH_BIND_ADDRESS=192.168.88.100
KIBANA_BIND_ADDRESS=192.168.88.100
EOF

echo "Created $env_file with mode 600"

