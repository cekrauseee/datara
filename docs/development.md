# Development, API and operations

## Tooling

The root pnpm workspace contains `apps/*` and `packages/*`. Turborepo runs development tasks without caching and caches build outputs under `dist/**`. Shared ESLint configuration enables TypeScript unused-variable and deprecation checks; it is intentionally narrower than a comprehensive recommended rule set. Shared Prettier uses single quotes, no semicolons, 100-column lines and import organization; the web package adds Tailwind class ordering.

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm format:check
```

Use the frozen lockfile when setting up an existing checkout. Change dependencies deliberately with pnpm and commit the resulting lockfile with their manifests.

`pnpm format` writes formatting throughout the repository. Prefer targeted formatting for small changes. Generated geographic JSON is excluded recursively from Prettier and should be regenerated rather than manually edited. Dependency build permissions are explicit in `pnpm-workspace.yaml`: esbuild is allowed, optional SQLite/msgpack native builds are disabled. Respect existing versions and lockfile pins.

## API and local election data

`pnpm run setup` prepares ignored root `.env`, the project-managed native PostgreSQL cluster, migrations, the limited official pilot and two photos. `pnpm dev` reloads this configuration, ensures the managed database is running, and launches web/API through Turbo. Dev explicitly passes API configuration through Turbo’s strict environment filtering. Vite uses strict port 5173; API `PORT` defaults to 3000. Occupied IPv4 or IPv6 localhost ports fail clearly.

`@datara/api` uses Hono and PostgreSQL. `DATABASE_URL` is required and is saved by setup; `PORT` defaults to 3000. The web geography explorer remains independent of the API. The backend imports and serves the official Brazilian 2026 first round with local published snapshots; it does not fetch sources during user requests.

See [database setup and ingestion](election-ingestion.md) for native PostgreSQL or optional Compose, migration, pilot/national population and replay. See [API contracts and verification](election-api.md) for routes, OpenAPI, exact HTTP examples, metric bases, local presentation and isolated database checks.

```sh
export DATABASE_URL='postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:5432/datara'
export ELECTION_ARCHIVE_DIR="$PWD/.data/elections"
pnpm --filter @datara/api db:migrate
pnpm --filter @datara/api elections --scope pilot --archive "$ELECTION_ARCHIVE_DIR"
pnpm --filter @datara/api dev
curl -fsS 'http://localhost:3000/elections?country=BR&year=2026&round=1'
curl -fsS 'http://localhost:3000/openapi.json'
```

The root route still returns `{"message":"datara"}`. Root local commands and API runtime/ingestion commands read the saved root `.env` with Node’s native environment-file support. Existing shell variables retain precedence. Test commands still require an explicitly selected `TEST_DATABASE_URL`. Build copies migrations to `dist/db`; production must also retain validated local presentation configuration and photo assets.

## Web verification

```sh
pnpm --filter @datara/web build
pnpm --filter @datara/web lint
pnpm --filter @datara/web typecheck
pnpm --filter @datara/web map:check
```

Build includes TypeScript checking. Geographic checks use Node assertions and checked-in assets; they do not download sources. The current build can emit a nonfatal warning for a JavaScript chunk over Vite's 500 kB threshold. A successful build does not imply browser flows have been tested.

Browser checks are explicit development tools, served by Vite and run in the browser console. Start the web dev server, open it and run the relevant checks:

```js
const navigation = await import('/scripts/check-map-navigation.mjs')
await navigation.checkCache()
await navigation.checkNavigation()
await navigation.checkInitialAnimationAndReveal()
await navigation.checkCountryState()

const canvas = await import('/scripts/check-map-browser.mjs')
await canvas.checkMap('BR')
await canvas.checkMap('US')
// Hover a place first:
canvas.checkTooltip()
```

These checks change the current view/history and create temporary canvases. Cache tests intentionally request nonexistent US state `99` and expect rejection. They cover request reuse/retry, selection/history, initial animation with cold/warm scenes, detail fade-in, country state preservation, controls, resize and cleanup. They are not production routes or Node CLI tests.

For performance measurements:

```js
const benchmark = await import('/scripts/benchmark-map.mjs')
await benchmark.benchmarkMap()
```

It compares cold/warm Massachusetts selection, a diagnostic run without Canvas paint, and São Paulo selection. It records RAF intervals, long tasks, long animation frames and Canvas-call CPU time where browser APIs support them. Use Chromium for the full measurements. Reload before a cold run; retain identical viewport, device pixel ratio and CPU throttling for comparisons. Do not run benchmarks while unrelated builds or heavy tooling compete for resources.

For visual checks, include dark/light themes, mobile width, long hover labels, direct selection URLs, country switching, reduced motion, slow/failed detail downloads and retry. Avoid making unrelated UI changes while validating performance.

## Build and hosting

`@datara/web` builds static files into `apps/web/dist`; `public/maps` is copied into the output, and the worker is emitted as a separate asset. Preview locally with `pnpm --filter @datara/web preview`. Configure static hosting to return `index.html` for application paths such as `/br` and `/us`, while serving actual assets normally. Otherwise deep-link reloads will 404.

The app uses `import.meta.env.BASE_URL` for runtime navigation/assets. When serving under a subpath, configure Vite's base and verify both the worker and map URLs. Browser-check examples assume a root-mounted development server. CSP, if configured by the host, must allow the same-origin worker and map requests. No deployment target, production CI workflow or secret provisioning is configured in this repository.

## Troubleshooting

| Symptom                                | Check                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Map unavailable                        | Static JSON path, response status, worker loading and browser error console                                         |
| Skeleton never completes               | Worker creation/preparation error, zero-size Canvas, missing map asset                                              |
| Local search missing US places         | `maps/us/2025/search.json` and the separate search retry state                                                      |
| County visible but no local boundaries | Zoom threshold, per-state detail request and retry message                                                          |
| Reload of `/us?...` fails              | Static-host SPA fallback                                                                                            |
| Geography appears angular at high zoom | Source simplification; not necessarily a rendering defect                                                           |
| Stutter during cold selections         | Profile worker messages, path creation and frame intervals; do not infer rasterization cost from vector count alone |
| API cannot start                       | Check DATABASE_URL, local PostgreSQL availability, configuration paths and PORT (default 3000)                      |

## Contribution boundaries

Keep geography acquisition, worker preparation, rendering and React UI separate. Reuse local UI components and semantic theme tokens. Preserve leading-zero IDs and shared boundaries. Add regression checks at the responsible layer. Changes to URLs, cache behavior or rendering must preserve keyboard operation, reduced motion, retry behavior and country-state retention.
