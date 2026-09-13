FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Create data directory (will be overridden by Northflank persistent volume)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "server.js"]
