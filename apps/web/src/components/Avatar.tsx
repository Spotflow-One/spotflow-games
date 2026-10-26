import { RefreshCw, Check } from "lucide-react";
import { fallbackBackground, type AvatarConfig } from "@spotflow-games/shared";

type Size = "xs" | "sm" | "md" | "lg" | "xl";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
}

interface Props {
  avatar: AvatarConfig | null;
  name: string;
  userId: string;
  size?: Size;
  host?: boolean;
  /** Shows a connection dot when set. */
  connected?: boolean;
}

/** A player's saved avatar, or initials when there is none. Built on the design system's sg-avatar. */
export function Avatar({ avatar, name, userId, size = "md", host, connected }: Props) {
  const bg = avatar?.background ?? fallbackBackground(userId);
  const away = connected === false;
  return (
    <span className={`sg-avatar ${size} bg${bg}${away ? " away" : ""}`} role="img" aria-label={name}>
      {avatar ? <Face avatar={avatar} /> : <span className="initials">{initials(name)}</span>}
      {host && (
        <svg className="crown" viewBox="0 0 24 14" aria-hidden="true">
          <path fill="currentColor" d="M2 13L3.5 2l5 5L12 1l3.5 6 5-5L22 13z" />
        </svg>
      )}
      {connected !== undefined && (
        <span className={`dot${away ? " off" : ""}`} aria-label={away ? "Reconnecting" : "Connected"}>
          {away ? <RefreshCw aria-hidden="true" /> : <Check aria-hidden="true" />}
        </span>
      )}
    </span>
  );
}

export function Face({ avatar }: { avatar: AvatarConfig }) {
  const hr = `hr${avatar.hairColor}`;
  return (
    <svg className="face" viewBox="0 0 64 64" aria-hidden="true">
      <HairBack style={avatar.hairStyle} cls={hr} />
      <path className={`sh${avatar.shirt}`} d="M12 64c0-11 9-18 20-18s20 7 20 18z" />
      <circle className={`sk${avatar.skin}`} cx="32" cy="32" r="12" />
      <HairFront style={avatar.hairStyle} cls={hr} />
      <Eyes style={avatar.eyes} />
      <Mouth style={avatar.mouth} />
      <Accessory style={avatar.accessory} />
    </svg>
  );
}

function HairBack({ style, cls }: { style: AvatarConfig["hairStyle"]; cls: string }) {
  switch (style) {
    case "curly":
      return (
        <g className={cls}>
          {[
            [22, 24],
            [28, 18],
            [36, 18],
            [42, 24],
            [44, 31],
            [20, 31],
          ].map(([cx, cy]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="7" />
          ))}
        </g>
      );
    case "long":
      return <path className={cls} d="M17 32c0-12 6.5-19 15-19s15 7 15 19v16h-7V32H24v16h-7z" />;
    case "bun":
      return <circle className={cls} cx="32" cy="12" r="6" />;
    case "afro":
      return <circle className={cls} cx="32" cy="27" r="19" />;
    default:
      return null;
  }
}

function HairFront({ style, cls }: { style: AvatarConfig["hairStyle"]; cls: string }) {
  switch (style) {
    case "short":
      return <path className={cls} d="M20 30c0-9 5-14 12-14s12 5 12 14c-2-3-5-5-9-5-5 0-10 1-15 5z" />;
    case "long":
    case "bun":
      return <path className={cls} d="M20 31c0-9 5-14 12-14s12 5 12 14c-3-4-7-6-12-6s-9 2-12 6z" />;
    case "mohawk":
      return <path className={cls} d="M29 22c0-6 1.5-11 3-14 1.5 3 3 8 3 14z" />;
    default:
      return null;
  }
}

function Eyes({ style }: { style: AvatarConfig["eyes"] }) {
  switch (style) {
    case "happy":
      return (
        <g className="fl">
          <path d="M26 33c1-1.5 2.5-1.5 3.5 0" />
          <path d="M35 33c1-1.5 2.5-1.5 3.5 0" />
        </g>
      );
    case "wink":
      return (
        <g>
          <circle className="fe" cx="27.5" cy="32.5" r="1.6" />
          <path className="fl" d="M35 32.5h3.5" />
        </g>
      );
    case "sleepy":
      return (
        <g className="fl">
          <path d="M26 32.5h3.5" />
          <path d="M35 32.5h3.5" />
        </g>
      );
    default:
      return (
        <g>
          <circle className="fe" cx="27.5" cy="32.5" r="1.6" />
          <circle className="fe" cx="36.5" cy="32.5" r="1.6" />
        </g>
      );
  }
}

function Mouth({ style }: { style: AvatarConfig["mouth"] }) {
  switch (style) {
    case "grin":
      return <path className="fe" d="M27.5 36.5h9c0 3-2 4.5-4.5 4.5s-4.5-1.5-4.5-4.5z" />;
    case "neutral":
      return <path className="fl" d="M29 38h6" />;
    case "open":
      return <ellipse className="fe" cx="32" cy="38.5" rx="2.2" ry="2.6" />;
    default:
      return <path className="fl" d="M28.5 37.5c2 1.6 5 1.6 7 0" />;
  }
}

function Accessory({ style }: { style: AvatarConfig["accessory"] }) {
  switch (style) {
    case "glasses":
      return (
        <g className="fl" strokeWidth="1.5">
          <circle cx="27.5" cy="32.5" r="3.6" />
          <circle cx="36.5" cy="32.5" r="3.6" />
          <path d="M31.1 32.5h1.8" />
        </g>
      );
    case "sunglasses":
      return (
        <g className="fe">
          <rect x="23.5" y="30" width="8" height="5" rx="2" />
          <rect x="32.5" y="30" width="8" height="5" rx="2" />
        </g>
      );
    case "headphones":
      return (
        <g>
          <path className="fl" strokeWidth="2.5" d="M19 33c0-9 6-15 13-15s13 6 13 15" />
          <rect className="fe" x="17" y="30" width="5" height="9" rx="2" />
          <rect className="fe" x="42" y="30" width="5" height="9" rx="2" />
        </g>
      );
    case "earrings":
      return (
        <g className="hr3">
          <circle cx="20" cy="37" r="1.8" />
          <circle cx="44" cy="37" r="1.8" />
        </g>
      );
    default:
      return null;
  }
}
