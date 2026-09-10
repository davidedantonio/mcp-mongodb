# Security Policy

## Supported Versions

This project is pre-1.0 and under active development. Security fixes are applied
to the latest published `0.x` release on npm and to `main`.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | :white_check_mark: |
| older releases | :x: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use one of the following private channels:

1. **GitHub Security Advisories** (preferred) — open a report at
   <https://github.com/davidedantonio/mcp-mongodb/security/advisories/new>.
2. **Email** — send details to **davide.dantonio1984@gmail.com** with the
   subject line `SECURITY: mcp-mongodb`.

Please include:

- a description of the issue and its impact,
- the version or commit affected,
- steps to reproduce or a proof of concept,
- any suggested remediation.

## What to expect

- **Acknowledgement** within 5 business days.
- An initial assessment and severity classification shortly after.
- Coordinated disclosure: we will agree on a timeline with you and credit you in
  the advisory unless you prefer to remain anonymous.

## Scope

Relevant concerns include, but are not limited to:

- ways to read fields not listed in `allowedFields`,
- ways to bypass the mandatory scope filter or query limits,
- any path that enables write/update/delete operations,
- injection through filter input reaching MongoDB,
- credential or connection-string exposure through logs or errors.
