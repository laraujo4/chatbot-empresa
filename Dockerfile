FROM node:20-slim

# Instalar Chromium e dependências necessárias
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates fonts-liberation libx11-6 libx11-xcb1 libxcb-dri3-0 \
    libxcomposite1 libxdamage1 libxrandr2 libasound2 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxss1 libxtst6 xdg-utils \
    chromium --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium"
ENV CHROME_PATH="/usr/bin/chromium"
ENV SESSION_PATH="/data/session"

# Copia package.json antes para cache
COPY package*.json ./

# Ajusta dono e instala dependências como usuário node
RUN chown -R node:node /app
USER node
RUN npm ci --production --no-audit --progress=false

# Copia o restante do código com dono correto
COPY --chown=node:node . .

EXPOSE 8080
CMD [ "node", "chatbot-empresa.js" ]