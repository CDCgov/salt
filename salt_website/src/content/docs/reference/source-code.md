---
title: Source Code
description: Where to find the SALT source code and how to contribute.
---

SALT is open-source software hosted on GitHub.

## Repository

**[https://github.com/cdcgov/salt](https://github.com/cdcgov/salt)**

The repository contains three main components:

| Directory | Contents |
|-----------|----------|
| `salt_management/` | Management server, Node.js / Express / SQLite / EJS |
| `salt_android/` | Tablet app, Android (Kotlin) |
| `salt_website/` | This documentation website, Astro / Starlight |

## Branches

| Branch | Description |
|--------|-------------|
| `main` | Stable releases |
| `salt-website` | Documentation website development |

## Installation script

The one-command installer is hosted at:

```
https://raw.githubusercontent.com/cdcgov/salt/main/salt_management/install.sh
```

See [Installation](/getting-started/installation/) for usage.

## License

See the `LICENSE` file in the repository root.

## Reporting issues

Open an issue on the GitHub repository: [https://github.com/cdcgov/salt/issues](https://github.com/cdcgov/salt/issues)

Include:
- A description of the problem
- Steps to reproduce
- The relevant component (management server, tablet app, or website)
- Server logs (`docker logs salt`) or tablet logs (uploaded from Developer Settings) if applicable
