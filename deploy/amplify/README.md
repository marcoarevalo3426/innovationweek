# Fix sign-in when the frontend is hosted on Amplify

The React page can load while its API is unavailable. This app makes requests such as `/api/auth/me`, `/api/auth/request` and `/api/auth/verify`. A normal Vite `dist/` upload to Amplify hosts static frontend files; it does not start this project's `server/index.js` Express process. Adding the Amplify SDK or generating Cognito/Auth/Data resources does not automatically implement these existing REST endpoints.

The old message, **Cannot reach the API. Start the app with npm run dev**, was local-development advice. Running `npm run dev` in an Amplify build does not create a persistent production API. The updated UI shows a connection state with retry and no longer attempts to parse an HTML fallback as JSON. Deployment routing still needs a working backend.

For the existing PostgreSQL, SES and persistent-image implementation, use this arrangement:

```text
Browser → https://YOUR_AMPLIFY_HOST
             ├── / and /assets/* → Amplify frontend files
             └── /api/* → HTTPS rewrite → Lightsail Apache/Nginx
                                             → Node on 127.0.0.1:3001
                                             → PostgreSQL / SES / image storage
```

This preserves the app's same-origin cookies and API URLs without a cross-origin authentication rewrite. The backend must be independently deployed and reachable over public HTTPS from Amplify. Your computer's `localhost`/`127.0.0.1` and a private database endpoint are not API targets Amplify can use.

Sources: [Amplify Hosting manual uploads](https://docs.aws.amazon.com/amplify/latest/userguide/manual-deploys.html), [HTTPS reverse-proxy rewrites](https://docs.aws.amazon.com/amplify/latest/userguide/redirect-rewrite-examples.html#reverse-proxy-rewrite).

For RDS database creation, data transfer and the optional native Gen 2 SQL connector, see [PostgreSQL for Amplify](../amplify-postgresql/README.md).

## 1. Deploy or check the Node API

Use the [PostgreSQL/SES deployment guide](../postgresql-ses/README.md) and [Lightsail Node.js blueprint guide](../lightsail-nodejs/README.md) to run the existing Express server, configure PostgreSQL, restore images, and put Apache/Nginx with a trusted HTTPS certificate in front of it.

Before configuring Amplify, check the backend's actual public URL:

```sh
curl -i https://api.yourdomain.com/api/health
```

Expect HTTP 200, `Content-Type: application/json`, and `{"ok":true,"database":"postgres"}`. If this fails, fix the API service, database connection, proxy, DNS or HTTPS first. A rewrite cannot start a missing backend.

Keep Node's port 3001 private to the Lightsail instance. Expose the reverse proxy's HTTPS port 443 publicly. Do not expose PostgreSQL to the browser. Configure SES delivery and its production access on the backend.

## 2. Tell the backend which frontend origin to accept

In the backend's protected production environment file, use the exact origin that employees open:

```dotenv
NODE_ENV=production
LOCAL_AUTH_BYPASS=false
APP_ORIGIN=https://YOUR_BRANCH.YOUR_APP_ID.amplifyapp.com
TRUST_PROXY=1
```

If using an Amplify custom domain, use that origin instead, for example `https://innovation.yourdomain.com`. Do not include a path or trailing slash. Restart the Node service after changing it:

```sh
sudo systemctl restart innovation-week
```

With the supplied Nginx/Apache configuration, the immediate Lightsail proxy sets its own forwarded headers, so the existing `TRUST_PROXY=1` remains appropriate. If you change the proxy topology, review trusted-proxy configuration instead of increasing it blindly. Node must not be directly reachable from the public internet.

Production keeps the normal email-code authentication. The local bypass is not a fix for cloud connectivity. Database passwords, SMTP credentials and session secrets stay on the backend, not in Amplify's public Vite variables or frontend files.

## 3. Add an Amplify API rewrite before the SPA fallback

Open **Amplify console → your app → Hosting → Rewrites and redirects → Manage redirects**. Start from [rewrites.example.json](rewrites.example.json), replacing `https://api.yourdomain.com` with the real HTTPS backend origin.

The API rule must precede every broad rule that serves `index.html`:

```json
{
  "source": "/api/<*>",
  "target": "https://api.yourdomain.com/api/<*>",
  "status": "200",
  "condition": null
}
```

Use a **200 rewrite**, which keeps the browser on the frontend origin. A 301/302 redirect changes the browser destination and does not give this cookie-based app the same-origin behaviour it expects.

The target retains `/api/`: `/api/auth/request` must reach the backend's `/api/auth/request`, not `/auth/request`. Keep the source as a path, not a domain-plus-path expression. The example file includes an asset-aware SPA fallback that avoids the main API prefix. Preserve any unrelated custom rules deliberately; remove/reorder old catch-all rules that would override the API route.

Saving the example JSON file in the repository does not apply the routing rules to your Amplify app. Paste/save the edited rules in the console, or configure them through your own existing deployment infrastructure.

Sources: [edit Amplify routing rules](https://docs.aws.amazon.com/amplify/latest/userguide/creating-editing-redirects.html), [rewrite order](https://docs.aws.amazon.com/amplify/latest/userguide/redirects.html).

## 4. Publish the current frontend

For an existing Git-connected deployment, build with `npm ci --include=dev` and `npm run build`, publishing **dist**. [amplify-static.example.yml](amplify-static.example.yml) is a frontend-only build example. It can be used as `amplify.yml` for a frontend-only pipeline, but do not overwrite an existing Amplify Gen 2 backend pipeline with it. Keep your backend deployment steps if they serve a separate purpose. The local data ignore rule is anchored to `/data/` so it does not hide `amplify/data/` source files from Git.

For a manual drag-and-drop deployment, run `npm run build` and upload a ZIP containing the **contents of dist**, with `index.html` at the ZIP root. The prepared `innovation-week-amplify-frontend.zip` has that layout. A full source ZIP and a static frontend ZIP serve different purposes; neither starts the Express process merely by being uploaded as static assets.

Deploy the new frontend and hard-refresh the site. The old developer-oriented message proves an earlier frontend build is still being served; the current build shows a connection/retry state instead. Changing that message alone does not restore API connectivity.

## 5. Verify the route and the entire sign-in flow

First check through the **Amplify hostname**, not just the backend hostname:

```sh
curl -i https://YOUR_AMPLIFY_HOST/api/health
curl -i https://YOUR_AMPLIFY_HOST/api/auth/me
```

Health should return the PostgreSQL JSON response. Without a session, `/api/auth/me` should return JSON with `user: null` and `localAuth: false`. If either returns `<!doctype html>`, the SPA fallback is still catching the request or the wrong build/site is being tested.

In a browser:

1. Open the Amplify frontend and request a code using your actual NEP mailbox.
2. Confirm that `POST /api/auth/request` returns JSON and the code arrives through SES.
3. Enter the code. Confirm `POST /api/auth/verify` returns a user and sets the HttpOnly `nep_session` cookie on the frontend origin.
4. Refresh the page. `/api/auth/me` should still identify that user, and authenticated `/api/images/...` requests should load the existing images.
5. Test an image upload and a controlled like/vote. These check authenticated POST/multipart forwarding, not just public GET routing.
6. Sign out, then confirm `/api/auth/me` returns `user: null`. Verify another user does not receive a cached session or gallery response.

The updated backend sets `Cache-Control: private, no-store, max-age=0` and `Vary: Cookie` on API responses. Confirm the deployed responses retain these headers and that your hosting/CDN settings do not override them with public caching. If cookies/custom headers or authenticated methods are not forwarded by the chosen hosting configuration, do not consider a passing health check sufficient; resolve the proxy behaviour before launch.

## Troubleshooting

| Result | Likely cause/action |
| --- | --- |
| HTML or the old JSON parsing error | API request matched a static SPA fallback. Fix rewrite order and redeploy the latest frontend. |
| 502/503 | API host/process is unavailable, TLS is invalid, or PostgreSQL startup failed. Check the Lightsail service journal and direct backend health. |
| `Invalid request origin` / 403 | Backend `APP_ORIGIN` does not exactly match the frontend origin, or the custom mutation header was not forwarded. |
| Code request succeeds but email never arrives | SES sender, region, SMTP credentials, sandbox recipient restrictions or suppression status. |
| Login succeeds but refresh signs out | Check cookie storage, secure HTTPS, cookie forwarding, response caching and that requests remain on the frontend origin. |
| Images fail | `/api/images/*` also needs the API rewrite, cookies and the backend's persistent uploaded files. |

## If you want the backend entirely on Amplify

That is a separate deployment adaptation. AWS supports Express through its compute deployment manifest, but uploading `dist` does not create that deployment. This implementation also writes images/logs and a local secret file, while Amplify compute has ephemeral storage with only `/tmp` writable. A production adaptation must move uploads to durable shared storage (such as S3), supply secrets appropriately, and configure the compute bundle/runtime and network access to PostgreSQL. The generated Auth/Data template is not a drop-in replacement for the app's custom OTP, PostgreSQL schema, voting rules or audit trail.

For the immediate fix, the HTTPS rewrite to the existing Lightsail API avoids that broader rewrite. Sources: [Amplify compute deployment specification and storage constraints](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-deployment-specification.html), [Express deployment example](https://docs.aws.amazon.com/amplify/latest/userguide/deploy-express-server.html).
