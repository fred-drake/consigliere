FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ src/
COPY tsconfig.json .

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=builder /app .
COPY config/consigliere.toml /etc/consigliere/consigliere.toml
USER bun
ENTRYPOINT ["bun", "run", "src/index.ts"]
