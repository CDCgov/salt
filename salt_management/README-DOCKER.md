# SALT Management Server — Docker deployment

One-command deployment of the SALT management server. The image bundles
Node.js, R + tidyverse, Quarto, and the R packages needed for the reports
executor. Persistent state (database, uploads, audit logs, generated reports)
lives in a host volume.

## Quick start

### Fresh Ubuntu droplet → production — one line

DNS already pointed at the droplet, root SSH access. From the droplet:

```bash
curl -fsSL https://raw.githubusercontent.com/cdcgov/salt/main/salt_management/install.sh \
  | sudo bash -s -- your-domain.example.org admin@example.org
```

`install.sh` installs Docker, clones the repo, builds the image, starts the
container with a persistent volume + auto-restart, opens the firewall, runs
`setup-nginx.sh` for Let's Encrypt TLS, and prints the demo facility's API
key on success. Browse to `https://your-domain.example.org` and log in as
`admin` / `admin123` (change the password immediately).

Flags: `--install-dir`, `--image IMAGE`, `--upstream PORT`,
`--repo URL`, `--branch NAME`, `--skip-firewall`, `--skip-nginx`. Run
`install.sh --help` for details.

### Build the image and run it yourself

No image is published, so build it from a checkout of this repo's
`salt_management/` directory. On any host with Docker installed:

```bash
docker build -t salt-management .
docker run -d --name salt -p 127.0.0.1:3000:3000 -v "$PWD/salt-data:/app/data" --restart unless-stopped salt-management
sudo ./setup-nginx.sh your-domain.example.org admin@example.org
```

### Server only (you're providing your own TLS termination)

```bash
docker compose up -d
```

`docker-compose.yml` binds the container to `127.0.0.1:3000`. Point your
existing reverse proxy / Cloudflare Tunnel / load balancer at it.

### Local development / testing without HTTPS

```bash
docker build -t salt-management .
docker run -d --name salt -p 3000:3000 -v "$PWD/salt-data:/app/data" salt-management
```

Visit `http://localhost:3000`.

## What ships in the image

| Layer | Version |
|---|---|
| Base | `rocker/tidyverse:latest` (R 4.x + tidyverse) |
| Node.js | 18.x (NodeSource) |
| Quarto | 1.9.37 |
| R packages | `RDS`, `DBI`, `RSQLite`, `httr`, `jsonlite`, `lubridate`, `scales`, `uuid` |
| App | `src/`, `public/`, `scripts/init-database.js` |

Image is ~2 GB unpacked, mostly due to R + Quarto.

## Persistent state

Everything under `/app/data` is on the volume:

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
│   ├── temp/                  Quarto scratch
│   ├── runs/                  Completed report outputs
│   ├── sources/               Report source archives
│   └── templates/             User-supplied report templates
├── surveys/                   Legacy survey storage
└── .session-secret            Auto-generated session signing key
```

Mount the host directory of your choice to `/app/data`. The container
auto-creates subdirs on boot, so an empty bind mount is fine.

## Environment variables

All optional.

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port inside the container |
| `NODE_ENV` | `production` | |
| `SESSION_SECRET` | auto-generated | If unset, the entrypoint generates a random 32-byte hex key on first boot and persists to `/app/data/.session-secret`. Subsequent boots reuse it. Set this explicitly to manage it via your own secret store. |

## First-boot seeds

On a fresh database the init script creates:

- **Default admin user**: `admin` / `admin123` — **change this immediately**.
- **Demo facility** with a random API key (printed in the container logs;
  use it on a tablet to register against this facility).
- **Three HIV lab tests**: HIV Confirmatory (dropdown), CD4 Count (numeric,
  cells/mm³), HIV Viral Load (numeric, copies/mL).
- **Short MSM Survey** — a complete, ready-to-run link-tracing survey,
  seeded **active** so a tablet can sync it immediately.
- **Sample survey** ("SALT HIV Survey", 6 questions) — a small **inactive**
  starter for experimenting with the survey editor.

Surveys are seeded only when the database has no surveys at all; the other
seeds are skipped if their tables already have rows. Restoring an existing
volume into a new container preserves your data.

## Operations

### Logs

```bash
docker logs -f salt
```

### Backup

The whole `data/` tree is the backup unit:

```bash
tar -czf salt-backup-$(date +%F).tar.gz salt-data/
```

The SQLite DB is small (typically < 100 MB even with thousands of subjects);
audio files are stored inline in the DB, so the database file holds
essentially everything.

### Upgrade

Pull the latest source and rebuild:

```bash
git pull
docker build -t salt-management .
docker stop salt && docker rm salt
docker run -d --name salt -p 127.0.0.1:3000:3000 -v "$PWD/salt-data:/app/data" --restart unless-stopped salt-management
```

The entrypoint re-runs `init-database.js`, which is idempotent — it picks
up any new tables added in the schema but leaves existing data alone.

### Shell into the container

```bash
docker exec -it salt bash
```

## Reverse proxy details

`setup-nginx.sh` automates the common case: Debian/Ubuntu host, nginx,
Let's Encrypt via certbot's nginx plugin, automatic HTTP→HTTPS redirect,
50 MB `client_max_body_size` to match the app's upload limit, generous
proxy timeouts for big surveys and long-running report renders.

```bash
sudo ./setup-nginx.sh <domain> <admin-email> [--upstream PORT]
```

Re-running upgrades certs and refreshes the site config. The certbot
systemd timer handles automatic renewal.

If you're not on Debian/Ubuntu, the site config it writes
(`/etc/nginx/sites-available/salt`) is a working starting point you can
adapt manually.

## Troubleshooting

**Container won't start**
```bash
docker logs salt
```
Common cause: a port conflict on 3000. Change the host-side port in the
`-p` flag.

**Can't reach the web UI from a remote machine**
By default `docker-compose.yml` binds to `127.0.0.1` only. Either run
`setup-nginx.sh` for proper TLS or change the bind to `0.0.0.0:3000` for
plain HTTP exposure (not recommended in production).

**Database missing tables after an upgrade**
The image's `init-database.js` only `CREATE TABLE IF NOT EXISTS`s — it
won't add new *columns* to existing tables. If a future image adds new
columns, a schema-evolution path will ship with that release. (As of v1.0
no in-place column additions are needed.)

**`/files/salt.apk` returns 404**
The Android APK is served from `data/files/`. `install.sh` copies any
`*.apk` from the repo checkout into `salt-data/files/` automatically. To
update or add one manually:
```bash
cp salt-new.apk /opt/salt/salt-data/files/salt.apk
```
No restart needed — it's served straight off the volume.

**Reset the admin password**
```bash
docker exec -it salt sqlite3 /app/data/database/salt.db \
  "DELETE FROM admin_users WHERE username='admin';"
docker exec salt node scripts/init-database.js
```
The init script will re-create the `admin` / `admin123` row.
