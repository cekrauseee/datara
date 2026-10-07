# Election API

The Hono API reads locally published PostgreSQL data. Import scripts and HTTP startup are independent; importing `createApp` does not start a listener, run migrations or fetch TSE. See [ingestion](election-ingestion.md) for native PostgreSQL setup, population, replay and publication.

## Start and query

Run from the repository root with an existing populated database. Shell variables are used directly; `.env` is not automatically loaded.

```sh
export DATABASE_URL='postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:5432/datara'
export ELECTION_ARCHIVE_DIR="$PWD/.data/elections"
pnpm --filter @datara/api elections --scope pilot --archive "$ELECTION_ARCHIVE_DIR"
pnpm --filter @datara/api dev
```

In another terminal:

```sh
curl -fsS 'http://localhost:3000/elections?country=BR&year=2026&round=1'
curl -fsS 'http://localhost:3000/elections/BR-2026-1/contests'
curl -fsS 'http://localhost:3000/elections/BR-2026-1/areas?level=municipality&uf=ac&limit=25'
curl -fsS 'http://localhost:3000/contests/BR-2026-1:6257:1:br/results?areaId=br&limit=25'
curl -fsS 'http://localhost:3000/contests/BR-2026-1:6259:5:ac/results?areaId=ac:01066:0004:0077'
curl -fsS 'http://localhost:3000/contests/BR-2026-1:6257:1:br/results?areaId=exterior'
curl -fsS 'http://localhost:3000/contests/BR-2026-1:6257:1:br/map?areaId=ac&metric=leader&level=municipality'
curl -fsS 'http://localhost:3000/openapi.json' > /tmp/datara-openapi.json
```

The documented schema is available at `/openapi.json`. Every route has input/output schemas and stable errors. Root `/` still returns `{"message":"datara"}`. No route prefix or header versions the API.

| Route                               | Purpose                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `/elections`                        | Filter available country/year/round editions and active publications        |
| `/elections/:electionId`            | Read edition metadata and selected publication                              |
| `/elections/:electionId/contests`   | List official contests, scope and seats                                     |
| `/elections/:electionId/areas`      | Search/name and navigate parent, level, UF, municipality/zone codes         |
| `/contests/:contestId/candidates`   | Paginated candidacies with resolved local presentation                      |
| `/contests/:contestId/results`      | One area's totals, source meaning, participation, ranking and votes         |
| `/contests/:contestId/distribution` | Paginated territorial candidate votes, support and contribution             |
| `/contests/:contestId/map`          | State/municipality metrics keyed by static map feature ID, without geometry |
| `/sources/:sourceId`                | Original public URL, SHA-256 and collection/generation times                |

Use `publicationId` from the edition response in related queries to keep map and detail on the same snapshot. The server pins one published dataset inside a read-only repeatable-read transaction per request. Missing explicit publications fail with `PUBLICATION_NOT_FOUND`; they never silently switch. Source IDs refer only to published datasets. Source responses omit archive paths and internal metadata. Source timestamps preserve their original text when no timezone can be established.

Lists support `limit` (default 25, maximum 100) and `offset`, with deterministic ordering and total/hasMore. Candidate search accepts `q` and `partyNumber`. Distribution requires `candidateId` and accepts `areaId` and `level`. For example, replace the candidate ID with one returned by the candidates endpoint:

```sh
curl -fsS 'http://localhost:3000/contests/BR-2026-1:6257:1:br/candidates?limit=1'
curl -fsS --get 'http://localhost:3000/contests/BR-2026-1:6257:1:br/distribution' \
  --data-urlencode 'candidateId=CANDIDATE_ID' --data-urlencode 'areaId=ac' \
  --data-urlencode 'level=municipality' --data-urlencode 'limit=25'
```

Map metrics are `leader`, `margin` (percentage points between the two highest recorded candidate counts), `turnout` (percentage), `candidateVotes`, `candidateShare` and `contribution`. The last three require `candidateId`. Maps permit only state or municipality levels and at most 10,000 areas; sections use paginated lists/distribution. The official pilot municipality leader payload has 5,571 feature entries and measured 975,611 bytes before HTTP compression; this is a payload measurement, not a national-load latency guarantee. Exterior entries without geometry are counted separately.

## Meaning of results

Counts are integers; unavailable measures are `null`, never invented zeros. Percentages include numerator, denominator, basis and state; denominator zero is `undefined`. Candidate omissions remain unknown unless the stored complete-result contract explicitly guarantees zero.

`recordedCandidateVotesSum` sums all stored candidate rows for the result before pagination and includes their recorded destinations; it is not a valid-vote share. `printedNominalVotes` includes all nominal BU votables, including those without a verified candidacy. Judicial valid votes remain unavailable in a BU. Official EA20 `pvapn` is returned separately with its original competing-candidate basis. BU and judicial-totalization votes are not interchangeable: territorial contribution is unavailable when the selected scope and local result have different source bases. Turnout always uses that contest/result's own electorate, including Senate and Noronha distinctions.

Tied leaders remain an array. Senate's two-seat cutoff also exposes second-versus-third margin. No margin predicts election, and a local leader does not imply an elected candidate. `officialSelectedFlag` retains the source `e=s` indicator, which can include second-round selection; the complete official status and its scope accompany it. Proportional seat allocation is never inferred from candidate rank.

Aggregated-section result requests return `state=shared`, `resultAreaId` of the principal and the shared totals. Distribution reports no isolated votes for those sections. Regions sum disjoint domestic UF EA20 observations, retain source references and report whether every member state was covered; exterior is separate. A known catalog area without an observation returns `state=unavailable`.

Errors use `error.code`, `message`, `requestId` and optional field details. Invalid input is HTTP 400, missing resources/publications HTTP 404, database unavailability HTTP 503 and unexpected faults HTTP 500. Query failures never become successful empty datasets. SQL and local paths do not appear in error responses; request IDs link internal diagnostics.

## Local presentation and configuration

`apps/api/config/election-presentation.json` is validated once at startup. Candidate keys are their full public IDs; party keys are party numbers. Reimports do not rewrite it. Official names/party data are the defaults; absent photos are `null` and the default color is `#64748b`.

```json
{
  "candidates": {
    "CANDIDATE_ID": {
      "displayName": "Local name",
      "color": "#2563eb",
      "photo": "photos/candidate.jpg"
    }
  },
  "parties": { "13": { "displayName": "Local party name", "color": "#dc2626" } }
}
```

Put local files in `apps/api/public/photos/`; they are served under `/assets/photos/`. Official local photos are acquired by `pnpm --filter @datara/api elections:photos`, optionally with `--contest ID --limit N`, as documented in [ingestion](election-ingestion.md). Use the same `PHOTO_DIRECTORY` for acquisition and API startup; official photo provenance remains in the archive without mutating the voting publication. Presentation resolves an available JSON photo override, then the downloaded official file, then `null`. Restart the API after changing photos or overrides; the file inventory is read once at startup. Overrides accept JPG/JPEG/PNG/WebP filenames, not arbitrary paths. `ELECTION_PRESENTATION_FILE`, `PHOTO_DIRECTORY` (directory containing `photos/`), and `ASSET_BASE_URL` can select durable configuration/assets without changing HTTP fields. A production artifact must include them or supply durable equivalents.

`DATABASE_URL` is required; `PORT` defaults to 3000, `CORS_ORIGIN` to `http://localhost:5173`, and `ASSET_BASE_URL` to `/assets`. Configuration is validated before listening. Allowed CORS origin must be a full origin without a trailing slash/path. Frontend integration is not part of this change.

## Verification

The API check reimports the complete official pilot archive offline into a fresh random schema in an explicitly selected test database, checks HTTP requests and drops only that schema. It requires schema-creation permission. It verifies scopes, limits, source privacy, full-result denominators, real Senate/primary/aggregated/exterior data, synthetic tie/zero edge values, OpenAPI and explicit publication pinning across a new import.

```sh
export TEST_DATABASE_URL='postgresql://YOUR_USER:YOUR_PASSWORD@127.0.0.1:5432/datara_test'
export ELECTION_ARCHIVE_DIR="$PWD/.data/elections"
pnpm --filter @datara/api check:bu
pnpm --filter @datara/api check:ingestion
pnpm --filter @datara/api check:api
pnpm --filter @datara/api typecheck
pnpm --filter @datara/api lint
pnpm --filter @datara/api build
```

Create `datara_test` with `createdb` against your local cluster before the database checks. The archive must already contain the default AC/DF/PE/ZZ pilot. The national acquisition command is implemented but has not been run; pilot checks cannot prove every national BU variant or national reconciliation.
