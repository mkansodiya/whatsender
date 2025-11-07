FROM node:20-bullseye-slim AS base

ENV NODE_ENV=production

WORKDIR /usr/src/app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        libvips \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

COPY controllers/ ./controllers/
COPY middlewares/ ./middlewares/
COPY routes/ ./routes/
COPY app.js response.js routes.js dirname.js whatsapp.js ./

RUN mkdir -p sessions

EXPOSE 8000

CMD ["node", "app.js"]

