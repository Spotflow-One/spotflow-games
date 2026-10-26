import { useState } from "react";
import { Link } from "react-router";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  AVATAR_OPTIONS,
  DEFAULT_AVATAR,
  type AvatarConfig,
  type Me as MeType,
  type ThemePreference,
} from "@spotflow-games/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { usePreferences } from "../lib/preferences";
import { Avatar } from "../components/Avatar";

const LABELS: Record<keyof AvatarConfig, string> = {
  skin: "Skin tone",
  hairStyle: "Hair",
  hairColor: "Hair colour",
  eyes: "Eyes",
  mouth: "Mouth",
  shirt: "Top",
  accessory: "Accessory",
  background: "Background",
};

/** CSS variable holding the swatch colour for colour options. */
const SWATCH: Partial<Record<keyof AvatarConfig, (v: number) => string>> = {
  skin: (v) => `var(--skin-${v})`,
  hairColor: (v) => `var(--hair-${v})`,
  background: (v) => `var(--avatar-bg-${v})`,
  shirt: (v) => `var(--brush-${["blue", "green", "orange", "purple", "red"][v - 1]})`,
};

const pretty = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

export function Me() {
  const { me, setMe } = useAuth();
  const { theme, setTheme, soundEnabled, setSoundEnabled } = usePreferences();
  const [draft, setDraft] = useState<AvatarConfig>(me?.avatar ?? DEFAULT_AVATAR);
  const [name, setName] = useState(me?.displayName ?? "");
  const [status, setStatus] = useState<{ kind: "success" | "danger"; text: string } | null>(null);
  if (!me) return null;

  const saveAvatar = async () => {
    try {
      setMe(await api<MeType>("/api/me/avatar", { method: "PUT", body: draft }));
      setStatus({ kind: "success", text: "Avatar saved. It now shows everywhere you play." });
    } catch (err) {
      setStatus({ kind: "danger", text: (err as Error).message });
    }
  };
  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setMe(await api<MeType>("/api/me", { method: "PATCH", body: { displayName: name } }));
      setStatus({ kind: "success", text: "Display name saved." });
    } catch (err) {
      setStatus({ kind: "danger", text: (err as Error).message });
    }
  };

  return (
    <>
      <div className="sg-row" style={{ justifyContent: "space-between" }}>
        <h1 className="sg-h1">Your profile</h1>
        <Link className="link" to={`/profile/${me.id}`}>
          View public profile
        </Link>
      </div>
      {status && (
        <div className={`sg-banner ${status.kind}`} role="status">
          {status.text}
        </div>
      )}

      <section className="sg-card sg-stack" aria-labelledby="avatar-heading">
        <h2 id="avatar-heading" className="sg-h3">
          Avatar
        </h2>
        <div className="grid-2" style={{ alignItems: "start" }}>
          <div className="sg-stack" style={{ alignItems: "center" }}>
            <Avatar avatar={draft} name={`${me.displayName} avatar preview`} userId={me.id} size="xl" />
            <div className="sg-row">
              <button className="sg-btn" onClick={saveAvatar}>
                Save avatar
              </button>
              <button
                className="sg-btn ghost"
                onClick={() => {
                  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;
                  setDraft(
                    Object.fromEntries(
                      Object.entries(AVATAR_OPTIONS).map(([k, xs]) => [k, pick(xs as readonly unknown[])]),
                    ) as AvatarConfig,
                  );
                }}
              >
                Surprise me
              </button>
            </div>
          </div>
          <div className="builder-options">
            {(Object.keys(AVATAR_OPTIONS) as Array<keyof AvatarConfig>).map((key) => (
              <div key={key} className="sg-field">
                <label id={`opt-${key}`}>{LABELS[key]}</label>
                <div className="sg-seg" role="radiogroup" aria-labelledby={`opt-${key}`}>
                  {(AVATAR_OPTIONS[key] as readonly (string | number)[]).map((value, i) => {
                    const swatch = SWATCH[key];
                    const label = swatch ? `${LABELS[key]} ${i + 1}` : pretty(String(value));
                    return (
                      <button
                        key={String(value)}
                        role="radio"
                        aria-checked={draft[key] === value}
                        aria-label={label}
                        onClick={() => setDraft({ ...draft, [key]: value })}
                      >
                        {swatch ? (
                          <span className="color-chip" style={{ background: swatch(value as number) }} />
                        ) : (
                          label
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="grid-2">
        <form className="sg-card sg-stack" onSubmit={saveName}>
          <h2 className="sg-h3">Display name</h2>
          <div className="sg-field">
            <label htmlFor="display-name">Shown in lobbies and leaderboards</label>
            <input
              id="display-name"
              className="sg-input"
              maxLength={40}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <button className="sg-btn secondary" type="submit">
              Save name
            </button>
          </div>
          <p className="sg-muted" style={{ margin: 0 }}>
            Signed in as {me.email}
          </p>
        </form>

        <section className="sg-card sg-stack" aria-labelledby="prefs-heading">
          <h2 id="prefs-heading" className="sg-h3">
            Appearance and sound
          </h2>
          <div className="sg-field">
            <label id="theme-label">Theme</label>
            <div className="sg-seg" role="radiogroup" aria-labelledby="theme-label">
              {(
                [
                  ["system", "System", Monitor],
                  ["light", "Light", Sun],
                  ["dark", "Dark", Moon],
                ] as Array<[ThemePreference, string, typeof Sun]>
              ).map(([value, label, Icon]) => (
                <button key={value} role="radio" aria-checked={theme === value} onClick={() => setTheme(value)}>
                  <Icon aria-hidden="true" size={16} />
                  {label}
                </button>
              ))}
            </div>
          </div>
          <button
            className="sg-switch"
            role="switch"
            aria-checked={soundEnabled}
            onClick={() => setSoundEnabled(!soundEnabled)}
          >
            <span className="track" aria-hidden="true" />
            Sound effects {soundEnabled ? "on" : "off"}
          </button>
        </section>
      </div>
    </>
  );
}
