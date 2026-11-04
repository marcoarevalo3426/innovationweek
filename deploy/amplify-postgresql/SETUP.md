# Create the same PostgreSQL database in AWS and link the Amplify app

**Existing Aurora IAM / Express configuration cluster:** use [production startup and connection checks](PRODUCTION.md). Express gateway clusters support IAM only and use Amazon trust certificates. Use automatic token generation instead of the generic password-mode template below. If still initializing an empty app database, keep the supplied schema/import instructions but use your working IAM/TLS connection.

Follow this guide for the existing app at:

**https://main.d3ha2gxpxiqxnu.amplifyapp.com**

This is one deployment path that preserves the app's current email-code login, PostgreSQL transactions and voting rules:

```text
Amplify React frontend
  → HTTPS /api/* rewrite
  → Express API on a Debian EC2 server
  → private Amazon RDS PostgreSQL
```

The API also uses SES for sign-in codes and persistent storage for uploaded images. Amplify's static frontend upload does not start the Express API. The current browser code links to PostgreSQL **through that API**, rather than receiving database credentials. These instructions do not change your live AWS account.

## What you will use

| Item | Value |
| --- | --- |
| Amplify app ID / branch | `d3ha2gxpxiqxnu` / `main` |
| Frontend origin | `https://main.d3ha2gxpxiqxnu.amplifyapp.com` |
| Database name | `innovation_week` |
| PostgreSQL runtime role | `innovation_app` |
| API hostname | Your chosen HTTPS hostname, for example `api.yourdomain.com` |
| API process | `server/index.js`, on `127.0.0.1:3001` |
| Database schema | [create-schema.sql](create-schema.sql), from this app's versioned migration |

Choose your AWS Region and keep the API server and RDS database together there. Replace the example API hostname and RDS endpoint everywhere below. Review the AWS resource estimates before creating them.

## 1. Prepare an API server and create RDS PostgreSQL

Create or select a **Debian 12/13 EC2 instance** for the Express API. This walkthrough uses EC2 in the RDS VPC to keep private database connectivity straightforward. It can also run migration commands. Connect to it through your approved SSH/administration access.

In **AWS console → RDS → Databases → Create database**:

1. Select **Standard create → PostgreSQL**.
2. Choose a supported PostgreSQL release at least as new as your source database. The local app helper uses PostgreSQL 16.
3. Set the DB identifier to a name such as `innovation-week-postgres`.
4. Set **Initial database name** to `innovation_week`. Use a separate master/migration login and store its password securely.
5. Under connectivity, select the API EC2 instance where the console offers automatic EC2 connectivity, or select its VPC and configure the security groups manually.
6. Keep **Public access: No**. Allow database TCP 5432 from the API/admin security group. The API host needs routing and outbound access to that database.
7. Select storage, availability, encryption and backups appropriate to your event, then create the database.

Wait for **Available**. Copy the real RDS endpoint from **Connectivity & security**; it looks like `something.REGION.rds.amazonaws.com`. This is a database hostname, not a web API URL.

The API server's public HTTP/HTTPS access is separate from database access. Expose the API reverse proxy on 80/443, keep Node 3001 private, and use a real domain with a trusted HTTPS certificate. If you already have an API on another host, it must have an explicit private route to RDS; a Lightsail network is not automatically the RDS VPC.

Sources: [RDS creation and EC2 connectivity](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CreateDBInstance.html), [connecting to RDS PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ConnectToPostgreSQLInstance.html).

## 2. Copy the project and install the database client

Copy the full app source to `/opt/innovation-week` on the API server, following [the native Debian guide](../debian/README.md) for Node.js 24.14+, the `innovation` runtime OS account and ownership. Install Linux dependencies on the server; do not copy a Mac's `node_modules`.

The API instance needs a PostgreSQL client and the AWS database CA bundle:

```sh
sudo apt-get update
sudo apt-get install -y postgresql-client curl ca-certificates
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o /tmp/innovation-rds-ca.pem
sudo install -m 644 /tmp/innovation-rds-ca.pem \
  /etc/ssl/certs/aws-rds-global-bundle.pem
```

From that VPC-connected server, test your actual RDS details:

```sh
psql "host=YOUR_RDS_ENDPOINT port=5432 dbname=innovation_week user=YOUR_MASTER_USER sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" -W
```

Enter the master database password at the prompt. Inside `psql`, `\conninfo` should show the intended database and an encrypted connection. If you omitted the initial database name during RDS creation, connect to `dbname=postgres` and run `CREATE DATABASE innovation_week;` once first.

Source: [verified TLS for RDS PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html).

## 3. Create the exact app schema, or transfer the existing event

### Fresh empty database: run the supplied schema file

Exit `psql` with `\q`. From the uploaded project folder:

```sh
cd /opt/innovation-week
psql "host=YOUR_RDS_ENDPOINT port=5432 dbname=innovation_week user=YOUR_MASTER_USER sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" \
  -W -v ON_ERROR_STOP=1 -f deploy/amplify-postgresql/create-schema.sql
```

The file creates the **same tables, columns, indexes, keys, constraints and default settings** as this app:

| Table | Purpose |
| --- | --- |
| `users` | Users and integer `is_admin` permission. |
| `ideas` | Idea details, owner and image filename. |
| `likes` | One like per user/idea pair. |
| `votes` | User/idea votes, including voting rounds. |
| `settings` | Voting, submissions, welcome display, awards and deadlines. |
| `challenges` | Hashed email codes and attempt/expiry information. |
| `sessions` | Hashed sessions and expiry information. |
| `audit` | Authoritative audit trail and generated IDs. |
| `data_imports` | Legacy-import protection metadata. |
| `schema_migrations` | Schema version checked at app startup. |

A fresh schema contains the initial settings row, with voting closed, two votes per user, submissions open and the welcome enabled. It creates no sample users or ideas. The SQL runs as one transaction and fails on existing tables; it does not delete or overwrite a populated database. Keep the database password out of the SQL file.

### Existing local event: restore a PostgreSQL dump instead

To preserve existing users, ideas, likes, votes and settings, use the export/restore commands in [the database migration guide, steps 3–4](README.md#3-export-the-existing-local-postgresql-event). The full dump already contains the schema, so **skip the schema-file command above** for that target.

Keep the old app stopped for the final coordinated database/image snapshot. Copy uploaded image files separately; PostgreSQL stores their filenames, not the image bytes. Use a fresh empty target for either initialization method.

## 4. Create the app's runtime database role

Connect to `innovation_week` as the master/schema owner and run these once:

```sql
CREATE ROLE innovation_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password innovation_app
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE innovation_week TO innovation_app;
GRANT USAGE ON SCHEMA public TO innovation_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO innovation_app;
GRANT SELECT, INSERT ON public.feedback TO innovation_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO innovation_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO innovation_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO innovation_app;
```

`\password` prompts for a new unique runtime-role password. If that role already exists, inspect/reuse it rather than blindly recreating it. Default privileges apply to future objects created by the role executing those statements; use that same owner for later migrations.

Verify the new role can connect with `sslmode=verify-full`. The Node service uses this role, while schema changes use the migration owner.

## 5. Link the Express API to RDS

Copy [backend-rds.env.example](backend-rds.env.example) to `/etc/innovation-week.env` on the API server, edit it, and keep owner root/mode 600. Preserve a protected backup if a production environment file already exists.

Replace all placeholders, especially:

```dotenv
NODE_ENV=production
LOCAL_AUTH_BYPASS=false
DB_CLIENT=postgres
DB_AUTO_MIGRATE=false
PGHOST=YOUR_RDS_ENDPOINT
PGPORT=5432
PGDATABASE=innovation_week
PGUSER=innovation_app
PGPASSWORD=YOUR_APP_ROLE_PASSWORD
PGSSLMODE=verify-full
PGSSLROOTCERT=/etc/ssl/certs/aws-rds-global-bundle.pem
APP_ORIGIN=https://main.d3ha2gxpxiqxnu.amplifyapp.com
```

Also set the real `ADMIN_EMAILS`, SES SMTP credentials/verified sender and a random `SESSION_SECRET` generated with `openssl rand -hex 48`. Keep `DATA_DIR=/var/lib/innovation-week`, `HOST=127.0.0.1`, `PORT=3001` and `TRUST_PROXY=1` for the supplied single immediate reverse proxy.

The production template lists every required variable. Database/SMTP passwords belong on the backend; Amplify frontend environment variables do not configure this separate Node process. For an imported existing account, `ADMIN_EMAILS` does not automatically promote `is_admin=0`; use an existing admin or the migration owner to approve the intended administrator.

After installing the project dependencies, check the connection using the same environment as the service:

```sh
cd /opt/innovation-week
sudo /usr/bin/node --env-file=/etc/innovation-week.env scripts/db-check.js
```

Use the actual Node executable if it is elsewhere. Expect `ok: true`, `backend: postgres` and database `innovation_week`, with the intended row counts. This command reads PostgreSQL and verifies its schema version.

## 6. Start the production API with HTTPS

Complete the systemd service and Nginx configuration in [the Debian guide](../debian/README.md), using the RDS environment from step 5 and your real API hostname. That guide supplies the service account, `/var/lib/innovation-week` permissions, service template and HTTPS/certificate-renewal steps.

Build the project as the deployment user, then start the configured service:

```sh
cd /opt/innovation-week
npm ci --include=dev
npm run build
npm prune --omit=dev
sudo systemctl daemon-reload
sudo systemctl enable --now innovation-week
sudo systemctl status innovation-week --no-pager
```

For an already running service after code/environment changes, use `sudo systemctl restart innovation-week`. Do not seed demo content in production. Restore existing uploads into the persistent data directory if transferring an event.

First test locally, then through your real HTTPS API hostname:

```sh
curl -fsS http://127.0.0.1:3001/api/health
curl -fsS https://api.yourdomain.com/api/health
```

Both should return:

```json
{"ok":true,"database":"postgres"}
```

Fix any API/service/database/TLS failure before changing Amplify routing. The health check includes a real PostgreSQL query. SES still needs an approved verified sender and suitable production access for employee sign-in delivery.

## 7. Link your Amplify frontend to that API

Open **Amplify → app `d3ha2gxpxiqxnu` → Hosting → Rewrites and redirects → Manage redirects**.

Use [the rewrite template](../amplify/rewrites.example.json), replacing `https://api.yourdomain.com` with the working API hostname from step 6. Put the API rule first:

```json
{
  "source": "/api/<*>",
  "target": "https://api.yourdomain.com/api/<*>",
  "status": "200",
  "condition": null
}
```

Preserve the remaining asset-aware SPA rules below it. Use **200 rewrite**, not a browser redirect, so requests and the session cookie stay on your Amplify frontend origin. The target must include `/api/`. It must be an HTTPS API hostname, never the RDS hostname or your computer's loopback address.

Save the rules in the console; the repository JSON file is only a template. Build/publish the current frontend from `dist`, or upload the contents-only `innovation-week-amplify-frontend.zip`. The browser already requests `/api/*`, so no database connection string needs to be added to React.

Source: [Amplify HTTPS reverse-proxy rewrites](https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html#reverse-proxy-rewrite).

## 8. Verify the complete connection

Run from your computer:

```sh
curl -i https://main.d3ha2gxpxiqxnu.amplifyapp.com/api/health
curl -i https://main.d3ha2gxpxiqxnu.amplifyapp.com/api/auth/me
```

The first response should be the PostgreSQL health JSON. Without a session, the second should be JSON with `user: null` and `localAuth: false`. HTML, a static 404 or a trailing-slash redirect to an HTML error page means the API routing still needs attention.

In the Amplify app, request a code using an actual NEP mailbox, verify receipt through SES, enter it, and refresh after sign-in. Confirm the cookie persists, existing images load, a controlled image upload succeeds, and vote/submission limits remain enforced. Verify private/no-store cache headers on personalized API responses and sign out successfully.

| Problem | Where to check |
| --- | --- |
| Database connection times out | RDS Available status, exact endpoint, VPC route and TCP 5432 security-group rules. |
| App says schema/migration is missing | Run the supplied schema once on the empty target, or restore the full dump, and check database name/schema version. |
| API process exits | `sudo journalctl -u innovation-week -n 100 --no-pager`; verify runtime credentials, CA file, SMTP and writable image directory. |
| Amplify `/api` returns HTML/404 | API rewrite and its order above the SPA fallback. |
| Save/login returns 403 | Exact `APP_ORIGIN` and forwarded mutation headers. |
| Code request succeeds but no email arrives | SES region, verified sender, SMTP credentials and sandbox/recipient restrictions. |

This completes the connection chain **Amplify → API → RDS PostgreSQL**. The separate [advanced guide](README.md#7-optional-connect-rds-through-native-amplify-gen-2-data) covers a native Amplify Data connector if you later choose to replace the existing REST API; it is not required for this working deployment path.
