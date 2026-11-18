import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env as workerEnv } from "cloudflare:workers";
import { AuthHandler } from "./auth";
import type { Env, Props } from "./env";
import { GoogleAuthRevoked, refreshGoogle } from "./google";
import { createServer } from "./tools";

// Stateless MCP endpoint: every request builds a fresh server (no Durable Objects needed).
const mcpHandler = createMcpHandler(createServer);

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return mcpHandler(request, env, ctx);
    },
  },
  defaultHandler: AuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  resourceMetadata: { resource: (workerEnv as unknown as Env).MCP_RESOURCE },
  // MCP token lives a bit shorter than Google's 1h token, so each MCP refresh also refreshes Google.
  accessTokenTTL: 3000,
  async tokenExchangeCallback({ grantType, props, env }) {
    if (grantType !== "refresh_token") return;
    const p = props as Props;
    try {
      const t = await refreshGoogle(env as Env, p.googleRefreshToken);
      const newProps: Props = {
        ...p,
        googleAccessToken: t.access_token,
        googleExpiresAt: Date.now() + t.expires_in * 1000,
        googleRefreshToken: t.refresh_token ?? p.googleRefreshToken,
      };
      return { newProps };
    } catch (e) {
      if (e instanceof GoogleAuthRevoked) throw new OAuthError("invalid_grant", { description: "Google access was revoked or expired. Reconnect." });
      throw new OAuthError("temporarily_unavailable", { description: "Google token refresh failed", statusCode: 503 });
    }
  },
});
