# Migrate NEP Innovation Week to Lightsail, PostgreSQL and SES

This guide describes moving the existing web app to a **Lightsail Linux Node.js instance**, storing application records in a **Lightsail managed PostgreSQL database**, and sending sign-in codes through **Amazon SES SMTP**. It uses the existing Apache or Nginx reverse proxy and systemd, without Docker or Caddy. Linux package commands below target Debian GNU/Linux; check `/etc/os-release` first.

**Current status:** the delivered application still uses synchronous `node:sqlite` in `server/db.js`. PostgreSQL support and a SQLite-to-PostgreSQL importer must be implemented and tested before the database cutover. Adding PostgreSQL credentials alone does not change its database. SES SMTP already works through the existing Nodemailer integration. This document and the accompanying environment template are migration instructions, not a completed application conversion or an AWS deployment.

## Target arrangement

```text
User's browser
    │ HTTPS 443
    ▼
Lightsail static IP / public hostname
    │ Apache or Nginx → 127.0.0.1:3001
    ▼
Node.js application, managed by systemd
    ├── TLS 5432 → private Lightsail managed PostgreSQL
    ├── STARTTLS 587 → Amazon SES SMTP → user's NEP mailbox
    └── persistent local disk → uploaded images and audit.jsonl
```

PostgreSQL replaces the SQLite records. It does **not** move image files or `audit.jsonl` into the database. Keep one app instance and a persistent `DATA_DIR` initially. Multiple app instances would additionally require shared uploads (such as S3), shared rate-limit storage and centralized log handling.

## 1. Prepare the application for PostgreSQL before cutover

Complete these development changes in a separate working copy. Keep the existing app and its data available until the replacement has passed staging checks.

### Driver, queries and API compatibility

1. Install `pg` with `npm install pg`, committing both `package.json` and `package-lock.json` in the converted project.
2. Replace the SQLite-only initialization in `server/db.js` with a PostgreSQL pool and a versioned PostgreSQL schema migration. A migration should complete before the HTTP server starts accepting traffic. Use a privileged migration account for DDL and the restricted application account for normal requests.
3. Convert database helpers to asynchronous operations. Update **every caller** in `server/index.js`, authentication middleware, startup checks, settings reads, ownership checks, audit handling, seed tools and tests to await them. Returning a Promise from the existing synchronous helpers is insufficient.
4. Replace `?` parameters with PostgreSQL `$1`, `$2`, etc.; keep values parameterized. Use explicit column lists for inserts. Replace `INSERT OR IGNORE` with `ON CONFLICT DO NOTHING` and the OTP challenge's `INSERT OR REPLACE` with `ON CONFLICT (email) DO UPDATE`. Remove `PRAGMA`, `DatabaseSync`, `db.prepare()` and SQLite-specific schema introspection from the PostgreSQL path.
5. Replace the audit export's `db.prepare(...).iterate()` with a PostgreSQL cursor or bounded keyset batches. Close the pool with `await pool.end()` during graceful shutdown.
6. Preserve API types. `COUNT(*)` and `BIGINT` values may arrive as strings; safely normalize counts and epoch-millisecond values before arithmetic or JSON responses. Keep permission/display flags as integer `0/1`, or explicitly translate booleans to that API format. Normalize timestamp/JSON representations consistently.
7. Add an explicit backend selector, proposed here as `DB_CLIENT=postgres`. When PostgreSQL is selected, missing credentials, connection errors or a failed schema migration must stop startup. **Do not silently fall back to a new SQLite file.** Log the selected backend without credentials and provide a database readiness check that actually executes a query.

The existing `/api/health` returns `{ "ok": true }` without checking database connectivity. It must not be used as proof of PostgreSQL readiness unless the converted app adds that check, or exposes a separate readiness endpoint.

Sources: [node-postgres queries](https://node-postgres.com/features/queries), [type handling](https://node-postgres.com/features/types).

### Schema mapping

Use the latest schema in `server/db.js`, including its additive migrations, as the source of truth. A low-change first conversion can preserve IDs and timestamp strings:

| Existing data | PostgreSQL mapping and migration rule |
| --- | --- |
| User/idea IDs and foreign keys | Keep `TEXT` initially so IDs are copied unchanged. UUID columns are also possible after validating every source value. |
| `users.is_admin` and display flags | `INTEGER` with `CHECK (... IN (0,1))` preserves the current API. |
| ISO date strings | Preserve as `TEXT` for the first migration, or use `TIMESTAMPTZ` and normalize API output to UTC ISO strings. Never interpret them as server-local time. |
| OTP/session expiry milliseconds | `BIGINT`; preserve the millisecond unit. These short-lived rows will be omitted from the production data transfer below. |
| `audit.id` | `BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`, allowing old IDs to be imported. Reset its sequence after importing. |
| `audit.details` | Keep JSON text, or use `JSONB` and update export/parsing code to accept objects. |
| Likes/votes | Preserve composite primary keys, the vote round and the idea-delete cascade. |
| Settings singleton | Preserve `id=1`, its check constraint and every setting; never overwrite imported values with defaults. |

Create all eight tables: `users`, `ideas`, `likes`, `votes`, `settings`, `challenges`, `sessions` and `audit`. Preserve unique user emails and the existing indexes. Include these four newer settings fields: `submission_mode`, `submission_ends_at`, `show_welcome` and `voting_started_at`. Preserve the default vote allowance of 2 and default welcome flag of 1 for genuinely new databases.

### Transactions and concurrent requests

Each transaction must use **one checked-out pool client** for `BEGIN`, every statement, audit insert and `COMMIT`/`ROLLBACK`. Release it in `finally`. Do not issue transaction statements through independent `pool.query()` calls.

The old SQLite `BEGIN IMMEDIATE` serialized writes. PostgreSQL's default transaction isolation does not automatically preserve the same safeguards. Implement and test locking or serializable transactions with bounded retries:

- Lock/re-read the singleton settings row when changing voting rounds, scheduling, closing submissions or checking a mutation against those controls. Use a consistent lock order across all affected operations.
- Serialize each user's count-and-insert operations for the vote allowance and two-idea limit, for example by locking that user's row. All routes that affect the same invariant must follow the same locking protocol.
- Make like toggles and vote toggles safe under simultaneous requests while retaining their unique constraints.
- Lock and consume an OTP challenge atomically, with expiry and attempt checks inside the transaction, so parallel verification cannot reuse one code. Preserve resend cooldowns and attempt limits under concurrency.
- Protect the final-admin rule against simultaneous permission changes, for example with a shared transaction lock for administrator permission updates.
- Keep audit rows in the same transaction as their associated database mutations. Append the optional file log after commit, or use a transactional outbox, so rolled-back actions are not reported as successful file events.

Recheck the submission deadline after image processing and immediately before inserting. Retain cleanup for failed image writes and failed transactions. Source: [node-postgres transactions](https://node-postgres.com/features/transactions).

### Required development deliverables

Before proceeding to the final cutover, the converted release needs a PostgreSQL schema migration, an importer for the existing SQLite data, an import-validation report, and PostgreSQL-backed integration/concurrency tests. Those commands/scripts are **not included in the current release**; agree their actual names and document them when implementing the conversion. Existing `npm test` uses temporary SQLite databases and does not certify PostgreSQL behaviour.

## 2. Create the Lightsail managed PostgreSQL database

1. Open **Lightsail → Databases → Create database**.
2. Choose the **same AWS account and Region as the app instance**. The example SES region later is Sydney (`ap-southeast-2`); use your actual region consistently.
3. Select PostgreSQL and a currently supported version offered by the console. Size the plan for the expected event traffic; choose a high-availability plan if you need database failover.
4. Name the resource, create it and wait for **Available**.
5. Record its endpoint hostname, port, initial database name, master username and password from its connection details. Keep credentials private.
6. Leave **Networking → Public mode OFF**. Connect from the Lightsail instance over the private network. Do not open port 5432 in the app instance's public firewall.

This creates a separate managed service; the database bundled with a Node.js blueprint is not automatically this PostgreSQL database. Install only the PostgreSQL **client** on the web instance, not another PostgreSQL server.

Sources: [create a database](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-creating-a-database.html), [private/public database access](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-database-public-mode.html), [same-Region requirement](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-databases.html).

## 3. Connect securely and create the application account

Run these commands on the Debian Lightsail web instance:

```sh
sudo apt-get update
sudo apt-get install -y postgresql-client ca-certificates curl
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o /tmp/innovation-aws-db-ca.pem
sudo install -m 644 /tmp/innovation-aws-db-ca.pem \
  /etc/ssl/certs/aws-rds-global-bundle.pem
```

Use the actual database endpoint, initial database name and master user:

```sh
psql "host=YOUR_DATABASE_ENDPOINT port=5432 dbname=YOUR_INITIAL_DATABASE user=YOUR_MASTER_USER sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" -W
```

Enter the password at the prompt rather than putting it in the command. In `psql`, run the following **once on the new database resource**:

```sql
CREATE ROLE innovation_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password innovation_app
CREATE DATABASE innovation_week;
\connect innovation_week
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE innovation_week TO innovation_app;
GRANT USAGE ON SCHEMA public TO innovation_app;
```

`\password` securely prompts for a new app-role password. The master/privileged migration account creates the PostgreSQL tables using the converted release's schema migration. After the tables exist, run as their owner:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO innovation_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO innovation_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO innovation_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO innovation_app;
```

Default privileges apply to future objects created by the role running those statements. Use that same migration owner for future DDL, or configure the defaults for the actual migration role. Do not run the web application with the master account. The one-time importer may use a controlled migration account to insert historical audit IDs and reset the audit sequence.

Verify the restricted role can connect with TLS:

```sh
psql "host=YOUR_DATABASE_ENDPOINT port=5432 dbname=innovation_week user=innovation_app sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" -W
```

Inside `psql`, use `\conninfo` and `SELECT current_database(), current_user;`. For the converted Node adapter, use explicit certificate verification too. A pool configuration can follow this pattern once `pg` is installed:

```js
import { readFileSync } from 'node:fs';
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: {
    ca: readFileSync(process.env.PGSSLROOTCERT, 'utf8'),
    rejectUnauthorized: true,
  },
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});
```

This illustrates the connection configuration, not a replacement for the database layer. Keep the AWS endpoint hostname for certificate verification; do not replace it with an IP. Do not disable certificate verification. Tune the pool against the database's connection capacity.

Sources: [Lightsail PostgreSQL TLS](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-connecting-to-postgres-database-using-ssl.html), [Lightsail CA certificates](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-download-ssl-certificate-for-managed-database.html), [node-postgres TLS](https://node-postgres.com/features/ssl).

## 4. Configure Amazon SES for sign-in codes

1. Open **Amazon SES** in your chosen sending Region.
2. Under **Verified identities**, create a domain identity for a domain you control, or verify the specific sender email address. For a domain identity, publish the DNS verification/DKIM records SES provides and wait for verification. Coordinate NEP-domain DNS changes with its administrator if needed.
3. Choose the verified address for `MAIL_FROM`, for example your approved Innovation Week mailbox. It does not have to be the same hostname as the web app. Users must still sign in with an exact `@nepgroup.com` address.
4. Under **SMTP settings**, create dedicated SMTP credentials and store them securely. Use SMTP sending permissions rather than broad AWS administration credentials.
5. Request **production access** in that Region. Describe the use case as transactional, requested sign-in codes for NEP employees. Until approved, SES sandbox recipients must also be verified.
6. Record the Region's SMTP endpoint. For Sydney it is `email-smtp.ap-southeast-2.amazonaws.com`; use port **587 with STARTTLS**. Port 465 is an alternative supported by this app, using TLS from connection start.
7. Configure bounce/complaint monitoring in SES and review sending quotas before launch.

SES SMTP credentials are different from database passwords and AWS access keys. No SES SDK conversion is required: the app already uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` and `MAIL_MODE=smtp`. Keep outbound port 587 reachable; no inbound SMTP rule is required.

Sources: [verify identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html), [SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html), [production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [SMTP connection testing](https://docs.aws.amazon.com/ses/latest/dg/send-email-smtp-client-command-line.html).

## 5. Prepare the app instance and production environment

Use [the Node.js blueprint deployment guide](../lightsail-nodejs/README.md) for the static IP, DNS, Node 24.14+, dedicated `innovation` account, `/opt/innovation-week` source folder, `/var/lib/innovation-week` storage and systemd service. Keep Node on `127.0.0.1:3001`; expose only HTTP/HTTPS through the existing Apache or Nginx route.

For this migration, substitute the **converted PostgreSQL release** for the current SQLite release. Skip that guide's claim that SQLite initializes automatically, and use the following production configuration instead of its SQLite-only template. Do not start the replacement until its schema and data import are ready.

Copy [production.env.example](production.env.example) to `/etc/innovation-week.env` only when the PostgreSQL implementation exists. Keep a protected backup of any existing environment file first, and edit the new one with `sudo nano /etc/innovation-week.env`. Set owner root and mode 600. The service's `EnvironmentFile` reads it; do not source it into your shell or copy it into the frontend.

Replace all placeholders, including:

- `APP_ORIGIN`: the exact public HTTPS origin with no trailing slash.
- `SESSION_SECRET`: a new secret generated with `openssl rand -hex 48` for this cutover; users will sign in again.
- `PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` and the readable CA file path.
- The proposed `DB_CLIENT=postgres` selector, as implemented in the converted release.
- `ADMIN_EMAILS`: a real NEP administrator address; verify imported administrator flags separately.
- The SES endpoint, SMTP credentials and verified sender.

Keep `NODE_ENV=production`, `LOCAL_AUTH_BYPASS=false`, persistent `DATA_DIR` and `TRUST_PROXY=1` for the single-proxy layout. Quote values containing spaces or other special characters using systemd environment-file syntax. Do not add shell `export` statements or shell substitutions to that file.

Build on Linux as the deployment user:

```sh
cd /opt/innovation-week
npm ci --include=dev
npm run build
npm prune --omit=dev
```

Install the converted release's production dependencies from its updated lockfile. Keep migration/import tools available until cutover validation finishes; if they are development dependencies, postpone pruning them until that work is complete.

## 6. Rehearse the SQLite data transfer

For an empty event, create the PostgreSQL schema with its defaults and skip importing content. For an event with existing ideas, rehearse the following against a disposable PostgreSQL staging database first.

### Freeze and back up the source

1. Stop the old app completely during final transfer. Closing submissions/voting alone does not freeze likes, edits, logins or admin changes. For a local app, stop `npm run dev`; for an existing systemd deployment use `sudo systemctl stop innovation-week` on the **source** instance.
2. Back up the entire source `DATA_DIR`: `innovation.sqlite`, any WAL/SHM files, `uploads/`, `.session-secret` and `audit.jsonl`. Keep an unchanged copy outside the target instance. Also back up the matching app release and sensitive environment settings.
3. Export from a read-only copy of the backed-up SQLite database, preserving UTF-8 text, nulls, IDs, timestamps and integer flags. Use a structured export/import tool with parameterized inserts. A SQLite `.dump` is not PostgreSQL-compatible, and `pg_restore` cannot read a SQLite database file.

### Import in dependency order

The conversion's importer should refuse a nonempty target unless an explicit, reviewed resume mode exists, validate schema versions, and roll back on errors. For a modest event, use a single PostgreSQL import transaction:

| Order | Import rules |
| --- | --- |
| 1. `users` | Preserve IDs, normalized emails and reviewed `is_admin` values. Do not grant the development-only Local Admin production permissions. |
| 2. `ideas` | Preserve authors, fields, image filenames and creation/update dates. |
| 3. `settings` | Replace the fresh `id=1` row with the source row, including round, deadlines, welcome and award flags. |
| 4. `likes` | Preserve each user/idea pair. |
| 5. `votes` | Preserve **every historical round**, not just the current round. |
| 6. `audit` | Preserve IDs, actor, action, timestamp and JSON details. |
| 7. `challenges`, `sessions` | Leave empty deliberately; require a new sign-in after cutover. |

After importing explicit audit IDs, reset its identity sequence as the migration owner:

```sql
SELECT setval(
    pg_get_serial_sequence('public.audit', 'id'),
    COALESCE((SELECT MAX(id) FROM public.audit), 1),
    EXISTS (SELECT 1 FROM public.audit)
);
```

Confirm that at least one **real** NEP user has production admin rights. `ADMIN_EMAILS` only bootstraps new accounts in the current app; it does not automatically promote an imported existing account with `is_admin=0`. If necessary, have the migration owner deliberately promote the approved imported account and record that change.

Keep normal Lightsail database backups enabled for a small event import. Its optional **data import mode** suspends backups and deletes emergency restore backups; use it only for a large import that needs it, after taking a snapshot, and disable it immediately afterward. Source: [Lightsail data import mode](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-database-data-import-mode.html).

### Transfer files separately

Copy `uploads/` to the target `/var/lib/innovation-week/uploads/`, preserving the image filenames referenced by the imported ideas. Preserve the historical `audit.jsonl` file too; it supplements the authoritative database audit rows. Give the `innovation` runtime account ownership of the target data directory, and use directory mode 750 with files restricted appropriately. Never place it in a public web root.

Keep SQLite backups outside the active target data directory. With PostgreSQL selected, the converted app must not create or modify `innovation.sqlite`. `DATA_DIR` remains necessary for image uploads and the file log even after the database changes.

## 7. Validate staging before the public cutover

Produce a comparison report from the frozen SQLite export and PostgreSQL:

- Exact row counts and ID sets for `users`, `ideas`, `likes`, `votes` and historical `audit` rows; the audit count may increase only after validation traffic begins.
- Exactly one settings row, with every value matching the source, including all vote rounds and UTC deadlines.
- Likes per idea, votes per idea **and round**, per-user vote usage and admin membership. Preserve users who already exceed a newly lowered vote limit; do not silently remove legitimate source votes.
- No orphaned references; all foreign keys and unique constraints enabled; every referenced image present and readable.
- Empty session/challenge tables immediately after import, plus a working new sign-in using SES and the approved NEP address.

Run the adapted API suite against a separate PostgreSQL test database, never the production database. Add simultaneous-request checks for vote/submission limits, OTP replay and final-admin removal. Verify database rollback on failure, audit export, image removal, co-admin permissions, new vote rounds, exact schedule boundaries and welcome/countdown behaviour.

Test with production-style HTTPS on a staging hostname. Confirm non-NEP emails are rejected and the local authentication bypass is off. A TCP/TLS connection or SES SMTP authentication check alone does not prove that a recipient can receive and use a sign-in code; test that complete flow.

## 8. Cut over and make the site public

1. Choose a maintenance window. Stop writes on the source, take the final backup/export, and repeat the rehearsed import into a clean production target. Keep the original source stopped.
2. Install the matching converted release and production environment. Complete schema migration/import validation before starting public traffic. Confirm the service's `ExecStart` uses the actual accessible Node executable, as described in the blueprint guide.
3. Start the app:

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now innovation-week
   sudo systemctl status innovation-week --no-pager
   sudo journalctl -u innovation-week -n 100 --no-pager
   curl -fsS http://127.0.0.1:3001/api/health
   ```

4. Confirm the converted app's database readiness check succeeds, PostgreSQL is the logged active backend, and no SQLite file is being written. Check a real gallery query and its imported data.
5. Enable the matching **Apache or Nginx** vhost from [the blueprint guide](../lightsail-nodejs/README.md), pointing all application requests to `127.0.0.1:3001`. Keep its 3 MiB request-body allowance for 2 MiB image uploads.
6. Point the domain A record to the instance's static IP, allow public TCP 80/443, obtain a valid HTTPS certificate and test certificate renewal. If replacing an existing site, prepare DNS/HTTPS in advance where possible and keep maintenance protection until final checks pass.
7. Visit the exact HTTPS origin from another network. Request and use an SES sign-in code, verify administrator access, open existing images and perform a controlled create/edit/like/vote test. Account for those test actions in the audit trail.
8. Reopen normal access only after validation. Check voting and submission deadlines against current time: migrated schedules may have elapsed during the maintenance window. Change event dates only deliberately through Admin.

The site is publicly reachable after DNS, the proxy and HTTPS work. Its innovation content remains behind NEP email authentication. Do not expose database credentials in Vite environment variables, browser bundles or public files.

## 9. Rollback and ongoing backups

**Before accepting new production writes:** stop the PostgreSQL release, restore the original release/environment and its unchanged source data snapshot, then restore routing. New logins will be required. Leave the failed PostgreSQL target isolated for investigation rather than deleting it immediately.

**After accepting new PostgreSQL writes:** restoring the old SQLite snapshot would lose those new actions. Stop writes again, back up both systems, and reconcile or reverse-migrate the new users, ideas, images, likes, votes, settings and audit records before reopening the old app. A DNS change alone is not a safe data rollback.

Enable database backups, retain manual snapshots before major changes and practise restoring to a separate target. Back up uploaded images, the file audit log, application release and protected environment settings separately; managed PostgreSQL backups do not contain those files. Keep the database private, review SES delivery/bounce alerts, monitor disk space and certificate renewal, and plan AWS CA certificate updates before expiry.

## Quick troubleshooting

| Problem | Check |
| --- | --- |
| PostgreSQL timeout | Database is Available, app and database share the account/Region, endpoint/port are correct, and local outbound rules permit 5432. |
| Certificate verification error | Correct AWS CA file, readable by the runtime account, exact endpoint hostname and valid instance time. |
| `permission denied` on table/sequence | Schema owner has applied grants to the runtime role, including after new migrations. |
| PostgreSQL tables stay empty while the app works | The original SQLite code may still be running. Verify the converted release and fail-fast backend selector. |
| Counts behave like strings or flags display incorrectly | Normalize PostgreSQL result types to the existing API contract. |
| Login sends no code | SES Region, verified sender, sandbox restrictions, SMTP credentials, outbound 587, suppression status and app logs. |
| Imported administrator cannot access Admin | Review imported `is_admin`; bootstrap email configuration does not promote an existing ordinary account. |
| Images are missing | Copy uploads separately and match stored filenames and runtime permissions. |
