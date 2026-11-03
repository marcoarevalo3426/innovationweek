#!/bin/bash
# Prepend AWS_REGION, RELEASE_URI, RELEASE_SHA256 and SSM_ENV_PARAMETER in launch-template user data.
set -euo pipefail
umask 077
export DEBIAN_FRONTEND=noninteractive AWS_PAGER=''
: "${AWS_REGION:?}" "${RELEASE_URI:?}" "${RELEASE_SHA256:?}" "${SSM_ENV_PARAMETER:?}"

apt-get update
apt-get install -y awscli ca-certificates curl python3 gzip tar libstdc++6 libatomic1
curl --fail --silent --show-error --proto '=https' \
  "https://s3.${AWS_REGION}.amazonaws.com/amazon-ssm-${AWS_REGION}/latest/debian_amd64/amazon-ssm-agent.deb" \
  -o /tmp/amazon-ssm-agent.deb
dpkg -i /tmp/amazon-ssm-agent.deb
systemctl enable --now amazon-ssm-agent

id innovation >/dev/null 2>&1 || useradd --system --home /opt/innovation-week --shell /usr/sbin/nologin innovation
install -d -m 755 /opt/innovation-week
install -d -o innovation -g innovation -m 700 /var/lib/innovation-week
aws s3 cp "$RELEASE_URI" /tmp/innovation-week-release.tgz --region "$AWS_REGION" --only-show-errors
printf '%s  %s\n' "$RELEASE_SHA256" /tmp/innovation-week-release.tgz | sha256sum --check --status
tar --no-same-owner -xzf /tmp/innovation-week-release.tgz -C /opt/innovation-week
chmod 755 /opt/innovation-week/runtime/node
/opt/innovation-week/runtime/node --version

# Both CA bundles are public. The existing verified PostgreSQL configuration selects its correct bundle.
curl --fail --silent --show-error --proto '=https' https://www.amazontrust.com/repository/AmazonRootCA1.pem -o /etc/ssl/certs/AmazonRootCA1.pem
curl --fail --silent --show-error --proto '=https' https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /etc/ssl/certs/aws-rds-global-bundle.pem
chmod 644 /etc/ssl/certs/AmazonRootCA1.pem /etc/ssl/certs/aws-rds-global-bundle.pem

# The SecureString value is never placed in user data, the release archive, or cloud-init output.
cat > /usr/local/sbin/innovation-week-refresh-env <<EOF
#!/bin/bash
set -euo pipefail
umask 077
export AWS_PAGER=''
temporary_env=\$(mktemp /etc/innovation-week.env.XXXXXX)
trap 'rm -f "\$temporary_env"' EXIT
aws ssm get-parameter --region '$AWS_REGION' --name '$SSM_ENV_PARAMETER' --with-decryption --query Parameter.Value --output text > "\$temporary_env"
test -s "\$temporary_env"
chmod 600 "\$temporary_env"
chown root:root "\$temporary_env"
mv "\$temporary_env" /etc/innovation-week.env
EOF
chmod 700 /usr/local/sbin/innovation-week-refresh-env
/usr/local/sbin/innovation-week-refresh-env

cat > /etc/systemd/system/innovation-week.service <<'UNIT'
[Unit]
Description=NEP Innovation Week API
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=innovation
Group=innovation
WorkingDirectory=/opt/innovation-week
EnvironmentFile=/etc/innovation-week.env
ExecStartPre=+/usr/local/sbin/innovation-week-refresh-env
ExecStart=/opt/innovation-week/runtime/node /opt/innovation-week/server/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=90
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now innovation-week
rm -f /tmp/innovation-week-release.tgz /tmp/amazon-ssm-agent.deb
