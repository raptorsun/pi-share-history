FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=9080 DATA_DIR=/data
EXPOSE 9080
CMD ["node", "server/index.mjs"]
