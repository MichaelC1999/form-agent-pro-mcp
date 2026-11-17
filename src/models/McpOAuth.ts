import { Schema, model } from "mongoose";

/**
 * Storage for the built-in MCP OAuth 2.1 authorization server.
 * Every record except registered clients expires through a MongoDB TTL index
 * on `expiresAt`. Tokens and codes are stored as SHA-256 hashes, never raw.
 */

// ─── Dynamically registered OAuth clients (RFC 7591) ─────────────────────────
// `info` is the full OAuthClientInformationFull object from the MCP SDK.
const McpOAuthClientSchema = new Schema(
  {
    clientId: { type: String, required: true, unique: true },
    info: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);
export const McpOAuthClient = model("McpOAuthClient", McpOAuthClientSchema);

// ─── Authorizations waiting on the Google sign-in round trip ─────────────────
// Keyed by the random `state` value sent to Google.
const McpPendingAuthSchema = new Schema(
  {
    stateHash: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    clientState: { type: String },
    scopes: { type: [String], default: [] },
    resource: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);
McpPendingAuthSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const McpPendingAuth = model("McpPendingAuth", McpPendingAuthSchema);

// ─── Single-use authorization codes issued after Google sign-in ──────────────
const McpAuthCodeSchema = new Schema(
  {
    codeHash: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    scopes: { type: [String], default: [] },
    resource: { type: String },
    /** Google `sub` — the same userId the web app stores on every record. */
    userId: { type: String, required: true },
    email: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);
McpAuthCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const McpAuthCode = model("McpAuthCode", McpAuthCodeSchema);

// ─── Access and refresh tokens ───────────────────────────────────────────────
const McpTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["access", "refresh"], required: true },
    clientId: { type: String, required: true },
    scopes: { type: [String], default: [] },
    resource: { type: String },
    userId: { type: String, required: true, index: true },
    email: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);
McpTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const McpToken = model("McpToken", McpTokenSchema);
