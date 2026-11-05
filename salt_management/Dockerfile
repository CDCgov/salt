# SALT Management Server image
#
# Base: rocker/tidyverse — R + tidyverse pre-installed (needed for the
# Quarto-based reports). Layered on top: Node.js 22 (the API/web server),
# Quarto (report rendering), the R packages reports depend on (RDS, DBI,
# RSQLite, etc.), and a Java runtime for the JEXL script checker.
#
# The image runs HTTP-only on port 3000. TLS is the reverse proxy's job
# (see setup-nginx.sh in this directory). All persistent state lives under
# /app/data which is declared as a VOLUME; supply a bind mount or named
# volume so the database and uploads survive container replacement.
#
# The server runs as the unprivileged user "salt" (uid/gid 10001), so the data
# folder must be owned by 10001:10001 (install.sh does this; see
# README-DOCKER.md for upgrades from images that ran as root).
#
# Supply chain: base images are pinned by digest, Node.js is copied from the
# official Node image, the Quarto package is checked against its published
# SHA-256, and R packages come from a dated CRAN snapshot. To update, change
# the version, digest, checksum or snapshot date below.

# Node.js 22 LTS, official image (sqlite3 6 needs Node 20.17 or newer).
FROM node:22.23.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d AS node

# Production npm dependencies, installed here so npm itself (and its own
# bundled packages) never reaches the final image.
FROM node AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Build stage: compiles the JEXL script checker (tools/jexl-check), which
# parses survey scripts with the same JEXL library the tablet uses.
FROM eclipse-temurin:17-jdk@sha256:43338b737d0f75d6883d3c4563bc66974113ca8ac296e82f39d161fb3d398f0d AS jexl-check
WORKDIR /build
COPY tools/jexl-check/JexlCheck.java ./
COPY tools/jexl-check/lib/ ./lib/
RUN mkdir -p build && javac --release 11 -cp "lib/*" -d build JexlCheck.java

FROM rocker/tidyverse:4.6.2@sha256:a6a87ea5d542adc2e9fad7819ce5074fba56a49bed648c685c3480c285d92ba9

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        openssl \
        sqlite3 \
        python3 \
        libglpk40 \
        libxml2-16 \
        fonts-noto-core \
        openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# Node.js from the pinned official image (no install script). Only the
# runtime: dependencies are installed in the "deps" stage.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN node --version

# Quarto. TARGETARCH is set automatically by Buildkit ("amd64" or "arm64");
# Quarto publishes both .deb flavors. When bumping QUARTO_VERSION, update both
# checksums from the release's quarto-<version>-checksums.txt.
ARG TARGETARCH
ENV QUARTO_VERSION=1.9.37
ARG QUARTO_SHA256_AMD64=98aad03c8ce11705caa7c48b8f6ea59f6ab02d1579e754ddb530c0f2e7b471c6
ARG QUARTO_SHA256_ARM64=cb92414e87a195632c4bb9ad7d8bd7f8c31050909f05fe485402f1467c409c4a
RUN curl -fsSL -o /tmp/quarto.deb \
        "https://github.com/quarto-dev/quarto-cli/releases/download/v${QUARTO_VERSION}/quarto-${QUARTO_VERSION}-linux-${TARGETARCH}.deb" \
    && case "$TARGETARCH" in \
         amd64) QUARTO_SHA256="$QUARTO_SHA256_AMD64" ;; \
         arm64) QUARTO_SHA256="$QUARTO_SHA256_ARM64" ;; \
         *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
       esac \
    && echo "$QUARTO_SHA256  /tmp/quarto.deb" | sha256sum -c - \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/quarto.deb \
    && rm /tmp/quarto.deb \
    && rm -rf /var/lib/apt/lists/*

# R packages used by the reports executor, from a dated CRAN snapshot so a
# rebuild gets the same versions. Move the date forward to update them.
ARG CRAN_SNAPSHOT=https://p3m.dev/cran/__linux__/resolute/2026-11-02
RUN install2.r --error --skipinstalled --repos "$CRAN_SNAPSHOT" \
        RDS DBI RSQLite httr jsonlite lubridate scales uuid \
    && rm -rf /tmp/downloaded_packages

# The unprivileged user the server runs as.
RUN groupadd --system --gid 10001 salt \
    && useradd --system --uid 10001 --gid salt --create-home --home-dir /home/salt --shell /usr/sbin/nologin salt

# TinyTeX — the LaTeX engine Quarto needs to render PDF output. The
# rocker/tidyverse base ships no TeX distribution, so any report with
# `format: pdf` fails without this. TinyTeX is ~200 MB (vs multi-GB for a
# full TeX Live) and auto-installs missing LaTeX packages on demand.
# Installed as "salt" into /home/salt/.TinyTeX, where Quarto looks for it at
# run time and can add missing LaTeX packages.
USER salt
RUN HOME=/home/salt quarto install tinytex --no-prompt
USER root

WORKDIR /app

# npm dependencies from the "deps" stage (cached across source-only changes).
COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules

# Application code. .dockerignore keeps dev/test/data noise out.
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# JEXL script checker: the tablet's JEXL jars plus the class compiled above.
COPY tools/jexl-check/lib/ ./tools/jexl-check/lib/
COPY tools/jexl-check/JexlCheck.java ./tools/jexl-check/
COPY --from=jexl-check /build/build/ ./tools/jexl-check/build/

# App files stay owned by root and read-only to the server's user, whatever
# file modes the build machine had (COPY keeps them).
RUN chmod -R u=rwX,go=rX /app/src /app/public /app/scripts /app/tools /app/package.json /app/package-lock.json

# Pre-create the data subdirs, owned by "salt", so a fresh named volume
# starts with the right ownership.
RUN mkdir -p \
        /app/data/database \
        /app/data/audit \
        /app/data/files \
        /app/data/uploads/surveys \
        /app/data/uploads/recruitment_payments \
        /app/data/uploads/labs \
        /app/data/uploads/device_logs \
        /app/data/reports/temp \
        /app/data/reports/runs \
        /app/data/reports/sources \
        /app/data/reports/templates \
        /app/data/surveys \
    && chown -R salt:salt /app/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER salt
ENV HOME=/home/salt

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/app.js"]
