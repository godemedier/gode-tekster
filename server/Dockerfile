# tekster.godemedier.dk (server/server.mjs). Bygges af Coolify fra repoets rod.
FROM node:22-alpine
WORKDIR /app
COPY server/server.mjs ./
COPY server/sider ./sider
RUN mkdir -p /data/filer && chown -R node:node /data
# Intet i containeren kalder npm/npx (CMD er ren node, HEALTHCHECK er wget), så
# pakkehåndteringerne fra base-imaget slettes: de bidrager kun med sårbarheder (L-695).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER node
ENV PORT=3000 DATA_DIR=/data NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.mjs"]
