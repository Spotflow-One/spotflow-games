import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@spotflow-games/shared";

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: GameSocket | null = null;

/** One shared connection per tab. The session cookie authenticates it. */
export function getSocket(): GameSocket {
  if (!socket) socket = io({ transports: ["websocket", "polling"], withCredentials: true });
  return socket;
}

export function closeSocket() {
  socket?.disconnect();
  socket = null;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Emit with an acknowledgement, rejecting with the server's message on failure. */
export function request<T = undefined>(event: keyof ClientToServerEvents, payload: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const s = getSocket();
    (s.timeout(8000).emit as (e: string, p: object, cb: (err: Error | null, res: Result<T>) => void) => void)(
      event,
      payload,
      (err, res) => {
        if (err) return reject(new Error("The server did not respond. Check your connection."));
        if (res.ok) resolve(res.data);
        else reject(new Error(res.error));
      },
    );
  });
}
