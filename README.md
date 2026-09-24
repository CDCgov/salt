# SALT (System Assisted Link Tracing)

### 📖 Full documentation: **[surveysalt.com](https://surveysalt.com)**

---

SALT is a platform for running **any link-tracing survey design**. This includes
Respondent-Driven Sampling (RDS), but also designs where recruitment chains are
short (BBS-lite, starfish sampling), where staff are facility-based with limited
training, and/or where sampling is continuous with no set end date.

SALT takes the guesswork out of sampling: staff and participants are walked
through the survey process step by step, controlled by a central administrative
dashboard that provides up-to-the-minute diagnostics and results.

## Quick start

Stand up a complete, production-ready SALT server on a fresh machine. You need:

- A fresh Ubuntu server (a cloud VM is fine) with root SSH access.
- A domain name whose DNS **A record is already pointed at the server's IP**.

From the server, run:

```bash
curl -fsSL https://raw.githubusercontent.com/ifellows/salt/main/salt_management/install.sh \
  | sudo bash -s -- your-domain.example.org admin@example.org
```

That single command installs Docker, builds and starts the SALT server, opens
the firewall, and provisions HTTPS with a Let's Encrypt certificate. When it
finishes, browse to `https://your-domain.example.org` and sign in as
`admin` / `admin123` — then change that password immediately.

Already have a host with Docker, or need a non-default setup (your own TLS
termination, a prebuilt image, or local testing)? See
[Docker deployment](salt_management/README-DOCKER.md).

---

## Documentation

| Document | What it covers |
|----------|----------------|
| [Architecture overview](ARCHITECTURE.md) | The SALT components and how they fit together |
| [Docker deployment](salt_management/README-DOCKER.md) | Running the server on an existing host — options, upgrades, backups, reverse proxy |
| [Management server guide](salt_management/README.md) | Configuring surveys, facilities, users, lab tests, and data export |
| [Android tablet setup](salt_android/README.md) | Installing and configuring the field data-collection app |
| [SALT methodology](SALT.pdf) | The sampling design and statistical approach behind SALT |


# CDC Notices

## Public Domain Standard Notice
This repository constitutes a work of the United States Government and is not
subject to domestic copyright protection under 17 USC § 105. This repository is in
the public domain within the United States, and copyright and related rights in
the work worldwide are waived through the [CC0 1.0 Universal public domain dedication](https://creativecommons.org/publicdomain/zero/1.0/).
All contributions to this repository will be released under the CC0 dedication. By
submitting a pull request you are agreeing to comply with this waiver of
copyright interest.

## License Standard Notice
The repository utilizes code licensed under the terms of the Apache Software
License and therefore is licensed under ASL v2 or later.

This source code in this repository is free: you can redistribute it and/or modify it under
the terms of the Apache Software License version 2, or (at your option) any
later version.

This source code in this repository is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the Apache Software License for more details.

You should have received a copy of the Apache Software License along with this
program. If not, see http://www.apache.org/licenses/LICENSE-2.0.html

The source code forked from other open source projects will inherit its license.

## Privacy Standard Notice
This repository contains only non-sensitive, publicly available data and
information. All material and community participation is covered by the
[Disclaimer](DISCLAIMER.md)
and [Code of Conduct](code-of-conduct.md).
For more information about CDC's privacy policy, please visit [http://www.cdc.gov/other/privacy.html](https://www.cdc.gov/other/privacy.html).

## Contributing Standard Notice
Anyone is encouraged to contribute to the repository by [forking](https://help.github.com/articles/fork-a-repo)
and submitting a pull request. (If you are new to GitHub, you might start with a
[basic tutorial](https://help.github.com/articles/set-up-git).) By contributing
to this project, you grant a world-wide, royalty-free, perpetual, irrevocable,
non-exclusive, transferable license to all users under the terms of the
[Apache Software License v2](http://www.apache.org/licenses/LICENSE-2.0.html) or
later.

All comments, messages, pull requests, and other submissions received through
CDC including this GitHub page may be subject to applicable federal law, including but not limited to the Federal Records Act, and may be archived. Learn more at [http://www.cdc.gov/other/privacy.html](http://www.cdc.gov/other/privacy.html).

## Records Management Standard Notice
This repository is not a source of government records, but is a copy to increase
collaboration and collaborative potential. All government records will be
published through the [CDC web site](http://www.cdc.gov).

## Additional Standard Notices
Please refer to [CDC's Template Repository](https://github.com/CDCgov/template) for more information about [contributing to this repository](https://github.com/CDCgov/template/blob/main/CONTRIBUTING.md), [public domain notices and disclaimers](https://github.com/CDCgov/template/blob/main/DISCLAIMER.md), and [code of conduct](https://github.com/CDCgov/template/blob/main/code-of-conduct.md).
