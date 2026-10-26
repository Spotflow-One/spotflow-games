/**
 * The single place that decides whether a Google identity may use Spotflow Games.
 * Checks the verified email, its domain, and the Google Workspace `hd` claim.
 */
export interface GoogleIdentityClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
}

export type IdentityCheck =
  | { ok: true; sub: string; email: string; name: string }
  | { ok: false; reason: "missing_claims" | "email_not_verified" | "wrong_domain" };

export function checkIdentity(claims: GoogleIdentityClaims, allowedDomain: string): IdentityCheck {
  const domain = allowedDomain.toLowerCase();
  if (!claims.sub || !claims.email) return { ok: false, reason: "missing_claims" };
  if (claims.email_verified !== true) return { ok: false, reason: "email_not_verified" };
  const email = claims.email.toLowerCase();
  const emailDomain = email.slice(email.lastIndexOf("@") + 1);
  if (emailDomain !== domain || claims.hd?.toLowerCase() !== domain) {
    return { ok: false, reason: "wrong_domain" };
  }
  const name = claims.name?.trim() || email.slice(0, email.indexOf("@"));
  return { ok: true, sub: claims.sub, email, name };
}
