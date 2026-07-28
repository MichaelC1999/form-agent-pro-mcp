# ─── Build stage ───────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Runtime stage ─────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# pdftk-java (form field extraction + FDF fill), qpdf (fallback field
# extraction), tesseract-ocr (document OCR) — see README.md "Dependencies".
# pdftk-java pulls in a JRE automatically via apt.
RUN apt-get update \
    && apt-get install -y --no-install-recommends pdftk-java qpdf tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY assets ./assets

ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "dist/app.js"]
