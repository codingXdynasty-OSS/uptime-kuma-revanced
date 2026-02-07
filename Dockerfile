FROM node:20.20.0-bookworm-slim

WORKDIR /app

# Install dependencies required by some packages (libatomic1 found in logs)
RUN apt-get update && \
    apt-get install -y --no-install-recommends libatomic1 curl gnupg git python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

# Add a non-root user (node is created by the base image)
# Create app directory with correct permissions
RUN chown -R node:node /app

USER node

# Copy package files
COPY --chown=node:node .npmrc .npmrc
COPY --chown=node:node package.json package.json
COPY --chown=node:node package-lock.json package-lock.json

# Copy additional files required for the build as seen in logs
COPY --chown=node:node extra/kuma-pr/package.json extra/kuma-pr/package.json
COPY --chown=node:node extra/push-examples/javascript-fetch/package.json extra/push-examples/javascript-fetch/package.json
COPY --chown=node:node extra/push-examples/typescript-fetch/package.json extra/push-examples/typescript-fetch/package.json
COPY --chown=node:node extra/update-language-files/package.json extra/update-language-files/package.json
COPY --chown=node:node extra/uptime-kuma-push/package.json extra/uptime-kuma-push/package.json

# Install dependencies
RUN npm ci

# Copy the rest of the application code
COPY --chown=node:node . .

# Build the frontend
RUN npm run build

# Expose the application port
EXPOSE 3001

# Default Environment Variables represented as ARGs
ARG uptime_kuma_revanced_AUTO_CREATE_ADMIN=1
ARG uptime_kuma_revanced_ADMIN_USER=test
ARG uptime_kuma_revanced_ADMIN_PASSWORD=Test123456!
ARG uptime_kuma_revanced_AUTO_LOGIN=1
ARG uptime_kuma_revanced_MONITORS_YAML_PATH=config/monitors.yaml
ARG uptime_kuma_revanced_DB_TYPE=mariadb
ARG uptime_kuma_revanced_DB_HOST=mariadb
ARG uptime_kuma_revanced_DB_PORT=3306
ARG uptime_kuma_revanced_DB_NAME=kuma
ARG uptime_kuma_revanced_DB_USER=kuma
ARG uptime_kuma_revanced_DB_PASSWORD=kuma
ARG uptime_kuma_revanced_DB_SSL=false

# Command to start the application
CMD ["npm", "run", "start-server"]
