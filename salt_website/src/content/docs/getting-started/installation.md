---
title: Installation
description: One-command installation of the SALT management server on a fresh Ubuntu machine.
---

## Prerequisites

- A fresh **Ubuntu** server (cloud VM, VPS, or bare metal)
- A **domain name** with its DNS A record already pointing at the server's IP address
- **Root SSH access** to the server

The server needs outbound internet access to pull Docker images and obtain a Let's Encrypt certificate.

## One-command installation

From the server (as root or via sudo), run:

```bash
curl -fsSL https://raw.githubusercontent.com/cdcgov/salt/main/salt_management/install.sh \
  | sudo bash -s -- your-domain.example.org admin@example.org
```

Replace `your-domain.example.org` with your actual domain and `admin@example.org` with a valid email address for the Let's Encrypt certificate.

The script:

1. Installs Docker if it is not already present
2. Clones the SALT repository
3. Builds the Docker image (Node.js + R + Quarto, ~2 GB)
4. Starts the container with a persistent volume and automatic restart
5. Opens the firewall (ports 80 and 443)
6. Runs `setup-nginx.sh` to configure nginx with Let's Encrypt TLS
7. Prints the demo facility API key when complete

When the script finishes, browse to `https://your-domain.example.org` and sign in as:

- **Username**: `admin`
- **Password**: `admin123`

**Change this password immediately** via Users → Edit.

## What ships on first boot

The first boot seeds the database with:

- Default admin user (`admin` / `admin123`)
- A **Demo Facility** with a random API key (shown in the container logs, use it to register a tablet)
- Three HIV lab tests: HIV Confirmatory (dropdown), CD4 Count (numeric), HIV Viral Load (numeric)
- **Short MSM Survey**: a complete, ready-to-run link-tracing survey, seeded active
- **SALT HIV Survey**: a small 6-question starter for experimenting with the editor, seeded inactive

## Optional install flags

| Flag | Description |
|------|-------------|
| `--install-dir DIR` | Directory to clone the repo into (default: `/opt/salt`) |
| `--image IMAGE` | Use a pre-built Docker image instead of building |
| `--upstream PORT` | Internal port the container listens on (default: 3000) |
| `--repo URL` | Alternative Git repository URL |
| `--branch NAME` | Git branch to check out |
| `--skip-firewall` | Skip firewall configuration |
| `--skip-nginx` | Skip nginx / Let's Encrypt setup |

Run `install.sh --help` for details.

## Next steps

- [Docker deployment options](/getting-started/docker-deployment/): non-default setups, upgrades, and backups
- [First steps](/getting-started/first-steps/): configure your first facility and connect a tablet
