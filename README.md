# datara

A minimal geographic explorer for Brazil and the United States. Search, hover, select, pan and zoom through administrative boundaries. The interface is in Portuguese and follows the system color scheme.

The current product displays geography, not election results or statistical overlays. Maps are static assets served by the web application; the independent API imports and queries Brazilian 2026 first-round election data from PostgreSQL. Frontend election integration is not implemented.

## Run locally

Requirements: Node.js **24.11.0 or newer**, **pnpm 11.10.0**, and installed **PostgreSQL 18** tools (Homebrew `postgresql@18`, `PG_BIN`, or PATH). An explicitly supplied existing PostgreSQL development database can be used instead. Setup does not install system packages.

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm dev
```

Use `pnpm run setup`: bare `pnpm setup` is pnpm's own installation command. Project setup saves ignored root `.env`, creates a persistent local database, migrates it, imports the limited official AC/DF/PE/ZZ pilot and acquires two representative presidential photos. Repeating setup preserves configuration and reuses the published dataset, including a national publication if one already exists. Interrupted initial imports resume on the next setup.

- Web: <http://localhost:5173/br>.
- API: <http://localhost:3000/elections> by default; edit `PORT` in root `.env` if occupied.
- `pnpm dev` loads saved configuration, starts the project-managed database when needed and launches web/API together. Ctrl+C stops them; `pnpm dev:stop` explicitly stops the managed database without deleting data.
- Web-only development remains `pnpm --filter @datara/web dev`.

See [local setup and advanced database operations](docs/election-ingestion.md) for ownership, prerequisites, existing databases and national population. The pilot is ready for API exploration; frontend election integration is not implemented.

## Workspace

| Package            | Directory           | Responsibility                                        |
| ------------------ | ------------------- | ----------------------------------------------------- |
| `datara`           | repository root     | pnpm workspace and Turborepo commands                 |
| `@datara/web`      | `apps/web`          | React, TypeScript, Vite, Canvas and geographic assets |
| `@datara/api`      | `apps/api`          | Hono election API and PostgreSQL ingestion on Node.js |
| `@datara/eslint`   | `packages/eslint`   | shared ESLint configuration                           |
| `@datara/prettier` | `packages/prettier` | shared Prettier configuration                         |

```sh
pnpm --filter @datara/web dev
pnpm --filter @datara/api dev
pnpm build
pnpm lint
pnpm typecheck
pnpm --filter @datara/web map:check
```

All packages are private. Package names do not require renaming checkout directories.

## Documentation

- [Product behavior and URL contract](docs/product.md)
- [Architecture and performance](docs/architecture.md)
- [Geographic data and regeneration](docs/geographic-data.md)
- [Development, API, verification and operations](docs/development.md)
- [Election database setup, population and publication](docs/election-ingestion.md)
- [Election API contract, HTTP examples and checks](docs/election-api.md)

Developer documentation lives here. Internal planning and continuation context live in the external Harness environment; they are not prerequisites for running datara.
