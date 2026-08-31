FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p /app/data/spool /app/data/archives /backup && chown -R node:node /app /backup

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
