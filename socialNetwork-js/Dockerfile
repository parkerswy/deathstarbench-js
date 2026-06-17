FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY config ./config
COPY gen-nodejs ./gen-nodejs
COPY social_network.thrift ./social_network.thrift
COPY src ./src

CMD ["node", "src/cmd/compose-post.js"]
