# KnobDeck app site

What the desktop app and plugins call, at https://app.knobdeck.harshalkudale.com. A plain Cloudflare
Worker with static assets, kept apart from the landing/payments site (`konbdeck-website`) so registry
updates never redeploy checkout or licensing.

| Path | What |
|---|---|
| `/plugins/registry.json` | Plugin registry (desktop app, website `/plugins`) |
| `/plugins/<id>/readme.md` | Plugin readmes, the registry's `readmeUrl` |
| `/themes/registry.json` | Dial theme registry |
| `POST /api/google/token` | OAuth token form (`authorization_code` with PKCE, or `refresh_token`) → Google tokens for the YouTube plugin; holds the client secret |

## Develop and deploy

```bash
npm install
cp .dev.vars.example .dev.vars   # local secrets
npm run dev
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

The Google OAuth client (Desktop app, id in `wrangler.jsonc`) is used only with
`http://127.0.0.1:47812/callback`.

## Registries

`.github/workflows/registries.yml` (run by hand) copies the latest `knobdeck-plugins` release's
`registry.json` and readmes to `public/plugins/` (`scripts/build-registry.mjs`) and the latest
`knobdeck-themes` release's `registry.json` to `public/themes/`, then commits; the push redeploys.
Bundles and theme zips stay on the GitHub Releases.

## App updates and downloads

Not here. The app's release files and update manifests are in R2 and served by the website
(`knobdeck-website`, `/updates/*` and `/download/*`). This site never touches R2.

## New domain

Add `app.knobdeck.xyz` to `routes` in `wrangler.jsonc` and keep this one: shipped apps and plugin builds
call it. Then change `SITE` in `knobdeck-plugins/scripts/registry.mjs`, `REGISTRY_*`/`THEMES_BASE` in
the app, `APP_SITE_URL` on the website, and the plugins repo's `KNOBDECK_*_TOKEN_URL` variables.
