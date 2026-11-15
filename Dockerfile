FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV STORAGE_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "src/index.js"]
