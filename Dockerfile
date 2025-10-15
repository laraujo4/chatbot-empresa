# Use uma imagem base que já inclui Chromium e Node.js.
# A imagem zenika/alpine-chrome é ideal, e vamos especificar uma versão com Node.js 20 (compatível com 22.20).
# Se houver problemas, podemos tentar uma versão mais específica ou uma imagem Node.js com instalação manual do Chromium.
FROM zenika/alpine-chrome:110-with-node-20

# Define o diretório de trabalho dentro do contêiner
WORKDIR /app

# Define o ambiente como produção
ENV NODE_ENV=production

# Copia os arquivos de definição de dependências (package.json e package-lock.json)
# para aproveitar o cache do Docker e instalar as dependências primeiro
COPY package*.json ./

# Instala as dependências do Node.js
# O Chromium já está na imagem base, então o puppeteer não precisará baixá-lo novamente aqui.
RUN npm install

# Copia o restante do código da sua aplicação para o contêiner
COPY . .

# Define a variável de ambiente que o Puppeteer usará para encontrar o executável do Chromium
# Este caminho é o padrão para o Chromium dentro da imagem zenika/alpine-chrome
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/chromium-browser"

# Define a porta que a aplicação irá expor (conforme seu código Node.js)
EXPOSE 8080

# Comando para iniciar a aplicação quando o contêiner for executado
# Ajustado para o nome do seu arquivo principal: chatbot-empresa.js
CMD [ "node", "chatbot-empresa.js" ]