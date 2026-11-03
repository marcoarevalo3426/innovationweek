> Current managed deployment: the API now uses an EC2 Auto Scaling group and encrypted Parameter Store configuration. See [fleet operations](../autoscaling/README.md) before changing production configuration or deploying new API code. This guide remains the single-server installation reference.

# Start production: existing Amplify frontend and Aurora PostgreSQL

Your Amplify frontend and database exist. You confirmed that **no Node/Express API server exists yet**. Deploy that API before the frontend can sign users in or save ideas.

```text
Browser → Amplify frontend → /api/* HTTPS rewrite
        → Nginx on Debian EC2 → Node/Express → Aurora PostgreSQL
```

This walkthrough uses your existing site and Aurora writer endpoint, IAM database authentication, SES SMTP and persistent images on one Debian EC2 instance. It uses no Docker or Caddy. These are instructions for you to execute; preparing them has not created or changed AWS resources.

## 1. Confirm database networking — on your Mac

Run in macOS Terminal, outside `psql`:

```sh
aws rds describe-db-clusters \
  --db-cluster-identifier innovationweek-database \
  --region ap-southeast-2 \
  --query 'DBClusters[0].{IAMEnabled:IAMDatabaseAuthenticationEnabled,ResourceId:DbClusterResourceId,VPCNetworking:VPCNetworkingEnabled,InternetGateway:InternetAccessGatewayEnabled}' \
  --output json
```

Save the complete `ResourceId` starting with `cluster-` for the IAM policy. `IAMEnabled` must be true. If the gateway/networking fields are null, inspect **RDS → cluster → Connectivity & security**; a null value does not establish the networking mode.

| Connection type | API server connectivity |
| --- | --- |
| Express configuration / internet access gateway (`InternetGateway=true`, `VPCNetworking=false`) | Outbound internet access to the database hostname on TCP 5432. This cluster has no database VPC security group to edit. |
| Regular cluster in a VPC | EC2 in the same VPC or another routed network; allow database TCP 5432 from the API server's security group. |

**Correction to the older generic setup guide:** Express gateway clusters support **IAM authentication only**. Do not revoke `rds_iam` from their master user, switch them to password authentication or paste a fixed IAM token into `PGPASSWORD` for production. This release adds `PG_AUTH_MODE=iam`, which generates a token for each new Node database connection using refreshable AWS credentials. Password mode remains the default for existing deployments that support it.

Use **AmazonRootCA1.pem**, which worked for your endpoint. Your Mac's certificate path does not exist on Debian; download it there too in step 5.

Sources: [Aurora Express configuration](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_GettingStartedAurora.AuroraPostgreSQL.ExpressConfig.html), [database IAM permissions](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.IAMPolicy.html).

## 2. Check the app schema and runtime account — in your working psql session

A successful login to `postgres` does not prove the application tables exist there. Check:

```sql
SELECT current_user, current_database();
\l
\dt public.*
```

If you initialized the app in `innovation_week`, switch databases:

```sql
\connect innovation_week
```

If the app tables were intentionally created in `postgres`, remain there and use `PGDATABASE=postgres` in step 6. Use the same database name in the grant below. If the schema is missing, initialize an **empty** application database using [the schema setup instructions](SETUP.md#3-create-the-exact-app-schema-or-transfer-the-existing-event), substituting your working IAM-token connection and Amazon Root CA 1 certificate. Preserve an existing schema/event; do not recreate it.

Verify the chosen application database:

```sql


SELECT max_votes, mode, submission_mode FROM public.settings;
\du innovation_app
```

Expect schema version `1`. A new event has settings `2`, `closed`, `open`; existing settings may differ. If `innovation_app` is absent, create it once:

```sql
CREATE ROLE innovation_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
```

As the administrator/schema owner in the **application database**, grant runtime access. Change `innovation_week` to `postgres` in the first grant if that is where the app tables reside:

```sql
GRANT CONNECT ON DATABASE innovation_week TO innovation_app;
GRANT USAGE ON SCHEMA public TO innovation_app;
GRANT SELECT ON public.schema_migrations TO innovation_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.users, public.ideas, public.likes, public.votes, public.settings,
  public.challenges, public.sessions, public.audit, public.data_imports
  TO innovation_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO innovation_app;
GRANT rds_iam TO innovation_app;
SELECT pg_has_role('innovation_app', 'rds_iam', 'member');
```

The final query must return `t`. This IAM runtime account needs no password. Keep DDL/migrations under your administrator/schema owner. Grant appropriate privileges for any new tables/sequences introduced by future migrations.

## 3. Create the API server and its IAM role — AWS console

For the detailed console walkthrough, follow [Create the Debian EC2 API server](EC2-SERVER.md). It includes the exact role, firewall, official Debian AMI selection, launch template, Elastic IP, SSH and readiness checks for this setup. Return here for production environment configuration and app startup.

Create a **Debian 12/13 EC2 instance in Sydney (`ap-southeast-2`)** using a maintained Debian AMI, IMDSv2 and encrypted persistent EBS storage. At least 2 GiB RAM is a practical starting point; dependency installation/builds may need more. Review instance, storage and public IPv4 costs before launching.

For this Nginx/HTTPS path, use a public subnet with an internet gateway route and a stable public address. Point a DNS name you control, such as `api.yourdomain.com`, to that address. Allow inbound TCP 80/443 and restrict SSH TCP 22 to your administration IP. Keep Node TCP 3001 closed to public access. Apply the database connectivity requirement from step 1.

In IAM, create a role with **Trusted entity: AWS service → EC2**, for example `InnovationWeekApiRole`. The IAM console creates the trust relationship and instance profile. Give it [this database connection policy](ec2-database-connect.policy.example.json), replacing the placeholder with the entire cluster resource ID from step 1:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ConnectAsInnovationApp",
      "Effect": "Allow",
      "Action": "rds-db:connect",
      "Resource": "arn:aws:rds-db:ap-southeast-2:375033595717:dbuser:REPLACE_WITH_CLUSTER_RESOURCE_ID/innovation_app"
    }
  ]
}
```

The statement allows authentication only as `innovation_app` on your cluster; SQL access is controlled by step 2. Attach the role under **EC2 → instance → Actions → Security → Modify IAM role**. Permissions on your personal `marcoarevalo` user do not automatically apply to EC2. Do not copy personal access keys or your Mac's AWS credentials onto the server.

If using a Lightsail Node.js blueprint instead, follow [its web-server instructions](../lightsail-nodejs/README.md); do not install Nginx over a preinstalled Apache service. Its AWS credential setup also differs. This walkthrough uses an EC2 instance role for unattended IAM access.

Sources: [EC2 application roles](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html), [scoped database permission](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.IAMPolicy.html).

## 4. Upload the updated source and install dependencies

Use the **updated source ZIP** supplied with this guide; it includes IAM support. The static frontend ZIP does not contain an API server. Use your AMI's actual SSH username/key; Debian commonly uses `admin`.

On your **Mac**, replacing the file paths and address:

```sh
scp -i /absolute/path/to/key.pem /absolute/path/to/innovation-week.zip admin@YOUR_EC2_ADDRESS:~/
ssh -i /absolute/path/to/key.pem admin@YOUR_EC2_ADDRESS
```

All following shell commands run in the **Debian SSH terminal**, unless marked otherwise. For a first installation:

```sh
sudo apt-get update
sudo apt-get install -y curl ca-certificates unzip nginx openssl postgresql-client certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/innovation-node24-setup.sh
sudo bash /tmp/innovation-node24-setup.sh
sudo apt-get install -y nodejs
node --version
command -v node

sudo unzip ~/innovation-week.zip -d /opt
sudo chown -R "$(id -un):$(id -gn)" /opt/innovation-week
cd /opt/innovation-week
umask 022
npm ci --include=dev
npm run build
npm prune --omit=dev
```

Confirm Node is at least **24.14** in the Node 24 line and available at `/usr/bin/node`, as used below. Install Linux dependencies on Debian, rather than copying the Mac's `node_modules`. If updating an existing checkout, preserve its code/configuration before replacing it.

## 5. Create persistent storage and install the certificate — Debian

Create the service account once; reuse it if present:

```sh
sudo useradd --system --user-group --home-dir /opt/innovation-week --shell /usr/sbin/nologin innovation
sudo install -d -o innovation -g innovation -m 750 /var/lib/innovation-week

curl --fail --show-error --location \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem \
  --output /tmp/innovation-AmazonRootCA1.pem
sudo install -m 644 /tmp/innovation-AmazonRootCA1.pem /etc/ssl/certs/AmazonRootCA1.pem
sudo -u innovation test -r /etc/ssl/certs/AmazonRootCA1.pem
sudo -u innovation test -r /opt/innovation-week/server/index.js
sudo -u innovation test -w /var/lib/innovation-week
```

The last three commands succeed silently. The runtime account needs read/traverse access to code and dependencies. `/var/lib/innovation-week` stores uploads and the file audit log; preserve it across releases. For an existing event, copy its images into this directory's `uploads/` subdirectory and give the runtime account access.

## 6. Configure production and SES — Debian

Create the environment file once; back up/edit an existing file instead of overwriting its secrets:

```sh
sudo install -o root -g root -m 600 deploy/amplify-postgresql/backend-aurora-iam.env.example /etc/innovation-week.env
openssl rand -hex 48
sudo nano /etc/innovation-week.env
```

Replace `SESSION_SECRET` with the generated random value, `ADMIN_EMAILS` with your actual NEP administrator email, and the SES SMTP/sender placeholders with real values. Keep secrets out of Git and support messages. The template configures:

```dotenv
NODE_ENV=production
LOCAL_AUTH_BYPASS=false
HOST=127.0.0.1
PORT=3001
DATA_DIR=/var/lib/innovation-week
APP_ORIGIN=https://main.d3ha2gxpxiqxnu.amplifyapp.com
TRUST_PROXY=1
DB_CLIENT=postgres
DB_AUTO_MIGRATE=false
PG_AUTH_MODE=iam
AWS_REGION=ap-southeast-2
PGHOST=innovationweek-database.cluster-cyqg0uctocgp.ap-southeast-2.rds.amazonaws.com
PGPORT=5432
PGDATABASE=innovation_week
PGUSER=innovation_app
PGSSLMODE=verify-full
PGSSLROOTCERT=/etc/ssl/certs/AmazonRootCA1.pem
```

Set `PGDATABASE=postgres` instead if that is the database containing the app schema. **Omit `PGPASSWORD` in IAM mode.** The SDK obtains EC2 role credentials and generates tokens for new connections; no AWS CLI login is needed for the service. A copied token is not a permanent production credential.

The complete template also sets `MAIL_MODE=smtp`, `SMTP_HOST=email-smtp.ap-southeast-2.amazonaws.com`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `ADMIN_EMAILS` and `SESSION_SECRET`. SES SMTP credentials differ from AWS CLI credentials. Verify the sender in SES Sydney and obtain production access to send codes to unverified employee recipients. Allow outbound SMTP TCP 587.

Systemd reads `/etc/innovation-week.env`. The supplied service does **not** automatically load `.env.production`; Amplify frontend build variables also do not configure this separate API. Keep `APP_ORIGIN` as your Amplify browser origin, without a trailing slash.

Sources: [SES SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html), [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [PostgreSQL dynamic password callbacks](https://node-postgres.com/features/connecting).

## 7. Verify PostgreSQL as the production service user — Debian

Before starting the app, run the project's database check with the **same user and protected environment** as the service. This check reads the database/schema and row counts; it does not change event data.

```sh
sudo systemd-run --unit=innovation-week-db-check --collect --wait --pipe \
  --property=User=innovation \
  --property=Group=innovation \
  --property=WorkingDirectory=/opt/innovation-week \
  --property=EnvironmentFile=/etc/innovation-week.env \
  /usr/bin/node /opt/innovation-week/scripts/db-check.js
```

Expect JSON containing the following (the real report includes more row counts):

```json
{
  "ok": true,
  "backend": "postgres",
  "database": "innovation_week",
  "username": "innovation_app",
  "schema": "public",
  "counts": { "users": 0, "ideas": 0 }
}
```

Counts can be nonzero. The database should be `postgres` if that is your chosen app database. Success checks the actual Node configuration, certificate, EC2 credentials, IAM policy, SQL privileges and schema version together. A working Mac `psql` login does not verify this server setup.

## 8. Start the API as a persistent service — Debian

```sh
cd /opt/innovation-week
sudo install -m 644 deploy/debian/innovation-week.service /etc/systemd/system/innovation-week.service
sudo systemctl daemon-reload
sudo systemctl enable --now innovation-week
sudo systemctl status innovation-week --no-pager
curl -i http://127.0.0.1:3001/api/health
```

Expect `active (running)`, HTTP 200 and:

```json
{"ok":true,"database":"postgres"}
```

The health route executes a database query. Its `database` value identifies the backend engine, not the selected database name; step 7 checks the actual name/user. Health does not verify email delivery or writes. Production startup requires complete SMTP configuration.

Inspect errors with:

```sh
sudo journalctl -u innovation-week -n 100 --no-pager
```

After changing environment values, run `sudo systemctl restart innovation-week`. Systemd starts the service after reboot; no `npm run dev` or open terminal is required.

## 9. Publish the API over HTTPS — Debian

Replace `api.yourdomain.com` below with your actual DNS name, already pointing to EC2. Keep `APP_ORIGIN` as the Amplify site.

```sh
sudo nano /etc/nginx/sites-available/innovation-week-api
```

Add:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;
    client_max_body_size 3m;
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / { return 404; }
}
```

Enable once, validate and request HTTPS:

```sh
sudo ln -s /etc/nginx/sites-available/innovation-week-api /etc/nginx/sites-enabled/innovation-week-api
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
sudo certbot --nginx --redirect -d api.yourdomain.com
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
curl -i https://api.yourdomain.com/api/health
```

Expect HTTP 200 and the health JSON. Fix direct API HTTPS access before adding the Amplify rule. AmazonRootCA1.pem verifies Aurora; Certbot configures a separate public HTTPS certificate for Nginx.

## 10. Link the existing Amplify frontend — Amplify console

Open **Amplify → app `d3ha2gxpxiqxnu` → Hosting → Rewrites and redirects**. Put this rule **before the SPA fallback**, replacing the API hostname:

```json
{
  "source": "/api/<*>",
  "target": "https://api.yourdomain.com/api/<*>",
  "status": "200",
  "condition": null
}
```

Use [the complete rewrite example](../amplify/rewrites.example.json) if editing the JSON array, preserving your remaining rules. Save the console change. The target must be the public **HTTPS API hostname**, not the Aurora endpoint or `127.0.0.1`. Keep `/api/` in the target and use status 200 rather than a browser redirect. Requests and the session cookie stay on the Amplify browser origin.

An ordinary Vite/React static Amplify deployment does not start Express. This guide runs Express on EC2. Amplify compute manifests are a different deployment approach requiring additional packaging/persistent-storage work.

Source: [Amplify HTTPS reverse-proxy rewrites](https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html#reverse-proxy-rewrite).

## 11. Verify the complete app — Mac/browser

In your Mac Terminal:

```sh
curl -i https://main.d3ha2gxpxiqxnu.amplifyapp.com/api/health
curl -i https://main.d3ha2gxpxiqxnu.amplifyapp.com/api/auth/me
```

Expect HTTP 200 and health JSON from the first command. Without a session cookie, the second should include `"user":null`, `"localAuth":false`, `"development":false`. API JSON responses should have `Content-Type: application/json` and `Cache-Control: private, no-store, max-age=0`. An HTML response indicates API routing/deployment trouble.

Open **https://main.d3ha2gxpxiqxnu.amplifyapp.com** in your browser. Sign in with a NEP email and the emailed six-digit code. Submit one real/test idea with an image, reload to check persistence/image access, like it, and test voting after an admin opens voting. Check the audit log; remove test data through the app when finished. Existing users keep their stored admin permissions; `ADMIN_EMAILS` assigns admin permission when a new account is created.

Repeat the health checks after at least 20 minutes and after `sudo systemctl restart innovation-week`. Idle pool connections close after 30 seconds, so these checks exercise new connections and help detect a mistakenly fixed token. Real AWS token refresh and SES delivery must be verified on your deployment.

## Troubleshooting

| Result | Check / action |
| --- | --- |
| Amplify returns HTML/404 for `/api/*` | Check API rewrite order and target. A frontend upload does not deploy Express. |
| Nginx 502 / connection refused | Check service status, journal and local port 3001 health. |
| `CredentialsProviderError` | Attach the EC2 instance role/profile with the database connect policy and allow IMDSv2 access. A Mac AWS login does not authenticate this service. |
| PAM authentication failed | Check `PG_AUTH_MODE=iam`, `PGUSER=innovation_app`, its `rds_iam` membership and the role policy's exact cluster resource ID and username. |
| Certificate verification fails | Use AmazonRootCA1.pem for your tested gateway endpoint, its actual Debian path and the correct server clock. Keep verified TLS enabled. |
| Database timeout / DNS error | Check outbound 5432, DNS and routes: internet egress for Express gateway, or routed VPC path and database SG for a regular cluster. |
| Missing schema/version | Check `PGDATABASE` and `PGSCHEMA`; use the schema owner to migrate only if actually missing. Preserve existing event data. |
| Table/sequence permission denied | Apply step 2 grants in the selected database as the owner. |
| Missing production/SMTP settings | Edit `/etc/innovation-week.env` and restart; the service does not load `.env.production`. |
| Health works but email does not arrive | Check SES sender, sandbox status, regional SMTP credentials, outbound 587 and API logs. Health does not send mail. |
| Invalid request origin | Set `APP_ORIGIN` to the exact Amplify origin with no trailing slash; use Amplify's same-origin `/api/*`. |

Preserve the environment/session secret, back up PostgreSQL plus `/var/lib/innovation-week`, and maintain OS/Node updates. Multiple API instances require shared uploads and coordinated rate-limit/log storage.
