# datara

A minimal geographic explorer for Brazil and the United States. Search, hover, select, pan and zoom through administrative boundaries. The interface is in Portuguese and follows the system color scheme.

The current product displays geography, not election results or statistical overlays. Maps are static assets served by the web application; the independent API imports and queries Brazilian 2026 first-round election data from PostgreSQL. Frontend election integration is not implemented.

## Run locally

Requirements: Node.js **24.11.0 or newer** and **pnpm 11.10.0**. Use the version pinned in `package.json`; keep `pnpm-lock.yaml` committed with dependency changes.

```sh
pnpm install --frozen-lockfile
pnpm --filter @datara/web dev
```

- Web: <http://localhost:5173/br> (Vite may select another port if occupied).
- API: <http://localhost:3000/>.
- The web explorer needs no database. The API requires `DATABASE_URL`; follow [database setup and population](docs/election-ingestion.md), then run `pnpm --filter @datara/api dev`.

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
