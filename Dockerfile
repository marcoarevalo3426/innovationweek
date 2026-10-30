FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY server ./server
COPY scripts ./scripts
COPY shared ./shared
USER node
VOLUME ["/data"]
EXPOSE 3001
CMD ["node", "server/index.js"]
