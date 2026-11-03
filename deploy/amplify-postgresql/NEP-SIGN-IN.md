# Allow every NEP colleague to sign in

The app admits any valid address on the exact `@nepgroup.com` domain. A colleague does not need an invitation, a pre-created database account or inclusion in `ADMIN_EMAILS`. That setting controls initial administrator privileges only.

1. Enter a NEP email address on the sign-in page.
2. The API sends a random six-digit code to that mailbox through the configured SMTP provider.
3. Enter the code within ten minutes. Incorrect or expired codes do not create an account or a session.
4. After successful verification, a first-time colleague receives an ordinary user account. Existing accounts retain their permissions.

Other domains, subdomains and lookalikes remain blocked. The frontend and API share the same validation rules. Local development retains its existing authentication bypass; production always requires verification.

## AWS email access — now approved

**Latest check on 3 November 2026:** SES production access is enabled and AWS review status is `GRANTED`. The regional quota is 50,000 messages per 24 hours and 14 messages per second. Individual colleagues no longer need SES recipient verification; the application still verifies ownership of each mailbox with its six-digit code. Keep the sender identity verified and account for the SES send-rate quota when planning a large sign-in burst. EC2 scaling does not change that quota.

Before approval, read-only checks in **Sydney (`ap-southeast-2`)** found:

- SES `ProductionAccessEnabled=false` (sandbox), with sending enabled.
- Only one individual sender/recipient identity currently verifies successfully.
- The `nepgroup.com` domain identity has `VerificationStatus=FAILED`; it does not authorize every address on that domain in the sandbox.
- Account-level suppression is enabled for both bounces and complaints.

The app's login rules cannot override SES recipient restrictions. Production access now permits delivery to colleagues without individual SES recipient verification. Keep the sender identity verified. If your organization later authorizes verification of the entire `nepgroup.com` domain, its DNS is separate from this app's `nepinnovationweek.com` zone.

## Request SES production access

**Submitted with your approval on 3 November 2026 and subsequently granted by AWS.** No duplicate request is needed. The steps below are retained as a reference for the submitted request and its status checks.

The prepared [request JSON](ses-production-access-request.json) describes the actual transactional code workflow, domain restriction, code expiry, rate limits and existing suppression settings. Submitting it sends an account-review request to AWS; it does not immediately approve production access.

To submit yourself from a Terminal with authenticated AWS CLI access, run from the app's source folder:

```sh
aws sesv2 put-account-details \
  --region ap-southeast-2 \
  --cli-input-json file://deploy/amplify-postgresql/ses-production-access-request.json
```

Or use **AWS SES → Sydney → Account dashboard → Get set up → Request production access**, choose **Transactional**, and enter `https://nepinnovationweek.com` as the website. Review the consent and bounce/complaint-handling acknowledgement before submitting. Use the prepared JSON's use-case description if AWS asks for details.

Check the result with:

```sh
aws sesv2 get-account --region ap-southeast-2 \
  --query '{ProductionAccess:ProductionAccessEnabled,SendingEnabled:SendingEnabled,Review:Details.ReviewDetails}'
```

`ProductionAccess=true` is the confirmation that recipient sandbox restrictions have been removed. A pending review is not approval. AWS may request additional information. Running or deploying the app does not automatically submit additional requests.

## Deploy and verify

Upload the refreshed frontend ZIP to Amplify. Deploy the updated full app source to Debian, including `shared/email-policy.js`, `src/`, `server/`, and `public/nep-innovation-week.png`. Preserve `/etc/innovation-week.env`, database contents and uploaded images. For a full source deployment, install dependencies/build as appropriate for your existing deployment process, then restart the API:

```sh
sudo systemctl restart innovation-week
curl --fail-with-body http://127.0.0.1:3001/api/health
```

Keep `NODE_ENV=production`, `MAIL_MODE=smtp`, the verified `MAIL_FROM`, and your existing Sydney SMTP credentials. Keep `APP_ORIGIN=https://nepinnovationweek.com`. Do not add every colleague to `ADMIN_EMAILS` or to a database table to enable sign-in.

Now that AWS has approved production access, have a colleague who has not signed in before visit the app and request their own code. Verify receipt, complete sign-in, then reload to confirm the session. They should have normal user permissions. Email generation and account verification are tested locally; delivery and mailbox filtering still need a real recipient test.

Sources: [SES sandbox restrictions and production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html), [AWS CLI request fields](https://docs.aws.amazon.com/cli/latest/reference/sesv2/put-account-details.html).
