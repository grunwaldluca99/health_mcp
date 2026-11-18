import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Bindings, vars and secrets this Worker gets from Cloudflare (see wrangler.jsonc). */
export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers; // injected by OAuthProvider into the default handler
  MCP_RESOURCE: string;
  ALLOWED_EMAIL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GARMIN_API_KEY: string;
  CONSENT_SECRET: string;
}

/**
 * What we store (encrypted) with each MCP grant, and get back on every tool call.
 * This is how a tool knows which Google token to use.
 */
export interface Props extends Record<string, unknown> {
  email: string;
  googleRefreshToken: string;
  googleAccessToken: string;
  googleExpiresAt: number; // epoch ms
}
