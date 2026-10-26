import { z } from "zod";

/**
 * Avatars are a curated set of options, stored as a small JSON config. No photo uploads.
 * Colours are indexes into the design system's fixed avatar tokens (skin-N, hair-N,
 * avatar-bg-N), so a palette change updates every saved avatar.
 */
export const AVATAR_OPTIONS = {
  skin: [1, 2, 3, 4, 5],
  hairStyle: ["none", "short", "curly", "long", "bun", "afro", "mohawk"],
  hairColor: [1, 2, 3, 4, 5, 6],
  eyes: ["round", "happy", "wink", "sleepy"],
  mouth: ["smile", "grin", "neutral", "open"],
  shirt: [1, 2, 3, 4, 5],
  accessory: ["none", "glasses", "sunglasses", "headphones", "earrings"],
  background: [1, 2, 3, 4, 5, 6],
} as const;

type Opts = typeof AVATAR_OPTIONS;
export type AvatarConfig = { -readonly [K in keyof Opts]: Opts[K][number] };

const oneOf = <K extends keyof Opts>(key: K) =>
  z.custom<Opts[K][number]>((v) => (AVATAR_OPTIONS[key] as readonly unknown[]).includes(v), {
    message: `Invalid ${key}`,
  });

export const avatarConfigSchema = z
  .object({
    skin: oneOf("skin"),
    hairStyle: oneOf("hairStyle"),
    hairColor: oneOf("hairColor"),
    eyes: oneOf("eyes"),
    mouth: oneOf("mouth"),
    shirt: oneOf("shirt"),
    accessory: oneOf("accessory"),
    background: oneOf("background"),
  })
  .strict();

export const DEFAULT_AVATAR: AvatarConfig = {
  skin: 3,
  hairStyle: "short",
  hairColor: 1,
  eyes: "round",
  mouth: "smile",
  shirt: 1,
  accessory: "none",
  background: 2,
};

/** Parse a stored avatar, falling back to null if it is missing or invalid. */
export function parseAvatar(value: unknown): AvatarConfig | null {
  const result = avatarConfigSchema.safeParse(value);
  return result.success ? (result.data as AvatarConfig) : null;
}

/** Background for the initials fallback, stable per user. */
export function fallbackBackground(userId: string): AvatarConfig["background"] {
  let h = 0;
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0;
  return AVATAR_OPTIONS.background[Math.abs(h) % AVATAR_OPTIONS.background.length]!;
}
