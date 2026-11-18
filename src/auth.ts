import {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./env";
import { GOOGLE_AUTH_URL, GOOGLE_SCOPES, emailFromIdToken, exchangeCode } from "./google";

/**
 * The login flow, in plain words:
 * 1. Claude opens /authorize. We show "Allow <client> to access your health data?".
 * 2. You click Allow. We send you to Google with the health scopes.
 * 3. Google sends you back to /callback with a code. We swap it for Google tokens,
 *    check the email is ALLOWED_EMAIL, and hand Claude its own MCP token.
 * The Google tokens live encrypted inside that grant (props), never in the browser.
 */
export const AuthHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize" && request.method === "GET") return await showConsent(request, env);
      if (url.pathname === "/authorize" && request.method === "POST") return await approve(request, env);
      if (url.pathname === "/callback") return await callback(request, env);
      if (url.pathname === "/") return text("Personal health MCP server for one person. Connect at /mcp.");
      if (url.pathname === "/privacy") return text(PRIVACY);
      return text("Not found", 404);
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError) return text(error.description ?? "Authorization failed", 400);
      if (error instanceof CimdFetchError) return text("This app could not be verified.", 400);
      throw error;
    }
  },
};

const PRIVACY = `Privacy policy - health-mcp
This is a private server used by a single person (its owner) to let their own AI assistant read their own health data.
Data from Google Health and Garmin is fetched on request and passed to the owner's AI assistant. It is not stored, sold or shared with anyone else.
Google OAuth tokens are stored encrypted on Cloudflare only to keep the connection alive, and can be revoked at any time at https://myaccount.google.com/permissions.
Google user data use complies with the Google API Services User Data Policy, including the Limited Use requirements.`;

const remember = (env: Env) => ({ secret: env.CONSENT_SECRET });

async function showConsent(request: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  if (await oauth.isConsentRemembered(request, authRequest, remember(env))) {
    return redirectToGoogle(request, env, authRequest, new Headers());
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function approve(request: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER;
  const form = await request.formData();
  const handle = String(form.get("handle"));
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle, { remember: remember(env) });
  return redirectToGoogle(request, env, approved.request, approved.headers);
}

async function redirectToGoogle(request: Request, env: Env, authRequest: Parameters<Env["OAUTH_PROVIDER"]["beginUpstream"]>[0], headers: Headers) {
  // PKCE: we keep the verifier server-side, Google only sees its hash.
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers: out } = await env.OAUTH_PROVIDER.beginUpstream(authRequest, { data: { verifier }, headers });
  const google = new URL(GOOGLE_AUTH_URL);
  google.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: new URL("/callback", request.url).href,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline", // we need a refresh token
    prompt: "consent", // Google only returns a refresh token on consent
    login_hint: env.ALLOWED_EMAIL,
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
  }).toString();
  out.set("Location", google.href);
  return new Response(null, { status: 302, headers: out });
}

async function callback(request: Request, env: Env) {
  const oauth = env.OAUTH_PROVIDER;
  const url = new URL(request.url);
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
  if (url.searchParams.get("error")) {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const tokens = await exchangeCode(env, url.searchParams.get("code") ?? "", data.verifier, new URL("/callback", request.url).href);
  if (!tokens.id_token || !tokens.refresh_token) return text("Google did not return the expected tokens. Try again.", 400);
  const { email, verified } = emailFromIdToken(tokens.id_token);
  if (!verified || email !== env.ALLOWED_EMAIL.toLowerCase()) return text("This server is private.", 403);

  const props: Props = {
    email,
    googleRefreshToken: tokens.refresh_token,
    googleAccessToken: tokens.access_token,
    googleExpiresAt: Date.now() + tokens.expires_in * 1000,
  };
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: email,
    metadata: { label: email },
    scope: original.scope,
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}

async function s256(input: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const text = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

function consentPage(d: ConsentDescription, handle: string) {
  const name = escape(d.clientName);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Allow ${name}?</title>
<body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem">
<h1>Allow ${name} to read your health data?</h1>
<p>${d.clientDomain ? `Published by <strong>${escape(d.clientDomain)}</strong>.` : "This app registered itself; its name is not verified."}
Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<p>Next you'll sign in with Google.</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form>`;
}
