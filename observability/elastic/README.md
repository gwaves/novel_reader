# Novel Reader ELK 部署

该目录用于在 `192.168.88.100:/home/gwaves/elastic-observability` 部署单节点 Elasticsearch、Kibana 和 Filebeat。真实密码、证书、数据和快照不会进入 Git。

## 初次部署

```bash
rsync -az --delete \
  --exclude .env --exclude certs/ --exclude data/ --exclude snapshots/ \
  observability/elastic/ \
  gwaves@192.168.88.100:/home/gwaves/elastic-observability/

ssh gwaves@192.168.88.100
cd /home/gwaves/elastic-observability
chmod +x scripts/*.sh
./scripts/generate-env.sh
mkdir -p certs data/elasticsearch data/kibana data/filebeat snapshots
docker compose -f compose.yml config --quiet
docker compose -f compose.yml up -d
./scripts/configure-platform.sh
./scripts/verify.sh
```

Kibana 默认仅监听 88.100 的内网地址：`http://192.168.88.100:5601`。Elasticsearch 使用自建 CA 和 HTTPS，不映射 9300。禁止在路由器上为 5601 或 9200添加公网映射。

登录账号为 `elastic`，初始密码只存在远端 `.env`。不要把密码复制进文档或命令历史；需要读取时在远端受控终端中加载 `.env`。

## 更新

同步时必须排除 `.env`、`certs/`、`data/` 和 `snapshots/`，随后执行：

```bash
docker compose -f compose.yml config --quiet
docker compose -f compose.yml up -d
./scripts/configure-platform.sh
./scripts/verify.sh
```

## 常用检查

```bash
docker compose -f compose.yml ps
docker compose -f compose.yml logs --tail=100 elasticsearch kibana filebeat
./scripts/verify.sh
```

## 停止与恢复

```bash
docker compose -f compose.yml stop
docker compose -f compose.yml start
```

不要使用 `docker compose down -v`。当前数据使用部署目录中的 bind mount；删除 `data/`、`certs/` 或 `.env` 会造成不可恢复的数据或身份信息丢失。
