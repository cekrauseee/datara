# Brazilian election ingestion

The API reads PostgreSQL; visits never fetch TSE files. The CLI imports the official 2026 first round, discovers its poll/election/office codes through EA11, reads EA12 catalogs, EA20 official aggregates, EA16 primary/aggregated sections and EA18's totalized BU. This includes president, governor, senator, federal/state/district deputies, Fernando de Noronha's district council and presidential exterior results where applicable.

## Integrated local setup

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm dev
# Ctrl+C ends the development session.
pnpm dev:stop
```

Bare `pnpm setup` is a built-in pnpm command; always use `pnpm run setup` for this project. PostgreSQL 18 must already be installed. The script finds the Homebrew `postgresql@18` binaries on macOS, an explicit `PG_BIN`, or compatible tools on PATH. It installs no system packages and registers no login service.

With no supplied database connection, setup initializes `.data/postgres`, binds it only to `127.0.0.1:55431`, and creates `datara` using local trust authentication for development. An ownership marker prevents taking over or resetting an existing manually initialized directory. Root `.env` stores this connection plus absolute archive/photo locations; existing values and comments are preserved. The archive remains `.data/elections`; managed photos are `.data/public/photos`. Database, sources, photos and configuration remain on disk when stopped. Back them up together.

Setup applies migrations and imports the default AC/DF/PE/ZZ pilot only when the edition has no published dataset. It reuses existing publications, including national ones. An initial publication UUID is checkpointed in `.data/local-setup.json`, so rerunning setup resumes an interrupted import; it never runs national acquisition automatically. Two presidential photos are prepared once for the active publication. `pnpm run setup --offline` can bootstrap entirely from an already complete pilot/photo archive.

`pnpm dev` does not import again. It loads saved configuration, restarts only the marked project-managed database, checks API and web localhost ports, and runs both apps. API defaults to port 3000 and Vite to strict port 5173. If occupied, stop the conflicting service or edit the API `PORT` in `.env`; unrelated processes are never killed. `pnpm dev:stop` stops only the marked managed cluster and preserves its contents. External databases are never started or stopped.

To select an existing local development database before first setup, provide `DATABASE_URL` in root `.env` or the setup environment. Setup migrates/populates that explicitly selected database. It refuses non-loopback URLs and host overrides unless invoked with `--allow-external-database`; that flag is only for an explicitly chosen development target and does not provision any service. A conflicting shell `DATABASE_URL` versus saved `.env` fails rather than silently changing targets. Root `.env` is private and ignored; the script never prints credentials.

API dev/start, migrations and ingestion/photo CLI commands also load root `.env` natively. Shell variables can override it for advanced commands. The manual database commands below are alternatives; they are not required after integrated setup.

## Local database

Use an existing PostgreSQL 18 connection with `DATABASE_URL`, or start the optional Docker Compose database. Docker is not installed by this project:

```sh
export POSTGRES_PASSWORD='choose-a-local-password'
docker compose up -d postgres
export DATABASE_URL='postgresql://datara:your-local-password@127.0.0.1:5432/datara'
pnpm --filter @datara/api db:migrate
```

Compose binds to localhost and persists PostgreSQL in a named volume. Use `docker compose stop` to stop it; do not remove the volume unless intentionally discarding the database. `apps/api/.env.example` documents API configuration. Runtime and ingestion commands load root `.env`; explicit shell variables take precedence.

The native macOS setup keeps PostgreSQL on persistent ignored local disk. It does not register a login service:

```sh
HOMEBREW_NO_AUTO_UPDATE=1 brew install postgresql@18
export PG_BIN="$(brew --prefix postgresql@18)/bin"
mkdir -p "$PWD/.data"
# Creates a new cluster; never point initdb at an existing populated cluster.
# -W prompts for a local database password.
"$PG_BIN/initdb" -D "$PWD/.data/postgres" -A scram-sha-256 -W --encoding=UTF8
"$PG_BIN/pg_ctl" -D "$PWD/.data/postgres" -l "$PWD/.data/postgres.log" -o '-h 127.0.0.1 -p 5432' start
"$PG_BIN/createdb" -h 127.0.0.1 -p 5432 -U "$(whoami)" datara
export DATABASE_URL='postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:5432/datara'
pnpm --filter @datara/api db:migrate
# Stop when finished; .data/postgres remains intact:
"$PG_BIN/pg_ctl" -D "$PWD/.data/postgres" stop
```

Use the database role initialized by `initdb` (your operating-system user by default). URL-encode special password characters in `DATABASE_URL`. If port 5432 is already occupied, choose another local port consistently in the startup, `createdb` and connection URL. Starting the same cluster later only needs `pg_ctl start`; do not run `initdb` again.

For disposable isolated verification only:

```sh
# macOS prerequisite, only if PostgreSQL is not already installed:
HOMEBREW_NO_AUTO_UPDATE=1 brew install postgresql@18
export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
initdb -D /tmp/datara-postgres-test -A trust --no-locale
pg_ctl -D /tmp/datara-postgres-test -l /tmp/datara-postgres-test.log -o '-h 127.0.0.1 -p 55432' start
createdb -h 127.0.0.1 -p 55432 datara_test
export DATABASE_URL="postgresql://$(whoami)@127.0.0.1:55432/datara_test"
# Stop after checks:
pg_ctl -D /tmp/datara-postgres-test stop
```

The disposable commands use local trust authentication and bind only localhost. For a durable development database, use a separate durable data directory and configure authentication appropriate to your host. Never overwrite an existing cluster.

## Populate and resume

Run from the repository root. The archive path is persistent, ignored by Git, and must be backed up together with PostgreSQL. `--archive` is resolved against the API package directory when using pnpm filter; the commands below supply an absolute path.

```sh
export ELECTION_ARCHIVE_DIR="$PWD/.data/elections"
# Real, explicitly limited pilot. Official contest-level catalogs/aggregates are national;
# municipality/zone observations and at most two primary BUs per UF are limited to AC/DF/PE/ZZ.
# Primary BU selection includes Noronha and prioritizes principals with aggregated children.
pnpm --filter @datara/api elections --scope pilot --archive "$ELECTION_ARCHIVE_DIR" --pilot-ufs ac,df,pe,zz --municipalities 1 --sections 2

# Full national acquisition, all applicable municipality/zone/primary-section units:
pnpm --filter @datara/api elections --scope national --archive "$ELECTION_ARCHIVE_DIR"

# The CLI prints a publication UUID immediately. Resume an interrupted pilot with the SAME scope/limits/archive:
pnpm --filter @datara/api elections --scope pilot --resume PUBLICATION_UUID --archive "$ELECTION_ARCHIVE_DIR" --pilot-ufs ac,df,pe,zz --municipalities 1 --sections 2

# Reprocess the archived sources into a new publication, with no network requests:
pnpm --filter @datara/api elections --scope pilot --offline --archive "$ELECTION_ARCHIVE_DIR" --pilot-ufs ac,df,pe,zz --municipalities 1 --sections 2

# Acquire an updated source version into a new publication:
pnpm --filter @datara/api elections --scope pilot --refresh --archive "$ELECTION_ARCHIVE_DIR"

# Prepare and validate without making the dataset active:
pnpm --filter @datara/api elections --scope pilot --no-publish --archive "$ELECTION_ARCHIVE_DIR"
pnpm --filter @datara/api elections --publish PUBLICATION_UUID
```

`--stop-after N` intentionally pauses after N result/auxiliary units, for interruption verification. The pilot is marked `scope=pilot, complete=false`; its missing section votes are never national zero votes. It includes all official applicable contest catalogs but imports only the chosen local observations and BUs. Catalog-only areas may be listed with no result. `--pilot-ufs`, `--municipalities` and `--sections` do not limit `--scope national`.

National loading is intentionally a separate user command. It may download hundreds of thousands of documents and take substantial time and disk space. This implementation uses one resumable sequential importer, not background workers. The archive hash store deduplicates identical bytes. A URL cache allows new imports to reuse previous acquisitions; `--refresh` replaces that cache only for new acquisitions, while resumed publications use their frozen source manifest. `--offline` fails if a required source is absent or corrupt. Restore both database and archive to preserve provenance and replay.

## Publication and integrity

Migration `001-election` is applied once under a database transaction/advisory lock. An import gets a UUID and a preparing publication. PostgreSQL stores its source manifest, expected tasks, completion state, catalogs and normalized observations. Each unit's normalization and completion marker commit together; retries replace that unit rather than add vote deltas. Downloaded raw bytes are written atomically by SHA-256 before their manifest row is committed. Corrupt archive bytes fail verification.

Published datasets are immutable through the importer. New imports preserve old publications. Validation requires all expected units, both EA20/BU observations and no unexplained total-ballot differences in fully imported zones. Publication and the edition's active pointer update in one transaction. Failed or paused imports do not change the active dataset. Explicitly noninstalled sections require the official auxiliary status; missing files, unknown statuses and ambiguous totalized hashes fail rather than becoming zero votes.

Aggregated sections retain their IDs and `principal_area_id`, and receive no duplicate result. Administrative zones are represented by municipal zone slices; whole-zone consumers must combine slices. Geography IDs remain electoral codes with optional static-map correspondence; exterior has no geometry. Rows from different publications/contests cannot link through the composite foreign keys.

EA20 totals retain the official raw field groups in metadata, plus explicit numeric columns. Candidate `vap`, vote destination and official `pvapn` are preserved. Party computed/valid nominal and legend votes are separate. EA20 valid votes and BU printed votes are different measurements: BU `valid_votes` remains null, and Senate printed ballots can be twice turnout. BU nominal votables without a uniquely verified candidacy remain queryable in `votable_results`; they are not invented candidacies. Absent candidate rows remain unknown unless the result contract can establish zero. No candidate-by-section cross product is materialized.

The BU2026 reader uses the official September 2026 ASN.1 structure, verifies file identity against inventory and rejects unsupported/encrypted structures. It does not perform signature authentication. The original bytes and SHA-256 preserve audit evidence; SHA-256 alone is not TSE signature verification. The national path has not been executed during development, so variants beyond the pilot remain subject to fail-closed validation.

## Verification

```sh
pnpm --filter @datara/api check:bu
pnpm --filter @datara/api typecheck
pnpm --filter @datara/api lint
pnpm --filter @datara/api build
```

The checked-in official Porto Walter, Abu Dhabi SA and Noronha fixtures exercise presidency, proportional legend, Senate's two choices, optional BU fields, council office 25, distinct per-election participation and truncated-file rejection. It was independently decoded using `asn1tools` and the official ASN.1 specification preserved beside it. Database/API integration checks and HTTP commands are documented with the API module.

The ingestion integration check requires the completed default pilot archive and an explicitly selected isolated PostgreSQL database. It creates and cleans up a temporary schema, imports genuine archived documents offline, checks interrupted/repeated imports and publication retention, and tests composite candidacy foreign keys. A synthetic one-vote reduction is tested inside a rolled-back transaction solely to verify replacement semantics; it is never published as official data.

```sh
createdb -h 127.0.0.1 -p 55432 datara_ingestion_check
export TEST_DATABASE_URL="postgresql://$(whoami)@127.0.0.1:55432/datara_ingestion_check"
export ELECTION_ARCHIVE_DIR="$PWD/.data/elections"
pnpm --filter @datara/api check:ingestion
# Cleanup schema is automatic; the isolated database can be removed afterwards:
dropdb -h 127.0.0.1 -p 55432 datara_ingestion_check
```

## Official photos and local presentation

Photos are an optional, separate acquisition command. The CLI reads the selected published dataset's frozen EA11 `ft` directory and candidacy IDs, downloads official `<sqcand>.jpeg` files and writes JPEGs named by the SHA-256 of the full public candidate ID. API startup discovers these local files; it resolves an available manual photo override first, then the official file, then `null`. Restart the API after photo changes.

```sh
export ELECTION_ARCHIVE_DIR="$PWD/.data/elections"
export PHOTO_DIRECTORY="$PWD/.data/presentation" # contains photos/; use the same value when starting API
# Fast real photo pilot: one president and one Acre federal deputy.
pnpm --filter @datara/api elections:photos --contest BR-2026-1:6257:1:br --limit 1
pnpm --filter @datara/api elections:photos --contest BR-2026-1:6259:6:ac --limit 1
# All primary candidacies in the active publication (national when that publication is national):
pnpm --filter @datara/api elections:photos
# Select an explicit retained snapshot, or replay/update its photos:
pnpm --filter @datara/api elections:photos --publication PUBLICATION_UUID --offline
pnpm --filter @datara/api elections:photos --refresh
```

The default output is `apps/api/public/photos/` when `PHOTO_DIRECTORY` is unset. Photo URL checkpoints, original SHA-256 bytes and per-publication manifests live in the ignored election archive, separate from the immutable published voting manifest. This provenance records URLs, collection times, HTTP status and hashes. Missing optional photos (HTTP 404/410) are recorded and do not block voting publication; other acquisition failures are reported with a nonzero CLI exit so they can be retried. Offline replay needs all requested photo sources archived; select the same contest/limit for a partial pilot. Existing manually modified generated files and presentation JSON are preserved. A refresh can replace a generated file only if its current hash matches the previously acquired original. Back up the photo output directory too.

For the targeted photo/API check, use a database containing the published pilot and the two photo sources acquired above:

```sh
export TEST_DATABASE_URL="$DATABASE_URL" # must reference the populated local test dataset
pnpm --filter @datara/api check:photos
```

This check replays real archived JPEGs to a temporary directory, checks candidate `photoUrl` and actual local HTTP image bytes/hash, verifies that the voting manifest was not changed, and removes only its temporary output. `check:presentation` separately verifies override precedence and absent-image fallback.
