import type { SessionView } from "./session.js";

/** Every client request is acknowledged with one of these. */
export type Ack<T = undefined> = (res: { ok: true; data: T } | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  "session:join": (payload: { code: string }, ack: Ack<SessionView>) => void;
  "session:leave": (payload: { code: string }, ack: Ack) => void;
  "session:ready": (payload: { code: string }, ack: Ack) => void;
  "session:reopen": (payload: { code: string }, ack: Ack) => void;
  "session:start": (payload: { code: string }, ack: Ack) => void;
  "session:end": (payload: { code: string }, ack: Ack) => void;
  "session:kick": (payload: { code: string; userId: string }, ack: Ack) => void;
  /** Game-specific action, validated by the game engine. */
  "game:action": (payload: { code: string; action: unknown }, ack: Ack) => void;
}

export interface ServerToClientEvents {
  "session:state": (view: SessionView) => void;
  "session:kicked": (payload: { code: string }) => void;
  "session:closed": (payload: { code: string; reason: string }) => void;
  /** Ephemeral game events that are not part of state, such as drawing strokes. */
  "game:event": (payload: { code: string; event: unknown }) => void;
}
