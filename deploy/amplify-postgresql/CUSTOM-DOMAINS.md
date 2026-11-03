# Production domains: Amplify and the Debian EC2 API

> The API is now managed by [EC2 Auto Scaling](../autoscaling/README.md). Persistent environment changes must be made in the encrypted SSM parameter `/innovation-week/production/env`; the local environment file is refreshed at startup. The single-server environment-edit steps below are historical reference. Prefer SSM administration and versioned fleet releases for the current production setup.

This deployment uses `https://nepinnovationweek.com` for the frontend and `https://api.nepinnovationweek.com` for the API. Resources are in **Sydney (`ap-southeast-2`), account `375033595717`**. The browser continues to use relative `/api/` requests through Amplify, so the existing session-cookie authentication works on the frontend domain.

**Verified on 3 November 2026:** frontend HTTP 200; API HTTPS certificate valid; target healthy; both direct and Amplify-proxied health checks HTTP 200 with PostgreSQL connected; production `/api/auth/me` reports local authentication disabled; `www` redirects to the apex. An invalid-email POST accepts the apex origin and rejects an unrelated origin, without sending mail or creating an email challenge. Real SES delivery and a complete OTP sign-in were not exercised.

## Resource map

| Resource | Configuration |
| --- | --- |
| Amplify | `innovationweek`, app `d3ha2gxpxiqxnu`, branch `main` |
| Route 53 public hosted zone | `nepinnovationweek.com`, `Z0529560WY9WLS2QSMPI` |
| Frontend DNS | Apex A alias and `www` CNAME to `d1iap63c31ftw3.cloudfront.net` |
| API EC2 instance | `i-0519323d1f9f9d3ac`, SSH `admin@32.236.122.92`, private `172.31.23.190` |
| VPC | `vpc-7864f51f` |
| API instance security group | `innovation-week-api-sg`, `sg-0c3a59b2d9c0b5637` |
| Load-balancer security group | `innovation-week-alb-sg`, `sg-05018159afeb4a801` |
| Application Load Balancer | `innovation-week-api-alb` |
| ALB DNS | `innovation-week-api-alb-744831183.ap-southeast-2.elb.amazonaws.com` |
| Backend target group | `innovation-week-api-tg`, HTTP port `3001`, instance target |
| ALB health check | `/`, HTTP `200` required for the Node process; `/api/health` separately verifies PostgreSQL |
| API ACM certificate | `71ff9c66-431a-4baf-a37d-001898512b5b`, domain `api.nepinnovationweek.com` |

The ALB spans `subnet-a04b31e9` (AZ a) and `subnet-75df1c2d` (AZ c). Public HTTP redirects to HTTPS. TLS terminates at the ALB, which forwards HTTP over the VPC to Node port 3001. **Nginx and Certbot are not required for this ALB route**; the earlier single-instance Nginx instructions describe a different deployment path. The ALB has ongoing AWS charges.

The instance accepts port 3001 only from the ALB security group and retains SSH port 22 from `180.181.251.130/32`. Public inbound 80/443 are removed from the instance security group. Do not expose 3001 to `0.0.0.0/0`. The VPC's shared default security group is unchanged.

## Server settings — run yourself in Debian SSH when needed

AWS routing cannot change the protected environment file inside Debian. Public checks currently show that the API is reachable and accepts the new frontend origin. If these settings are already applied, no further restart is necessary. To apply or restore the domain settings, run this on the existing API server after connecting with your usual SSH key:

```sh
sudo python3 - <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import os, shutil
p = Path('/etc/innovation-week.env')
text = p.read_text()
backup = str(p) + '.before-domain-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
shutil.copy2(p, backup)
os.chmod(backup, 0o600)
updates = {
    'HOST': '0.0.0.0',
    'PORT': '3001',
    'APP_ORIGIN': 'https://nepinnovationweek.com',
    'TRUST_PROXY': '1',
}
lines = []
for line in text.splitlines():
    key = line.split('=', 1)[0].strip()
    if key.startswith('export '):
        key = key[7:].strip()
    if key not in updates:
        lines.append(line)
lines.extend(key + '=' + value for key, value in updates.items())
p.write_text('\n'.join(lines) + '\n')
os.chmod(p, 0o600)
print('Updated domain settings. Protected backup:', backup)
PY
sudo systemctl restart innovation-week
sudo systemctl is-active innovation-week
curl --fail-with-body --max-time 15 http://127.0.0.1:3001/api/health
```

Expected: `active` and `{"ok":true,"database":"postgres"}`. The script preserves all other settings, including PostgreSQL, SMTP and session credentials. Keep `NODE_ENV=production`, `MAIL_MODE=smtp`, the existing instance-role IAM database settings and verified database TLS. Never publish the environment file or its protected backup.

`HOST=0.0.0.0` allows the ALB to reach Node over the instance's private address. The security group restricts that network access. `TRUST_PROXY=1` trusts the ALB immediately in front of Node; do not insert Nginx into this route without revisiting proxy handling. Amplify is an additional upstream proxy, so client-IP rate limiting should also be checked through the deployed frontend before a larger rollout.

## DNS, HTTPS and Amplify routing

Keep these DNS records in the existing public zone:

- Apex A alias → the Amplify CloudFront distribution, preserving the working frontend.
- `www` CNAME → the same Amplify distribution.
- `api` A alias → the ALB DNS name; ALB hosted zone ID `Z1GM3OXH4ZPM65`.
- The existing Amplify certificate validation CNAME.
- API certificate validation CNAME: `_6cf30b48c76bac229e05fa49e0aa58dd.api.nepinnovationweek.com.` → `_576f5547aec85a6e563a33ea57145cde.wzccmgtwzk.acm-validations.aws.`

Retain the certificate validation records for automatic renewal. API TLS uses the ACM certificate on ALB listener 443; the database CA file verifies a separate connection to PostgreSQL.

The configured Amplify rules are:

```json
[
  {
    "source": "https://www.nepinnovationweek.com",
    "target": "https://nepinnovationweek.com",
    "status": "301"
  },
  {
    "source": "/api/<*>",
    "target": "https://api.nepinnovationweek.com/api/<*>",
    "status": "200"
  }
]
```

This replaces the expired `trycloudflare.com` tunnel and canonicalizes `www` to the frontend origin accepted by the API. Keep API rewrites before any SPA fallback if adding one later. Do not set frontend code to connect directly to PostgreSQL or add server/database credentials to Amplify frontend build variables.

## Verify the running deployment

Allow roughly 1–2 minutes after restarting Node for target health checks, then run from your Mac:

```sh
curl --fail-with-body --max-time 20 https://api.nepinnovationweek.com/api/health
curl --fail-with-body --max-time 20 https://nepinnovationweek.com/api/health
curl --fail-with-body --max-time 20 https://nepinnovationweek.com/api/auth/me
curl -I https://www.nepinnovationweek.com
```

The first two should return HTTP 200 with `{"ok":true,"database":"postgres"}`. The third should return JSON with `"user":null`, `"localAuth":false`, and `"development":false` before login. The last should redirect to `https://nepinnovationweek.com`. API responses should include `Content-Type: application/json` and `Cache-Control: private, no-store, max-age=0`.

Then visit the frontend and sign in using your own `@nepgroup.com` address. Receiving and verifying the code tests SES and the authenticated cookie flow; the health endpoint tests PostgreSQL connectivity only.

| Symptom | Check |
| --- | --- |
| Local health fails or service exits | `sudo systemctl status innovation-week --no-pager`; inspect `sudo journalctl -u innovation-week -n 60 --no-pager` locally. Fix the underlying startup/database error before changing DNS. |
| ALB target connection error | Check `sudo ss -ltnp 'sport = :3001'` shows `0.0.0.0:3001`; confirm the API SG is attached and permits the ALB SG. Check an existing host firewall if one is enabled; do not disable it globally. |
| Direct API returns 502/503 | Inspect EC2 → Target Groups → `innovation-week-api-tg` → Targets. Check local health and listener/port first. A registered target needs to become healthy. |
| Direct API works, Amplify API fails | Check the `/api/<*>` 200 rewrite, its HTTPS target and propagation. |
| POST fails with invalid request origin | Use the apex frontend and confirm the service reads `APP_ORIGIN=https://nepinnovationweek.com`. |
| Login code delivery fails | Inspect SES Sydney SMTP credentials, verified sender and sandbox/production access. Domain routing does not fix SMTP authentication errors. |

The public frontend, database-backed health checks and complete OTP login require separate verification. Do not treat an issued certificate or an active ALB alone as proof that the application is healthy.

## Change records and recovery

The workspace directory `work/aws-domain-config-2026-11-03/` (outside the distributable app) records pre-change AWS settings and applied AWS responses. It contains no application secrets. The Debian environment backup stays on the server, root-readable only.

For recovery, preserve SSH access. Compare the saved `security-groups-before.json`, `instance-before.json`, `route53-before.json` and `amplify-before.json` before reversing individual changes. The old Amplify tunnel was already unavailable, so restoring that rewrite will not restore a working API. Restore a server environment backup only after reviewing whether newer settings need to be retained. Do not delete the ALB until API DNS and Amplify no longer depend on it, and do not modify unrelated Meraki resources.

References: [ALB HTTPS listeners](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html), [ALB security groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-update-security-groups.html), [Amplify HTTPS reverse proxy](https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html#reverse-proxy-rewrite).
