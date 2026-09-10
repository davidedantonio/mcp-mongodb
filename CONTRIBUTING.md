# Contributing to mcp-mongodb

Thanks for taking the time to contribute! This document explains how to propose
changes to this project.

By participating, you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open a [bug report](https://github.com/davidedantonio/mcp-mongodb/issues/new/choose).
- **Request a feature** — open a [feature request](https://github.com/davidedantonio/mcp-mongodb/issues/new/choose).
- **Improve docs** — README fixes and clarifications are always welcome.
- **Send a pull request** — see below.

For anything security-related, please read [SECURITY.md](./SECURITY.md) instead
of opening a public issue.

## Development setup

Requires **Node.js >= 22**.

```bash
git clone https://github.com/davidedantonio/mcp-mongodb.git
cd mcp-mongodb
npm install
```

### Useful scripts

| Script | Purpose |
| --- | --- |
| `npm test` | Run the unit test suite (Vitest). |
| `npm run test:watch` | Run tests in watch mode. |
| `npm run test:integration` | Run integration tests. |
| `npm run test:coverage` | Run tests with coverage. |
| `npm run typecheck` | Type-check without emitting. |
| `npm run lint` | Lint and format check (Biome). |
| `npm run build` | Compile to `lib/`. |
| `npm run demo:up` / `demo:down` | Start / stop the local MongoDB demo (Docker). |

## Making a change

1. **Fork** the repository and create a branch from `main`:
   `git checkout -b fix/short-description`
2. Make your change. Keep the scope focused — one logical change per PR.
3. Add or update tests for any behavior change.
4. Make sure the full check passes locally:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   ```
5. Commit with a clear message (see below).
6. Push and open a pull request against `main`, filling in the PR template.

### Design principles to preserve

This server is **read-only by construction**. Please do not add:

- write/update/delete operations,
- an environment variable or config flag that enables writes,
- a way to bypass `allowedFields` projection or the scope filter,
- an open-ended query surface beyond the existing closed set of operations.

Changes that weaken these guarantees will not be merged.

## Commit messages

- Use the imperative mood: "add X", "fix Y", not "added"/"fixed".
- Keep the subject line under ~72 characters.
- Reference issues in the body with `Fixes #123` when applicable.

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`) are
appreciated but not required.

## Pull request expectations

- CI must be green (lint, typecheck, tests).
- New code has test coverage.
- Public behavior changes are reflected in the README.
- The PR description explains **what** changed and **why**.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE) that covers this project.
