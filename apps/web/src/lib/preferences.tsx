import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { ThemePreference } from "@spotflow-games/shared";
import { api } from "./api";
import { useAuth } from "./auth";

interface Preferences {
  theme: ThemePreference;
  setTheme: (t: ThemePreference) => void;
  soundEnabled: boolean;
  setSoundEnabled: (on: boolean) => void;
}

const PrefsContext = createContext<Preferences | null>(null);

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage can be unavailable in private windows */
  }
};

/** Theme and sound follow the signed-in profile, with a local copy for before sign-in. */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const { me, setMe } = useAuth();
  const [theme, setThemeState] = useState<ThemePreference>(() => (read("sg-theme") as ThemePreference) || "system");
  const [soundEnabled, setSoundState] = useState(() => read("sg-sound") === "on");

  useEffect(() => {
    if (!me) return;
    setThemeState(me.themePreference);
    setSoundState(me.soundEnabled);
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
    write("sg-theme", theme);
  }, [theme]);

  useEffect(() => write("sg-sound", soundEnabled ? "on" : "off"), [soundEnabled]);

  const save = useCallback(
    (patch: { themePreference?: ThemePreference; soundEnabled?: boolean }) => {
      if (me)
        api("/api/me", { method: "PATCH", body: patch }).then(
          (m) => setMe(m as never),
          () => {},
        );
    },
    [me, setMe],
  );

  const setTheme = (t: ThemePreference) => {
    setThemeState(t);
    save({ themePreference: t });
  };
  const setSoundEnabled = (on: boolean) => {
    setSoundState(on);
    save({ soundEnabled: on });
  };

  return (
    <PrefsContext.Provider value={{ theme, setTheme, soundEnabled, setSoundEnabled }}>{children}</PrefsContext.Provider>
  );
}

export function usePreferences() {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePreferences must be used inside PreferencesProvider");
  return ctx;
}
