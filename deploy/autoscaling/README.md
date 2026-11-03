# EC2 scaling and European access

Deployment status: **enabled in AWS on 3 November 2026**. The group was verified with two healthy servers across AZs a/c and scaled back to its normal one-server capacity. Both CPU and request-count target-tracking policies are enabled.

| Resource | Live configuration |
| --- | --- |
| Region / account | `ap-southeast-2` / `375033595717` |
| Auto Scaling group | `innovation-week-api-asg`, min/desired 1, max 4 |
| Launch template | `innovation-week-api-fleet`, `lt-0caa430400247386c`, pinned version `5` |
| Shared bucket | `nep-innovation-week-375033595717-ap-southeast-2`, private, SSE-S3 encryption, versioning, TLS required |
| Configuration | SecureString `/innovation-week/production/env`, encrypted with the default SSM managed key |
| Runtime identity | Existing `InnovationWeekApiRole`; shared database permission retained; bucket/prefix and parameter access scoped to this app |
| Release | `releases/20261103-admin-management-v5/app.tgz`; SHA256 `27c831640fff87f3fe82c609fe59e4cefd92b344a390ea77f1ccca9b42e318ce` |
| Original instance | `i-0519323d1f9f9d3ac`, attached and protected from routine scale-in during this initial deployment |
| Replacement test instance | `i-02b89bbfb61c95abc`, successfully booted, validated, then terminated by the scale-in test |

The original instance's protection prevents routine scale-in from selecting it. It does not prevent unhealthy-instance replacement. New nodes use encrypted gp3 root disks. The original root disk was retained unchanged. Configuration values and all four original images were migrated and validated without printing secrets or displaying image contents.

The selected capacity is **1–4 On-Demand t3.medium instances**, spanning Sydney AZs a/c using the existing VPC, API security group, target group, ALB, certificate and domain. One instance remains the normal minimum to reduce idle cost. At that minimum there is no spare API instance during a failure or launch warmup. Four is a capacity cap, not a dollar spending cap: EBS, IPv4, CPU credits, storage, traffic and existing services are billed separately.

For a known large event, increase desired/minimum capacity ahead of the opening and return it to one afterward. Reactive scaling includes server startup time; this configuration does not keep an idle warm pool. The regional Standard On-Demand quota was checked and has sufficient vCPU capacity for four app nodes.

## Application changes

- `IMAGE_STORAGE=s3` shares uploaded images in a private, encrypted S3 bucket. The default remains local storage for existing local installations. `/api/images/*` still requires authentication; image objects are not public.
- `RATE_LIMIT_STORE=postgres` shares atomic counters across instances. Apply `rate-limit-store.sql` as the schema owner before enabling it and grant the runtime database role SELECT/INSERT/UPDATE/DELETE on that table. It does not change event data or the core event-schema version.
- Email-code counters use a hash of the normalized NEP address; authenticated mutation counters use the user ID. This avoids grouping every colleague behind the same CDN/proxy IP into one user's limit. Invalid-address requests retain an IP-based limit. Code cooldown, five-attempt lockout and NEP-only validation remain active.
- PostgreSQL already holds sessions, codes, ideas, likes, votes and the authoritative audit log. All nodes must use the same `SESSION_SECRET` and database. The per-instance audit file is a local copy; Admin export reads the complete shared database audit log.
- Gzip compresses eligible API responses. User-specific JSON remains private/no-store.
- Concurrently built indexes on likes by idea and votes by round/idea support gallery count queries as the dataset grows. For a new database, apply `gallery-indexes.sql` as its schema owner outside an explicit transaction.
- The gallery response includes the current user, eliminating a second authentication round trip on each poll. Hidden tabs pause background gallery polling, and overlapping polls are suppressed.

## Fleet startup

`bootstrap.sh` is a launch-template startup script. It expects these nonsecret values to be prepended:

```sh
export AWS_REGION=ap-southeast-2
export RELEASE_URI=s3://YOUR_PRIVATE_BUCKET/releases/RELEASE_ID/app.tgz
export RELEASE_SHA256=SHA256_OF_RELEASE
export SSM_ENV_PARAMETER=/innovation-week/production/env
```

The release archive must contain the application, Linux production `node_modules`, and the validated Debian Node executable as `runtime/node`. Exclude `.env*`, user data, SSH keys, credentials and repository metadata. Fetch the encrypted environment from Parameter Store at startup using the EC2 role. Never bake SMTP/session credentials into an AMI, user data or a release.

Use the existing official Debian 13 AMI, encrypted gp3 root disks, IMDSv2, detailed monitoring and the existing instance profile with narrowly scoped additional S3 and Parameter Store permissions. Install SSM Agent so subsequent deployments can use Run Command without SSH. The current public subnets provide outbound service connectivity; inbound application traffic remains restricted to the ALB security group.

## Migration and scaling sequence

1. Back up the protected environment and current application files on Debian. Inventory existing images and copy them to the private S3 upload prefix. Preserve original images until validation succeeds.
2. Create the operational rate-limit table as the database owner and grant only the runtime operations required by the limiter.
3. Set `IMAGE_STORAGE=s3`, `S3_UPLOAD_BUCKET`, `S3_UPLOAD_PREFIX=uploads/`, `RATE_LIMIT_STORE=postgres` and the existing region in the protected environment. Retain the existing session secret, SMTP and verified database TLS settings. Store the resulting environment in the encrypted Parameter Store parameter without printing it.
4. Build and upload a versioned, checksum-verified Linux release. Test local health, image reads and cross-instance sessions before routing users to new instances.
5. Create a launch template with a **pinned numeric version**, then an Auto Scaling group with min/desired 1, max 4, the two existing ALB subnets and its instance-type target group. Use `HealthCheckType=ELB`, a 600-second grace period and 300-second instance warmup. The target group checks `/`, which verifies the running Node HTTP server and its built index page. Keep `/api/health` for separate database-readiness monitoring; a shared database outage should not churn every otherwise running API instance.
6. Enable target tracking at **40% average CPU** and initially **600 ALB requests per target per minute**. Those are conservative starting thresholds, not a tested user-capacity guarantee. Target tracking scales out when either policy calls for capacity and scales in when both agree. Tune with representative traffic and database metrics.
7. Verify a temporary scale-out to two healthy nodes, then scale-in to one with connection draining (configured to 60 seconds). Preserve the original server during cutover until shared state and replacement startup are validated. Do not enable scaling policies against a template that has not successfully booted.
8. Deploy the optimized frontend to Amplify. Confirm private API cache headers, compressed responses, existing sign-in and image access through the frontend domain.

## Europe and limits

Amplify already distributes the frontend through AWS's global CDN. API compression, fewer network round trips, and paused background polling reduce transfer and load for distant users. Keep authenticated API data out of public CDN caches.

The API and PostgreSQL writer remain in Sydney. Auto Scaling improves capacity and replacement recovery; it does not remove Europe–Sydney network latency. A European API/writer deployment would require a separate consistency, database, data-residency and cost decision. It is not included in this cost-conscious first stage.

The existing database-scoped transaction lock still serializes mutations to preserve submission/vote limits. Additional EC2 instances do not remove a database/write-contention bottleneck. Measure actual gallery, image, sign-in and voting traffic before promising a concurrent-user capacity or raising the four-instance cap.

## Checks completed so far

63 native PostgreSQL/unit tests passed, including two simultaneous API processes sharing verification codes, sessions, rate limits and ideas; atomic counter contention/reset; S3 adapter sharing and error behavior; and compressed private idea responses. The frontend production build passed. Live checks verified all four migrated images against local originals, S3 read/write/delete using the EC2 role, a healthy staged API, a fresh replacement boot, shared image/counter access, configuration equality with Parameter Store, SSM commands, two healthy load-balancer targets across two zones, and scale-in to one.

The scale-in test changed desired capacity explicitly. The CPU/request policies and their alarms are enabled, but no high-load stress test against production event data was performed. Thresholds therefore remain starting values, not a measured concurrent-user guarantee.

## Operations after this migration

**Configuration is now managed in Parameter Store.** Update the SecureString `/innovation-week/production/env` for persistent SMTP, session, database or application-setting changes, then restart the fleet through SSM. `/etc/innovation-week.env` is a protected local copy refreshed before service startup; editing that local copy alone will not persist across restarts. Never put the decrypted parameter in Git, chat, frontend build variables or release archives.

Use Systems Manager Session Manager or Run Command for administration. All new nodes install SSM Agent; the existing node is also enrolled. New nodes do not require an SSH key. To view current capacity and scaling actions:

```sh
aws autoscaling describe-auto-scaling-groups --region ap-southeast-2 \
  --auto-scaling-group-names innovation-week-api-asg
aws autoscaling describe-scaling-activities --region ap-southeast-2 \
  --auto-scaling-group-name innovation-week-api-asg
curl --fail-with-body https://nepinnovationweek.com/api/health
```

**Publish API changes as a new immutable fleet release.** Build a Linux release with production dependencies (the `prepare-fleet-runtime.js` script pins the API-only manifest from the source lockfile), validate it, upload under a new `releases/RELEASE_ID/` prefix, create a new launch-template version with its URI/checksum, and update the ASG to that explicit version. Roll out with enough healthy capacity to stay within the four-server cap. Review the original instance's scale-in protection when planning replacement. Patching only one running instance will otherwise leave future scale-outs on the old release.

The authoritative audit history remains in PostgreSQL and Admin export includes every node. The existing local `audit.jsonl` and `monitor-requests.json` files contain per-instance activity. They are not aggregate fleet metrics; use ALB/ASG CloudWatch metrics for fleet load and health. Keep that distinction when extending any previous single-instance monitoring integration.

The rollback backup on the original server is `/var/backups/innovation-week-scaling/20261103T034312Z-a1b__0un`, protected from ordinary users. It includes original source/configuration and original dependencies. Existing local upload files were retained. Disable scaling and drain replacement traffic before reverting to a local-only image configuration; never mix old local-storage nodes with new S3-writing nodes in the serving target group.

That legacy backup is server-local and does not survive termination of the original instance. Durable fleet rollback uses retained S3 release versions, pinned launch-template versions and encrypted Parameter Store revisions.

References: [EC2 target tracking](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html), [Amplify global CDN](https://docs.aws.amazon.com/amplify/latest/userguide/welcome.html), [S3 security](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html), [SSM on Debian](https://docs.aws.amazon.com/systems-manager/latest/userguide/agent-install-deb.html).


## Footer settings release — 3 November 2026

Launch-template version **2** uses release `20261103-footer-v2` and schema **2**. Migration `002-footer-link.sql` adds the footer message, clickable text, and URL to the existing settings row. Admin → Footer link saves these values through the authenticated settings API and records the administrator action in the audit log. Updates are shared across the fleet through PostgreSQL.

The original instance was put in standby while the new instance served traffic, updated through SSM, validated, and returned to service. Both nodes passed checks for matching API source, schema version, footer defaults, shared image/rate-limit configuration, and database readiness. The group was then returned to desired capacity one with its original instance protected.

**Schema-aware rollback:** after migration 3, older releases fail their strict startup checks. A rollback to earlier API code must retain the current `server/migrate.js` and both `002-footer-link.sql` and `003-submission-limit.sql`, or use a compatible release. Do not drop settings columns or downgrade the database to roll back a display feature. Pair an API rollback with a compatible frontend when older code lacks the latest routes.


## Admin activity and participation release — 3 November 2026

Launch-template version **4** uses release `20261103-admin-activity-v4`; the PostgreSQL schema remains **2**. No migration, permission expansion, production log clearing, or event-data reset is part of deployment.

Admin → Activity log → Clear logs requires confirmation and deletes only the shared audit history. A fresh `admin.audit_cleared` record identifies the administrator. Local diagnostic copies synchronize to that boundary within 30 seconds; offline nodes do so on startup. Delayed acknowledgements from older transactions cannot append pre-clear records after a clear snapshot. Independent backups and infrastructure logs are outside this application action.

The synthetic monitor email is skipped before recording new audit actions. Legacy rows for that actor are hidden in the activity view and export. Participation is admin-only, excludes the monitor, and independently counts distinct voted and liked ideas to avoid join multiplication. Current-round votes are the default; All rounds counts distinct ideas across stored rounds. Likes show current selections.

57 tests cover authorization, explicit confirmation, unchanged accounts/ideas/votes/likes, monitor filtering, correct participation totals, cross-node copy cleanup, and a deliberately delayed commit acknowledgement during a clear. The production clear endpoint is not invoked as a deployment test. Use the original instance's standby/drain procedure while a validated replacement serves requests for in-place updates; return desired capacity to one afterward.

The final pre-update server backup is `/var/backups/innovation-week-admin-v4/20261103T111829Z` on the original instance. It preserves the schema-compatible previous API source; environment credentials remain in Parameter Store.


## Account management and CSV release — 3 November 2026

Launch-template version **5** uses `20261103-admin-management-v5`; schema **3** adds `settings.max_ideas` with default 2 and range 1–100. The database owner runs migration 3 before the new API starts. It changes no accounts, ideas, votes or likes. Runtime grants on the existing settings table cover its new column.

Administrators can confirm account deletion, including the account’s ideas, votes/likes, sessions and pending codes. Other users’ reactions to removed ideas are deleted with those ideas. The signed-in administrator and last administrator are protected. Eligible emails can create a new account afterward; deletion is not a ban. The operation is audited and image cleanup runs after the transaction commits. Deployment does not call this destructive endpoint.

Manage ideas defaults to highest current-round votes, with Votes/Likes sort toggles and full-detail CSV export. Participation export respects the selected history scope and search. Exports require admin access and escape CSV text and spreadsheet formulas. The stricter sign-in policy accepts only letters and single separating periods before `@nepgroup.com`; the existing production bootstrap admin configuration passed a check for that policy without printing its addresses.

63 tests passed, including CSV Unicode/multiline/quoting/formula handling, export authorization/order, dynamic submission caps under concurrent requests, account removal/file cleanup/session revocation, and simultaneous administrator deletion. Existing ideas remain when a cap is reduced. Admins retain their existing submission exemption; submission closure still blocks all new ideas.


## Independent like schedule rollout — 4 November 2026

Launch-template version **6** uses release `20261104-like-schedule-v6`; schema **4** adds independent like mode/start/end settings. Migration `004-like-schedule.sql` preserves all likes and defaults to open without an end date. It was run by the database owner after pinning the new launch template and before starting the new API. No extra database grants, environment changes or dependencies were required.

Admin → **Voting & Like schedule** now contains separate voting and like forms. Closing likes blocks both like and unlike requests, enforced transactionally on the API; totals remain visible. Scheduled likes open and close automatically using server time. **Reset all likes** requires explicit confirmation, records an audit action, and preserves votes, rounds and schedules. Production reset was not used as a deployment test.

The rollout stages and tests the release on port 3002, boots a fresh version-6 fleet node, drains the original instance through ASG standby, updates its source through SSM, and verifies matching source, schema, default like settings, runtime permissions and PostgreSQL health. The original pre-update source backup is `/var/backups/innovation-week-like/20261103T131110Z`. Rolling back older application code after this additive migration must retain the schema-4 `server/migrate.js` and migration file.

Local validation: **67 native PostgreSQL tests passed**, plus production frontend build and isolated UI checks for saved dates, closed-like button states, reset cancellation and reset isolation. No stress-tested capacity claim is made.
