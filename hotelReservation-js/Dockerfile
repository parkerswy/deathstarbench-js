FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY config.json ./config.json
COPY proto ./proto
COPY src ./src
COPY x509 ./x509

CMD ["node", "src/cmd/frontend.js"]
