# SALT Documentation Website

Static marketing and documentation site for [SALT (System Assisted Link Tracing)](https://github.com/cdcgov/salt), built with [Astro](https://astro.build/) and [Starlight](https://starlight.astro.build/).

## Development

```bash
npm install
npm run dev        # Start local dev server at http://localhost:4321
npm run build      # Build static site to dist/
npm run preview    # Preview the built site locally
```

## Deployment

### Build and copy to a local web root

```bash
./deploy.sh --target /var/www/salt-docs
```

### Build and rsync to a remote server

```bash
./deploy.sh --target user@your-server.example.org:/var/www/salt-docs
```

### nginx configuration

A ready-to-use nginx site configuration is at `deploy/nginx-surveysalt.conf`. Edit the `server_name` and `root` directives, then:

```bash
sudo cp deploy/nginx-surveysalt.conf /etc/nginx/sites-available/surveysalt
sudo ln -s /etc/nginx/sites-available/surveysalt /etc/nginx/sites-enabled/
sudo certbot --nginx -d docs.your-domain.example.org -m admin@example.org --agree-tos --non-interactive
sudo nginx -t && sudo systemctl reload nginx
```

## Structure

```
salt_website/
├── src/
│   ├── content/
│   │   └── docs/                  # All documentation pages (Markdown / MDX)
│   │       ├── index.mdx          # Landing page (Starlight splash template)
│   │       ├── getting-started/   # What is SALT, installation, Docker, first steps
│   │       ├── management/        # Management dashboard docs (16 pages)
│   │       ├── tablet/            # Tablet app docs (4 pages)
│   │       └── reference/         # Glossary, troubleshooting, source code
│   └── assets/
│       └── screenshots/           # All screenshots with stable names (36 files)
├── public/
│   └── favicon.svg
├── screenshots/                   # Original screenshots (source, not served)
├── deploy/
│   └── nginx-surveysalt.conf      # nginx site configuration
├── deploy.sh                      # Build and deploy script
├── astro.config.mjs
├── package.json
├── tsconfig.json
└── src/content.config.ts
```

## Screenshots

All 36 screenshots are in `src/assets/screenshots/` with stable, descriptive names. The manifest at `src/assets/screenshots/README.md` maps each stable name back to the original filename and describes what the screenshot shows.

## Adding content

1. Create a `.md` file in the appropriate `src/content/docs/` subdirectory
2. Add frontmatter with at minimum `title` and `description`
3. Add the page to the sidebar in `astro.config.mjs`
4. Reference screenshots with the path `../../../assets/screenshots/filename.png` (three levels up from `src/content/docs/subdir/`)
