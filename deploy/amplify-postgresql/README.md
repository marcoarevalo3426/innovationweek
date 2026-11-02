# Deploy this app's PostgreSQL database for AWS Amplify

**Start here for the current app:** [single deployment walkthrough with the exact schema SQL](SETUP.md). It covers RDS creation, schema initialization, API configuration and linking your existing Amplify site.

Your frontend is hosted at **https://main.d3ha2gxpxiqxnu.amplifyapp.com**, app ID `d3ha2gxpxiqxnu`, branch `main`.

For this guide, **PostgreSQL runs in Amazon RDS**, and Amplify hosts the frontend or connects a Gen 2 backend to that database. Amplify's default `Todo` model in `amplify/data/resource.ts` is DynamoDB-backed; uploading PostgreSQL files or adding that model does not deploy this project's PostgreSQL schema.

AWS also offers PostgreSQL capabilities through the preview AWS Blocks integration. This guide uses the established RDS + Amplify Data connection workflow rather than introducing a new application framework. See [Amplify's SQL integration](https://docs.amplify.aws/react/build-a-backend/data/connect-to-existing-data-sources/connect-postgres-mysql-database/) and [AWS Blocks with Amplify](https://docs.amplify.aws/react/build-a-backend/aws-blocks/).

**Scope:** these are deployment instructions and examples. They do not create AWS resources, copy your data or change the active Amplify backend. Steps 1–5 move the database. Step 6 connects the existing app. Step 7 describes an optional native Amplify Data integration, which requires further application changes before replacing the existing API.

## Choose the application connection

| Connection | What it means for this project |
| --- | --- |
| **A. Existing Express API → RDS PostgreSQL** | Preserves the current NEP email-code login, vote/submission transactions and API. Amplify proxies `/api/*` to a separately deployed HTTPS API. This is the shortest path to a working version of the current app. |
| **B. Amplify Gen 2 Data → RDS PostgreSQL** | Adds an AppSync/SQL Lambda connection. The React client, authentication, permissions and business operations need adapting; generated CRUD does not replace `server/index.js`. Start with the read-only staging proof in step 7. |

In either arrangement, the browser calls an HTTPS API. It never connects directly to PostgreSQL or receives a database password. Creating a database alone does not resolve the current missing `/api/auth/me` route.

## 1. Create Amazon RDS for PostgreSQL

In the AWS console, select the Region used by your Amplify **backend** resources, then open **RDS → Databases → Create database**. A frontend hostname does not identify the backend Region. Sydney (`ap-southeast-2`) is only an example in this project's templates.

Choose:

- **Standard create → PostgreSQL**. Use a currently supported version at least as new as your source. The project's local helper uses PostgreSQL 16; retaining major version 16 makes the first migration simpler.
- DB instance identifier: for example `innovation-week-postgres`.
- Initial database name: `innovation_week`.
- Master account: an administrative/migration account, with its password stored securely. Use separate limited database accounts for the running application.
- A VPC and a DB subnet group spanning at least two Availability Zones.
- **Public access: No** for the private-network deployment below.
- Encryption, automated backups and deletion protection appropriate to production. Select a capacity/availability plan and review its estimated charges before creating it.

Wait until the database is **Available**. Record the actual endpoint hostname, port 5432 and master username privately. Do not use the instance identifier as the endpoint, and do not use the RDS endpoint as an Amplify HTTPS rewrite target.

Source: [creating an RDS database](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CreateDBInstance.html).

## 2. Arrange private network access

For migration, use an administrative machine in the database's VPC, or a workstation with an approved VPN route into that VPC. An EC2 administration host reached through your existing SSM/VPN/bastion arrangement is suitable. Transfer the dump to that machine using your approved private file-transfer method.

For connection A, deploy the Express API in a network that can reach the database. An EC2 API host in the same VPC is straightforward. An existing Lightsail instance needs an explicitly configured network route/peering arrangement to RDS; its default network is not automatically the RDS VPC. Existing Lightsail managed PostgreSQL is a separate deployment option covered by the older guide.

Set the RDS security group to allow TCP **5432 from the administration/API security groups**, not from the entire internet. Check the corresponding outbound rules and routing.

For connection B, Amplify can detect a same-account, same-Region RDS endpoint and place its generated SQL Lambda in that VPC. After synthesis/deployment, verify its generated security-group rules: database TCP 5432 must be reachable, and the connector needs HTTPS access to configuration services such as Systems Manager. Provide that access through the VPC's approved NAT/endpoints and scoped rules described in the SQL integration documentation. A private Lambda does not gain internet access merely by being in a subnet.

The schema-generation command also needs a network route to the database. Run it on a VPC-connected development/admin machine or over VPN. The documentation's public-endpoint/local-IP alternative is not needed when the machine already has private connectivity; keep the database private for this guide.

Sources: [RDS connectivity](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ConnectToPostgreSQLInstance.html), [Amplify SQL integration and VPC requirements](https://docs.amplify.aws/react/build-a-backend/data/connect-to-existing-data-sources/connect-postgres-mysql-database/).

## 3. Export the existing local PostgreSQL event

Install PostgreSQL client tools compatible with the source and target, and check `pg_dump --version`. The npm database helper starts PostgreSQL but does not bundle `pg_dump` or `pg_restore`.

Stop the old Node app so ideas, likes, votes, logins and admin settings cannot change. Leave local PostgreSQL running. From your computer, replacing local connection details if needed:

```sh
pg_dump -h 127.0.0.1 -p 5432 -U innovation -d innovation_week -W \
  --format=custom --no-owner --no-acl --schema=public \
  --exclude-table-data=public.sessions --exclude-table-data=public.challenges \
  --file=innovation-week.dump
```

Enter the local database password at the prompt. This exports users/admin permissions, ideas, likes, all voting rounds, settings, audit history and migration metadata. Sessions/codes are intentionally omitted so users authenticate again.

Archive the images and file audit log separately while app writes remain stopped:

```sh
tar -czf innovation-files.tar.gz -C /absolute/path/to/project/data uploads audit.jsonl
```

For an empty event without `audit.jsonl`, archive `uploads` alone. Keep an unchanged backup of the source release and sensitive configuration. Do not copy the live `data/postgres` cluster directory to RDS. Transfer the dump and file archive securely to the VPC-connected migration machine.

If the event still exists only in SQLite, first follow [the local PostgreSQL conversion guide](../postgresql/README.md). `pg_restore` cannot read a SQLite file.

Source: [PostgreSQL dump format and compatibility](https://www.postgresql.org/docs/16/app-pgdump.html).

## 4. Restore the schema and data into RDS

On the VPC-connected migration machine, install the PostgreSQL client and download the AWS CA bundle:

```sh
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  -o aws-rds-global-bundle.pem
```

Use absolute certificate/file paths in the following examples. First connect to the actual database created in step 1:

```sh
psql "host=YOUR_RDS_ENDPOINT port=5432 dbname=innovation_week user=YOUR_MASTER_USER sslmode=verify-full sslrootcert=/absolute/path/aws-rds-global-bundle.pem" -W
```

Use `\conninfo` to confirm the endpoint/database and TLS connection. If you omitted the initial database name during creation, connect to the default `postgres` database and run `CREATE DATABASE innovation_week;` once.

For an existing event, restore into that **empty** database:

```sh
pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname="host=YOUR_RDS_ENDPOINT port=5432 dbname=innovation_week user=YOUR_MASTER_USER sslmode=verify-full sslrootcert=/absolute/path/aws-rds-global-bundle.pem" \
  -W /absolute/path/innovation-week.dump
```

The full dump already contains the schema and `schema_migrations`. Do not initialize it first with `db:migrate`; do not overwrite a populated target with `--clean`.

For a **new empty event without a dump**, use this release's migration tool instead. Create a protected environment file outside the public/source files containing the RDS `PGHOST`, `PGPORT`, `PGDATABASE`, migration-owner `PGUSER`/`PGPASSWORD`, `PGSSLMODE=verify-full` and `PGSSLROOTCERT` absolute path. Then, from the project directory on the VPC-connected machine:

```sh
node --env-file=/absolute/private/path/rds-migration.env scripts/db-migrate.js
node --env-file=/absolute/private/path/rds-migration.env scripts/db-check.js
```

Use Node.js 24.14+ and the project's installed dependencies. These direct commands load the specified file; they do not automatically read a systemd environment file. Keep the migration account separate from runtime credentials.

Sources: [RDS verified TLS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html), [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html).

## 5. Create restricted roles and validate the transfer

Connect to `innovation_week` as the schema owner. For the existing Express API, create its runtime role once:

```sql
CREATE ROLE innovation_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password innovation_app
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE innovation_week TO innovation_app;
GRANT USAGE ON SCHEMA public TO innovation_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO innovation_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO innovation_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO innovation_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO innovation_app;
```

`\password` prompts for the new role password. Run default-privilege statements as the owner that will create future schema objects. These privileges are for trusted server code, not browser-generated CRUD.

Compare the frozen source and RDS using `db:check` plus SQL queries: users/idea IDs, likes, votes by round, settings, admin membership and audit counts must match. Confirm `settings` has one row with `id=1`, and `sessions`/`challenges` are empty immediately after restore. Include the newer welcome/submission/voting-marker fields. Confirm a new audit row uses a fresh identity value and every image filename exists in the separately restored uploads.

Use managed RDS backups and retain a snapshot before later schema changes. Database backups do not contain the image files or protected app configuration.

## 6A. Connect the current web app to RDS

Use [backend-rds.env.example](backend-rds.env.example) for the separately deployed Express API. Its important values are:

```dotenv
NODE_ENV=production
LOCAL_AUTH_BYPASS=false
DB_CLIENT=postgres
DB_AUTO_MIGRATE=false
PGHOST=YOUR_RDS_ENDPOINT
PGPORT=5432
PGDATABASE=innovation_week
PGUSER=innovation_app
PGPASSWORD=YOUR_UNIQUE_APP_ROLE_PASSWORD
PGSSLMODE=verify-full
PGSSLROOTCERT=/etc/ssl/certs/aws-rds-global-bundle.pem
APP_ORIGIN=https://main.d3ha2gxpxiqxnu.amplifyapp.com
```

Install the CA at that path on the API host, supply SES SMTP configuration, a new session secret, a real NEP admin email and persistent `DATA_DIR`, then start/restart the production Node service. Restore `innovation-files.tar.gz` into its data directory with the runtime OS account owning the files. Existing PostgreSQL support already accepts RDS endpoints; there is no additional driver rewrite for connection A.

`PG*` variables belong on the server. Setting them in Amplify's **frontend build environment** does not configure a separately hosted Express process. Likewise, a `SQL_CONNECTION_STRING` secret used by the Gen 2 connector is not automatically consumed by `server/pg-config.js`.

Configure the Amplify `/api/<*>` HTTPS rewrite to the actual API hostname using [the routing guide](../amplify/README.md). Test **both** the direct backend and Amplify-routed `/api/health`; expect `{"ok":true,"database":"postgres"}`. Test real SES code receipt, code verification, cookie persistence after refresh, image upload and vote limits.

If the existing `/api` route is still missing, deploying RDS alone will leave the sign-in error unchanged. The database and API are separate resources.

## 6B. If the API must also run on Amplify compute

Amplify supports an Express compute deployment with a deployment manifest, but this project is not packaged for that runtime yet. Adapt the following before using it for production:

- Build a supported self-contained compute bundle and configure its runtime/port; publishing `dist` alone remains a static deployment.
- Provide runtime secrets and a working network route to RDS. A private RDS database is not automatically reachable from every hosting compute environment.
- Replace local uploads with durable shared storage such as S3. Move file logging to appropriate centralized logs while retaining authoritative PostgreSQL audit rows.
- Supply a persistent session secret explicitly. Do not depend on writable source directories or local files surviving compute replacement.

See [Amplify compute constraints](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-deployment-specification.html) and [Express compute packaging](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-express-server.html). This is an application/deployment adaptation, not a database-console setting.

## 7. Optional: connect RDS through native Amplify Gen 2 Data

This section is a **read-only staging integration** for the generated Amplify backend already in this repository. It does not activate the current sign-in page, which still calls Express `/api/auth/*`. Work on an isolated branch/test database and keep the functioning app on connection A until an application conversion is implemented and verified.

### 7.1 Give the connector a separate, limited database role

As the database owner, create a role that can read only the staging ideas table:

```sql
CREATE ROLE innovation_amplify_read LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password innovation_amplify_read
GRANT CONNECT ON DATABASE innovation_week TO innovation_amplify_read;
GRANT USAGE ON SCHEMA public TO innovation_amplify_read;
GRANT SELECT ON TABLE public.ideas TO innovation_amplify_read;
```

Do not use the master or broad Express role for a browser-facing generated API. This sample grants no access to users, admin flags, OTP hashes, sessions, votes, audit records or migration metadata.

### 7.2 Set a sandbox secret and generate the SQL schema

On the VPC-connected development machine, use an AWS profile authorized to deploy the development Amplify backend. The `ampx` CLI is already a development dependency. Set the secret interactively:

```sh
npx ampx sandbox secret set SQL_CONNECTION_STRING --profile YOUR_AWS_PROFILE
```

At the private prompt enter a PostgreSQL URI for the limited role:

```text
postgres://innovation_amplify_read:URL_ENCODED_PASSWORD@YOUR_RDS_ENDPOINT:5432/innovation_week
```

URL-encode special characters in the password. Never put the real URI in Git, a `VITE_*` variable, browser code or a command-line argument. Amplify's SQL connector manages verified RDS TLS separately from the existing Express `PGSSLROOTCERT` configuration.

Generate the schema on that network-connected machine:

```sh
npx ampx generate schema-from-database \
  --connection-uri-secret SQL_CONNECTION_STRING \
  --out amplify/data/schema.sql.ts \
  --profile YOUR_AWS_PROFILE
```

Inspect the result. The intended staging model is `ideas`; generated names depend on the introspected schema. Check that sensitive tables were not included or authorized. Keep generated schema files separate from your authorization/custom operations. Regenerate them after later database schema changes; this command reads database structure, it does not migrate rows.

The command names/options above were checked against this project's installed CLI help. Source: [Amplify's existing PostgreSQL integration](https://docs.amplify.aws/react/build-a-backend/data/connect-to-existing-data-sources/connect-postgres-mysql-database/).

### 7.3 Add read-only authorization in the staging resource

On the staging branch, replace the example `Todo` resource deliberately after preserving any other backend resources you need. For a generated model actually named `ideas`, `amplify/data/resource.ts` can use:

```ts
import { type ClientSchema, defineData } from '@aws-amplify/backend';
import { schema as generatedSqlSchema } from './schema.sql';

const schema = generatedSqlSchema.setAuthorization(models => [
  models.ideas.authorization(allow => [allow.authenticated().to(['read'])]),
]);

export type Schema = ClientSchema<typeof schema>;
export const data = defineData({
  schema,
  authorizationModes: { defaultAuthorizationMode: 'userPool' },
});
```

Use the actual generated model name if different. Avoid global guest access or authenticated writes across the entire imported schema. Confirm `amplify/backend.ts` still registers the `auth` and `data` resources. Do not edit the generated `schema.sql.ts` to store application authorization rules.

Deploy the staging sandbox:

```sh
npx tsc --project amplify/tsconfig.json --noEmit
npx ampx sandbox --profile YOUR_AWS_PROFILE
```

These commands create/update real AWS backend resources when you run them. They have not been run by this documentation task.

### 7.4 Test with an Amplify-aware staging client

Configure the staging frontend using its generated outputs and create an Amplify Data client:

```ts
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import outputs from './amplify_outputs.json'; // adjust to this file's location
import type { Schema } from './amplify/data/resource';

Amplify.configure(outputs);
const client = generateClient<Schema>();
// After signing in through the staging Amplify/Cognito authentication flow:
const result = await client.models.ideas.list();
if (result.errors?.length) throw new Error('Staging database query failed.');
```

This is illustrative TypeScript for a staging client, not a patch to the current JSX entry point. The current Express session cookie does not authenticate requests to AppSync's Cognito authorization mode.

Before production, implement NEP-domain enforcement and the intended passwordless code flow. The generated `loginWith.email` scaffold alone does not reproduce all current authentication rules. Replace or bridge the React `/api` calls with the new authenticated operations and maintain user-ID mapping.

### 7.5 Complete the business/API conversion before releasing native writes

Add server-side operations for vote limits/reset rounds, submission limits/deadlines, idea ownership, equal co-admin permissions/final-admin protection and transactional auditing. Preserve atomic PostgreSQL transactions and concurrency behaviour; direct generated `votes.create()` or `users.update()` must not bypass these rules.

Keep OTP/session storage and administrator-changing operations private. Move images to S3 with the same authenticated access/size rules. Preserve UTC dates, nulls and `0/1` API flags. Check GraphQL scalar compatibility before exposing `BIGINT` millisecond expiry values or audit IDs; they must not be truncated into a 32-bit integer field.

Only after these changes and the full NEP sign-in/idea/vote/admin tests pass should native connection B replace connection A. Connecting the database is not the same as completing that application conversion.

### 7.6 Deploy the Gen 2 branch

Store `SQL_CONNECTION_STRING` as an Amplify **backend secret** for the production branch, with the same secret name as the sandbox and the intended production role. Sandbox secrets are not automatically production secrets. Configure database access for the deployed connector and the required Amplify service permissions.

Use a Git-connected Gen 2 backend pipeline, such as [amplify-gen2.example.yml](amplify-gen2.example.yml), after reviewing/merging your existing build configuration. Its backend phase runs `ampx pipeline-deploy`; the frontend phase builds `dist`. A drag-and-drop frontend ZIP does not execute this backend deployment. If your current manual-hosting app cannot attach the required Gen 2 Git pipeline, create a separate Git-connected staging app and cut over only after verification.

Source: [backend secrets](https://docs.amplify.aws/react/deploy-and-host/amplify-hosting/secrets-and-vars/), [Gen 2 deployment workflows](https://docs.amplify.aws/react/start/migrate-to-gen2/feature-matrix/).

## 8. Final checks and rollback

For either connection, verify the intended frontend/branch points to the intended RDS database. Compare source/target records and settings; check a fresh login, upload, edit, like, two-vote limit, voting reset, submission closure and admin changes. Validate unauthorized users cannot access protected data. Check that no application secrets are present in frontend artifacts.

RDS backups protect database rows; retain image/log/configuration backups separately. Before accepting new cloud writes, rollback can return to the unchanged source. Once cloud writes begin, freeze changes and reconcile new records/files before moving back to the old source, or those actions would be lost.

No RDS instance, Amplify backend, secret, security-group rule or production routing change has been created by writing this guide.
