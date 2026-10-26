import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";
import { checkIdentity, type IdentityCheck } from "./domain.js";

/** Google OpenID Connect with PKCE, state and nonce. Identity is decided by checkIdentity. */
export class GoogleAuth {
  constructor(private config: Config) {}

  get enabled() {
    return Boolean(this.config.GOOGLE_CLIENT_ID && this.config.GOOGLE_CLIENT_SECRET);
  }

  get redirectUri() {
    return new URL("/api/auth/google/callback", this.config.APP_URL).toString();
  }

  private client() {
    return new OAuth2Client({
      clientId: this.config.GOOGLE_CLIENT_ID,
      clientSecret: this.config.GOOGLE_CLIENT_SECRET,
      redirectUri: this.redirectUri,
    });
  }

  async authUrl(state: string, nonce: string) {
    const client = this.client();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const url = client.generateAuthUrl({
      scope: ["openid", "email", "profile"],
      state,
      nonce,
      // `hd` only filters Google's account picker; the server re-checks the domain.
      hd: this.config.ALLOWED_EMAIL_DOMAIN,
      prompt: "select_account",
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    return { url, codeVerifier };
  }

  async exchange(code: string, codeVerifier: string, expectedNonce: string): Promise<IdentityCheck> {
    const client = this.client();
    const { tokens } = await client.getToken({ code, codeVerifier });
    if (!tokens.id_token) return { ok: false, reason: "missing_claims" };
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.config.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload || payload.nonce !== expectedNonce) return { ok: false, reason: "missing_claims" };
    return checkIdentity(payload, this.config.ALLOWED_EMAIL_DOMAIN);
  }
}
