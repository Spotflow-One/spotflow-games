import { z } from "zod";
import type { AvatarConfig } from "./avatar.js";

export const ALLOWED_EMAIL_DOMAIN = "spotflow.one";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export interface PublicProfile {
  id: string;
  displayName: string;
  avatar: AvatarConfig | null;
  createdAt: string;
}

export interface Me extends PublicProfile {
  email: string;
  isAdmin: boolean;
  themePreference: ThemePreference;
  soundEnabled: boolean;
}

export const ALIAS_MAX_LENGTH = 24;

/** A name for one game session only. Empty means use the display name. */
export const aliasSchema = z
  .string()
  .trim()
  .max(ALIAS_MAX_LENGTH)
  .transform((v) => v || null)
  .nullable();

export const updateMeSchema = z
  .object({
    displayName: z.string().trim().min(1).max(40).optional(),
    themePreference: z.enum(THEME_PREFERENCES).optional(),
    soundEnabled: z.boolean().optional(),
  })
  .strict();
export type UpdateMe = z.infer<typeof updateMeSchema>;
