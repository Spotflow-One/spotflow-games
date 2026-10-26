import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { ZodError } from "zod";
import { sessionCodeSchema, type ClientToServerEvents, type ServerToClientEvents } from "@spotflow-games/shared";
import type { Db } from "../db/client.js";
import { SESSION_COOKIE, findSessionUser, type SessionUser } from "../auth/sessions.js";
import { getUser } from "../auth/users.js";
import { GameError } from "../games/contract.js";
import type { SessionManager } from "../sessions/manager.js";
import type { Room } from "../sessions/room.js";
import { RateLimiter } from "./rateLimit.js";

type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { user: SessionUser }>;

const userRoom = (userId: string) => `user:${userId}`;

export interface GatewayOptions {
  db: Db;
  manager: SessionManager;
  /** Allowed browser origin for WebSocket connections. */
  appOrigin: string;
  parseCookie: (header: string) => Record<string, string | undefined>;
  log: Pick<Console, "info" | "warn" | "error">;
}

export function createGateway(server: HttpServer, opts: GatewayOptions) {
  const { db, manager, log } = opts;
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, { user: SessionUser }>(
    server,
    {
      // WebSockets skip CORS, so check the origin ourselves to stop cross-site hijacking.
      allowRequest: (req, cb) => cb(null, !req.headers.origin || req.headers.origin === opts.appOrigin),
    },
  );
  const limiter = new RateLimiter();

  manager.setTransport({
    sendState: (userId, view) => io.to(userRoom(userId)).emit("session:state", view),
    sendEvent: (userIds, code, event) => {
      if (userIds.length) io.to(userIds.map(userRoom)).emit("game:event", { code, event });
    },
    sendClosed: (userIds, code, reason) => {
      if (userIds.length) io.to(userIds.map(userRoom)).emit("session:closed", { code, reason });
    },
  });

  io.use(async (socket, next) => {
    try {
      const cookies = opts.parseCookie(socket.handshake.headers.cookie ?? "");
      const user = await findSessionUser(db, cookies[SESSION_COOKIE]);
      if (!user) return next(new Error("unauthorized"));
      socket.data.user = user;
      next();
    } catch (err) {
      next(err as Error);
    }
  });

  io.on("connection", (socket: GameSocket) => {
    const user = socket.data.user;
    socket.join(userRoom(user.id));
    const joined = new Set<string>();

    /** Wraps a handler with code lookup, rate limiting and uniform error acks. */
    const handle = <P extends { code: string }, T>(
      event: string,
      fn: (room: Room, payload: P) => T | Promise<T>,
      perSecond: number | ((room: Room) => number) = 5,
    ) => {
      return async (payload: P, ack: (res: { ok: true; data: T } | { ok: false; error: string }) => void) => {
        const reply = typeof ack === "function" ? ack : () => {};
        try {
          const code = sessionCodeSchema.parse(payload?.code);
          const room = manager.get(code);
          if (!room) return reply({ ok: false, error: "No session with that code" });
          const rate = typeof perSecond === "function" ? perSecond(room) : perSecond;
          if (!limiter.take(`${socket.id}:${event}`, rate)) return reply({ ok: false, error: "Slow down a little" });
          reply({ ok: true, data: await fn(room, { ...payload, code }) });
        } catch (err) {
          if (err instanceof GameError) return reply({ ok: false, error: err.message });
          if (err instanceof ZodError) return reply({ ok: false, error: "Invalid request" });
          log.error(`socket ${event} failed`, err);
          reply({ ok: false, error: "Something went wrong" });
        }
      };
    };

    socket.on(
      "session:join",
      handle(
        "join",
        async (room) => {
          // Re-read the profile so a just-updated name or avatar shows up in the lobby.
          const fresh = (await getUser(db, user.id)) ?? user;
          if (fresh.deactivatedAt) throw new GameError("This account is deactivated");
          await manager.join(room.code, fresh, socket.id);
          joined.add(room.code);
          return room.viewFor(user.id);
        },
        2,
      ),
    );
    socket.on(
      "session:leave",
      handle("leave", async (room) => {
        joined.delete(room.code);
        await manager.leave(room.code, user.id);
        return undefined;
      }),
    );
    socket.on(
      "session:ready",
      handle("ready", (room) => void room.markReady(user.id)),
    );
    socket.on(
      "session:reopen",
      handle("reopen", (room) => void room.reopen(user.id)),
    );
    socket.on(
      "session:start",
      handle("start", async (room) => {
        await room.start(user.id);
        return undefined;
      }),
    );
    socket.on(
      "session:end",
      handle("end", (room) => void room.end(user.id)),
    );
    socket.on(
      "session:kick",
      handle("kick", async (room, p: { code: string; userId: string }) => {
        await manager.kick(room.code, user.id, String(p.userId));
        return undefined;
      }),
    );
    socket.on(
      "game:action",
      handle(
        "action",
        (room, p: { code: string; action: unknown }) => void room.handleAction(user.id, p.action),
        (room) => room.actionRateLimit,
      ),
    );

    socket.on("disconnect", () => {
      for (const code of joined) manager.get(code)?.disconnect(user.id, socket.id);
      limiter.clear(`${socket.id}:`);
    });
  });

  return io;
}
