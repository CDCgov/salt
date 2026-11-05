---
title: Docker Deployment
description: Building and running the SALT server with Docker, all options, upgrades, backups, and reverse proxy details.
---

The SALT management server is distributed as a Docker image. The image bundles Node.js, R + tidyverse, Quarto, and all R packages needed for the reports executor.

## Quick-start options

### One-command production install

Recommended for a fresh Ubuntu server. See [Installation](/getting-started/installation/).

### Build and run yourself

On any host with Docker installed, from a checkout of the `salt_management/` directory:

```bash
docker build -t salt-management .
mkdir -p salt-data && sudo chown -R 10001:10001 salt-data
docker run -d --name salt \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/salt-data:/app/data" \
  --restart unless-stopped \
  salt-management
sudo ./setup-nginx.sh your-domain.example.org admin@example.org
```

The server runs as an unprivileged user (uid and gid 10001), never as root, so the `salt-data` folder must belong to that user. The one-command install does this for you. Docker Desktop on macOS and Windows handles ownership itself, so the `chown` isn't needed there.

### Docker Compose (existing reverse proxy)

```bash
mkdir -p salt-data && sudo chown -R 10001:10001 salt-data
docker compose up -d
```

`docker-compose.yml` binds to `127.0.0.1:3000`. Point your existing reverse proxy, Cloudflare Tunnel, or load balancer at it.

### Local development (no HTTPS)

```bash
docker build -t salt-management .
docker run -d --name salt -p 3000:3000 -v "$PWD/salt-data:/app/data" salt-management
```

Visit `http://localhost:3000`.

## What ships in the image

| Layer | Version |
|-------|---------|
| Base | `rocker/tidyverse:4.6.2` (R 4.6.2 + tidyverse), pinned to an exact image |
| Node.js | 22.23.4 LTS, from the official Node image |
| Quarto | 1.9.37, checked against its published checksum |
| R packages | `RDS`, `DBI`, `RSQLite`, `httr`, `jsonlite`, `lubridate`, `scales`, `uuid`, from a dated CRAN snapshot |
| User | Unprivileged `salt` user (uid 10001); the container never runs as root |
| App | `src/`, `public/`, `scripts/init-database.js` |

Image is approximately 2 GB unpacked, mostly due to R and Quarto.

## Persistent state

Everything under `/app/data` lives on the volume:

```
data/
├── database/salt.db           SQLite database
├── audit/YYYY-MM/             Audit log JSONL backups
├── uploads/
│   ├── surveys/               Raw survey upload JSON
│   ├── recruitment_payments/  Recruitment payment JSON
│   ├── labs/                  Lab result JSON
│   └── device_logs/           Tablet debug logs
├── reports/
│   ├── temp/                  Quarto scratch space
│   ├── runs/                  Completed report outputs
│   ├── sources/               Report source archives
│   └── templates/             User-supplied report templates
├── surveys/                   Legacy survey storage
└── .session-secret            Auto-generated session signing key
```

Mount the host directory of your choice to `/app/data`. The container creates subdirectories automatically on boot, so an empty bind mount is fine.

## Environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3000` | HTTP port inside the container |
| `NODE_ENV` | `production` | |
| `SESSION_SECRET` | auto-generated | Generated on first boot and persisted to `/app/data/.session-secret`. Set explicitly to manage via your own secret store. |

## Operations

### View logs

```bash
docker logs -f salt
```

### Backup

The entire `data/` tree is the backup unit:

```bash
tar -czf salt-backup-$(date +%F).tar.gz salt-data/
```

Audio files are stored inline in the SQLite database, so the database file holds essentially all data. Typical size is under 100 MB even with thousands of subjects.

### Upgrade

Pull the latest source and rebuild:

```bash
git pull
docker build -t salt-management .
docker stop salt && docker rm salt
sudo chown -R 10001:10001 salt-data   # once, when upgrading from an image that ran as root
docker run -d --name salt \
  -p 127.0.0.1:3000:3000 \
  -v "$PWD/salt-data:/app/data" \
  --restart unless-stopped \
  salt-management
```

The entrypoint re-runs `init-database.js`, which is idempotent, it adds any new tables introduced in the new schema but leaves existing data untouched.

Images built before November 2026 ran as root, so an existing `salt-data` folder belongs to root. If the new container can't write to it, it stops at startup and prints the `chown` command to run. Re-running the one-command install fixes this automatically.

### Shell into the container

```bash
docker exec -it salt bash
```

### Reset the admin password

```bash
docker exec -it salt sqlite3 /app/data/database/salt.db \
  "DELETE FROM admin_users WHERE username='admin';"
docker exec salt node scripts/init-database.js
```

The init script re-creates the `admin` / `admin123` row.

## Reverse proxy

`setup-nginx.sh` automates the common case: Debian/Ubuntu host, nginx, Let's Encrypt via certbot, automatic HTTP→HTTPS redirect, 50 MB `client_max_body_size` to match the app's upload limit, and generous proxy timeouts for large surveys and long-running report renders.

```bash
sudo ./setup-nginx.sh <domain> <admin-email> [--upstream PORT]
```

Re-running the script upgrades certificates and refreshes the site config. The certbot systemd timer handles automatic renewal.

If you are not on Debian/Ubuntu, the nginx site config written to `/etc/nginx/sites-available/salt` is a working starting point you can adapt manually.

## Troubleshooting

**Container won't start**

```bash
docker logs salt
```

Common cause: a port conflict on 3000. Change the host-side port in the `-p` flag.

**Can't reach the web UI from a remote machine**

By default `docker-compose.yml` binds to `127.0.0.1`. Either run `setup-nginx.sh` for TLS or change the bind to `0.0.0.0:3000` for plain HTTP exposure (not recommended in production).

**`/files/salt.apk` returns 404**

The Android APK is served from `data/files/`. Copy it manually:

```bash
cp salt-new.apk /opt/salt/salt-data/files/salt.apk
```

No restart needed.
