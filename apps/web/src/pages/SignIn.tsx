import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Wordmark } from "../components/Wordmark";

const ERRORS: Record<string, string> = {
  wrong_domain: "Only Spotflow Google accounts can sign in. Switch to your spotflow.one account and try again.",
  email_not_verified: "Your Google email isn't verified yet. Verify it with Google, then sign in again.",
  deactivated: "This account has been deactivated. Contact a platform admin if that's a mistake.",
  expired: "The sign-in took too long. Try again.",
  cancelled: "Sign-in was cancelled.",
  google: "Google sign-in failed. Try again in a moment.",
  missing_claims: "Google didn't share the details we need. Try again.",
};

export function SignIn() {
  const { me, refresh } = useAuth();
  const [params] = useSearchParams();
  const [config, setConfig] = useState<{ google: boolean; devLogin: boolean; domain: string } | null>(null);
  const [devEmail, setDevEmail] = useState("");
  const [error, setError] = useState(ERRORS[params.get("error") ?? ""] ?? null);
  const returnTo = params.get("returnTo") ?? "/";

  useEffect(() => {
    api<{ google: boolean; devLogin: boolean; domain: string }>("/api/auth/config").then(setConfig, () => {});
  }, []);

  if (me) return <Navigate to={returnTo} replace />;

  return (
    <div className="center-page">
      <div className="sg-card sg-stack signin-card">
        <span className="sg-wordmark">
          <Wordmark />
        </span>
        <h1 className="sg-h2">Game night with the team</h1>
        <p className="sg-muted" style={{ margin: 0 }}>
          Sign in with your Spotflow Google account to host or join a game.
        </p>
        {error && (
          <div className="sg-banner danger" role="alert">
            <span className="ic">
              <TriangleAlert aria-hidden="true" />
            </span>
            <span>{error}</span>
          </div>
        )}
        {config?.google && (
          <a className="sg-btn lg" href={`/api/auth/google?returnTo=${encodeURIComponent(returnTo)}`}>
            Sign in with Google
          </a>
        )}
        {config && !config.google && !config.devLogin && (
          <p className="sg-muted">Google sign-in isn't configured on this server yet.</p>
        )}
        {config?.devLogin && (
          <form
            className="sg-stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                await api("/api/auth/dev-login", { method: "POST", body: { email: devEmail } });
                await refresh();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <div className="sg-field">
              <label htmlFor="dev-email">Developer sign-in (local only)</label>
              <input
                id="dev-email"
                className="sg-input"
                type="email"
                required
                placeholder={`you@${config.domain}`}
                value={devEmail}
                onChange={(e) => setDevEmail(e.target.value)}
              />
            </div>
            <button className="sg-btn secondary" type="submit">
              Sign in without Google
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
