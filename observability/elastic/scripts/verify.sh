#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

if [[ ! -f .env ]]; then
  echo "Missing $root_dir/.env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

ca=certs/ca/ca.crt
es_url="https://${ELASTICSEARCH_BIND_ADDRESS}:9200"
kibana_url="http://${KIBANA_BIND_ADDRESS}:5601"

docker compose -f compose.yml ps
curl --fail --silent --show-error --cacert "$ca" -u "elastic:${ELASTIC_PASSWORD}" \
  "$es_url/_cluster/health?wait_for_status=yellow&timeout=30s"
echo
curl --fail --silent --show-error "$kibana_url/api/status" >/dev/null
curl --fail --silent --show-error --cacert "$ca" -u "elastic:${ELASTIC_PASSWORD}" \
  -H 'Content-Type: application/json' \
  "$es_url/novel-reader-logs/_search?size=0" \
  -d '{"query":{"match_all":{}}}'
echo
