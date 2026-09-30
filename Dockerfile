# Downloads work by spawning yt-dlp (plus ffmpeg for muxing) as child processes, so
# the app needs a host that allows that. Vercel's serverless runtime does not, and it
# never ships bin/ inside a function bundle - see "Hosting it online" in README.md.
FROM node:20-bookworm-slim

# ffmpeg comes from apt rather than the usual build-time download: probeFfmpeg() in
# app/api/download/route.js honours a system ffmpeg on PATH, which keeps the image
# smaller and the build far quicker (the direct download is roughly 160 MB).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so this layer only rebuilds when package-lock.json changes.
# postinstall runs get-ytdlp.js here and stores the Linux yt-dlp binary in bin/;
# .dockerignore keeps the Windows binaries on this machine out of the image.
# scripts/ MUST be copied before `npm install`: postinstall executes
# `node scripts/get-ytdlp.js`, and if scripts/ is missing that step exits non-zero
# and fails the whole build. Verified: npm exits 1 with "Cannot find module" when
# the postinstall script is absent.
COPY package.json package-lock.json ./
COPY scripts/ ./scripts/
ENV SKIP_FFMPEG_DOWNLOAD=1
RUN npm install --no-audit --no-fund

COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Render, Railway and Fly inject PORT. HOSTNAME must be 0.0.0.0 or the container
# only listens on loopback and the platform reports the app as down.
ENV HOSTNAME=0.0.0.0 PORT=3000 NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "exec npm start -- -H \"$HOSTNAME\" -p \"$PORT\""]
