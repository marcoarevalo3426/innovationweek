# PostgreSQL: run locally, import SQLite, then move to AWS

The app now uses **PostgreSQL exclusively** for its live database. `node:sqlite` is used only by the one-time importer and its tests. Remote databases require verified TLS. No Docker is needed.

The frontend, email login rules, local authentication bypass, image uploads and event controls are unchanged. PostgreSQL 16 is the local development version and a suitable starting point for a later Lightsail PostgreSQL deployment. Choose a supported AWS target version that is at least as new as the source database.

## 1. Install dependencies and configure the local connection

From the project folder:

```sh
npm ci
```

For a new checkout, copy `.env.example` to `.env`. If `.env` already exists, keep its values and add the following PostgreSQL settings instead of overwriting it:

```dotenv
DB_CLIENT=postgres
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=innovation_week
PGUSER=innovation
PGPASSWORD=innovation_local_only
PGSSLMODE=disable
DB_AUTO_MIGRATE=true
DATA_DIR=./data
LOCAL_AUTH_BYPASS=true
```

The published development password is only for the loopback development server. Use a unique password and verified TLS on AWS. The application never falls back to SQLite if PostgreSQL is unavailable.

## 2. Start local PostgreSQL

In **Terminal 1**:

```sh
npm run db:local
```

Keep this terminal open. This development-only helper downloads PostgreSQL with the development dependencies, runs it on `127.0.0.1:5432`, and persists its cluster under `data/postgres/`. Ctrl+C stops the database without deleting its files. On a later run it reuses the cluster and existing database.

If an existing PostgreSQL server already uses port 5432, either use that server with your actual database credentials, or choose another `PGPORT` in `.env` for the helper. Initial user/password settings apply when a cluster is created; changing `.env` does not change an existing database role's password.

If Codex's macOS sandbox reports `could not create shared memory segment: Operation not permitted`, run this command in the macOS **Terminal app**. Do not delete data or change database permissions to work around the sandbox. On Linux, run the helper as your normal non-root user.

You may use a separately installed PostgreSQL 16 server instead. Create a database and role matching `.env`, then skip `db:local`. The production app needs only the `pg` driver; it does not start or manage a PostgreSQL server.

## 3. Create the schema before starting the app

In **Terminal 2**:

```sh
npm run db:migrate
npm run db:check
```

`db:migrate` applies versioned SQL migrations transactionally and is safe to repeat. `db:check` confirms the active PostgreSQL database/schema and prints table counts without passwords. Development startup can also migrate automatically; production defaults to **no automatic DDL** and requires this migration command with the migration owner's database credentials.

If this is an empty new event, proceed to step 5. If you have an existing `data/innovation.sqlite`, import it in step 4 **before the first app startup**. Even a first local login creates a user and audit record, which makes the target nonempty and causes the importer to refuse it.

## 4. Import existing ideas and settings from SQLite

Stop the old SQLite app and keep the new app stopped. Do not stop PostgreSQL. Back up the source database and its `uploads/` folder together while the old app is stopped. Keep the backup outside the active target data directory.

The importer opens SQLite read-only. It does not reset or delete the source. Preview the transfer:

```sh
npm run db:import:sqlite -- --source /absolute/path/to/old-data/innovation.sqlite --dry-run
```

Then import:

```sh
npm run db:import:sqlite -- --source /absolute/path/to/old-data/innovation.sqlite
npm run db:check
```

When the old database is still in this project's `data/` folder, the command can use `--source ./data/innovation.sqlite`. Existing identical images in `data/uploads/` are reused. For a backup elsewhere, keep its `uploads/` folder beside its SQLite file; referenced images are copied into the target `DATA_DIR/uploads/`.

The import:

- Preserves users, administrator flags, ideas, likes, **all voting rounds**, audit IDs and event settings.
- Supplies the original additive defaults when importing an older SQLite schema, including welcome/submission settings and the voting-start marker.
- Checks source integrity, foreign keys, JSON audit details and referenced images; refuses conflicting target images.
- Requires a PostgreSQL target with no application rows except its initial settings row. It never merges or overwrites a live event.
- Imports inside one transaction, compares every imported field with the export, and resets the audit identity sequence.
- Leaves OTP challenges and sessions empty, so everyone signs in again. The development Local Admin's stored `is_admin=0` stays unchanged.
- Preserves the source file log when already in place; otherwise reconstructs the historical target file log from the authoritative audit rows.

`--dry-run` reports source counts and checks target emptiness without copying files or writing rows. Actual import also validates PostgreSQL constraints and round-trip values. A repeated import fails deliberately. If it reports an uncertain commit or a file-log error after commit, inspect `db:check` before retrying; do not delete a populated target.

If an ordinary account for your chosen production admin already exists in imported data, `ADMIN_EMAILS` will not promote it automatically. Have the database owner deliberately set that approved user's `is_admin=1`, or use an existing administrator to assign it in Admin.

## 5. Start the web application

In Terminal 2, after migration/import has finished:

```sh
npm run dev
```

Open **http://127.0.0.1:5173**. Local development still opens as Local Admin without sending email. With `LOCAL_AUTH_BYPASS=false`, the local console email mode lets you test OTP login. The API is **http://127.0.0.1:3001**.

Check **http://127.0.0.1:3001/api/health**. It runs a PostgreSQL query and returns:

```json
{"ok":true,"database":"postgres"}
```

If PostgreSQL is unavailable at startup, the app exits with a connection/schema error. If a running database becomes unavailable, the health endpoint returns HTTP 503. Live application code no longer opens or writes `innovation.sqlite`.

For a built local app, use `npm run build` followed by `npm start`, and browse port 3001. Keep the PostgreSQL terminal running for either mode.

## 6. Run meaningful database tests

```sh
npm test
npm run build
```

By default, the test runner starts a temporary PostgreSQL cluster, creates independent schemas for each test workflow, and removes them afterward. It does not use your event's tables or SQLite file.

In a sandbox that blocks PostgreSQL server startup, keep `npm run db:local` running from Terminal and use:

```sh
TEST_USE_LOCAL_POSTGRES=true npm test
```

This uses the loopback server from `.env` but creates and drops uniquely named **test schemas**, leaving the event's `public` schema unchanged. The configured role needs permission to create those schemas. Remote servers are refused by this test mode. Do not run direct `node --test` integration commands against a production database.

Tests cover the ordinary API workflow, local-vs-production login behaviour, repeatable schema migration, SQLite transfer/rollback/repeat refusal, integer compatibility, parallel vote/submission limits, parallel OTP verification/attempt counts, administrator removal and audit rollback. They exercise PostgreSQL rather than an SQLite adapter.

## 7. Later: migrate local PostgreSQL to AWS PostgreSQL

Follow [the AWS PostgreSQL and SES guide](../postgresql-ses/README.md). At that point this is a **PostgreSQL-to-PostgreSQL** transfer; do not repeat the SQLite importer.

The main steps are:

1. Create private Lightsail managed PostgreSQL in the app instance's account/Region, with a supported version at least as new as the local PostgreSQL version.
2. Stop local app writes, export PostgreSQL with `pg_dump`, and archive uploaded images separately.
3. Copy the dump/images to the Lightsail web instance and restore into a new empty database using the migration owner.
4. Configure a restricted runtime role, the AWS CA bundle and `PGSSLMODE=verify-full`.
5. Set production email delivery with SES, the public HTTPS origin, a new secret and `LOCAL_AUTH_BYPASS=false`.
6. Validate rows/images, start the service, then switch public traffic.

No further database-driver rewrite is needed. SQLite backups remain useful for pre-conversion recovery, but new PostgreSQL changes are not written back into them.

## Data, backup and operational notes

- PostgreSQL stores users, ideas, likes, votes, settings, sessions, challenges and authoritative audit rows. Back it up with PostgreSQL-aware tools or managed database backups.
- `DATA_DIR` stores images, `audit.jsonl` and the local session-secret file. The development helper additionally keeps its cluster under `data/postgres/`; do not copy a running raw cluster directory to AWS as a database migration.
- A database dump alone does not include image files. Stop app writes when taking the coordinated database/image migration snapshot.
- Use `pg_dump`/`pg_restore` with a client version compatible with both source and target. A newer major-version source cannot be assumed to restore into an older AWS engine.
- The app uses a database-scoped transaction advisory lock to retain the old single-writer guarantees for this modest event. All app mutations use it, including OTP consumption, voting, submissions, settings and admin permissions. This favors predictable rules over write throughput. Revisit the locking design before a substantially larger multi-instance deployment.
- Database audit inserts commit with their mutations. File-log append occurs after commit; failed file writes are reported while the database remains authoritative.
- Production defaults `DB_AUTO_MIGRATE=false`; run migrations under the schema owner and grant the runtime role only its required table/sequence privileges.

References: [node-postgres transactions](https://node-postgres.com/features/transactions), [PostgreSQL advisory locks](https://www.postgresql.org/docs/16/explicit-locking.html#ADVISORY-LOCKS), [pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html).
