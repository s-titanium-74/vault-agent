FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/cli/package.json packages/cli/package.json

RUN npm ci

COPY . .

RUN npm run build \
  && npm prune --omit=dev --workspaces \
  && mkdir -p /data/vault /data/index /home/node/.config/vault-agent \
  && chmod +x /app/docker-entrypoint.sh \
  && chown -R node:node /app /data /home/node/.config

USER node

ENV NODE_ENV=production
ENV VAULT_AGENT_INDEX_DIR=/data/index

VOLUME ["/data/vault", "/data/index"]
EXPOSE 8787

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["serve"]
