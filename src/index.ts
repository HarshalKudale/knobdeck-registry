// app.knobdeck.harshalkudale.com: what the desktop app and plugins call, kept apart from the
// landing/payments site so registry updates never redeploy checkout or licensing.
//   /plugins/registry.json, /plugins/<id>/readme.md, /themes/registry.json  static (public/)
//   POST /api/discord/token, POST /api/google/token                          OAuth secret holders
//   /updates/darwin/<arch>/<current version>   macOS updater (tauri-plugin-updater): 204 or the update
//   /updates/<os>/latest.json                  the offered release's update file: public/updates/<os>/latest.json
//                                              is a pointer {"version"} (committed by the app repo's release
//                                              workflow), resolved to R2 `releases/<version>/update-<os>.json`
//   /download/<version>/<file>                 release files (R2 `releases/<version>/<file>`), cached
//                                              at the edge and counted in Analytics Engine
//   /download/mac, /download/linux/<deb|rpm|arch>   302 to the offered version's file
// The release workflow in the (private) app repo uploads the files to R2 and commits the pointers here.

function json(body: unknown, status = 200, cache = "no-store") {
  return Response.json(body, { status, headers: { "Cache-Control": cache } });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname.startsWith("/updates/") || pathname.startsWith("/download/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
      const mac = pathname.match(/^\/updates\/darwin\/(aarch64|x86_64)\/([0-9][\w.+-]*)$/);
      if (mac) return macUpdate(env, ctx, mac[2]);
      const manifest = pathname.match(/^\/updates\/(darwin|linux|windows)\/latest\.json$/);
      if (manifest) {
        const m = await readManifest(env, ctx, manifest[1]);
        return m ? json(m, 200, "public, max-age=300") : new Response(null, { status: 204 });
      }
      const alias = pathname.match(/^\/download\/(mac|linux\/(deb|rpm|arch))$/);
      if (alias) return latestRedirect(env, ctx, url, alias[2] ?? "mac");
      const file = pathname.match(/^\/download\/(\d+\.\d+\.\d+)\/([\w.+-]+)$/);
      if (file) return download(request, env, ctx, file[1], file[2]);
      return json({ error: "not found" }, 404);
    }
    if (pathname === "/api/discord/token" || pathname === "/api/google/token") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      return pathname === "/api/discord/token" ? discordToken(request, env) : googleToken(request, env);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

/** `1.10.0` > `1.9.9`. Pre-release and build suffixes are ignored. */
function newer(candidate: string, current: string) {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((p) => parseInt(p, 10) || 0);
  const [a, b] = [parts(candidate), parts(current)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

type Manifest = Record<string, unknown> & { version?: string };

/**
 * The offered release's update file. `public/updates/<os>/latest.json` (static, in this repo) names
 * the version; its `releases/<version>/update-<os>.json` comes from R2, cached at the edge for 5
 * minutes so app polls don't each cost an R2 read. No pointer, or a broken one, is null (= nothing
 * to offer).
 */
async function readManifest(env: Env, ctx: ExecutionContext, os: string): Promise<Manifest | null> {
  const ptr = await env.ASSETS.fetch(new Request(`https://assets.local/updates/${os}/latest.json`));
  if (!ptr.ok) return null;
  const version = ((await ptr.json().catch(() => null)) as { version?: unknown } | null)?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const key = new Request(`https://manifest.internal/${version}/${os}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  let text: string;
  if (hit) {
    text = await hit.text();
  } else {
    const obj = await env.RELEASES.get(`releases/${version}/update-${os}.json`);
    text = obj ? await obj.text() : "null";
    ctx.waitUntil(cache.put(key, new Response(text, { headers: { "Cache-Control": "public, max-age=300" } })));
  }
  try {
    const m = JSON.parse(text) as Manifest | null;
    return m && m.version === version ? m : null;
  } catch {
    return null;
  }
}

/**
 * The macOS app asks here (tauri.macos.conf.json): `{version, notes, pub_date, url, signature}`
 * (one universal build serves both architectures). Tauri expects 204 when there is nothing newer.
 */
async function macUpdate(env: Env, ctx: ExecutionContext, current: string) {
  const latest = await readManifest(env, ctx, "darwin");
  const version = latest?.version ?? "";
  if (!version || typeof latest?.url !== "string" || typeof latest?.signature !== "string" || !newer(version, current)) {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  return json({ version, notes: latest.notes ?? "", pub_date: latest.pub_date, url: latest.url, signature: latest.signature });
}

/** `/download/mac` (the website's button) and `/download/linux/<kind>`: 302 to the offered version. */
async function latestRedirect(env: Env, ctx: ExecutionContext, url: URL, kind: string) {
  const m = await readManifest(env, ctx, kind === "mac" ? "darwin" : "linux");
  const target = kind === "mac"
    ? (m?.dmg as string | undefined)
    : ((m?.packages as Record<string, { url?: string }> | undefined)?.[kind]?.url);
  if (!target) return json({ error: "no release yet" }, 404);
  return Response.redirect(new URL(target, url.origin).toString(), 302);
}

const CONTENT_TYPES: [RegExp, string][] = [
  [/\.dmg$/, "application/x-apple-diskimage"],
  [/\.deb$/, "application/vnd.debian.binary-package"],
  [/\.rpm$/, "application/x-rpm"],
  [/\.(tar\.gz|tgz)$/, "application/gzip"],
  [/\.zst$/, "application/zstd"],
  [/\.(sig|json)$/, "text/plain; charset=utf-8"],
];

/**
 * A release file from R2. Versioned paths never change, so they're cached at the edge for a year
 * (a cache hit costs no R2 read). Every GET that starts at byte 0 is counted, cached or not; resumed
 * range requests aren't, so one download counts once.
 */
async function download(request: Request, env: Env, ctx: ExecutionContext, version: string, name: string) {
  const range = request.headers.get("Range");
  const count = () => {
    if (request.method !== "GET" || (range && !/^bytes=0-/.test(range)) || name.endsWith(".sig")) return;
    const cf = request.cf as { country?: string } | undefined;
    // Analytics Engine: query by blob1 (file), blob2 (version); see README "Download counts".
    env.DOWNLOADS?.writeDataPoint({
      blobs: [name, version, cf?.country ?? "", request.headers.get("User-Agent")?.slice(0, 120) ?? ""],
      doubles: [1],
      indexes: [version],
    });
  };
  const cacheKey = new Request(new URL(`/download/${version}/${name}`, request.url), { headers: range ? { Range: range } : {} });
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) {
    count();
    return hit;
  }

  const key = `releases/${version}/${name}`;
  const obj = range ? await env.RELEASES.get(key, { range: request.headers }) : await env.RELEASES.get(key);
  if (!obj) return json({ error: "not found" }, 404);
  count();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", CONTENT_TYPES.find(([re]) => re.test(name))?.[1] ?? "application/octet-stream");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  if (!/\.(sig|json)$/.test(name)) headers.set("Content-Disposition", `attachment; filename="${name}"`);
  const body = request.method === "HEAD" ? null : (obj as R2ObjectBody).body;

  if (range && obj.range) {
    const r = obj.range as { offset?: number; length?: number; suffix?: number };
    const offset = r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0);
    const length = r.length ?? obj.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return new Response(body, { status: 206, headers });
  }
  headers.set("Content-Length", String(obj.size));
  const res = new Response(body, { headers });
  if (request.method === "GET") ctx.waitUntil(cache.put(new Request(cacheKey.url), res.clone()));
  return res;
}

const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
// Must match the redirect URI registered on the Discord application.
const DISCORD_REDIRECT_URI = "http://127.0.0.1:31416/callback";
const MAX_TOKEN_LENGTH = 256;


const isToken = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_TOKEN_LENGTH && /^[\w-]+$/.test(v);

async function discordToken(request: Request, env: Env) {
  const clientId = env.DISCORD_CLIENT_ID?.trim();
  // Trimmed: a secret pasted with a trailing newline makes Discord answer `invalid_client`.
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return json({ error: "Discord token exchange is not configured" }, 503);
  }

  // `{ code }` from first-time setup, or `{ refresh_token }` to renew an expiring token.
  let body: { code?: unknown; refresh_token?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "expected a JSON body" }, 400);
  }
  let grant: Record<string, string>;
  if (isToken(body?.code)) {
    grant = { code: body.code, grant_type: "authorization_code", redirect_uri: DISCORD_REDIRECT_URI };
  } else if (isToken(body?.refresh_token)) {
    grant = { refresh_token: body.refresh_token, grant_type: "refresh_token" };
  } else {
    return json({ error: "expected a code or refresh_token" }, 400);
  }

  const res = await fetch(DISCORD_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...grant }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    // Discord's error code (e.g. `invalid_client` = wrong secret) is safe to pass on and tells setup what broke.
    const reason =
      typeof data.error_description === "string"
        ? data.error_description
        : `Discord rejected the request (${typeof data.error === "string" ? data.error : `HTTP ${res.status}`})`;
    return json({ error: reason }, 502);
  }
  // Only what the plugin needs; never echo the secret or Discord's raw body.
  return json({ access_token: data.access_token, expires_in: data.expires_in, refresh_token: data.refresh_token });
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// The only redirect the YouTube plugin's setup uses; pinning it keeps this route from serving
// as a general token proxy for the KnobDeck Google app.
const GOOGLE_REDIRECT_URI = "http://127.0.0.1:47812/callback";
const MAX_GOOGLE_LENGTH = 2048;


// Google codes and refresh tokens contain "/" and "." (e.g. "4/0Ab…", "1//0g…").
const isGoogleToken = (v: string | null): v is string =>
  !!v && v.length <= MAX_GOOGLE_LENGTH && /^[\w\-./~+]+$/.test(v);
// RFC 7636: 43–128 unreserved characters.
const isVerifier = (v: string | null): v is string => !!v && /^[A-Za-z0-9\-._~]{43,128}$/.test(v);

async function googleToken(request: Request, env: Env) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  // Trimmed: a secret pasted with a trailing newline makes Google answer `invalid_client`.
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return json({ error: "Google token exchange is not configured" }, 503);
  }

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
  } catch {
    return json({ error: "expected a form body" }, 400);
  }

  // The plugin's own client_id field is ignored: the secret only fits the configured app.
  let grant: Record<string, string>;
  const type = form.get("grant_type");
  if (type === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (!isGoogleToken(code) || !isVerifier(verifier) || form.get("redirect_uri") !== GOOGLE_REDIRECT_URI) {
      return json({ error: "invalid_request" }, 400);
    }
    grant = { grant_type: type, code, code_verifier: verifier, redirect_uri: GOOGLE_REDIRECT_URI };
  } else if (type === "refresh_token") {
    const refresh = form.get("refresh_token");
    if (!isGoogleToken(refresh)) return json({ error: "invalid_request" }, 400);
    grant = { grant_type: type, refresh_token: refresh };
  } else {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...grant }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== "string") {
    // Google's 4xx (e.g. 400 invalid_grant for a revoked sign-in) is passed on with its error code,
    // so the plugin asks the user to sign in again. invalid_client is this site's misconfiguration
    // (wrong id/secret), not the user's, so it is a gateway failure like any other.
    const error = typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    const userFault = res.status >= 400 && res.status < 500 && error !== "invalid_client";
    return json({ error, error_description: data.error_description }, userFault ? res.status : 502);
  }
  // Only what the plugin needs; never echo the secret or Google's raw body.
  return json({
    access_token: data.access_token,
    expires_in: data.expires_in,
    refresh_token: data.refresh_token,
    scope: data.scope,
    token_type: data.token_type,
  });
}
