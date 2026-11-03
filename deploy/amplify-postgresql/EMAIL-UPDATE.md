# Deploy the branded sign-in email to Debian

> Current production uses [EC2 Auto Scaling](../autoscaling/README.md). Publish future email changes in a new fleet release and update the launch-template version so newly launched servers receive the same template. The email-only installer below is the earlier single-server procedure; patching just one fleet instance will not update future replacements.

Sign-in emails are created by the Node API on Debian. An Amplify frontend deployment does not update them. The new template includes the supplied NEP logo embedded inline, a bold 48px six-digit code, mobile-friendly formatting, the ten-minute expiry, and a plain-text alternative.

The `innovation-week-email-update.zip` package contains just the email template, logo, deployment script and these instructions. The script backs up the affected files under `/var/backups/innovation-week-email/`, checks JavaScript syntax, and wires the branded template into either the existing branded API version or the original known plain-text version. It preserves unrelated API code and refuses an unrecognized integration before changing files. Database records, uploads, environment files and SMTP credentials are not modified.

## 1. Copy the email update from your Mac

Run this in your Mac Terminal from the folder containing the downloaded ZIP:

```sh
scp -i "$HOME/Downloads/innovation-week-api.pem" \
  innovation-week-email-update.zip admin@32.236.122.92:~/
ssh -i "$HOME/Downloads/innovation-week-api.pem" admin@32.236.122.92
```

## 2. Apply it in the Debian SSH terminal

```sh
sudo apt-get update
sudo apt-get install -y unzip
update_dir="$(mktemp -d "$HOME/innovation-week-email-update.XXXXXX")"
unzip ~/innovation-week-email-update.zip -d "$update_dir"
sudo bash "$update_dir/innovation-week-email-update/scripts/update-sign-in-email.sh" /opt/innovation-week
```

If the script reports success, restart the app and check its connection to PostgreSQL:

```sh
sudo systemctl restart innovation-week
sudo systemctl status innovation-week --no-pager
curl --fail-with-body http://127.0.0.1:3001/api/health
```

Expect `{"ok":true,"database":"postgres"}`. If startup fails, inspect `sudo journalctl -u innovation-week -n 60 --no-pager` locally. The deployment script prints the backup location for the three changed files.

## 3. Check the email

Visit `https://nepinnovationweek.com` and request a **new** sign-in code using your own NEP mailbox. Already delivered emails do not change. Choose the HTML/rich-text view in your email client. The logo is attached inline using a content ID; it does not depend on loading a remote image URL. Some email clients may still hide images until the recipient permits them. Plain-text clients receive the readable fallback without visual formatting.

The update does not send any email by itself. Existing SES sender verification, credentials and recipient restrictions still apply. Email styling does not remove SES sandbox restrictions or approve production access.
