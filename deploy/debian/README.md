# Production deployment on Debian GNU/Linux

Run the application directly on a fresh Debian 12/13 Lightsail instance using **Node.js 24, systemd, Nginx and Let's Encrypt**. This deployment uses no Docker, Caddy or Snap. The application source requires no OS-specific changes.

These are deployment instructions and configuration templates, not an automated remote deployment. They have not been executed on your AWS instance. Replace every placeholder before starting the service.

## 1. Prepare the instance and domain

Create/select a Debian GNU/Linux instance. Attach a static IP and point your hostname's DNS A record to it. Allow inbound TCP 80 and 443 in Lightsail, along with your SSH access. The app itself will listen only on `127.0.0.1:3001`.

The default SSH username for an OS-only Lightsail Debian instance is **admin**. Other blueprints can use different accounts. This SSH account is separate from your NEP application administrator.

Run from your computer, using your actual key and instance IP:

```sh
ssh -i /path/to/your-key.pem admin@YOUR_STATIC_IP
```

Sources: [Lightsail SSH usernames](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-ssh-using-terminal.html), [static IP](https://docs.aws.amazon.com/lightsail/latest/userguide/lightsail-create-static-ip.html), [firewall rules](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-editing-firewall-rules.html).

## 2. Install packages and Node.js

Run on the Debian server as a user with sudo access:

```sh
sudo apt-get update
sudo apt-get install -y curl ca-certificates gnupg unzip nginx openssl certbot python3-certbot-nginx

curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/innovation-node24-setup.sh
sudo bash /tmp/innovation-node24-setup.sh
sudo apt-get install -y nodejs

node --version
npm --version
command -v node
```

Confirm Node is **24.14 or newer within the 24.x release line**, and the executable is `/usr/bin/node` as used by the supplied service. NodeSource configures its package repository so Node 24 can be maintained through apt.

Sources: [NodeSource Debian installation](https://www.nodesource.com/blog/Update-Node.js-versions-on-linux), [Debian Certbot Nginx package](https://packages.debian.org/trixie/python3-certbot-nginx).

## 3. Upload the project

Download the project's `innovation-week.zip`. From your computer, in the folder containing that ZIP:

```sh
scp -i /path/to/your-key.pem innovation-week.zip admin@YOUR_STATIC_IP:~/
```

On the server, extract the ZIP into `/opt`. This assumes a first installation with no existing `/opt/innovation-week` checkout:

```sh
sudo unzip ~/innovation-week.zip -d /opt
sudo chown -R "$(id -un):$(id -gn)" /opt/innovation-week

cd /opt/innovation-week
umask 022
npm ci --include=dev
npm run build
npm prune --omit=dev
```

Install dependencies on Debian rather than copying a Mac's `node_modules`; image processing uses platform-specific packages. The server serves the built `dist` directory and the API together.

## 4. Create the runtime account and data directory

Use the dedicated `innovation` account for the app service. It does not need interactive shell access or sudo privileges.

```sh
sudo useradd --system --user-group --home-dir /opt/innovation-week --shell /usr/sbin/nologin innovation
sudo install -d -o innovation -g innovation -m 750 /var/lib/innovation-week
```

The checkout remains owned by your SSH/deployment user. The runtime account needs read access to the code and dependencies, and write access to `/var/lib/innovation-week`. If the `innovation` account already exists, reuse it rather than running `useradd` again.

## 5. Configure production

Generate a random session secret:

```sh
openssl rand -hex 48
```

Copy the supplied environment template once, then edit it:

```sh
cd /opt/innovation-week
sudo cp deploy/debian/production.env.example /etc/innovation-week.env
sudo chmod 600 /etc/innovation-week.env
sudo nano /etc/innovation-week.env
```

Replace:

- `APP_ORIGIN` with your exact HTTPS origin, without a trailing slash.
- `SESSION_SECRET` with the generated secret.
- `ADMIN_EMAILS` with your real NEP administrator email, or comma-separated NEP admin emails.
- SMTP username, password and verified sender address with real email configuration.
- `SMTP_HOST` if using another SES region or SMTP provider.

Keep `NODE_ENV=production`, `LOCAL_AUTH_BYPASS=false`, `HOST=127.0.0.1`, `DATA_DIR=/var/lib/innovation-week` and `TRUST_PROXY=1` for this topology. `EnvironmentFile` is read by systemd; there is no need to copy production secrets into the source checkout or export them in your shell.

For SES, verify your sender identity in the selected region and obtain production access before sending to unverified recipient identities. SES SMTP credentials differ from AWS access keys. Production sign-in requires a working NEP mailbox; it does not use the local development account.

Sources: [SES SMTP credentials](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html), [SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

## 6. Start the systemd service

```sh
cd /opt/innovation-week
sudo cp deploy/debian/innovation-week.service /etc/systemd/system/innovation-week.service
sudo systemctl daemon-reload
sudo systemctl enable --now innovation-week
sudo systemctl status innovation-week --no-pager
curl -fsS http://127.0.0.1:3001/api/health
```

The health endpoint should return `{"ok":true}`. The supplied service runs as `innovation`, starts after reboot, and restarts after a process failure. The database tables and upload directory are created automatically on startup. Production settings and SMTP configuration must be complete for startup to succeed.

Source: [systemd service configuration](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).

## 7. Enable Nginx

```sh
cd /opt/innovation-week
sudo cp deploy/debian/nginx.conf /etc/nginx/sites-available/innovation-week
sudo nano /etc/nginx/sites-available/innovation-week
```

Replace `innovation.yourdomain.com` in `server_name` with the same hostname used by `APP_ORIGIN`.

```sh
sudo ln -s /etc/nginx/sites-available/innovation-week /etc/nginx/sites-enabled/innovation-week
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

The `ln` command is needed only once. This configuration forwards the entire app to Node and permits a request body of up to 3 MiB, accommodating the app's 2 MiB image plus multipart form data. The API still enforces its image size and type rules.

Check public HTTP reachability before requesting the certificate:

```sh
curl -fsS http://innovation.yourdomain.com/api/health
```

Sources: [Nginx reverse proxy](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/), [request body limit](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size).

## 8. Configure HTTPS with Debian's Certbot packages

With DNS pointing to this instance and ports 80/443 reachable:

```sh
sudo certbot --nginx --redirect -d innovation.yourdomain.com
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

Follow Certbot's certificate/account prompts. Certbot updates the enabled Nginx site for HTTPS and redirects HTTP to HTTPS. The dry run checks certificate renewal.

```sh
curl -fsS https://innovation.yourdomain.com/api/health
sudo systemctl list-timers certbot.timer --no-pager
```

Sources: [Debian Certbot package](https://packages.debian.org/trixie/certbot), [Certbot Nginx plugin and renewal](https://eff-certbot.readthedocs.io/en/stable/using.html#nginx).

## 9. Sign in and configure the event

Open your HTTPS hostname. Sign in with the email listed in `ADMIN_EMAILS` and enter the emailed code. Configure the welcome section, voting dates, submission deadline, awards and co-admin permissions through Admin.

A fresh database has no sample ideas. The local development authentication bypass remains disabled in production.

## Operations and updates

Application logs:

```sh
sudo journalctl -u innovation-week -n 100 --no-pager
```

Nginx errors:

```sh
sudo tail -n 100 /var/log/nginx/error.log
```

After editing `/etc/innovation-week.env`:

```sh
sudo systemctl restart innovation-week
```

For source updates, stop the app, back up its data, replace the code while preserving `/var/lib/innovation-week` and `/etc/innovation-week.env`, then run `npm ci --include=dev`, `npm run build`, `npm prune --omit=dev`, and start the service again. Run build commands as the deployment user, not root.

For a simple consistent backup, stop the service before archiving the entire data directory, then restart it. Keep backup copies outside the instance. Back up the production environment file separately as sensitive configuration. Deleting or replacing `/var/lib/innovation-week` loses the stored ideas, uploads, likes, votes and audit history.
