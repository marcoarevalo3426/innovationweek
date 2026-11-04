# Deploy the PostgreSQL app to AWS Lightsail with SES

The application now runs on PostgreSQL. Start with [the local PostgreSQL guide](../postgresql/README.md) to create the local database or import the old SQLite event once. This guide covers the later **PostgreSQL-to-AWS-PostgreSQL** move. The existing Node.js Lightsail instance, systemd and Apache/Nginx deployment remain suitable; no Docker or Caddy is required.

These are instructions, not an AWS deployment already performed. Debian package commands assume Debian GNU/Linux. Keep both old and replacement app processes stopped during the final data snapshot/import; closing voting/submissions does not stop likes, edits or login writes.

## 1. Create a private managed PostgreSQL database

In **Lightsail → Databases → Create database**, choose PostgreSQL in the same AWS account and Region as the web instance. Use a supported version at least as new as the source PostgreSQL version; the local helper uses PostgreSQL 16. Choose capacity and availability for your event, then wait for Available.

Leave **Public mode OFF**. Record the endpoint, port, master username, password and initial database name privately. The web instance connects privately on 5432. Do not open 5432 to the internet or use the database bundled with the Node blueprint as a substitute for the managed PostgreSQL resource.

Sources: [create a Lightsail database](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-creating-a-database.html), [private database access](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-configuring-database-public-mode.html), [available PostgreSQL engines](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-choosing-a-database.html).

## 2. Export local PostgreSQL and images

Install PostgreSQL 16 client tools on your computer if you do not already have `pg_dump`/`pg_restore`. The npm local server helper does not bundle those client utilities. On a Mac with Homebrew, installing `postgresql@16` supplies them under `$(brew --prefix postgresql@16)/bin`; you can use its client tools without starting a second server. On Debian use the matching PostgreSQL client package. Check `pg_dump --version` against the source server version.

Stop `npm run dev` / the Node app, leaving the database running. Using the actual local credentials, export the app's dedicated public schema:

```sh
pg_dump -h 127.0.0.1 -p 5432 -U innovation -d innovation_week -W \
  --format=custom --no-owner --no-acl --schema=public \
  --exclude-table-data=public.sessions --exclude-table-data=public.challenges \
  --file=innovation-week.dump
```

The password prompt uses the local database password. Keep the dump private. This retains schema migrations, users/admin flags, ideas, settings, all vote rounds, likes and audit rows, but requires new sign-in after cutover. Include image files separately:

```sh
tar -czf innovation-files.tar.gz -C /absolute/path/to/project/data uploads audit.jsonl
```

If an empty event has no `audit.jsonl` yet, archive `uploads` alone. Do not archive `data/postgres/` or copy its raw database files into AWS. Keep an unchanged source backup and release for rollback.

Copy the dump, file archive and project source to the Lightsail instance using SCP/SFTP. Use the SSH username shown by your blueprint, such as `admin` or `bitnami`; it is separate from app/database accounts. Restore from the web instance so managed database public access can remain off.

Sources: [pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html), [Homebrew PostgreSQL 16](https://formulae.brew.sh/formula/postgresql@16).

## 3. Install the CA and connect from the web instance

On the Debian web instance:

```sh
sudo apt-get update
sudo apt-get install -y postgresql-client ca-certificates curl
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o /tmp/innovation-db-ca.pem
sudo install -m 644 /tmp/innovation-db-ca.pem /etc/ssl/certs/aws-rds-global-bundle.pem
```

Make sure the installed `pg_restore` version can read your dump. Connect with the actual master endpoint and initial database details:

```sh
psql "host=YOUR_AWS_DATABASE_ENDPOINT port=5432 dbname=YOUR_INITIAL_DATABASE user=YOUR_MASTER_USER sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" -W
```

In `psql`, create a dedicated target database and restricted app role once:

```sql
CREATE ROLE innovation_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password innovation_app
CREATE DATABASE innovation_week;
```

Use a unique app-role password. `\password` prompts without putting it in shell history. Do not use the master account for normal web requests. Sources: [Lightsail PostgreSQL TLS](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-connecting-to-postgres-database-using-ssl.html), [CA bundle](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-download-ssl-certificate-for-managed-database.html).

## 4. Restore into the new empty target

On the web instance, restore using the schema/migration owner. Use the exact endpoint hostname for TLS verification:

```sh
pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname="host=YOUR_AWS_DATABASE_ENDPOINT port=5432 dbname=innovation_week user=YOUR_MASTER_USER sslmode=verify-full sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem" \
  -W /absolute/path/to/innovation-week.dump
```

Do not run `db:migrate` on an empty target **before** this full-schema restore; the dump already contains the schema and its migration record. Do not restore into a populated event or use destructive `--clean` to bypass conflicts. Restore to a new database if rehearsal left rows behind.

For a new empty event with no source dump, use `npm run db:migrate` with the migration owner's connection settings instead. Migration commands read `.env` or process variables; a production systemd `EnvironmentFile` is not automatically loaded by a command in your SSH shell. For example, as an authorized administrator use the actual Node binary:

```sh
sudo /usr/bin/node --env-file=/etc/innovation-week-migration.env scripts/db-migrate.js
```

That separately protected temporary migration environment must use the DDL owner's credentials; the runtime environment should not. Delete temporary credential files after use. Use this release's `db:migrate` for later versioned migrations as well.

Connect as the schema owner to `innovation_week` and grant runtime access:

```sql
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

Run default-privilege statements as the role that will create future migration objects. The runtime role can read `schema_migrations` but does not need schema DDL permissions. Source: [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html).

## 5. Restore image files and configure the application

Use [the Node.js blueprint guide](../lightsail-nodejs/README.md) for source upload/build, the `innovation` OS service account, static IP, DNS, systemd and the existing Apache/Nginx proxy. Before starting the app, restore `uploads/` and `audit.jsonl` from your trusted archive into `/var/lib/innovation-week`, then give that directory to the service account:

```sh
sudo install -d -o innovation -g innovation -m 750 /var/lib/innovation-week
sudo tar -xzf /absolute/path/to/innovation-files.tar.gz -C /var/lib/innovation-week
sudo chown -R innovation:innovation /var/lib/innovation-week
sudo chmod -R u+rwX,go-rwx /var/lib/innovation-week
```

Copy [production.env.example](production.env.example) to `/etc/innovation-week.env` once, edit it and keep owner root/mode 600. Fill in the real `PGHOST`, `PGDATABASE=innovation_week`, `PGUSER=innovation_app`, app-role password, CA path, SES credentials, public HTTPS origin and administrator email.

Keep these settings:

```dotenv
DB_CLIENT=postgres
DB_AUTO_MIGRATE=false
PGPORT=5432
PGSSLMODE=verify-full
PGSSLROOTCERT=/etc/ssl/certs/aws-rds-global-bundle.pem
NODE_ENV=production
LOCAL_AUTH_BYPASS=false
HOST=127.0.0.1
PORT=3001
DATA_DIR=/var/lib/innovation-week
TRUST_PROXY=1
```

Generate a fresh `SESSION_SECRET` with `openssl rand -hex 48`. `APP_ORIGIN` must exactly match the public HTTPS origin, with no trailing slash. Production defaults to no automatic schema changes. Remote connection errors and missing CA verification stop startup; there is no SQLite fallback. Never put `PGPASSWORD` or SMTP credentials in Vite/browser environment settings.

If the production admin email already belongs to an imported ordinary account, deliberately promote that approved account through an existing admin or the migration owner. `ADMIN_EMAILS` bootstraps only newly created accounts.

## 6. Configure Amazon SES SMTP

1. Open SES in the chosen sending Region. Verify the approved sender address or a domain you control under **Verified identities**. Publish the requested DNS/DKIM records for domain verification; coordinate NEP DNS changes with its owner.
2. Under **SMTP settings**, generate dedicated SMTP credentials. They are different from AWS access keys, database credentials and your SSH login.
3. Request **production access** for transactional sign-in codes. In the sandbox, recipients must be verified as well as the sender. Approval and quotas are regional.
4. Set `MAIL_MODE=smtp`, the regional endpoint, port 587, SMTP user/password and the verified `MAIL_FROM` in the protected runtime environment.
5. For Sydney the endpoint is `email-smtp.ap-southeast-2.amazonaws.com`. Port 587 uses STARTTLS; port 465 is also supported and uses TLS immediately. No application rewrite or SES SDK is required.
6. Test complete code receipt and verification with an actual NEP mailbox. Monitor SES bounces, complaints and sending quotas. Outbound SMTP must be reachable; do not open inbound SMTP ports.

Sources: [verified identities](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html), [SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html), [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

## 7. Validate, enable HTTPS and launch

Build the uploaded source on Linux with `npm ci --include=dev`, `npm run build` and `npm prune --omit=dev`. The native image-processing dependencies must be installed for Linux, not copied from a Mac. The database server helper is a development dependency and is not required on the production host.

Before public access, compare source and target counts, IDs, settings, per-round vote totals, admin flags and all referenced images. Confirm sessions/challenges are empty immediately after restore. The dump includes its audit identity sequence; test that a new audit insert receives a fresh ID.

To run the supplied connection/count check with the systemd environment file:

```sh
cd /opt/innovation-week
sudo /usr/bin/node --env-file=/etc/innovation-week.env scripts/db-check.js
```

Use the actual Node binary if it differs from `/usr/bin/node`. Start the configured service:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now innovation-week
sudo systemctl status innovation-week --no-pager
curl -fsS http://127.0.0.1:3001/api/health
```

Expect `{"ok":true,"database":"postgres"}`. The health endpoint actually queries PostgreSQL. Test gallery reads, images, a controlled idea submission, likes/votes, OTP sign-in and Admin access. Verify the local bypass is disabled and non-NEP emails are rejected.

Finish the blueprint guide's Apache/Nginx vhost and HTTPS certificate steps. Allow public TCP 80/443, keep 3001 private, point the public hostname at the static IP, and verify HTTP redirects to HTTPS. Configure certificate renewal. Recheck the restored event dates before opening traffic: deadlines may have elapsed during the move.

## Rollback and backups

Before accepting new AWS writes, you can stop the new service and restore routing to the unchanged local/source deployment. After new AWS writes begin, the source is stale: freeze both sides and reconcile new rows/files before rolling back, otherwise those actions will be lost.

Enable managed PostgreSQL backups and retain manual snapshots before major changes. Back up uploaded images, `audit.jsonl`, protected environment settings and the matching release separately. Managed database backups contain no local image files. Do not delete the source until a restore test and a successful production launch have been verified.
