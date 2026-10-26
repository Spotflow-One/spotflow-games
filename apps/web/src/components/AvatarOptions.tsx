import { AVATAR_OPTIONS, type AvatarConfig } from "@spotflow-games/shared";

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

/** A random avatar, for "Surprise me". */
export function randomAvatar(): AvatarConfig {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]!;
  return Object.fromEntries(
    Object.entries(AVATAR_OPTIONS).map(([k, xs]) => [k, pick(xs as readonly unknown[])]),
  ) as AvatarConfig;
}

/** The avatar options, one row of choices per feature. */
export function AvatarOptions({
  value: current,
  onChange,
}: {
  value: AvatarConfig;
  onChange: (v: AvatarConfig) => void;
}) {
  return (
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
                  type="button"
                  role="radio"
                  aria-checked={current[key] === value}
                  aria-label={label}
                  onClick={() => onChange({ ...current, [key]: value })}
                >
                  {swatch ? <span className="color-chip" style={{ background: swatch(value as number) }} /> : label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
