import { createHash, randomBytes } from "crypto";
import { Router, Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { McpOAuthClient, McpPendingAuth, McpAuthCode, McpToken } from "../models/McpOAuth";

/**
 * Built-in OAuth 2.1 authorization server for the MCP endpoint.
 *
 * MCP clients register themselves (dynamic client registration), then send
 * the user here to sign in. We don't ask for passwords: the user signs in
 * with Google, and we issue our own tokens tied to their Google `sub` — the
 * same userId the web app uses — so web and MCP records line up.
 *
 * Flow: client → /authorize → Google sign-in → /oauth/google/callback →
 * our auth code back to the client → /token (PKCE checked by the SDK).
 */

const PENDING_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 5 * 60_000;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;

export const MCP_SCOPE = "mcp";
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";

const newSecret = () => randomBytes(32).toString("base64url");
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Public origin of this server, e.g. https://immi-server-i5sok.ondigitalocean.app */
export function publicBaseUrl(): URL {
  return new URL(process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? "3001"}`);
}

function googleClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set for MCP sign-in");
  }
  return new OAuth2Client(clientId, clientSecret, new URL(GOOGLE_CALLBACK_PATH, publicBaseUrl()).toString());
}

// ─── Client registration store ───────────────────────────────────────────────

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const doc = await McpOAuthClient.findOne({ clientId }).lean();
    return (doc?.info as OAuthClientInformationFull | undefined) ?? undefined;
  },
  async registerClient(client) {
    // The SDK fills in client_id / client_id_issued_at before calling this.
    const info = client as OAuthClientInformationFull;
    await McpOAuthClient.create({ clientId: info.client_id, info });
    return info;
  },
};

// ─── Token issuing ───────────────────────────────────────────────────────────

async function issueTokens(params: {
  clientId: string;
  userId: string;
  email?: string;
  scopes: string[];
  resource?: string;
}): Promise<OAuthTokens> {
  const access = newSecret();
  const refresh = newSecret();
  const now = Date.now();
  const base = {
    clientId: params.clientId,
    userId: params.userId,
    email: params.email,
    scopes: params.scopes,
    resource: params.resource,
  };
  await McpToken.create([
    { ...base, tokenHash: sha256(access), kind: "access", expiresAt: new Date(now + ACCESS_TTL_S * 1000) },
    { ...base, tokenHash: sha256(refresh), kind: "refresh", expiresAt: new Date(now + REFRESH_TTL_S * 1000) },
  ]);
  return {
    access_token: access,
    token_type: "bearer",
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: params.scopes.join(" "),
  };
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const mcpOAuthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const state = newSecret();
    await McpPendingAuth.create({
      stateHash: sha256(state),
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      clientState: params.state,
      scopes: params.scopes?.length ? params.scopes : [MCP_SCOPE],
      resource: params.resource?.toString(),
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });
    const url = googleClient().generateAuthUrl({
      scope: ["openid", "email", "profile"],
      state,
      prompt: "select_account",
    });
    res.redirect(url);
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const doc = await McpAuthCode.findOne({ codeHash: sha256(authorizationCode) }).lean();
    if (!doc || doc.clientId !== client.client_id || doc.expiresAt.getTime() < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return doc.codeChallenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    // Single use: delete on read, so a replayed code fails.
    const doc = await McpAuthCode.findOneAndDelete({ codeHash: sha256(authorizationCode) }).lean();
    if (!doc || doc.clientId !== client.client_id || doc.expiresAt.getTime() < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (redirectUri && redirectUri !== doc.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && doc.resource && resource.toString() !== doc.resource) {
      throw new InvalidGrantError("resource does not match the authorization request");
    }
    return issueTokens({
      clientId: client.client_id,
      userId: doc.userId,
      email: doc.email ?? undefined,
      scopes: doc.scopes,
      resource: doc.resource ?? undefined,
    });
  },

  async exchangeRefreshToken(client, refreshToken, scopes) {
    // Rotate: the old refresh token is consumed.
    const doc = await McpToken.findOneAndDelete({ tokenHash: sha256(refreshToken), kind: "refresh" }).lean();
    if (!doc || doc.clientId !== client.client_id || doc.expiresAt.getTime() < Date.now()) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    const granted = scopes?.length ? scopes.filter((s) => doc.scopes.includes(s)) : doc.scopes;
    return issueTokens({
      clientId: client.client_id,
      userId: doc.userId,
      email: doc.email ?? undefined,
      scopes: granted,
      resource: doc.resource ?? undefined,
    });
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const doc = await McpToken.findOne({ tokenHash: sha256(token), kind: "access" }).lean();
    if (!doc || doc.expiresAt.getTime() < Date.now()) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: doc.clientId,
      scopes: doc.scopes,
      expiresAt: Math.floor(doc.expiresAt.getTime() / 1000),
      resource: doc.resource ? new URL(doc.resource) : undefined,
      extra: { userId: doc.userId, email: doc.email },
    };
  },

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    await McpToken.deleteOne({ tokenHash: sha256(request.token), clientId: client.client_id });
  },
};

// ─── Google sign-in callback ─────────────────────────────────────────────────

export const googleCallbackRouter = Router();

googleCallbackRouter.get(GOOGLE_CALLBACK_PATH, async (req: Request, res: Response) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";

  const pending = state ? await McpPendingAuth.findOneAndDelete({ stateHash: sha256(state) }).lean() : null;
  if (!pending || pending.expiresAt.getTime() < Date.now()) {
    res.status(400).send("This sign-in link has expired. Please start again from your AI app.");
    return;
  }

  const back = new URL(pending.redirectUri);
  if (pending.clientState) back.searchParams.set("state", pending.clientState);

  if (!code) {
    // User cancelled at Google, or Google returned an error.
    back.searchParams.set("error", "access_denied");
    res.redirect(back.toString());
    return;
  }

  try {
    const google = googleClient();
    const { tokens } = await google.getToken(code);
    const ticket = await google.verifyIdToken({
      idToken: tokens.id_token ?? "",
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) throw new Error("Google ID token has no sub");

    const ourCode = newSecret();
    await McpAuthCode.create({
      codeHash: sha256(ourCode),
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: pending.scopes,
      resource: pending.resource,
      userId: payload.sub,
      // Only keep emails Google has verified: they gate admin/test-mode checks.
      email: payload.email_verified ? payload.email : undefined,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    console.log(`[mcp-oauth] Signed in user=${payload.sub} for client=${pending.clientId}`);

    back.searchParams.set("code", ourCode);
    res.redirect(back.toString());
  } catch (err) {
    console.error("[mcp-oauth] Google callback failed:", err);
    back.searchParams.set("error", "server_error");
    res.redirect(back.toString());
  }
});
