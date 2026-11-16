# BlackBox Stream vote server — v75
# One file, no dependencies. Mount a volume at /data to keep votes.
FROM node:22-alpine

# su-exec lets the container start as root (so it can claim a freshly mounted
# volume) and then drop to the unprivileged `node` user.
RUN apk add --no-cache su-exec

WORKDIR /app

# Only what the server needs. No npm install: there are no dependencies.
COPY package.json ./
COPY server/bbx-vote-server.mjs ./server/bbx-vote-server.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data && chown -R node:node /app /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    BBX_VOTES_FILE=/data/votes.json

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/bbx-vote-server.mjs"]
