import { useState } from "react";
import { Pencil } from "lucide-react";
import {
  ALIAS_MAX_LENGTH,
  DEFAULT_AVATAR,
  type AvatarConfig,
  type Me,
  type ParticipantView,
  type SessionView,
} from "@spotflow-games/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { request } from "../lib/socket";
import { Avatar } from "./Avatar";
import { AvatarOptions, randomAvatar } from "./AvatarOptions";

/**
 * Lets a player pick the alias and avatar others see, before the game starts. The alias lasts
 * for this session only; the avatar is saved to their profile.
 */
export function HowYouAppear({
  code,
  you,
  onJoined,
  onError,
}: {
  code: string;
  you: ParticipantView | undefined;
  onJoined: (v: SessionView) => void;
  onError: (message: string) => void;
}) {
  const { me, setMe } = useAuth();
  const currentAlias = you && me && you.displayName !== me.displayName ? you.displayName : "";
  // Open until the player has picked an alias for this game.
  const [open, setOpen] = useState(!currentAlias);
  const [alias, setAlias] = useState(currentAlias);
  const [avatar, setAvatar] = useState<AvatarConfig>(me?.avatar ?? DEFAULT_AVATAR);
  const [saving, setSaving] = useState(false);
  if (!me) return null;
  const shownName = alias.trim() || me.displayName;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      setMe(await api<Me>("/api/me/avatar", { method: "PUT", body: avatar }));
      // Joining again sets the alias for this session and shows the new avatar.
      onJoined(await request<SessionView>("session:join", { code, alias }));
      setOpen(false);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <section className="sg-card sg-row you-card" aria-label="How you appear in this game">
        <Avatar avatar={me.avatar} name={you?.displayName ?? me.displayName} userId={me.id} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="nm">
            <b>{you?.displayName ?? me.displayName}</b>
          </div>
          <div className="sg-muted">How other players see you</div>
        </div>
        <button className="sg-btn secondary sm" onClick={() => setOpen(true)}>
          <Pencil aria-hidden="true" size={16} />
          Change name or avatar
        </button>
      </section>
    );
  }
  return (
    <form className="sg-card sg-stack you-card" aria-labelledby="appear-heading" onSubmit={save}>
      <h2 id="appear-heading" className="sg-h3">
        How you'll appear
      </h2>
      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="sg-stack" style={{ alignItems: "center" }}>
          <Avatar avatar={avatar} name={`${shownName} avatar preview`} userId={me.id} size="xl" />
          <b>{shownName}</b>
          <div className="sg-field" style={{ alignSelf: "stretch" }}>
            <label htmlFor="alias">Alias</label>
            <input
              id="alias"
              className="sg-input"
              maxLength={ALIAS_MAX_LENGTH}
              placeholder={me.displayName}
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
            />
            <span className="sg-muted">Only for this game. Leave empty to use your name.</span>
          </div>
          <div className="sg-row">
            <button className="sg-btn" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="sg-btn ghost" type="button" onClick={() => setAvatar(randomAvatar())}>
              Surprise me
            </button>
            <button className="sg-btn ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
        <AvatarOptions value={avatar} onChange={setAvatar} />
      </div>
    </form>
  );
}
