FROM oven/bun:1.1-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src/ src/
COPY tsconfig.json .

FROM oven/bun:1.1-alpine
WORKDIR /app
COPY --from=builder /app .
COPY config/consigliere.toml /etc/consigliere/consigliere.toml
RUN adduser -D -u 1000 consigliere
USER consigliere
ENTRYPOINT ["bun", "run", "src/index.ts"]
