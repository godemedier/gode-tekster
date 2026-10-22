# synk.godemedier.dk (ADR-0054). Bygges af Coolify fra repoets rod: Dockerfile `/synk/Dockerfile`,
# watch path `synk/**`. Lageret ligger i volumen på /data (SQLite + blobs), med i nattens restic.

# Gæstens side til en delt tekst (ADR-0060): samme skriveflade som programmet, bygget med
# vite.del.config.ts. Ændres kun editoren (src/), skal serveren udrulles i hånden, fordi watch path
# kun er synk/**.
FROM node:22-alpine AS side
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vite.del.config.ts del.html ./
COPY src/ src/
RUN npx vite build -c vite.del.config.ts

FROM rust:1-alpine AS bygger
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY synk/ synk/
RUN cargo build --release --locked --manifest-path synk/Cargo.toml -p synk-server

FROM alpine:3
RUN adduser -D -H -u 10001 synk && mkdir /data && chown synk /data
COPY --from=bygger /src/synk/target/release/synk-server /usr/local/bin/synk-server
COPY --from=side /src/dist-del /srv/del
USER synk
ENV DATA_DIR=/data PORT=3000 GUEST_DIR=/srv/del
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["synk-server"]
