FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY config ./config
COPY gen-nodejs ./gen-nodejs
COPY media_service.thrift ./media_service.thrift
COPY src ./src

CMD ["node", "src/cmd/compose-review.js"]

