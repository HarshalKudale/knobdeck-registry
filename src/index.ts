// app.knobdeck.harshalkudale.com: what the desktop app and plugins call, kept apart from the
// landing/payments site so registry updates never redeploy checkout or licensing.
//   /plugins/registry.json, /plugins/<id>/readme.md, /themes/registry.json  static (public/)
//   POST /api/google/token                                                     OAuth secret holder
// (The Discord plugin signs in with PKCE straight against Discord: its app is a public client.)

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/google/token") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      return googleToken(request, env);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

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
