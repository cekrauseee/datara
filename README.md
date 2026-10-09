# datara

A minimal geographic explorer for Brazil and the United States. Search, hover, select, pan and zoom through administrative boundaries, and explore Brazil's 2026 first-round election results on the same map. The interface is in Portuguese and follows the system color scheme.

Maps are static assets served by the web application; the independent API imports and queries Brazilian 2026 first-round election data from PostgreSQL. Setup loads a limited official pilot; a separate documented command estimates and acquires the complete national first round, resumably.

In Brazil, the header's collection selector switches from plain geography to the 2026 first-round elections. Choosing an office paints the map in the leading candidate's colour by municipality or state, with intensity by margin and a legend with counts and coverage, and replaces the selection card with a results panel for the country, a state, a municipality, an electoral zone, a section, the exterior or a region: top candidates or a paginated ranking, totals, official status, coverage and provenance, and lists to the level below. Selecting a candidate focuses the panel and the map on that candidate's support, votes or contribution. Missing data shows as a dash with its reason, never as zero; every state, including office, candidate, zone and section, lives in the URL, and the plain map keeps working when the API is unavailable. On narrow screens the panel becomes a bottom sheet.

## Run locally

Requirements: Node.js **24.11.0 or newer**, **pnpm 11.10.0**, and installed **PostgreSQL 18** tools (Homebrew `postgresql@18`, `PG_BIN`, or PATH). An explicitly supplied existing PostgreSQL development database can be used instead. Setup does not install system packages.

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm dev
```

Use `pnpm run setup`: bare `pnpm setup` is pnpm's own installation command. Project setup saves ignored `apps/api/.env`, creates a persistent local database, migrates it, imports the limited official AC/DF/PE/ZZ pilot and acquires two representative presidential photos. Repeating setup preserves configuration and reuses the published dataset, including a national publication if one already exists. Interrupted initial imports resume on the next setup.

- Web: <http://localhost:5173/br>.
- API: <http://localhost:3000/elections> by default; edit `PORT` in `apps/api/.env` if occupied.
- `pnpm dev` loads saved configuration, starts the project-managed database when needed and launches web/API together. Ctrl+C stops them; `pnpm dev:stop` explicitly stops the managed database without deleting data.
- Documentation: <http://localhost:3002>; `pnpm docs:dev` needs no API/database/setup. After a docs build, `pnpm docs:start` runs its production preview.
- Web-only development remains `pnpm --filter @datara/web dev`; set `VITE_API_URL` when the API is not on <http://localhost:3000>.

See [local setup and advanced database operations](docs/election-ingestion.md) for ownership, prerequisites, existing databases and the national population command. With the pilot, the election view has national and state results, but municipal, zone and section results only for the few areas the pilot imports in AC, DF, PE and the exterior; elsewhere the panel says the pilot has no result for the area.

## Workspace

| Package            | Directory           | Responsibility                                              |
| ------------------ | ------------------- | ----------------------------------------------------------- |
| `datara`           | repository root     | pnpm workspace and Turborepo commands                       |
| `@datara/web`      | `apps/web`          | React, TypeScript, Vite, Canvas and geographic assets       |
| `@datara/docs`     | `apps/docs`         | Next.js, bilingual MDX docs and generated OpenAPI reference |
| `@datara/theme`    | `packages/theme`    | shared neutral palette and Geist assets                     |
| `@datara/api`      | `apps/api`          | Hono election API and PostgreSQL ingestion on Node.js       |
| `@datara/eslint`   | `packages/eslint`   | shared ESLint configuration                                 |
| `@datara/prettier` | `packages/prettier` | shared Prettier configuration                               |

```sh
pnpm --filter @datara/web dev
pnpm --filter @datara/api dev
pnpm build
pnpm lint
pnpm typecheck
pnpm --filter @datara/web map:check
pnpm --filter @datara/web election:check
```

All packages are private. Package names do not require renaming checkout directories.

## Documentation

- [Product behavior and URL contract](docs/product.md)
- [Architecture and performance](docs/architecture.md)
- [Geographic data and regeneration](docs/geographic-data.md)
- [Development, API, verification and operations](docs/development.md)
- [Election database setup, population and publication](docs/election-ingestion.md)
- [Election API contract, HTTP examples and checks](docs/election-api.md)

The public documentation app renders canonical bilingual MDX in `docs/site/`. The links above point to repository entry pages. Internal planning and continuation context live in the external Harness environment; they are not prerequisites for running datara.
