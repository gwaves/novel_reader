# Gateway 部署说明

Gateway 第一版面向两种部署方式：

- 云服务器/VPS 上运行 Docker 容器，通过 Nginx、Caddy 或云厂商负载均衡提供 HTTPS。
- 家里或办公室机器运行 Docker 容器，通过公网映射、反向代理或隧道服务暴露 HTTPS 域名。

公网环境不要直接暴露未加 HTTPS 的接口。建议外层统一终止 TLS，再反代到容器内的 `http://127.0.0.1:6180` 或 Docker 网络地址。

生产流水线如果跑在内网另一台机器上，可以同时保留两个入口：

- 内部生产流水线访问 Gateway 应用 HTTP 端口，例如 `http://192.168.88.100:6180`。
- 手机或外部客户端访问 Nginx HTTPS 入口，例如 `https://novel.gwaves.net:8888`。

这样生产流水线不会因为 HTTPS 证书域名和内网 IP 不匹配而失败；HTTPS 证书只由 Nginx 入口负责。

## Docker Compose

在 `gateway/` 目录准备 `.env`：

```bash
GATEWAY_PUBLIC_BASE_URL=https://reader.example.com
GATEWAY_DEV_ACCESS_TOKEN=replace-with-a-long-random-token
GATEWAY_CORS_ORIGINS=
GATEWAY_AI_BASE_URL=https://api.openai.com/v1
GATEWAY_AI_API_KEY=
GATEWAY_AI_MODEL=gpt-4.1-mini
GATEWAY_EMBEDDING_PROVIDER=ollama
GATEWAY_EMBEDDING_BASE_URL=http://192.168.88.100:11434
GATEWAY_EMBEDDING_API_KEY=
GATEWAY_EMBEDDING_MODEL=qwen3-embedding:8b
```

启动：

```bash
docker compose up -d --build
```

默认挂载：

- `gateway/data` -> 容器 `/data`，保存 `books.json` 和单书 `package.json`。
- `gateway/audio` -> 容器 `/audio`，只读提供本地 MP3 清单和音频文件。

如果生产流水线运行在 Mac 等内网机器上，需要让 Gateway 应用端口对局域网开放：

```yaml
services:
  gateway:
    expose:
      - "6180"
    ports:
      - "6180:6180"
```

如果生产流水线也运行在 Gateway 宿主机上，可以只绑定本机：

```yaml
services:
  gateway:
    ports:
      - "127.0.0.1:6180:6180"
```

对外 HTTPS 入口仍由 Nginx 或其他反向代理暴露，不需要让移动端直连 `6180`。

## 目录格式

移动数据包：

```text
gateway/data/
├── books.json
└── books/
    └── <bookId>/
        └── package.json
```

本地 MP3：

```text
gateway/audio/
└── books/
    └── <bookId>/
        ├── audio.json
        └── chapter-1.mp3
```

## 反向代理

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name reader.example.com;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:6180;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Compose 内置 Nginx 容器时，可以使用同一 Docker 网络里的服务名反代：

```nginx
server {
    listen 8443 ssl http2;
    server_name novel.gwaves.net;

    ssl_certificate /etc/letsencrypt/live/novel.gwaves.net/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/novel.gwaves.net/privkey.pem;

    client_max_body_size 512m;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;
    proxy_connect_timeout 30s;
    proxy_buffering off;
    proxy_request_buffering off;

    location / {
        proxy_pass http://gateway:6180;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

对应端口关系：

```text
手机/外部客户端
  -> https://novel.gwaves.net:8888
  -> nginx 容器 8443
  -> http://gateway:6180

内网生产流水线
  -> http://192.168.88.100:6180
  -> Gateway 应用
```

## 验证

```bash
curl https://reader.example.com/health
curl -H "Authorization: Bearer $GATEWAY_DEV_ACCESS_TOKEN" \
  https://reader.example.com/auth/session

curl http://192.168.88.100:6180/health
curl -H "Authorization: Bearer $GATEWAY_DEV_ACCESS_TOKEN" \
  http://192.168.88.100:6180/capabilities
```

`/health` 可公开访问；移动数据、AI、embedding 和 MP3 接口都需要 bearer token。
