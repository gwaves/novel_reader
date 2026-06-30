#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${GATEWAY_SECURITY_BASE_URL:-https://novel.gwaves.net:8888}"
IP_URL="${GATEWAY_SECURITY_IP_URL:-https://114.248.3.13:8888}"
HOST_HEADER="${GATEWAY_SECURITY_HOST:-novel.gwaves.net}"
EVIL_ORIGIN="${GATEWAY_SECURITY_EVIL_ORIGIN:-https://evil.example}"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

status_code() {
  curl --noproxy '*' -k -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@"
}

headers() {
  curl --noproxy '*' -k -sS -D - -o /dev/null --max-time 10 "$@"
}

admin_status="$(status_code "$BASE_URL/admin/ui")"
[[ "$admin_status" == "403" ]] || fail "expected /admin/ui to return 403, got $admin_status"

admin_api_status="$(status_code "$BASE_URL/admin/books")"
[[ "$admin_api_status" == "401" ]] || fail "expected /admin/books without token to return 401, got $admin_api_status"

mobile_status="$(status_code "$BASE_URL/mobile/books")"
[[ "$mobile_status" == "401" ]] || fail "expected /mobile/books without token to return 401, got $mobile_status"

cors_headers="$(headers -X OPTIONS -H "Origin: $EVIL_ORIGIN" -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: Authorization, Content-Type' "$BASE_URL/mobile/books")"
if printf '%s\n' "$cors_headers" | grep -qi '^access-control-allow-origin: \*'; then
  fail 'wildcard CORS is exposed to an arbitrary Origin'
fi

capabilities_body="$(curl --noproxy '*' -k -sS --max-time 10 "$BASE_URL/capabilities")"
if printf '%s\n' "$capabilities_body" | grep -Eq 'development-static-token|adminTokenConfigured|mobileTokenConfigured|tokenSecretConfigured'; then
  fail '/capabilities exposes auth implementation details'
fi

version_body="$(curl --noproxy '*' -k -sS --max-time 10 "$BASE_URL/version")"
if printf '%s\n' "$version_body" | grep -q '"environment"'; then
  fail '/version exposes runtime environment'
fi

unknown_host_status="$(status_code -H 'Host: localhost' "$IP_URL/health" || true)"
[[ "$unknown_host_status" != "200" ]] || fail 'unknown Host header returned 200'

if echo | openssl s_client -tls1_1 -connect "${HOST_HEADER}:8888" -servername "$HOST_HEADER" >/dev/null 2>&1; then
  fail 'TLS 1.1 handshake succeeded'
fi

printf 'Gateway security smoke checks passed for %s\n' "$BASE_URL"
