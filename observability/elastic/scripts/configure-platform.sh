#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

set -a
# shellcheck disable=SC1091
source .env
set +a

ca=certs/ca/ca.crt
es_url="https://${ELASTICSEARCH_BIND_ADDRESS}:9200"
kibana_url="http://${KIBANA_BIND_ADDRESS}:5601"

for _ in $(seq 1 60); do
  if curl --noproxy '*' --fail --silent --cacert "$ca" -u "elastic:${ELASTIC_PASSWORD}" \
    "$es_url/novel-reader-logs/_count" >/dev/null; then
    break
  fi
  sleep 2
done

curl --noproxy '*' --fail --silent --show-error --cacert "$ca" \
  -u "elastic:${ELASTIC_PASSWORD}" \
  -H 'Content-Type: application/json' \
  -X PUT "$es_url/novel-reader-logs/_settings" \
  -d '{"index":{"number_of_replicas":0}}' >/dev/null

curl --noproxy '*' --fail --silent --show-error --cacert "$ca" \
  -u "elastic:${ELASTIC_PASSWORD}" \
  -H 'Content-Type: application/json' \
  -X PUT "$es_url/_snapshot/local_snapshots" \
  -d '{"type":"fs","settings":{"location":"novel-reader"}}' >/dev/null

curl --noproxy '*' --fail --silent --show-error --cacert "$ca" \
  -u "elastic:${ELASTIC_PASSWORD}" \
  -H 'Content-Type: application/json' \
  -X PUT "$es_url/_slm/policy/novel-reader-daily" \
  -d '{"schedule":"0 30 3 * * ?","name":"<novel-reader-{now/d}>","repository":"local_snapshots","config":{"indices":["novel-reader-logs*"],"include_global_state":false},"retention":{"expire_after":"14d","min_count":3,"max_count":14}}' >/dev/null

curl --noproxy '*' --fail --silent --show-error \
  -u "elastic:${ELASTIC_PASSWORD}" \
  -H 'Content-Type: application/json' \
  -H 'kbn-xsrf: true' \
  -X POST "$kibana_url/api/data_views/data_view" \
  -d '{"data_view":{"id":"novel-reader-logs","name":"Novel Reader Logs","title":"novel-reader-logs*","timeFieldName":"@timestamp"},"override":true}' >/dev/null

echo "Configured snapshot policy and Kibana data view"
