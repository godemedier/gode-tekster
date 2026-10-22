# tekster.godemedier.dk (server/server.mjs). Bygges af Coolify fra repoets rod.
FROM node:22-alpine
WORKDIR /app
COPY server/server.mjs ./
COPY server/sider ./sider
RUN mkdir -p /data/filer && chown -R node:node /data
USER node
ENV PORT=3000 DATA_DIR=/data NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.mjs"]
