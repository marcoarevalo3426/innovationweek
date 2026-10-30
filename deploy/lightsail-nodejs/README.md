# Make the uploaded app public on a Lightsail Node.js blueprint

Use this guide **after copying the full project to your instance**. It runs the app without Docker or Caddy, using Node.js, systemd and an HTTPS reverse proxy. You do not need a Lightsail launch script after the instance has already been created.

These commands target **Debian GNU/Linux**, as requested. They are instructions to run in your Lightsail SSH terminal, not commands already executed on your AWS account. Replace example paths, domain names and email settings. A domain name and working SMTP delivery are needed for the production login flow; production session cookies require HTTPS.

AWS supplies both Lightsail-managed and Bitnami Node.js blueprints. Their default folders and process managers differ. This guide puts this application in `/opt/innovation-week` and gives it its own service so it does not depend on a sample application's PM2 entry. See [AWS's blueprint-specific Node.js guide](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-quick-start-guide-nodejs.html).

## 1. Check the server and choose the web-server route

Open **Lightsail → your instance → Connect → Connect using SSH**. Run the following commands exactly; do not add `--version` to `whoami`:

```sh
whoami
cat /etc/os-release
node --version
command -v node
sudo ss -ltnp | awk 'NR == 1 || $4 ~ /:(80|443|3001)$/'
ls -ld /opt/bitnami /etc/nginx /etc/apache2 2>/dev/null
```

Confirm `/etc/os-release` identifies Debian before using the `apt-get` commands below. If it identifies Amazon Linux or another distribution, its package installation commands need adapting; the label “Linux/Unix + Node.js” alone does not identify the OS.

Choose **one** route for step 7:

| Server setup | Route |
| --- | --- |
| `/opt/bitnami/apache/bin/httpd` exists and the bundled Apache serves ports 80/443 | **7A: Bitnami Apache**. Keep the bundled Apache. |
| Debian's Apache (`apache2`) serves ports 80/443 | **7B: Debian Apache**. |
| Nginx serves ports 80/443, or there is no web server yet | **7C: Nginx**. |
| A Node sample process directly serves port 80/443 | Identify that sample before using **7C**. Stop only the sample that this app replaces. |

If there is a blueprint PM2 sample named `nodeapp`, `sudo pm2 list` and `sudo pm2 describe nodeapp` show its entry point and status. Only if you have confirmed that it is the unused welcome app blocking ports 80/443, stop it with `sudo pm2 stop nodeapp` and persist that change with `sudo pm2 save`. Do not start this application's `server/index.js` in PM2 as well as systemd. If another application owns a required port, resolve its routing before continuing.

## 2. Attach a static IP, configure DNS and open public ports

In the Lightsail console:

1. Attach a **static IPv4 address** to this instance.
2. At your DNS provider, add an **A record** for your chosen hostname, for example `innovation.yourdomain.com`, pointing to that static IP. You can use your existing DNS provider; moving DNS to Lightsail is optional.
3. Under the instance's **Networking → IPv4 firewall**, allow **TCP 80 (HTTP)** and **TCP 443 (HTTPS)**. Keep SSH access on TCP 22 restricted appropriately.
4. Do not open public ports **3001** or **5173**. Node will listen on loopback; Vite is for local development.
5. If an OS firewall is enabled, also allow TCP 80/443 there. Keep SSH allowed before changing firewall rules.

If you publish an AAAA record, it must point to this instance's working IPv6 address and the IPv6 firewall must allow 80/443 too. Otherwise leave the AAAA record absent.

Sources: [static IP](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-create-static-ip.html), [Lightsail firewall rules](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-editing-firewall-rules.html).

## 3. Put the uploaded source in its deployment folder

The source folder must contain `package.json`, `package-lock.json`, `server/`, `src/`, `public/` and `deploy/`. Uploading only `dist/` cannot run the API or database.

Install supporting packages, then set `UPLOADED_APP` to the actual folder you already copied. The example path is a placeholder; it must be the folder containing `package.json`, not its parent:

```sh
sudo apt-get update
sudo apt-get install -y curl ca-certificates openssl rsync

UPLOADED_APP='/replace/with/your/uploaded/innovation-week'
test -f "$UPLOADED_APP/package.json"
test -f "$UPLOADED_APP/server/index.js"
```

Both `test` commands should succeed. Do not continue if they report a missing file. For a **first installation**, copy the source to the standard location:

```sh
sudo install -d -m 755 /opt/innovation-week
sudo rsync -a --exclude=node_modules --exclude=dist --exclude=data \
  --exclude='.env*' --exclude=.git --exclude=.DS_Store \
  "$UPLOADED_APP/" /opt/innovation-week/
sudo chown -R "$(id -un):$(id -gn)" /opt/innovation-week
sudo chmod -R u+rwX,go+rX /opt/innovation-week
cd /opt/innovation-week
```

If you already uploaded directly into `/opt/innovation-week`, skip `rsync` and apply the ownership/read permissions there. The transfer intentionally excludes local data, secrets and Mac dependencies. It starts a new production database. Migrating existing event data is a separate backup/restore operation. Keep environment secrets outside any public document root.

## 4. Confirm Node.js 24 and build on Linux

This application needs **Node.js 24.14 or newer**; use the supported 24.x release line for this guide. The blueprint's preinstalled version may be older.

```sh
node --version
node -e "require('node:sqlite'); console.log('SQLite runtime available')"
```

If the installed Node is older, or is in a private home-directory version-manager folder, install a system-wide Node 24 runtime:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/innovation-node24-setup.sh
sudo bash /tmp/innovation-node24-setup.sh
sudo apt-get install -y nodejs
export PATH="/usr/bin:/bin:$PATH"
hash -r
node --version
```

Use this `/usr/bin/node` for this app even if Bitnami still supplies its own Node binary. Do not change the bundled runtime for unrelated applications. Source: [NodeSource's Debian installation instructions](https://www.nodesource.com/blog/Update-Node.js-versions-on-linux).

Build as your SSH user:

```sh
cd /opt/innovation-week
umask 022
npm ci --include=dev
npm run build
npm prune --omit=dev
test -f dist/index.html
```

`npm ci` installs Linux dependencies from the lockfile. Do not reuse `node_modules` copied from a Mac. Do not use `npm run dev` for the public server.

## 5. Configure persistent storage and production email login

Create the runtime account if it does not already exist:

```sh
id innovation >/dev/null 2>&1 || sudo useradd --system --user-group \
  --home-dir /opt/innovation-week --shell /usr/sbin/nologin innovation
sudo install -d -o innovation -g innovation -m 750 /var/lib/innovation-week
```

Generate a secret, then copy the environment template **once**. If `/etc/innovation-week.env` already exists, edit it rather than overwriting it:

```sh
openssl rand -hex 48
sudo cp /opt/innovation-week/deploy/debian/production.env.example /etc/innovation-week.env
sudo chmod 600 /etc/innovation-week.env
sudo nano /etc/innovation-week.env
```

Set these values, replacing every placeholder:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
DATA_DIR=/var/lib/innovation-week
LOCAL_AUTH_BYPASS=false
APP_ORIGIN=https://innovation.yourdomain.com
SESSION_SECRET=PASTE_THE_RANDOM_SECRET_HERE
TRUST_PROXY=1
ADMIN_EMAILS=your.actual.email@nepgroup.com
MAIL_MODE=smtp
SMTP_HOST=email-smtp.ap-southeast-2.amazonaws.com
SMTP_PORT=587
SMTP_USER=YOUR_SES_SMTP_USERNAME
SMTP_PASS=YOUR_SES_SMTP_PASSWORD
MAIL_FROM=your.verified.sender@nepgroup.com
```

`APP_ORIGIN` must exactly match the public HTTPS URL, without a trailing slash. `TRUST_PROXY=1` assumes one reverse proxy directly in front of Node, as configured here. The local authentication bypass stays disabled. Systemd reads this environment file; do not paste secrets into Apache/Nginx configuration or the frontend.

For Amazon SES, use the SMTP endpoint and credentials from the same region as your verified sender. SMTP credentials are different from AWS access keys. SES sandbox accounts can send only to verified recipients; request production access for general NEP sign-in. Startup checks configuration, but a successful health check does not prove email delivery works.

Sources: [SES SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html), [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

## 6. Keep the app running with systemd

Resolve the actual Node executable instead of assuming the blueprint installed it in `/usr/bin`:

```sh
NODE_EXECUTABLE="$(readlink -f "$(command -v node)")"
sudo -u innovation "$NODE_EXECUTABLE" --version
sudo cp /opt/innovation-week/deploy/debian/innovation-week.service \
  /etc/systemd/system/innovation-week.service
sudo sed -i "s|^ExecStart=.*|ExecStart=$NODE_EXECUTABLE /opt/innovation-week/server/index.js|" \
  /etc/systemd/system/innovation-week.service
sudo systemctl daemon-reload
sudo systemctl enable --now innovation-week
sudo systemctl status innovation-week --no-pager
curl -fsS http://127.0.0.1:3001/api/health
```

The `sudo -u innovation` check must succeed before starting the service. If the selected binary is inaccessible, use the system-wide installation in step 4. The health response should be `{"ok":true}`. SQLite tables, uploads and audit storage initialize automatically in `/var/lib/innovation-week`. No separate database installation is needed.

If startup fails, inspect `sudo journalctl -u innovation-week -n 100 --no-pager`. Fix configuration or permissions before configuring public routing. The service stays running after SSH disconnects and starts on reboot. Source: [systemd service configuration](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

## 7A. Public routing with Bitnami's bundled Apache

Use this branch only for the bundled Apache under `/opt/bitnami/apache`. Skip 7B and 7C.

Install Certbot without installing a second web server:

```sh
sudo apt-get install -y certbot
sudo install -d -m 755 /var/www/innovation-certbot/.well-known/acme-challenge
sudo cp /opt/innovation-week/deploy/lightsail-nodejs/apache-http.conf \
  /opt/bitnami/apache/conf/vhosts/innovation-week-http.conf
sudo nano /opt/bitnami/apache/conf/vhosts/innovation-week-http.conf
```

Replace `innovation.yourdomain.com` with your domain. Keep the HTTPS redirect lines commented for now. The hostname-specific vhost proxies the app to port 3001 and reserves the certificate challenge path. Bitnami's usual vhost include loads `conf/vhosts/*.conf`; verify that include if your image was customized.

```sh
sudo /opt/bitnami/apache/bin/httpd -t
sudo /opt/bitnami/ctlscript.sh restart apache
curl -fsS http://innovation.yourdomain.com/api/health
sudo certbot certonly --webroot -w /var/www/innovation-certbot \
  --cert-name innovation.yourdomain.com -d innovation.yourdomain.com
```

Complete Certbot's prompts. Only after it issues the certificate:

```sh
sudo cp /opt/innovation-week/deploy/lightsail-nodejs/apache-https.conf \
  /opt/bitnami/apache/conf/vhosts/innovation-week-https.conf
sudo nano /opt/bitnami/apache/conf/vhosts/innovation-week-https.conf
sudo nano /opt/bitnami/apache/conf/vhosts/innovation-week-http.conf
```

Replace the hostname in the HTTPS file's `ServerName` and both certificate paths. In the HTTP file, uncomment the three `Rewrite...` lines to redirect visitors to HTTPS. Preserve the certificate challenge exception for renewal. If the image already has a vhost with this exact hostname, update that vhost instead of adding duplicates.

```sh
sudo /opt/bitnami/apache/bin/httpd -t
sudo /opt/bitnami/ctlscript.sh restart apache
```

The templates require Apache modules `proxy`, `proxy_http`, `headers`, `ssl`, `alias` and `rewrite`. Check `sudo /opt/bitnami/apache/bin/httpd -M` if configuration testing reports a missing directive; enable the corresponding bundled `LoadModule` line before restarting. Do not use Debian's `a2enmod` to configure Bitnami Apache.

Add a renewal reload hook:

```sh
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' \
  '/opt/bitnami/apache/bin/httpd -t && /opt/bitnami/apache/bin/httpd -k graceful' \
  | sudo tee /etc/letsencrypt/renewal-hooks/deploy/innovation-apache >/dev/null
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/innovation-apache
sudo /etc/letsencrypt/renewal-hooks/deploy/innovation-apache
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

Continue with step 8. Sources: [Bitnami Node.js and Apache vhosts](https://docs.bitnami.com/virtual-machine/infrastructure/nodejs/get-started/get-started/), [Certbot webroot certificates](https://eff-certbot.readthedocs.io/en/stable/using.html#webroot).

## 7B. Public routing with Debian's Apache

Use this branch only when `/etc/apache2` is the active Apache configuration. Skip 7A and 7C.

```sh
sudo apt-get install -y certbot
sudo a2enmod proxy proxy_http headers ssl alias rewrite
sudo install -d -m 755 /var/www/innovation-certbot/.well-known/acme-challenge
sudo cp /opt/innovation-week/deploy/lightsail-nodejs/apache-http.conf \
  /etc/apache2/sites-available/innovation-week-http.conf
sudo nano /etc/apache2/sites-available/innovation-week-http.conf
```

Replace the hostname. Keep the HTTPS redirect commented until the certificate exists:

```sh
sudo a2ensite innovation-week-http
sudo apache2ctl configtest
sudo systemctl reload apache2
curl -fsS http://innovation.yourdomain.com/api/health
sudo certbot certonly --webroot -w /var/www/innovation-certbot \
  --cert-name innovation.yourdomain.com -d innovation.yourdomain.com
sudo cp /opt/innovation-week/deploy/lightsail-nodejs/apache-https.conf \
  /etc/apache2/sites-available/innovation-week-https.conf
sudo nano /etc/apache2/sites-available/innovation-week-https.conf
sudo nano /etc/apache2/sites-available/innovation-week-http.conf
```

Replace the hostname in all HTTPS settings, then uncomment the HTTP redirect lines as described in 7A. Enable HTTPS and certificate renewal:

```sh
sudo a2ensite innovation-week-https
sudo apache2ctl configtest
sudo systemctl reload apache2
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' 'apache2ctl configtest && systemctl reload apache2' \
  | sudo tee /etc/letsencrypt/renewal-hooks/deploy/innovation-apache >/dev/null
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/innovation-apache
sudo /etc/letsencrypt/renewal-hooks/deploy/innovation-apache
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

Continue with step 8.

## 7C. Public routing with Nginx

Use this branch if Nginx is already serving the instance or ports 80/443 are free. Skip 7A and 7B. Do not install/start Nginx alongside Apache on the same ports.

```sh
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp /opt/innovation-week/deploy/debian/nginx.conf \
  /etc/nginx/sites-available/innovation-week
sudo nano /etc/nginx/sites-available/innovation-week
```

Replace `server_name` with your domain. If your existing Nginx already defines that hostname, update its server block instead of adding a duplicate. Enable the new site once:

```sh
sudo ln -s /etc/nginx/sites-available/innovation-week /etc/nginx/sites-enabled/innovation-week
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
curl -fsS http://innovation.yourdomain.com/api/health
sudo certbot --nginx --redirect -d innovation.yourdomain.com
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

This uses Debian's standard Nginx `sites-enabled` include. For a customized installation, place the same server block in its actual included configuration directory. Sources: [Nginx reverse proxy](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/), [Certbot Nginx plugin](https://eff-certbot.readthedocs.io/en/stable/using.html#nginx).

## 8. Verify public access and sign in

Replace the example domain in these checks:

```sh
curl -I http://innovation.yourdomain.com
curl -fsS https://innovation.yourdomain.com/api/health
sudo systemctl is-enabled innovation-week
sudo systemctl list-timers certbot.timer --no-pager
```

HTTP should redirect to HTTPS and HTTPS health should return `{"ok":true}`. From your own computer or phone, open **https://innovation.yourdomain.com**. The app should show the NEP email login page. Request a code using the actual NEP email in `ADMIN_EMAILS`, verify receipt, and sign in. Configure voting, submissions and awards in Admin. Test an image upload, a second ordinary user and mobile access before sharing the address.

After a first successful launch, reboot once during a suitable maintenance window with `sudo reboot`, reconnect, and repeat the HTTPS health and login checks. This verifies both Node and the existing web server return after reboot. Enable Lightsail automatic snapshots and retain data backups outside the instance.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser times out | Static IP/DNS A record, stale AAAA record, Lightsail 80/443 rules and OS firewall. |
| Default Node.js/Bitnami welcome page | Domain's `Host` must match the new vhost; confirm its configuration is loaded and no duplicate hostname overrides it. Testing by IP can select the default site. |
| `502`/`503` | `sudo systemctl status innovation-week`, its journal, and `curl http://127.0.0.1:3001/api/health`. |
| Node exits immediately | Node 24 runtime, real SMTP values, `SESSION_SECRET`, `APP_ORIGIN`, `ADMIN_EMAILS` and writable data directory. |
| `403` on save or login does not persist | Use the exact configured HTTPS origin; check forwarded protocol and secure cookies. |
| Image upload rejected with `413` | Proxy body limit must allow 3 MiB; the app still limits the image itself to 2 MiB. Both supplied proxy templates include this setting. |
| Login code never arrives | SES region, verified sender, sandbox recipient restrictions, SMTP credentials, spam folder and outbound SMTP connectivity. Inspect app logs. |
| Certificate issuance fails | Public DNS and port 80 must reach this instance; the Apache challenge path must bypass the app and HTTP redirect. |

App logs: `sudo journalctl -u innovation-week -n 100 --no-pager`. Avoid publishing logs containing private operational details or your environment file.

## Future updates and backups

1. Stop the app with `sudo systemctl stop innovation-week`.
2. Back up the **entire** `/var/lib/innovation-week` directory while stopped, then retain a copy outside the instance. Back up `/etc/innovation-week.env` separately as sensitive configuration.
3. Update only the source in `/opt/innovation-week`; preserve the data directory, environment file and proxy/certificate configuration.
4. As the deployment user, run `npm ci --include=dev`, `npm run build` and `npm prune --omit=dev`.
5. Run `sudo systemctl start innovation-week` and repeat the health check.

After editing production environment settings, run `sudo systemctl restart innovation-week`. Database migrations happen automatically on startup. Do not seed demonstration data in production, delete the data directory, or replace it with a development database during routine updates.
