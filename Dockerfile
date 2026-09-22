FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY public ./public
COPY server/access.js ./server/access.js
COPY onprem ./onprem
USER node
EXPOSE 3000
CMD ["node","onprem/server.mjs"]
