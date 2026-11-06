# Create the Debian EC2 API server for your current AWS setup

This guide creates the missing server for your existing NEP Innovation Week app. Your frontend stays on Amplify, and your data stays in the existing Aurora PostgreSQL cluster. You will create one Debian EC2 instance for Node/Express, Nginx HTTPS and persistent image uploads.

```text
https://main.d3ha2gxpxiqxnu.amplifyapp.com
    → /api/* rewrite → https://YOUR_API_HOSTNAME/api/*
    → Debian EC2: Nginx → Node on 127.0.0.1:3001
    → existing Aurora PostgreSQL writer endpoint on 5432
```

Preparing these instructions has not created resources in your AWS account. The EC2 instance, EBS disk and public IPv4 address incur charges according to your account/region; check the console estimate and your Free Tier/credits before launching.

## Values for your setup

| Setting | Value |
| --- | --- |
| AWS account | `375033595717` |
| Region | Asia Pacific (Sydney), `ap-southeast-2` |
| Existing Amplify app / branch | `d3ha2gxpxiqxnu` / `main` |
| Existing database cluster | `innovationweek-database` |
| Database writer hostname | `innovation-week-postgres.cluster-cyqg0uctocgp.ap-southeast-2.rds.amazonaws.com` |
| Database authentication | IAM; generate tokens automatically in Node |
| Database certificate | `AmazonRootCA1.pem` |
| New EC2 instance name | `innovation-week-api` |
| New instance role | `InnovationWeekApiRole` |
| New security group | `innovation-week-api-sg` |
| Operating system | Official Debian 13, amd64 / x86_64 |
| Suggested starting size | `t3.medium`, 2 vCPUs / 4 GiB RAM, if offered in your account |
| Root disk | 20 GiB gp3, encrypted; increase for expected uploads |
| SSH user | `admin` |
| Application database user | `innovation_app` |

The suggested size gives dependency installation and builds more room than a 2 GiB instance; it is a starting recommendation, not a measured capacity requirement. Use the console's instance comparison/pricing to review it. For the public HTTPS API, you also need a hostname you control, such as `api.yourdomain.com`; replace that example everywhere below.

Sources: [Debian 13 official EC2 images and login](https://wiki.debian.org/Cloud/AmazonEC2Image/Trixie), [AWS T3 specifications](https://aws.amazon.com/ec2/instance-types/t3/).

## 1. Identify your database networking and resource ID — Mac Terminal

Your AWS CLI is already authenticated. Run outside `psql`:

```sh
aws rds describe-db-clusters \
  --db-cluster-identifier innovationweek-database \
  --region ap-southeast-2 \
  --query 'DBClusters[0].{ResourceId:DbClusterResourceId,IAMEnabled:IAMDatabaseAuthenticationEnabled,VPCNetworking:VPCNetworkingEnabled,InternetGateway:InternetAccessGatewayEnabled}' \
  --output json
```

Save `ResourceId`, including the leading `cluster-`. It is different from the cluster name/hostname. IAM must be enabled, as you already confirmed.

| Database connection type | VPC choice for the new EC2 server |
| --- | --- |
| `InternetGateway=true`, `VPCNetworking=false`: Aurora Express configuration | Use an existing suitable public subnet, such as one in your default VPC. EC2 connects outward to Aurora's IAM-protected internet access gateway. There is no Aurora database VPC/security group to match. |
| Regular VPC-based Aurora cluster | Choose the database's VPC and a public subnet with a route to an internet gateway. Allow database inbound TCP 5432 from the new EC2 security group. |

If the fields are null, inspect **RDS → Databases → innovationweek-database → Connectivity & security** to determine the connection type. Do not guess from null values.

Aurora Express gateway clusters require IAM authentication only. Keep your working master-user IAM setup. The server will use a separate runtime database user and its own EC2 role.

Source: [Aurora Express configuration and networking](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_GettingStartedAurora.AuroraPostgreSQL.ExpressConfig.html).

## 2. Create the EC2 database permission and role — AWS console

IAM is global; keep EC2/VPC/RDS resources in Sydney.

### Create the permission policy

1. Open **IAM → Policies → Create policy**.
2. Select the **JSON** editor.
3. Paste [ec2-database-connect.policy.example.json](ec2-database-connect.policy.example.json), shown below.
4. Replace `REPLACE_WITH_CLUSTER_RESOURCE_ID` with the complete resource ID from step 1.
5. Choose **Next**, name the policy `InnovationWeekDatabaseConnect`, and create it.

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

This allows authentication only as `innovation_app` on the specified cluster. Database table/sequence privileges are granted separately, in step 2 of [the production guide](PRODUCTION.md#2-check-the-app-schema-and-runtime-account--in-your-working-psql-session).

### Create the EC2 role

1. Open **IAM → Roles → Create role**.
2. For **Trusted entity type**, select **AWS service**.
3. Select **Service/use case: EC2**.
4. Attach `InnovationWeekDatabaseConnect`.
5. Name the role **`InnovationWeekApiRole`** and create it.

Creating the role through the IAM console also creates its EC2 instance profile. The EC2 service must be the trusted entity; your personal IAM user is not the service identity. No administrator-wide policy or personal access keys are needed for database access. If the role already exists, inspect/reuse it with the correct policy instead of creating a duplicate.

Sources: [EC2 IAM roles and instance profiles](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html), [Aurora IAM database-user permission](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/UsingWithRDS.IAMDBAuth.IAMPolicy.html).

## 3. Select the VPC/public subnet and create the security group — AWS console

1. Select **Sydney** in the region selector.
2. Open **VPC → Subnets** and identify the VPC/subnet selected in step 1.
3. Check its associated **Route table**. For this public API server, it needs a default IPv4 route `0.0.0.0/0 → igw-...`, in addition to its local VPC route.
4. Check that the internet gateway is attached to that VPC.

If using Aurora Express and there is no suitable VPC/subnet, create one under **VPC → Create VPC → VPC and more**. Use an unused CIDR range, one Availability Zone, one public subnet, zero private subnets, no NAT gateway and no VPC endpoints for this public single-server path. Keep DNS resolution enabled. Confirm the created public route table has an internet gateway route. For a regular VPC database, arrange a public subnet in its existing VPC rather than creating an unrelated VPC without database routing.

Open **EC2 → Security Groups → Create security group**:

- Name: **`innovation-week-api-sg`**.
- VPC: the VPC selected above.
- Inbound rules:

| Type | Port | Source | Purpose |
| --- | --- | --- | --- |
| SSH | TCP 22 | **My IP**, your current public IPv4 `/32` | Administration from your Mac |
| HTTP | TCP 80 | `0.0.0.0/0` | HTTPS certificate issuance and redirect |
| HTTPS | TCP 443 | `0.0.0.0/0` | Public HTTPS endpoint used by Amplify |

The web ports are public because Amplify must reach the HTTPS API. Keep SSH restricted. Leave the default outbound rules initially so the server can reach package repositories, DNS, Aurora TCP 5432 and SES SMTP TCP 587. Do not add public inbound rules for Node 3001 or PostgreSQL 5432 on this server. This walkthrough uses IPv4.

For a **regular VPC-based Aurora cluster only**, edit the database security group and add inbound PostgreSQL TCP 5432 with source **`innovation-week-api-sg`**. For an Express gateway cluster, this database security-group step does not apply.

Source: [VPC internet gateway, public routes and public addresses](https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html).

## 4. Create a regional SSH key pair — AWS console and Mac

1. In Sydney, open **EC2 → Key Pairs → Create key pair**.
2. Name: **`innovation-week-api`**.
3. Key type: **RSA**.
4. Private key format: **`.pem`**.
5. Create the key and save the downloaded file securely.

Assuming it is saved to your Mac's Downloads folder, run in **Mac Terminal**:

```sh
chmod 400 "$HOME/Downloads/innovation-week-api.pem"
```

Use your actual filename/path if different. This key is for SSH to Debian; it is not an IAM token, database password or SES credential.

## 5. Find the official Debian AMI — Mac Terminal / AWS console

To avoid a stale or incorrect AMI ID, list the current official Debian 13 x86_64 images in Sydney:

```sh
aws ec2 describe-images \
  --region ap-southeast-2 \
  --owners 136693071363 \
  --filters 'Name=name,Values=debian-13-amd64-*' \
    'Name=architecture,Values=x86_64' 'Name=state,Values=available' \
  --query 'reverse(sort_by(Images, &CreationDate))[:5].{AMI:ImageId,Name:Name,Created:CreationDate,Owner:OwnerId}' \
  --output table
```

Choose the newest available image from this query and copy its AMI ID. Debian documents `136693071363` as its official publisher account. The chosen amd64/x86_64 image matches the proposed T3 instance. If the query returns `AccessDenied`, locate the image through the EC2 AMI console with your AWS administrator's help; do not change IAM permissions broadly just to search images.

Source: [Debian 13 EC2 publication and image discovery](https://wiki.debian.org/Cloud/AmazonEC2Image/Trixie).

## 6. Save the server configuration as a launch template — AWS console

Open **EC2 → Launch Templates → Create launch template**. A template saves the settings for reproducible replacement servers.

| Field | Set to |
| --- | --- |
| Launch template name | `innovation-week-api` |
| Version description | `Debian 13 Node API with Aurora IAM` |
| AMI | The official Sydney Debian 13 x86_64 AMI ID from step 5 |
| Instance type | `t3.medium`, if offered in Sydney for your account |
| Key pair | `innovation-week-api` |
| Network security group | `innovation-week-api-sg` |
| Subnet | Select the public subnet when launching, if not included here |
| Storage | AMI root volume: 20 GiB, `gp3`, encryption enabled |
| Instance resource tag | `Name=innovation-week-api` |
| Advanced details → IAM instance profile | `InnovationWeekApiRole` |
| Metadata endpoint | Enabled |
| Metadata version / tokens | **V2 only / Required** |
| Metadata response hop limit | `1` for this native Node deployment |
| User data | Leave blank; configure the app through SSH |

Choose **Create launch template** and note its version number. Put no database tokens, SMTP passwords or session secrets into user data or the launch template. Later configuration uses the protected server environment file.

If you choose another instance type, check its availability and architecture in the console and select a matching AMI. This guide does not require Spot instances, Auto Scaling, a load balancer or a NAT gateway. T3 burst CPU settings can affect charges; review the credit mode and console estimate.

Sources: [Create a launch template](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/create-launch-template.html), [IMDSv2 settings](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html).

## 7. Launch one instance from the template — AWS console

1. Select the template → **Actions → Launch instance from template**.
2. Select the numbered version you just created.
3. Set number of instances to **1** and use normal On-Demand purchasing.
4. Choose your public subnet and verify that the attached security group belongs to its VPC.
5. Set **Auto-assign public IP: Enable**, where offered. This instance needs a public IPv4 address for SSH and the HTTPS API.
6. Verify the IAM instance profile, encrypted root disk, key pair, Debian image and IMDSv2 settings.
7. Review the cost summary and choose **Launch instance**.
8. Open **Instances**, select `innovation-week-api`, and wait for state **Running** and all status checks to pass.

If an IAM role/profile is missing from the list, check its EC2 trust relationship and your user's permission to pass that role. If the instance already launched without the role, attach it using **Actions → Security → Modify IAM role**.

## 8. Assign a stable public IP and configure DNS — AWS console / DNS provider

1. Open **EC2 → Elastic IPs → Allocate Elastic IP address** in Sydney.
2. Allocate an address, select it, then **Actions → Associate Elastic IP address**.
3. Choose **Resource type: Instance**, select `innovation-week-api`, and select its primary private address.
4. Associate the address and copy it.
5. At your domain's DNS provider, create an **A record** for your actual API hostname, pointing to this Elastic IP.

Example mapping (replace with your actual values):

```text
api.yourdomain.com → YOUR_EC2_ELASTIC_IP
```

The Elastic IP remains stable across stop/start; an auto-assigned public IP can change. Public IPv4/Elastic IP charges apply, including to addresses retained when a server is stopped. An IP address alone is not the HTTPS hostname required by the supplied Nginx/Certbot setup. Your Amplify-generated `amplifyapp.com` hostname is for the existing frontend; use a separate hostname whose DNS you control for the API.

Source: [Elastic IP behavior and billing](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/elastic-ip-addresses-eip.html).

## 9. Connect from your Mac and prepare Debian

In **Mac Terminal**, use your actual Elastic IP:

```sh
ssh -i "$HOME/Downloads/innovation-week-api.pem" admin@YOUR_EC2_ELASTIC_IP
```

Official Debian AMIs use **`admin`**, not `ubuntu`, `ec2-user` or the database username `postgres`.

Inside the **Debian SSH terminal**:

```sh
whoami
cat /etc/os-release
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y curl ca-certificates gnupg unzip nginx openssl postgresql-client netcat-openbsd certbot python3-certbot-nginx

curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/innovation-node24-setup.sh
sudo bash /tmp/innovation-node24-setup.sh
sudo apt-get install -y nodejs
node --version
npm --version
command -v node
```

Expect Debian 13, user `admin`, Node 24.14 or newer within the 24.x line and `/usr/bin/node`. Reboot if required by OS/kernel updates, then reconnect using the same Elastic IP. Do not install PostgreSQL server locally: the API will use your existing Aurora database.

For NodeSource/package installation details, see [the project's Debian deployment guide](../debian/README.md#2-install-packages-and-nodejs).

## 10. Check networking, certificate verification and the attached role — Debian

Check Aurora DNS and TCP access:

```sh


nc -vz -w 5 innovation-week-postgres.cluster-cyqg0uctocgp.ap-southeast-2.rds.amazonaws.com 5432
```

Install the certificate onto the **server**:

```sh
curl --fail --show-error --location \
  https://www.amazontrust.com/repository/AmazonRootCA1.pem \
  --output /tmp/innovation-AmazonRootCA1.pem
sudo install -m 644 /tmp/innovation-AmazonRootCA1.pem /etc/ssl/certs/AmazonRootCA1.pem

openssl s_client -starttls postgres \
  -connect innovation-week-postgres.cluster-cyqg0uctocgp.ap-southeast-2.rds.amazonaws.com:5432 \
  -servername innovation-week-postgres.cluster-cyqg0uctocgp.ap-southeast-2.rds.amazonaws.com \
  -verify_hostname innovation-week-postgres.cluster-cyqg0uctocgp.ap-southeast-2.rds.amazonaws.com \
  -CAfile /etc/ssl/certs/AmazonRootCA1.pem \
  -verify_return_error -brief </dev/null
```

Expect successful TCP access and `Verification: OK`. This verifies TLS without logging into PostgreSQL or sending a password/token.

Check the attached role's **name only**, without retrieving its credentials:

```sh
NEP_IMDS_TOKEN="$(curl --fail --silent --show-error --max-time 5 \
  -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')"
curl --fail --silent --show-error --max-time 5 \
  -H "X-aws-ec2-metadata-token: $NEP_IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/iam/security-credentials/
unset NEP_IMDS_TOKEN
```

Expect `InnovationWeekApiRole`. The metadata URL must be run **inside EC2**, not on your Mac. Do not append a role name to that URL for a support report, because the resulting endpoint returns temporary credentials. This name check proves the role is attached; it does not prove its database permission is correct. The Node database check below does that.

## 11. Upload the updated app, then start the production API

Leave the SSH terminal open. In a **second Mac Terminal window**, upload the updated source ZIP, replacing the ZIP path and Elastic IP:

```sh
scp -i "$HOME/Downloads/innovation-week-api.pem" \
  /absolute/path/to/innovation-week.zip \
  admin@YOUR_EC2_ELASTIC_IP:~/
```

For a first installation, in the **Debian SSH terminal**:

```sh
sudo unzip ~/innovation-week.zip -d /opt
sudo chown -R "$(id -un):$(id -gn)" /opt/innovation-week
cd /opt/innovation-week
umask 022
npm ci --include=dev
npm run build
npm prune --omit=dev
```

Use the current source ZIP with `PG_AUTH_MODE=iam` support, not the frontend-only ZIP. Install Linux dependencies on Debian instead of copying a Mac's `node_modules`. Preserve an existing checkout/configuration before deploying an update.

Now continue with [the production guide](PRODUCTION.md):

1. **Step 2:** verify the schema and grant the `innovation_app` SQL privileges/`rds_iam` role if not already done. Keep the app's actual database name (`innovation_week` or `postgres`).
2. **Steps 5–6:** create the runtime OS account and persistent upload directory; configure `/etc/innovation-week.env` using [the IAM template](backend-aurora-iam.env.example). Use the server certificate path, complete SES settings and no fixed `PGPASSWORD`.
3. **Step 7:** run `scripts/db-check.js` as the service user with the production environment. Expect `ok: true`, the correct database and `username: innovation_app`.
4. **Step 8:** install/start the systemd service. Expect `active (running)` and successful `http://127.0.0.1:3001/api/health`.
5. **Step 9:** configure Nginx and Certbot for your actual API DNS hostname. Expect health JSON over public HTTPS.
6. **Steps 10–11:** add the Amplify `/api/*` 200 rewrite to the HTTPS API, then test sign-in, image uploads, likes and votes.

The server is ready for the full application once these three checks succeed:

| Check | Expected result |
| --- | --- |
| Node database check on Debian | `ok: true`, intended database, `innovation_app` |
| `https://YOUR_API_HOSTNAME/api/health` | HTTP 200, `{"ok":true,"database":"postgres"}` |
| `https://main.d3ha2gxpxiqxnu.amplifyapp.com/api/health` | The same health JSON through Amplify |

At that point the API is run by systemd; your Mac and SSH terminal do not need to stay open. Keep PostgreSQL backups and backups of `/var/lib/innovation-week` for uploaded images. EBS persistence across reboot does not replace backups or protect files if a volume is deleted on instance termination.

## Troubleshooting the new EC2 server

| Problem | Check |
| --- | --- |
| SSH times out | Elastic IP, public subnet internet gateway route, inbound SSH source matching your current public IP and local/corporate firewall. |
| `Permission denied (publickey)` | Use `admin`, the key selected at launch and `chmod 400` on that key. |
| Role not found in metadata | Attach the correct EC2 instance profile; keep the metadata endpoint enabled and use an IMDSv2 token. |
| Aurora TCP check times out | Internet egress for Express gateway, or VPC routing/database SG access for a regular VPC cluster. |
| TLS certificate verification fails | Correct server certificate file, hostname and clock; do not disable certificate verification. |
| Node reports PAM authentication failure | Check runtime user's `rds_iam`, `PG_AUTH_MODE=iam`, region, hostname and the EC2 role's exact resource-ID/user ARN. |
| npm/build exits with an out-of-memory error | Check `free -h`; use an instance with more memory or build the frontend on CI. |
| Certbot fails | Check public API DNS A record and inbound 80/443; ensure the chosen hostname resolves to this EC2 instance. |

This guide specifies one API server. It does not configure automatic failover or deploy infrastructure on your behalf.
