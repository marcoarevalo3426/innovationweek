#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash scripts/update-sign-in-email.sh /opt/innovation-week" >&2
  exit 1
fi

package_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
app_dir="${1:-/opt/innovation-week}"

python3 - "$package_dir" "$app_dir" <<'PY'
from pathlib import Path
from datetime import datetime, timezone
import os, re, shutil, stat, subprocess, sys, tempfile

package, app = (Path(value).resolve() for value in sys.argv[1:])
index = app / 'server/index.js'
source = index.read_text()
helper = package / 'server/sign-in-email.js'
logo = package / 'public/nep-innovation-week.png'
if logo.read_bytes()[:8] != b'\x89PNG\r\n\x1a\n':
    raise SystemExit('The packaged email logo is not a PNG. No files changed.')

if not re.search(r'transporter\.sendMail\(\s*signInEmail\(', source):
    # Upgrade the original known plain-text call without replacing unrelated API code.
    pattern = r"transporter\.sendMail\(\{\s*from:\s*process\.env\.MAIL_FROM,\s*to:\s*email,\s*subject:\s*'Your NEP Innovation Week sign-in code',\s*text:\s*`Your sign-in code is \$\{code\}\.[^`]*`\s*\}\)"
    source, count = re.subn(pattern, "transporter.sendMail(signInEmail({ from: process.env.MAIL_FROM, to: email, code }))", source)
    if count != 1:
        raise SystemExit('Unrecognized email integration. No files changed; review server/index.js before updating it.')
if not re.search(r"import\s*\{\s*signInEmail\s*\}\s*from\s*['\"]\./sign-in-email\.js['\"]", source):
    source = "import { signInEmail } from './sign-in-email.js';\n" + source

# Check syntax before modifying any installed files; this does not start Node or access the database.
with tempfile.TemporaryDirectory(prefix='innovation-email-check-') as staging:
    candidate = Path(staging) / 'index.mjs'
    candidate.write_text(source)
    subprocess.run(['/usr/bin/node', '--check', str(candidate)], check=True)
    subprocess.run(['/usr/bin/node', '--check', str(helper)], check=True)

backup_root = Path('/var/backups/innovation-week-email')
backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
backup = Path(tempfile.mkdtemp(prefix=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-'), dir=backup_root))
updates = {
    'server/index.js': source.encode(),
    'server/sign-in-email.js': helper.read_bytes(),
    'public/nep-innovation-week.png': logo.read_bytes(),
}
originals = {}
for relative in updates:
    target = app / relative
    originals[relative] = target.exists()
    if target.exists():
        saved = backup / relative
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, saved)

try:
    for relative, content in updates.items():
        target = app / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        existed = target.exists()
        owner = target.stat() if existed else index.stat()
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as staged:
            staged.write(content)
            staged_path = Path(staged.name)
        os.chmod(staged_path, stat.S_IMODE(owner.st_mode) if existed else 0o644)
        os.chown(staged_path, owner.st_uid, owner.st_gid)
        os.replace(staged_path, target)
except BaseException:
    for relative, existed in originals.items():
        target = app / relative
        if existed:
            shutil.copy2(backup / relative, target)
        else:
            target.unlink(missing_ok=True)
    raise

print('Installed branded sign-in email and logo. Backup:', backup)
print('Next: sudo systemctl restart innovation-week')
print('Then: curl --fail-with-body http://127.0.0.1:3001/api/health')
PY
