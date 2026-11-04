#!/bin/bash
#
# SALT Management Server — production install for a fresh Ubuntu droplet.
#
# Takes a freshly-provisioned Ubuntu host with DNS already pointing at it to
# a fully-running production server (HTTPS reverse proxy, persistent data,
# auto-restart on reboot).
#
# Usage (one-liner — installs git, clones repo, builds, runs everything):
#   curl -fsSL https://raw.githubusercontent.com/cdcgov/salt/main/salt_management/install.sh \
#     | sudo bash -s -- <domain> <admin-email>
#
# Usage (already-cloned repo):
#   sudo ./install.sh <domain> <admin-email> [options]
#
# Example:
#   sudo ./install.sh salt.example.org admin@example.org
#
# Options:
#   --install-dir DIR   Where to install / where the data lives (default: /opt/salt)
#   --repo URL          Git repo to clone if running outside a checkout
#                       (default: https://github.com/cdcgov/salt.git)
#   --branch NAME       Branch / tag / commit to check out (default: main)
#   --image IMAGE       Docker image to run (default: build locally from the checkout).
#                       Pass e.g. "fellstat/salt:latest" once the image is published.
#   --upstream PORT     Container's published port on the host (default: 3000)
#   --skip-firewall     Don't touch ufw at all
#   --enable-firewall   Also activate ufw (allow 22/80/443) if it's inactive.
#                       Without this, ufw rules are added but ufw is NOT
#                       enabled — so an existing iptables setup isn't disturbed.
#   --disable-mcp       Disable the MCP report-builder server (ON by default).
#                       MCP_PUBLIC_URL is still set to https://<domain> so it's
#                       correct if you re-enable MCP later in the compose file.
#   --skip-nginx        Don't run setup-nginx.sh (no TLS termination)
#   --proceed           Forwarded to setup-nginx.sh — required to continue
#                       when an existing nginx with enabled sites is found.
#   -h, --help          Show this help and exit
#
# What this script does, in order:
#   1. Sanity: root, Ubuntu, network reachable
#   2. apt update + install git, curl, ca-certificates
#   3. Install Docker Engine + Compose plugin if missing
#   4. Create $INSTALL_DIR + $INSTALL_DIR/salt-data
#   5. Copy this repo's docker-compose.yml (and Dockerfile context, if building)
#      into $INSTALL_DIR
#   6. Build the image OR pull it
#   7. docker compose up -d (restart policy keeps it up across reboots)
#   8. Wait for /health to respond on 127.0.0.1:<port>
#   9. Configure ufw to allow 22, 80, 443 (if ufw is active)
#  10. Run setup-nginx.sh (TLS via Let's Encrypt)
#  11. Print a summary with the URL, default credentials, and the demo
#      facility API key (pulled from container logs)

set -euo pipefail

# ---- Defaults --------------------------------------------------------------
DOMAIN=""
EMAIL=""
INSTALL_DIR="/opt/salt"
REPO_URL="https://github.com/cdcgov/salt.git"
REPO_BRANCH="main"
IMAGE=""              # empty = build locally
UPSTREAM_PORT=3000
SKIP_FIREWALL=0
ENABLE_FIREWALL=0
SKIP_NGINX=0
PROCEED=0
ENABLE_MCP=1   # MCP report builder on by default; --disable-mcp turns it off

# REPO_DIR is the salt_management/ directory we'll run subcommands from.
# When this script is curl-piped to bash, $0 is "bash" or similar — there's no
# file to dirname. We detect that below and clone the repo.
SCRIPT_PATH=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
REPO_DIR="$SCRIPT_PATH"

usage() {
    sed -n '3,38p' "$0"
    exit 1
}

# ---- Arg parsing -----------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --install-dir)  INSTALL_DIR="$2"; shift 2 ;;
        --repo)         REPO_URL="$2"; shift 2 ;;
        --branch)       REPO_BRANCH="$2"; shift 2 ;;
        --image)        IMAGE="$2"; shift 2 ;;
        --upstream)     UPSTREAM_PORT="$2"; shift 2 ;;
        --skip-firewall) SKIP_FIREWALL=1; shift ;;
        --enable-firewall) ENABLE_FIREWALL=1; shift ;;
        --skip-nginx)   SKIP_NGINX=1; shift ;;
        --proceed)      PROCEED=1; shift ;;
        --disable-mcp)  ENABLE_MCP=0; shift ;;
        -h|--help)      usage ;;
        -*)             echo "Unknown flag: $1" >&2; usage ;;
        *)
            if   [[ -z "$DOMAIN" ]]; then DOMAIN="$1"
            elif [[ -z "$EMAIL"  ]]; then EMAIL="$1"
            else echo "Unexpected argument: $1" >&2; usage
            fi
            shift
            ;;
    esac
done

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
    usage
fi

# ---- Sanity ----------------------------------------------------------------
if [[ "$EUID" -ne 0 ]]; then
    echo "ERROR: must run as root (writes /opt, runs apt, restarts docker). Try: sudo $0 ..." >&2
    exit 1
fi

if ! grep -qi ubuntu /etc/os-release 2>/dev/null; then
    echo "WARNING: this installer targets Ubuntu. Detected:" >&2
    head -2 /etc/os-release >&2
    echo "Continuing, but apt/snap commands may behave differently on other distros." >&2
fi

log() { echo "[install] $*"; }
fail() { echo "[install] ERROR: $*" >&2; exit 1; }

log "Domain      : $DOMAIN"
log "Email       : $EMAIL"
log "Install dir : $INSTALL_DIR"
log "Image       : ${IMAGE:-(build locally)}"
log "Upstream    : 127.0.0.1:$UPSTREAM_PORT"

# ---- 1. Base packages ------------------------------------------------------
log "Updating apt and installing base prerequisites..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw

# ---- 1b. Bootstrap repo if we were piped to bash (no local checkout) ------
# Detect by checking that the script's directory contains the Dockerfile we
# need to build. If not, clone the repo into the install dir and re-point
# REPO_DIR at the salt_management/ subdir.
if [[ -z "$REPO_DIR" || ! -f "$REPO_DIR/Dockerfile" ]]; then
    CLONE_PATH="$INSTALL_DIR/repo"
    log "Cloning $REPO_URL ($REPO_BRANCH) into $CLONE_PATH..."
    mkdir -p "$INSTALL_DIR"
    if [[ -d "$CLONE_PATH/.git" ]]; then
        git -C "$CLONE_PATH" fetch --depth 1 origin "$REPO_BRANCH"
        git -C "$CLONE_PATH" checkout "$REPO_BRANCH"
        git -C "$CLONE_PATH" reset --hard "origin/$REPO_BRANCH"
    else
        rm -rf "$CLONE_PATH"
        git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$CLONE_PATH"
    fi
    REPO_DIR="$CLONE_PATH/salt_management"
    [[ -f "$REPO_DIR/Dockerfile" ]] || fail "Cloned repo doesn't contain salt_management/Dockerfile — wrong branch or repo?"
    log "Repo ready at $REPO_DIR"
fi

# ---- 2. Docker -------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    log "Installing Docker Engine + Compose plugin (docker.io official repo)..."
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    UBUNTU_CODENAME="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $UBUNTU_CODENAME stable" \
        > /etc/apt/sources.list.d/docker.list

    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
else
    log "Docker already present: $(docker --version)"
fi

# ---- 3. Install dir + data dir --------------------------------------------
log "Preparing $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR/salt-data"

# The Android APK is served by the app from data/files/. Since data/ is a
# volume mount (and dockerignored), the APK never reaches the container via
# the image — copy it from the repo checkout into the host volume so
# /files/salt.apk works. Repo is the source of truth for the shipped version.
APK_SRC_DIR="$REPO_DIR/data/files"
if [[ -d "$APK_SRC_DIR" ]] && compgen -G "$APK_SRC_DIR/*.apk" >/dev/null; then
    log "Copying APK(s) into $INSTALL_DIR/salt-data/files/..."
    mkdir -p "$INSTALL_DIR/salt-data/files"
    cp -f "$APK_SRC_DIR"/*.apk "$INSTALL_DIR/salt-data/files/"
else
    log "No APK found at $APK_SRC_DIR — /files/salt.apk will 404 until you add one."
fi

# ---- 4. Image: pull or build ----------------------------------------------
if [[ -n "$IMAGE" ]]; then
    log "Pulling image: $IMAGE"
    docker pull "$IMAGE"
    RUN_IMAGE="$IMAGE"
else
    log "Building image from $REPO_DIR (this can take 10–20 minutes the first time)..."
    docker build -t salt-local:latest "$REPO_DIR"
    RUN_IMAGE="salt-local:latest"
    log "Built $RUN_IMAGE"
fi

# ---- 5. Write a compose file rooted at $INSTALL_DIR -----------------------
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
if [[ "$ENABLE_MCP" -eq 1 ]]; then MCP_ENABLED_VALUE="true"; else MCP_ENABLED_VALUE="false"; fi
log "MCP report builder: $([[ "$ENABLE_MCP" -eq 1 ]] && echo "ENABLED (default)" || echo "disabled (--disable-mcp given)"); public URL https://$DOMAIN"
log "Writing $COMPOSE_FILE"
cat > "$COMPOSE_FILE" <<COMPOSE
# Generated by install.sh — edit and 'docker compose up -d' to apply changes.
services:
  salt:
    image: $RUN_IMAGE
    container_name: salt-management
    restart: unless-stopped
    ports:
      - "127.0.0.1:${UPSTREAM_PORT}:3000"
    volumes:
      - ./salt-data:/app/data
    environment:
      NODE_ENV: production
      PORT: 3000
      # SESSION_SECRET auto-generates on first boot and persists to
      # salt-data/.session-secret. Set it here to manage externally.
      # MCP report builder. MCP_PUBLIC_URL is the OAuth issuer + resource id
      # advertised to AI clients (claude.ai etc.), so it must be the public URL.
      MCP_ENABLED: "${MCP_ENABLED_VALUE}"
      MCP_PUBLIC_URL: "https://${DOMAIN}"
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 45s
    # Cap container log growth — morgan logs every request, so json-file
    # logs grow unbounded without this. Keeps at most 50 MB (5 x 10 MB).
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
COMPOSE

# ---- 6. Start container ---------------------------------------------------
log "Starting container..."
(cd "$INSTALL_DIR" && docker compose up -d)

# ---- 7. Wait for /health --------------------------------------------------
log "Waiting for /health on 127.0.0.1:$UPSTREAM_PORT..."
for i in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$UPSTREAM_PORT/health"; then
        log "Server is healthy."
        break
    fi
    sleep 2
    if [[ $i -eq 60 ]]; then
        fail "Server didn't come up after 120 seconds. Inspect: docker logs salt-management"
    fi
done

# ---- 8. Firewall ----------------------------------------------------------
# Adding ufw allow-rules is harmless whether ufw is active or not. ENABLING
# ufw is not: on a host firewalled some other way (raw iptables, cloud
# firewall) it could cut off services on other ports. So enabling is opt-in
# via --enable-firewall.
if [[ "$SKIP_FIREWALL" -eq 0 ]]; then
    log "Adding ufw allow rules (22/tcp, 80/tcp, 443/tcp)..."
    ufw allow 22/tcp >/dev/null
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    if ufw status | grep -q "Status: inactive"; then
        if [[ "$ENABLE_FIREWALL" -eq 1 ]]; then
            log "Enabling ufw (--enable-firewall given)..."
            echo "y" | ufw enable >/dev/null
        else
            log "ufw is inactive — leaving it that way. Rules are staged; run 'ufw enable' yourself, or re-run with --enable-firewall."
        fi
    fi
fi

# ---- 9. Reverse proxy + TLS -----------------------------------------------
if [[ "$SKIP_NGINX" -eq 0 ]]; then
    log "Setting up nginx + Let's Encrypt for $DOMAIN..."
    NGINX_ARGS=("$DOMAIN" "$EMAIL" --upstream "$UPSTREAM_PORT")
    [[ "$PROCEED" -eq 1 ]] && NGINX_ARGS+=(--proceed)
    # setup-nginx.sh exits non-zero (blast-radius guard) if it finds an
    # existing nginx and --proceed wasn't passed. Surface that clearly
    # instead of letting `set -e` abort with no context.
    if ! bash "$REPO_DIR/setup-nginx.sh" "${NGINX_ARGS[@]}"; then
        fail "Reverse proxy setup did not complete. If an existing nginx was detected, review the warning above and re-run install.sh with --proceed (or --skip-nginx to wire your own proxy at 127.0.0.1:$UPSTREAM_PORT)."
    fi
fi

# ---- 10. Summary ----------------------------------------------------------
DEMO_KEY="$(docker logs salt-management 2>&1 | grep -oE 'salt_[a-f0-9-]{36}' | head -1 || true)"

cat <<DONE

================================================================
SALT Management Server — install complete
================================================================
URL              : $( [[ "$SKIP_NGINX" -eq 0 ]] && echo "https://$DOMAIN" || echo "http://127.0.0.1:$UPSTREAM_PORT (no TLS — --skip-nginx was used)" )
Install dir      : $INSTALL_DIR
Data volume      : $INSTALL_DIR/salt-data
Container        : salt-management (restart=unless-stopped)
Compose file     : $COMPOSE_FILE

Default admin    : admin / admin123      ← CHANGE IMMEDIATELY
Demo facility    : ${DEMO_KEY:-"(see: docker logs salt-management | grep API)"}
AI report builder: $( [[ "$ENABLE_MCP" -eq 1 ]] && echo "ENABLED — connect a client to https://$DOMAIN/mcp (Reports tab → AI Report Builder)" || echo "disabled — set MCP_ENABLED: \"true\" in $COMPOSE_FILE to turn on" )

Common ops:
    docker compose -f $COMPOSE_FILE logs -f
    docker compose -f $COMPOSE_FILE restart
    docker compose -f $COMPOSE_FILE pull && docker compose -f $COMPOSE_FILE up -d

Backup:
    tar -czf salt-backup-\$(date +%F).tar.gz -C $INSTALL_DIR salt-data
================================================================
DONE
