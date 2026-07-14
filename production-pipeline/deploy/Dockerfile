FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg openssh-client rsync \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY production-pipeline ./production-pipeline
COPY scripts/summary-source-locator.mjs ./scripts/summary-source-locator.mjs
RUN chmod -R a+rX /app/production-pipeline /app/scripts

ENV NODE_ENV=production
EXPOSE 6290

CMD ["node", "production-pipeline/src/service.mjs"]
