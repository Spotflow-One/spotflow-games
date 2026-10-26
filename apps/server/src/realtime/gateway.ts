import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import { ZodError } from "zod";
import { sessionCodeSchema, type ClientToServerEvents, type ServerToClientEvents } from "@spotflow-games/shared";
import type { Db } from "../db/client.js";
import { SESSION_COOKIE, findSessionUser, type SessionUser } from "../auth/sessions.js";
import { getUser } from "../auth/users.js";
import { GameError } from "../games/contract.js";
import type { SessionManager, Transport } from "../sessions/manager.js";
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
  /**
   * Wraps delivery so messages reach players on every server instance. Given the function that
   * delivers to sockets on this instance, it returns the transport the manager uses.
   */
  bus?: (deliverLocally: Transport) => Transport;
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
  // Per-socket ceiling for game actions; each game applies its own lower rate inside.
  const maxActionRate = 50;

  const local: Transport = {
    sendStates: (_code, views) => {
      for (const [userId, view] of views) io.to(userRoom(userId)).emit("session:state", view);
    },
    sendEvent: (userIds, code, event) => {
      if (userIds.length) io.to(userIds.map(userRoom)).emit("game:event", { code, event });
    },
    sendClosed: (userIds, code, reason) => {
      if (userIds.length) io.to(userIds.map(userRoom)).emit("session:closed", { code, reason });
    },
  };
  manager.setTransport(opts.bus ? opts.bus(local) : local);

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
    const run = async (code: string, fn: (room: Room) => unknown) => {
      await manager.run(code, fn);
      return undefined;
    };

    /** Wraps a handler with code validation, rate limiting and uniform error acks. */
    const handle = <P extends { code: string }, T>(
      event: string,
      fn: (code: string, payload: P) => T | Promise<T>,
      perSecond = 5,
    ) => {
      return async (payload: P, ack: (res: { ok: true; data: T } | { ok: false; error: string }) => void) => {
        const reply = typeof ack === "function" ? ack : () => {};
        try {
          const code = sessionCodeSchema.parse(payload?.code);
          if (!limiter.take(`${socket.id}:${event}`, perSecond))
            return reply({ ok: false, error: "Slow down a little" });
          reply({ ok: true, data: await fn(code, { ...payload, code }) });
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
        async (code) => {
          // Re-read the profile so a just-updated name or avatar shows up in the lobby.
          const fresh = (await getUser(db, user.id)) ?? user;
          if (fresh.deactivatedAt) throw new GameError("This account is deactivated");
          const view = await manager.join(code, fresh, socket.id);
          joined.add(code);
          return view;
        },
        2,
      ),
    );
    socket.on(
      "session:leave",
      handle("leave", async (code) => {
        joined.delete(code);
        await manager.leave(code, user.id);
        return undefined;
      }),
    );
    socket.on(
      "session:ready",
      handle("ready", (code) => run(code, (room) => room.markReady(user.id))),
    );
    socket.on(
      "session:reopen",
      handle("reopen", (code) => run(code, (room) => room.reopen(user.id))),
    );
    socket.on(
      "session:start",
      handle("start", (code) => run(code, (room) => room.start(user.id))),
    );
    socket.on(
      "session:end",
      handle("end", (code) => run(code, (room) => room.end(user.id))),
    );
    socket.on(
      "session:kick",
      handle("kick", async (code, p: { code: string; userId: string }) => {
        await manager.kick(code, user.id, String(p.userId));
        return undefined;
      }),
    );
    socket.on(
      "game:action",
      handle(
        "action",
        (code, p: { code: string; action: unknown }) =>
          run(code, (room) => {
            // Each game sets its own action rate on top of the generous per-socket cap.
            if (!limiter.take(`${socket.id}:action:${room.gameType}`, room.actionRateLimit))
              throw new GameError("Slow down a little");
            room.handleAction(user.id, p.action);
          }),
        maxActionRate,
      ),
    );

    socket.on("disconnect", () => {
      for (const code of joined) {
        manager.disconnect(code, user.id, socket.id).catch((err) => log.error("socket disconnect failed", err));
      }
      limiter.clear(`${socket.id}:`);
    });
  });

  return io;
}
