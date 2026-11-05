#!/bin/bash
#
# SALT Management Server entrypoint
#
# Runs as the unprivileged "salt" user (uid/gid 10001), set in the Dockerfile.
#
# On every boot:
#   0. Check the data folder is owned by that user (it was root-owned before
#      the image stopped running as root) and say how to fix it if not.
#   1. Ensure the data subdirs exist (host bind mounts may shadow the
#      pre-created tree from the image).
#   2. Auto-generate SESSION_SECRET if the operator didn't supply one.
#      Persist to /app/data/.session-secret so sessions survive restarts.
#      An explicit env var still wins.
#   3. Run the idempotent init-database.js — applies the full schema with
#      IF NOT EXISTS, seeds the demo facility + admin + sample survey + lab
#      tests only when the relevant tables are empty.
#   4. exec the main command (node src/app.js by default).

set -e

DATA_ROOT=/app/data

# --- Data folder ownership --------------------------------------------------
# files/ (the APK download) is only read, so files an admin copies there as
# root are fine; everything else the server writes to.
NOT_OWNED="$(find "$DATA_ROOT" -path "$DATA_ROOT/files" -prune -o ! -user "$(id -u)" -print -quit 2>/dev/null || true)"
if [ ! -w "$DATA_ROOT" ] || [ -n "$NOT_OWNED" ]; then
    echo "[entrypoint] ERROR: the data folder is not owned by the server's user (uid $(id -u), gid $(id -g))." >&2
    [ -n "$NOT_OWNED" ] && echo "[entrypoint]   For example: ${NOT_OWNED}" >&2
    echo "[entrypoint] The container no longer runs as root. On the host, give the data folder to that user, e.g.:" >&2
    echo "[entrypoint]   sudo chown -R $(id -u):$(id -g) /opt/salt/salt-data     # install.sh installs" >&2
    echo "[entrypoint]   sudo chown -R $(id -u):$(id -g) ./salt-data             # docker compose from the repo" >&2
    echo "[entrypoint] then start the container again. (install.sh does this automatically.)" >&2
    exit 1
fi

mkdir -p \
    "$DATA_ROOT/database" \
    "$DATA_ROOT/audit" \
    "$DATA_ROOT/files" \
    "$DATA_ROOT/uploads/surveys" \
    "$DATA_ROOT/uploads/recruitment_payments" \
    "$DATA_ROOT/uploads/labs" \
    "$DATA_ROOT/uploads/device_logs" \
    "$DATA_ROOT/reports/temp" \
    "$DATA_ROOT/reports/runs" \
    "$DATA_ROOT/reports/sources" \
    "$DATA_ROOT/reports/templates" \
    "$DATA_ROOT/surveys"

# --- SESSION_SECRET ---------------------------------------------------------
if [ -z "${SESSION_SECRET:-}" ]; then
    SECRET_FILE="$DATA_ROOT/.session-secret"
    if [ ! -f "$SECRET_FILE" ]; then
        echo "[entrypoint] SESSION_SECRET not provided; generating one and persisting to $SECRET_FILE"
        openssl rand -hex 32 > "$SECRET_FILE"
        chmod 600 "$SECRET_FILE"
    fi
    SESSION_SECRET="$(cat "$SECRET_FILE")"
    export SESSION_SECRET
fi

# --- Database init / upgrade ------------------------------------------------
# init-database.js is idempotent (CREATE TABLE IF NOT EXISTS everywhere,
# guarded INSERTs for seed data), so running on every boot is safe. Fresh
# deployments get the full schema + seeds; existing deployments are no-ops
# unless the image ships a newer schema with additional tables.
echo "[entrypoint] Running database init..."
node scripts/init-database.js

# --- Hand off to the app ----------------------------------------------------
echo "[entrypoint] Starting SALT server..."
exec "$@"
