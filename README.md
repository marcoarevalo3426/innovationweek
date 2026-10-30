# NEP Innovation Week

A complete local-first, single-page React application using the supplied NEP logo. React + Vite, Express, and a persistent SQLite database. Node.js 24.14 or newer is required. No AWS account is needed locally. The default local experience skips email authentication and opens the app as a development administrator.

## Start locally

Run these commands from the project directory. If you already have a `.env`, keep it and skip the copy command.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. The API runs on port 3001. Vite reloads frontend edits; restart `npm run dev` after changing the server or environment settings.

Local development opens directly as **Local Admin** (`local.admin@nepgroup.com`). There is no email form, code generation, email delivery or session creation. The sign-out control is hidden in this mode. Ideas, likes, votes and audit records still use a persistent user identity. Local admin permissions are granted only for local requests; the account is stored with `is_admin = 0`.

The bypass is enabled only with an unset/development `NODE_ENV` and a loopback `HOST` (`127.0.0.1`, `localhost`, or `::1`). Production and automated authentication tests always use the email login flow, even if `LOCAL_AUTH_BYPASS=true`.

To test email login locally, set `LOCAL_AUTH_BYPASS=false` in `.env` and restart `npm run dev`. Enter a valid `@nepgroup.com` email. With `MAIL_MODE=console`, the code appears in the form and terminal, and no real email is sent. Use `admin@nepgroup.com` for the initial local email-auth administrator, or configure `ADMIN_EMAILS` before that email first signs in. Co-admin permissions are managed on the Administrators tab after a colleague has signed in once. Bootstrap emails apply only when an account is first created.

The database starts empty. To optionally add sample ideas for local exploration before first use:

```sh
npm run seed:demo
```

This development-only command refuses to seed a nonempty gallery or a production database. It creates fictitious sample users and ideas. It is never run automatically.

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

The `server/db.js` module initializes and migrates the SQLite schema automatically on startup. The separate `users` table stores the `is_admin` integer (1 or 0). Other tables are `ideas`, `likes`, `votes`, `settings`, `challenges`, `sessions`, and `audit`. Foreign keys and unique constraints protect relationships and duplicates. Critical writes run in SQLite transactions. SQL uses bound parameters.

`DATA_DIR` contains the SQLite database, uploads, local secret and audit log. It is excluded from Git and the source ZIP. The app needs one writable persistent data directory. Do not put this directory in publicly served static files. For a simple complete backup, stop the server, back up the whole directory, then restart. For live backups use SQLite’s backup API rather than copying only the database while WAL mode is active. Exporting the audit log does not back up ideas or images.

The ZIP and Docker image contain **no user data or login codes**. Rebuilding the frontend does not change the database.

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
NODE_ENV=production
HOST=0.0.0.0
PORT=3001
APP_ORIGIN=https://your-innovation-domain.example
SESSION_SECRET=at-least-32-cryptographically-random-characters
DATA_DIR=/absolute/persistent/data/directory
TRUST_PROXY=1
```

Use the exact external origin without a trailing slash. Generate a secret with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. Set `TRUST_PROXY=1` only when exactly one trusted reverse proxy sits in front of Node. Restrict direct public access to port 3001 and terminate HTTPS at that proxy. Production cookies require HTTPS. Production startup refuses console email mode, missing SMTP credentials, a short/missing secret, a missing origin or an unconfigured initial administrator.

A fresh production database starts with an empty gallery, closed voting, the welcome section enabled and idea submissions open. Switching to production does not reset an existing database or its event settings. Set up the event in the Admin screen after first login. Test email delivery with your actual SMTP account before launch; external email delivery was not tested without credentials.

### Suggested AWS deployment

For the simplest first deployment, use **one Amazon Lightsail instance**, run this Node service with a persistent data disk and HTTPS reverse proxy, and keep the included SQLite database. SQLite is a file-based database running on your instance, rather than an AWS-managed database service. It fits a modest internal event on a single server.

If you want an **AWS-managed database**, recommend **PostgreSQL on Amazon Lightsail Managed Databases**. AWS manages common maintenance and backups. Moving this implementation to PostgreSQL requires replacing the SQLite database adapter/schema and migrating its rows; it is a future migration, not an environment-variable switch. For multiple app instances, also move uploads to S3 and use shared rate-limit storage, and centralize/retain audit logs. Do not run this SQLite implementation as a horizontally scaled or ephemeral serverless service.

References: [Lightsail managed databases](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-databases.html), [PostgreSQL connections](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-connecting-to-postgres-database.html).

### Migrate to PostgreSQL and Amazon SES

The [Lightsail PostgreSQL and SES migration guide](deploy/postgresql-ses/README.md) covers the required database-layer conversion, private managed PostgreSQL with verified TLS, restricted database accounts, SES setup, existing-data and image transfer, validation, public deployment and rollback. A proposed production environment template is included.

The current application still runs on SQLite. The guide documents PostgreSQL implementation work that must be completed before cutover; it does not enable PostgreSQL by configuration alone. SES SMTP is already supported.

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
| `server/db.js` | SQLite initialization, migrations, transactions and audit logging. |
| `server/seed.js` | Optional development sample ideas. |
| `public/nep-innovation-week.png` | Supplied NEP Innovation Week logo. |
| `tests/` | API/event-state/local-access tests and the optional browser workflow. |
| `deploy/debian/` | Native Debian production guide and systemd/Nginx/environment templates. |
| `deploy/lightsail-nodejs/` | After-upload public-access guide for Debian Node.js blueprints, including Apache HTTP/HTTPS templates. |
| `deploy/postgresql-ses/` | PostgreSQL/SES migration instructions and a proposed environment template; PostgreSQL support requires application changes. |
| `dist/` | Generated frontend output from `npm run build`. |
| `data/` | Default local database, uploads, secret and audit log; excluded from source archives. |

## Verification

```sh
npm test
npm run build
npm audit
# Optional automated browser suite:
npx playwright install chromium
npm run test:e2e
```

Event tests cover exact voting/submission boundaries and a repeatable migration of an existing database, welcome-panel defaults/toggles, and automatic transitions before, during and after voting. API tests cover both manual and scheduled submission closure, admin enforcement, reopening, and editing after closure. The local-access tests verify automatic admin access without cookies, disabled code endpoints, persistence of the local identity, skipped SMTP initialization, explicit opt-out and production isolation. The API test suite uses an isolated temporary database and covers authentication, domain validation, OTP lockout/replay, upload validation, ownership, submission limits, like toggles, vote limits/withdrawals/resets, schedule boundaries, role changes, moderation, audit export and session revocation. It does not touch the local app’s data. The browser suite also uses an isolated temporary database and includes desktop, tablet and mobile workflows. If Chromium is already installed elsewhere, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable.

The latest completed automated run passed **26 tests** covering API, event-state, migration and local-access behaviour. Production builds passed after the subsequent dialog and typography updates. In-app browser checks verified the welcome toggle, voting countdown, submission deadlines (including a form already open), explicit dialog dismissal, save confirmations, duplicate-submission prevention, the 10px minimum text size, and the 14px countdown subheader without its former extra message. `npm audit` reported zero vulnerabilities at the original dependency handoff; that audit is historical, not a fresh scan on every documentation update. The automated browser suite could not launch Chromium within the execution sandbox; the in-app browser was used for interactive visual and workflow checks. Live SMTP/SES delivery and an AWS deployment remain environment-specific setup steps.
