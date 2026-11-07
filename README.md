# KnobDeck app site

What the desktop app and plugins call, at https://app.knobdeck.harshalkudale.com. A plain Cloudflare
Worker with static assets, kept apart from the landing/payments site (`konbdeck-website`) so registry
updates never redeploy checkout or licensing.

| Path | What |
|---|---|
| `/plugins/registry.json` | Plugin registry (desktop app, website `/plugins`) |
| `/plugins/<id>/readme.md` | Plugin readmes, the registry's `readmeUrl` |
| `/themes/registry.json` | Dial theme registry |
| `/updates/darwin/<arch>/<version>` | macOS in-app updater (`tauri-plugin-updater`): 204 when `<version>` is current, else the offered release's update file |
| `/updates/<linux\|darwin>/latest.json` | The offered release's `update-<os>.json` (Linux: `packages.{deb,rpm,arch}` with sha256) |
| `/download/<version>/<file>` | App release files from R2, cached at the edge, each download counted |
| `/download/mac`, `/download/linux/<deb\|rpm\|arch>` | 302 to the offered version's file (the website's download button) |
| `POST /api/discord/token` | `{ code }` or `{ refresh_token }` → Discord tokens for the Discord plugin; holds the client secret |
| `POST /api/google/token` | OAuth token form (`authorization_code` with PKCE, or `refresh_token`) → Google tokens for the YouTube plugin; holds the client secret |

## Develop and deploy

```bash
npm install
cp .dev.vars.example .dev.vars   # local secrets
npm run dev
npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

The Discord application needs `http://127.0.0.1:31416/callback` as a redirect URI. The Google OAuth
client (Desktop app, id in `wrangler.jsonc`) is used only with `http://127.0.0.1:47812/callback`.

## Registries

`.github/workflows/registries.yml` (run by hand) copies the latest `knobdeck-plugins` release's
`registry.json` and readmes to `public/plugins/` (`scripts/build-registry.mjs`) and the latest
`knobdeck-themes` release's `registry.json` to `public/themes/`, then commits; the push redeploys.
Bundles and theme zips stay on the GitHub Releases.

## App releases and updates

Plugins, themes and the SDK stay on their public GitHub releases. Only the app (private repo) is
served from here, out of the R2 bucket `knobdeck-releases` (binding `RELEASES`):

- **GitHub release** (private): every release's files and its `update-<os>.json`. The full history.
- **R2 `releases/<version>/`:** the newest 5 releases' files and `update-<os>.json`, uploaded by the
  app repo's `release.yml` (`scripts/publish-r2.mjs`). Older ones are pruned, never an offered one.
- **This repo, `public/updates/<os>/latest.json`:** `{"version": "1.0.3"}`, a pointer. The worker
  reads it and serves R2's `releases/1.0.3/update-<os>.json` (cached 5 minutes). `release.yml`
  commits it when a release is offered; the push deploys.

**Roll back:** run the app repo's `offer.yml` with the older version, or edit the pointer here and
commit. The version must still be in R2. No pointer, or a version missing from R2, means "nothing
new" (204), never an error in the app.

The bucket must exist before this deploys: `npx wrangler r2 bucket create knobdeck-releases`.

### Download counts

Each download that starts at byte 0 (cached or not; `.sig` files excluded) writes one Analytics
Engine point to the `knobdeck_downloads` dataset: blob1 file, blob2 version, blob3 country, blob4
user agent. The in-app macOS updater's fetch of `KnobDeck.app.tar.gz` counts as an update; the dmg,
deb, rpm and pkg count as installs from the website. Query with an API token that has Account
Analytics: Read:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $TOKEN" --data "
    SELECT blob2 AS version, blob1 AS file, SUM(_sample_interval) AS downloads
    FROM knobdeck_downloads WHERE timestamp > NOW() - INTERVAL '30' DAY
    GROUP BY version, file ORDER BY version DESC"
```

Points are kept for 3 months; export them if you want a longer history.

### Guard rails

- R2 has no spending cap. Set **Billing → Billable Usage → budget alerts** ($1 and $5) and an R2
  storage usage notification at 5 GB.
- Files are served through this Worker, so the bucket needs no public access: keep the `r2.dev`
  URL off and add no custom domain to the bucket.
- One rate-limiting rule (free plan) on `app.knobdeck.harshalkudale.com/download/*`, e.g. 20
  requests per minute per IP.
- The CI token is an R2 API token with Object Read & Write on this one bucket only.
- Add a lifecycle rule that aborts incomplete multipart uploads after 1 day.

## New domain

Add `app.knobdeck.xyz` to `routes` in `wrangler.jsonc` and keep this one: shipped apps and plugin builds
call it. Then change `SITE` in `knobdeck-plugins/scripts/registry.mjs`, `REGISTRY_*`/`THEMES_BASE` in
the app, `APP_SITE_URL` on the website, and the plugins repo's `KNOBDECK_*_TOKEN_URL` variables.
