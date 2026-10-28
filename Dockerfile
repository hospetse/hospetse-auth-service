# Imagem base: Linux enxuto já com Node 22 instalado
FROM node:22-slim

# O Prisma precisa do OpenSSL, que a versão "slim" não traz
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia primeiro só o que define as dependências, para o Docker reaproveitar
# esta camada quando apenas o código mudar
COPY package*.json prisma.config.ts ./
COPY prisma ./prisma

RUN npm ci

# O generate não conecta no banco, mas o prisma.config.ts exige a variável: valor falso só para o build
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" npx prisma generate

COPY . .

# Roda como usuário comum, não como root
USER node

EXPOSE 3001

# As variáveis vêm do ambiente (Railway ou --env-file), não de um .env dentro da imagem
CMD ["node", "index.js"]
