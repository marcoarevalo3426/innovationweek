# NEP Innovation Week

A complete local-first, single-page React application using the supplied NEP logo. React + Vite, Express, and a persistent PostgreSQL database. Node.js 24.14 or newer is required. No AWS account is needed locally. The default local experience skips email authentication and opens the app as a development administrator.

## Start locally with PostgreSQL

Read the complete [local PostgreSQL and migration guide](deploy/postgresql/README.md) before starting an existing event. Run commands from this project folder.

```sh
npm ci
# For a new checkout only; keep an existing .env:
cp .env.example .env
```

In Terminal 1, start the development PostgreSQL 16 server and keep it running:

```sh
npm run db:local
```

In Terminal 2, create the schema:

```sh
npm run db:migrate
```

If you have existing SQLite data, stop the old app and import it **before the first PostgreSQL app startup**:

```sh
npm run db:import:sqlite -- --source ./data/innovation.sqlite --dry-run
npm run db:import:sqlite -- --source ./data/innovation.sqlite
```

Skip import for an empty event. The importer preserves the old source, users, ideas, files, likes, all vote rounds, settings and audit history. It refuses an already populated target. Sessions/codes are intentionally omitted. Keep `uploads/` beside the source SQLite file when importing a backup.

Then start the app:

```sh
npm run db:check
npm run dev
```

Open http://127.0.0.1:5173. The API runs on port 3001. PostgreSQL uses port 5432 by default, with development data under `data/postgres/`. Vite reloads frontend edits; restart the API after server/environment changes. If the Codex sandbox blocks PostgreSQL shared memory, run `db:local` in the macOS Terminal app.

Local development opens directly as **Local Admin** (`local.admin@nepgroup.com`) without an email form, delivery, code or session cookie. The stored account has `is_admin=0`; temporary development admin access requires unset/development `NODE_ENV` and a loopback `HOST`. Production and test email workflows do not use this bypass.

To test email login locally, set `LOCAL_AUTH_BYPASS=false` and restart. Console email mode displays local codes; SMTP mode sends real mail. Only exact `@nepgroup.com` addresses are accepted. `ADMIN_EMAILS` applies when an account is first created; imported existing users retain their permissions.

Optional fictitious demo data can be added with `npm run seed:demo` before use; it refuses a nonempty gallery or production. It is never run automatically. PostgreSQL must be running for all server commands; there is no SQLite fallback.

## Current interface and behaviour

| Area | Current behaviour |
| --- | --- |
| Local sign-in | Opens as Local Admin without an email form, code, email delivery or session cookie. Production continues to require email authentication. |
| Typography | All application text has a minimum font size of **10px**, including mobile layouts. |
| Countdown subheader | The “Innovation week starts in” / “Innovation week ends in” text and remaining time are **14px** on desktop, tablet and mobile. The previous “Make your ideas count” text and its arrow icon have been removed. |
| Before voting | The original **Big ideas. Brighter possibilities.** welcome section appears by default. Toggle it in **Admin → Homepage & awards → Show the welcome section before voting**, then save. |
| During voting | The welcome section is replaced by the illustrated **Voting Open** panel and its live end-time countdown. |
| After voting | The illustrated **Voting Closed** panel appears when the deadline passes or an admin closes an active session. |
| New submissions | Admins can accept ideas, set a closing deadline, stop submissions immediately or reopen them under **Admin → Idea submissions**. The closure applies to admins as well as ordinary users. |
| Share/edit dialog | Only **X** and **Cancel** dismiss it. Outside clicks and Escape leave it open. Saving shows a confirmation without closing it, and disables resubmission. |

The optional subheader countdown is controlled by **Admin → Voting & schedule → Show the countdown**. Turning it off does not hide the live countdown inside the voting panel. Before voting starts, disabling the welcome section shows **Voting Opens Soon** for a future scheduled opening, or the closed-status panel when no opening is scheduled.

## What is included

- NEP-only email validation on both client and server; cryptographically random six-digit codes, ten-minute expiration, five attempts, resend cooldown, rate limiting, hashed codes and sessions, one-day HttpOnly session cookies, logout and same-origin mutation protection.
- Responsive gallery: four cards on wide desktops, three on narrower desktops, two on tablets and one on phones. Card images are 250px high. Accessible detail dialogs, search, sorting and personal like/vote filters.
- The share/edit idea dialog preserves drafts on backdrop clicks and Escape. Successful submissions display **Your idea is shared.**; edits display **Changes saved.** The submit button becomes disabled (**Submitted** or **Saved**). Close the dialog with X or Cancel. Idea-detail and confirmation dialogs retain their separate dismissal behaviour.
- User area: up to two current submissions per ordinary user, with create/edit/delete. Required title (120 characters), problem (4,000), solution (4,000) and team skills (1,000); optional JPG/PNG/WebP image up to 2 MiB. Images can be replaced or removed; the server validates and re-encodes uploads to WebP.
- Unlimited likes across ideas, one like per person per idea. Clicking again removes the like.
- Default two votes per person per voting round, configurable from 1–100. Each person can vote once per distinct idea. Clicking a voted idea again withdraws that vote while voting is open. Users can vote for their own ideas. Counts and permissions are enforced on the server, including concurrent requests.
- Administrator controls: open/close voting immediately, configure its end time, schedule a start and end, change vote allowance, reset everyone’s voting round, and show an optional extra countdown below the main header. All co-admins have equal permissions. The final administrator cannot be removed.
- Administrator CRUD for all ideas, with no administrative submission limit. The two-idea rule applies to ordinary users.
- Independent top-three vote/like leaderboards and award banners. Awards require at least one vote/like; ties share the award. Top-three ties use the earliest creation time as a stable tiebreaker. Award counts update live; announcing an award does not freeze results. Close voting first for final vote results. Likes remain available.
- Persistent audit records, an append-only `data/audit.jsonl` file, paginated admin activity viewer and JSONL export. Records cover sign-in/code requests/failures, logout, idea detail views and mutations, likes, votes, user permission changes, settings, resets and audit access. Automatic background polling, input keystrokes and local search changes are not logged. Codes and session tokens are excluded from audit logs. Console delivery mode prints codes only for local development.
- Fifteen-second background refresh and refresh when a window regains focus. Voting eligibility is checked on every server request; the browser countdown uses a server-time offset. Schedule boundaries trigger an additional immediate refresh. No cron process is required, and schedules survive restarts.

Changing the maximum votes below a person’s existing count retains their votes, sets available votes to zero, and prevents new votes until they withdraw enough or an admin resets the round. Resetting votes increments the round, retains previous rounds for audit and leaves likes intact. Deleting an idea deletes its likes/votes and releases those vote slots; the delete action remains logged.

## Voting panel and idea-submission deadlines

Before voting starts, the homepage shows the original **Big ideas. Brighter possibilities.** welcome section by default. In **Admin → Homepage & awards**, turn **Show the welcome section before voting** on or off and save settings. Turning it off shows the voting-status panel instead. This preference persists across restarts.

Once voting opens, the welcome automatically gives way to **Voting Open** and its countdown. When voting ends or an admin closes an active session, the **Voting Closed** panel appears. A new future schedule returns to the welcome section if enabled. Separate ballot-box illustrations accompany voting-status panels. When open, it counts down in days, hours, minutes and seconds to the configured voting end. When the welcome section is disabled, the **Voting Opens Soon** panel counts down to a future scheduled start instead. When its start/end date is configured, the panel shows a countdown independently of the optional header countdown.

In **Admin → Voting & schedule**, choose **Open now** and enter **Voting ends**, or choose **Schedule** and enter both **Voting starts** and **Voting ends**. End time is required when opening voting through these controls. Voting closes automatically at the deadline, including when it was opened manually. Existing installations that already had voting open without an end date stay open; set the end time in Admin to enable their countdown. No closing date is invented during the database migration.

In **Admin → Idea submissions**, choose:

- **Accept ideas** to keep new submissions open.
- **Schedule a deadline** and configure **Idea submissions close** to close automatically.
- **Stop submissions** and save, or use **Stop submissions now**, for immediate closure.
- **Reopen submissions now** to accept ideas again.

All dates are entered in the browser’s local timezone, labeled in Admin, and stored as UTC timestamps. Submission deadlines are independent of voting dates. Closing submissions disables every new-idea control, including the admin’s add button. A submission form already open becomes disabled when its deadline arrives. The API also rejects late submissions, checking again after image processing, so an upload cannot bypass the deadline. Existing ideas remain editable/deletable, and likes remain available. The same rule applies to ordinary users and administrators.

The browser derives event states from server-adjusted time every second and refreshes at each boundary; server checks remain authoritative on every mutation. Existing databases receive additive columns for submission controls, the welcome preference (`show_welcome`, default `1`), and a voting-start marker (`voting_started_at`). The marker distinguishes an event that has not started from a manually closed active event. Ideas, users, likes, votes and existing event settings are preserved. New databases accept ideas by default.

## Data and backup

`server/db.js` now uses asynchronous PostgreSQL queries through `pg`. Versioned SQL lives in `server/migrations/`; `npm run db:migrate` applies it transactionally. Production defaults to schema verification without automatic DDL, allowing a separate migration owner and restricted runtime role.

Tables are `users`, `ideas`, `likes`, `votes`, `settings`, `challenges`, `sessions` and `audit`, plus `schema_migrations` and `data_imports` migration metadata. IDs, UTC ISO strings and integer flags retain the existing API shape. Epoch values use PostgreSQL `BIGINT` and safely convert to JavaScript numbers. Unique keys and foreign keys enforce relationships. Parameterized SQL protects values.

App mutations take a database-scoped transaction advisory lock to retain the original single-writer guarantees for the event. It protects vote/submission limits, OTP verification, event settings and administrator removal across concurrent connections. Transactional audit rows commit with their changes; file logs append after commit. For substantially larger write loads, revisit the locking design.

PostgreSQL backups contain application records. `DATA_DIR` still contains uploaded images, `audit.jsonl` and the local secret; back these up separately and keep them outside any public document root. The local PostgreSQL helper also persists its cluster under `data/postgres/`. Do not copy a running raw cluster directory to AWS; use PostgreSQL dump/restore or managed database backups and coordinate an image snapshot while app writes are stopped.

The old SQLite file is retained as an import/backup source and is not updated by the converted app. Source ZIPs and container images contain no user data or secrets. Building the frontend does not alter PostgreSQL records. See [the PostgreSQL guide](deploy/postgresql/README.md) for import validation, test isolation and AWS transfer steps.

## Email through Amazon SES or another SMTP provider

To test delivery locally, disable the local bypass. Edit `.env`:

```dotenv
LOCAL_AUTH_BYPASS=false
MAIL_MODE=smtp
SMTP_HOST=email-smtp.ap-southeast-2.amazonaws.com
SMTP_PORT=587
SMTP_USER=your-ses-smtp-username
SMTP_PASS=your-ses-smtp-password
MAIL_FROM=innovation@nepgroup.com
ADMIN_EMAILS=your.actual.admin@nepgroup.com
```

Port 587 requires STARTTLS; port 465 uses TLS immediately. SES SMTP credentials differ from AWS access keys. Verify the sender identity in the selected region and request SES production access before sending to unverified recipients. The code-delivery panel and terminal codes are disabled in SMTP mode.

Sources: [SES SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html), [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

## Run the built application

```sh
npm run build
npm start
```

Visit http://127.0.0.1:3001. Express serves both the compiled SPA and API. Upload the source project to the server, run `npm ci`, build there, and keep the Node process running. Uploading `dist` alone is insufficient: authentication, uploads, votes and persistence require the API.

For a real server set these in addition to SMTP settings:

```dotenv
DB_CLIENT=postgres
DB_AUTO_MIGRATE=false
PGHOST=your-private-postgresql-endpoint
PGPORT=5432
PGDATABASE=innovation_week
PGUSER=innovation_app
PGPASSWORD=your-unique-database-password
PGSSLMODE=verify-full
PGSSLROOTCERT=/etc/ssl/certs/aws-rds-global-bundle.pem
NODE_ENV=production
HOST=0.0.0.0
PORT=3001
APP_ORIGIN=https://your-innovation-domain.example
SESSION_SECRET=at-least-32-cryptographically-random-characters
DATA_DIR=/absolute/persistent/data/directory
TRUST_PROXY=1
```

Use the exact external origin without a trailing slash. Generate a secret with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Set `TRUST_PROXY=1` only when exactly one trusted reverse proxy sits in front of Node. Restrict direct public access to port 3001 and terminate HTTPS at that proxy. Production cookies require HTTPS. Production startup refuses console email mode, missing SMTP credentials, a short/missing secret, a missing origin or an unconfigured initial administrator.

A newly migrated empty PostgreSQL database starts with an empty gallery, closed voting, the welcome section enabled and idea submissions open. Switching to production does not reset an existing database or its event settings. Set up the event in the Admin screen after first login. Test email delivery with your actual SMTP account before launch; external email delivery was not tested without credentials.

### AWS deployment with PostgreSQL and SES

Use one Lightsail app instance and a private **Lightsail managed PostgreSQL database** in the same account/Region. The app now uses PostgreSQL locally and remotely, so the later move requires a database dump/restore and production connection settings rather than another driver rewrite. Keep a persistent image directory and HTTPS reverse proxy.

Follow [the AWS PostgreSQL and SES guide](deploy/postgresql-ses/README.md) for a restricted app database role, verified TLS with AWS's CA bundle, PostgreSQL dump/restore, image transfer, SES, production startup, validation and rollback. [The local guide](deploy/postgresql/README.md) covers the initial SQLite import.

The production environment template in `deploy/postgresql-ses/production.env.example` is implemented by this release. Use `DB_AUTO_MIGRATE=false` for the runtime role and run schema migrations separately with the schema owner. Remote PostgreSQL requires `PGSSLMODE=verify-full`; the app rejects remote unverified connections and never falls back to SQLite.

For multiple app instances, move uploads to shared storage such as S3, use shared rate-limit storage and centralize logs. No AWS deployment or SES delivery test has been performed without your credentials.

### PostgreSQL for Amplify: RDS and native Gen 2 integration

Start with [the single setup walkthrough](deploy/amplify-postgresql/SETUP.md) to create the same database schema in AWS and link the existing Amplify frontend. The ready-to-run [schema SQL](deploy/amplify-postgresql/create-schema.sql) includes the app migration metadata and all constraints/defaults.

The [Amplify PostgreSQL deployment guide](deploy/amplify-postgresql/README.md) explains RDS creation/private networking, database dump/restore, restricted roles, the existing Express connection and an optional native Amplify Gen 2 SQL integration. It includes an RDS server environment template and a Gen 2 pipeline example, without changing the active `amplify/` resources.

The default Amplify `Todo` model uses DynamoDB. Native PostgreSQL integration generates an AppSync/SQL Lambda connection to an existing database; it does not automatically replace the current REST login/voting API. The guide keeps those two deployment paths explicit.

### Amplify frontend hosting: connect the Express API

If the site loads on Amplify but sign-in reports an unreachable API, follow [the Amplify API routing guide](deploy/amplify/README.md). A static Vite deployment publishes the UI but does not start `server/index.js`. Deploy the API separately with PostgreSQL/SES, then add a **200 HTTPS rewrite for `/api/<*>` before the SPA fallback**. Set the backend's `APP_ORIGIN` to the Amplify/custom frontend origin. Routing and frontend build templates are provided under `deploy/amplify/`; they are not automatically applied to AWS.

The generated Amplify Auth/Data scaffolding does not replace this app's existing `/api/auth/*` endpoints. Keep any existing backend pipeline unless deliberately adapting that architecture. The current frontend validates JSON responses, recovers from an unavailable API and no longer tells cloud users to start a local development server. API responses include private/no-store cache headers for cookie-based user data.

### Lightsail Node.js blueprint: after uploading the files

Follow the [Lightsail Node.js public-access guide](deploy/lightsail-nodejs/README.md) after copying the full project to your server. It covers Debian-based Node.js blueprints, selecting the existing Bitnami Apache, Debian Apache or Nginx route, Node 24, the Linux build, production SMTP login, a persistent systemd service, static IP/DNS/firewall configuration, HTTPS and certificate renewal. Apache configuration templates are included. No launch script, Docker or Caddy is required.

The guide distinguishes the Node.js blueprint from an OS-only instance. It uses a dedicated app service instead of assuming the blueprint's sample PM2 process already points to this project's entry point. These instructions have not been executed on your AWS instance.

### Native Debian deployment (no Docker or Caddy)

Use the complete [Debian production guide](deploy/debian/README.md) for Node.js 24, systemd, Nginx and Let's Encrypt on a Debian Lightsail instance. It includes installation, the `admin` SSH account, a dedicated `innovation` runtime account, production email settings, HTTPS, persistence and operations.

Ready-to-copy templates are provided in `deploy/debian/`: `innovation-week.service`, `nginx.conf`, and `production.env.example`. These are deployment templates; they have not been installed on your AWS instance.

### Docker (optional)

The included multi-stage Dockerfile builds the frontend and packages a non-root Node runtime. Configure a production `.env` with SMTP, a real origin, secret, admin email and `TRUST_PROXY` as appropriate. The Dockerfile sets `NODE_ENV=production` and `DATA_DIR=/data`. Do not override these with development values in your environment file.

```sh
docker build -t nep-innovation-week .
docker run -d --name nep-innovation-week --restart unless-stopped \
  --env-file .env -e NODE_ENV=production -e HOST=0.0.0.0 -e DATA_DIR=/data \
  -p 127.0.0.1:3001:3001 -v innovation-data:/data nep-innovation-week
```

Put an HTTPS reverse proxy in front of `127.0.0.1:3001`. The named Docker volume preserves data across container replacement. Docker build/run has not been executed in this environment.

## Project structure

| Location | Purpose |
| --- | --- |
| `src/main.jsx` | React entry point. |
| `src/App.jsx` | Login, gallery, user/admin views and dialogs. |
| `src/VotingHero.jsx` | Voting graphics, countdown and submission-status notice. |
| `src/SubmissionControls.jsx` | Admin submission-deadline and open/close controls. |
| `src/styles.css`, `src/events.css` | Responsive styling and typography. |
| `shared/event-state.js` | Voting, submission and homepage-panel rules shared by client and server. |
| `server/index.js` | Express API, authentication, uploads, permissions and audit endpoints. |
| `server/auth-mode.js` | Local-only authentication-bypass rules. |
| `server/db.js` | PostgreSQL pool, asynchronous queries, transactions and audit logging. |
| `server/migrations/` | Versioned PostgreSQL schema migrations. |
| `server/sqlite-import.js` | Read-only legacy SQLite transfer with row/file validation. |
| `scripts/` | Local PostgreSQL helper, schema migration, import, checks and isolated tests. |
| `server/seed.js` | Optional development sample ideas. |
| `public/nep-innovation-week.png` | Supplied NEP Innovation Week logo. |
| `tests/` | API/event-state/local-access tests and the optional browser workflow. |
| `deploy/debian/` | Native Debian production guide and systemd/Nginx/environment templates. |
| `deploy/lightsail-nodejs/` | After-upload public-access guide for Debian Node.js blueprints, including Apache HTTP/HTTPS templates. |
| `deploy/amplify/` | Amplify frontend/API connection guide, HTTPS rewrite example and frontend build template. |
| `deploy/amplify-postgresql/` | RDS PostgreSQL migration and optional native Amplify Gen 2 SQL connection instructions. |
| `deploy/postgresql/` | Local PostgreSQL setup, SQLite import and AWS handoff steps. |
| `deploy/postgresql-ses/` | Implemented PostgreSQL/SES production environment and AWS dump/restore guide. |
| `dist/` | Generated frontend output from `npm run build`. |
| `data/` | Uploads, file log, local secret and development PostgreSQL cluster; excluded from source archives. |

## Verification

```sh
npm test
npm run build
```

The test runner provisions a temporary PostgreSQL cluster and isolated schemas. If a macOS sandbox blocks database startup, run `npm run db:local` in Terminal and use `TEST_USE_LOCAL_POSTGRES=true npm test`. This mode uses only a loopback server and creates/drops separate test schemas, leaving the event tables in `public` unchanged.

The suite covers the full API workflow, development authentication isolation, voting/submission boundaries, repeatable PostgreSQL migrations, SQLite import validation/rollback/repeat refusal, parallel vote/submission limits, OTP replay/attempt counts, administrator removal, integer types and transactional audit logging. A production frontend build and actual PostgreSQL tests are separate checks; SQL-only validation is not equivalent to native multi-connection testing.

The optional Playwright browser suite requires a running loopback PostgreSQL server and uses a separate schema. Install Chromium with `npx playwright install chromium`, then run `npm run test:e2e`. See its configuration for executable overrides. No tests should target production event tables.

Current checks: **36 tests passed against native PostgreSQL** using isolated test schemas, including API, migration/import, parallel-request and frontend response/proxy checks. The frontend build passed. Public Amplify routing and SES delivery still require testing against your deployed services. The earlier WASM checks were preliminary; native validation is now complete.
