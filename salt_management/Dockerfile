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

# Build stage: compiles the JEXL script checker (tools/jexl-check), which
# parses survey scripts with the same JEXL library the tablet uses.
FROM eclipse-temurin:17-jdk AS jexl-check
WORKDIR /build
COPY tools/jexl-check/JexlCheck.java ./
COPY tools/jexl-check/lib/ ./lib/
RUN mkdir -p build && javac --release 11 -cp "lib/*" -d build JexlCheck.java

FROM rocker/tidyverse:latest

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=3000

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        openssl \
        sqlite3 \
        python3 \
        libglpk40 \
        libxml2 \
        fonts-noto-core \
        openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 (LTS) from NodeSource. sqlite3 6 needs Node 20.17 or newer.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Quarto. TARGETARCH is set automatically by Buildkit ("amd64" or "arm64");
# Quarto publishes both .deb flavors. Bump QUARTO_VERSION when needed.
ARG TARGETARCH
ENV QUARTO_VERSION=1.9.37
RUN curl -fsSL -o /tmp/quarto.deb \
        "https://github.com/quarto-dev/quarto-cli/releases/download/v${QUARTO_VERSION}/quarto-${QUARTO_VERSION}-linux-${TARGETARCH}.deb" \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/quarto.deb \
    && rm /tmp/quarto.deb \
    && rm -rf /var/lib/apt/lists/*

# TinyTeX — the LaTeX engine Quarto needs to render PDF output. The
# rocker/tidyverse base ships no TeX distribution, so any report with
# `format: pdf` fails without this. TinyTeX is ~200 MB (vs multi-GB for a
# full TeX Live) and auto-installs missing LaTeX packages on demand.
RUN quarto install tinytex --no-prompt

# R packages used by the reports executor.
RUN install2.r --error --skipinstalled \
        RDS DBI RSQLite httr jsonlite lubridate scales uuid \
    && rm -rf /tmp/downloaded_packages

WORKDIR /app

# Install npm deps first so the layer caches across source-only changes.
COPY package*.json ./
RUN npm ci --omit=dev

# Application code. .dockerignore keeps dev/test/data noise out.
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# JEXL script checker: the tablet's JEXL jars plus the class compiled above.
COPY tools/jexl-check/lib/ ./tools/jexl-check/lib/
COPY tools/jexl-check/JexlCheck.java ./tools/jexl-check/
COPY --from=jexl-check /build/build/ ./tools/jexl-check/build/

# Pre-create the data subdirs so first-run permissions are sane.
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
        /app/data/surveys

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/app.js"]
