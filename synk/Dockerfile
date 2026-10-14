# synk.godemedier.dk (ADR-0054). Bygges af Coolify fra repoets rod: Dockerfile `/synk/Dockerfile`,
# watch path `synk/**`. Lageret ligger i volumen på /data (SQLite + blobs), med i nattens restic.
FROM rust:1-alpine AS bygger
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY synk/ synk/
RUN cargo build --release --locked --manifest-path synk/Cargo.toml -p synk-server

FROM alpine:3
RUN adduser -D -H -u 10001 synk && mkdir /data && chown synk /data
COPY --from=bygger /src/synk/target/release/synk-server /usr/local/bin/synk-server
USER synk
ENV DATA_DIR=/data PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["synk-server"]
