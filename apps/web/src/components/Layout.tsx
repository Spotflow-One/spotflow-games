import { Link, Outlet, useNavigate } from "react-router";
import { LogOut, Monitor, Moon, Sun, Volume2, VolumeX } from "lucide-react";
import type { ThemePreference } from "@spotflow-games/shared";
import { useAuth } from "../lib/auth";
import { usePreferences } from "../lib/preferences";
import { closeSocket } from "../lib/socket";
import { Avatar } from "./Avatar";

const NEXT_THEME: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };

export function Layout() {
  const { me, signOut } = useAuth();
  const { theme, setTheme, soundEnabled, setSoundEnabled } = usePreferences();
  const navigate = useNavigate();
  const ThemeIcon = THEME_ICON[theme];

  return (
    <div className="sg-screen">
      <header className="sg-appbar app-appbar">
        <Link to="/" className="sg-wordmark">
          Spotflow <em>Games</em>
        </Link>
        <span className="grow" />
        <button
          className="sg-btn ghost sm"
          aria-label={soundEnabled ? "Sound on. Turn sound off" : "Sound off. Turn sound on"}
          title={soundEnabled ? "Sound on" : "Sound off"}
          onClick={() => setSoundEnabled(!soundEnabled)}
        >
          {soundEnabled ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}
        </button>
        <button
          className="sg-btn ghost sm"
          aria-label={`Theme: ${theme}. Switch to ${NEXT_THEME[theme]}`}
          title={`Theme: ${theme}`}
          onClick={() => setTheme(NEXT_THEME[theme])}
        >
          <ThemeIcon aria-hidden="true" />
        </button>
        {me && (
          <>
            <Link to="/me" aria-label="Your profile and avatar">
              <Avatar avatar={me.avatar} name={me.displayName} userId={me.id} size="sm" />
            </Link>
            <button
              className="sg-btn ghost sm"
              aria-label="Sign out"
              title="Sign out"
              onClick={async () => {
                closeSocket();
                await signOut();
                navigate("/signin");
              }}
            >
              <LogOut aria-hidden="true" />
            </button>
          </>
        )}
      </header>
      <main className="sg-stage app-main">
        <Outlet />
      </main>
    </div>
  );
}
