import type { FastifyInstance } from "fastify";
import { GAME_INFO, sessionCodeSchema, type SessionSummary } from "@spotflow-games/shared";
import { requireUser } from "../auth/plugin.js";
import type { GameRegistry } from "../games/registry.js";
import type { SessionManager } from "../sessions/manager.js";
import type { RoomInfo } from "../sessions/store.js";

const summary = (room: RoomInfo): SessionSummary => ({
  id: room.id,
  code: room.code,
  gameType: room.gameType,
  status: room.status,
  hostId: room.hostId,
  hostName: room.hostName,
  playerCount: room.playerCount,
  createdAt: room.createdAt.toISOString(),
});

export function sessionRoutes(app: FastifyInstance, deps: { manager: SessionManager; registry: GameRegistry }) {
  const { manager, registry } = deps;

  app.get("/api/games", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const available = new Set(registry.available());
    return Object.entries(GAME_INFO).map(([type, info]) => ({
      type,
      ...info,
      available: available.has(type as never),
    }));
  });

  app.get("/api/sessions", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return (await manager.liveRooms()).filter((r) => r.status === "lobby" || r.status === "ready").map(summary);
  });

  app.post("/api/sessions", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const room = await manager.create(user.id, req.body as never);
    return reply.code(201).send(summary({ ...room, hostName: user.displayName }));
  });

  app.get("/api/sessions/:code", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const parsed = sessionCodeSchema.safeParse((req.params as { code: string }).code);
    const room = parsed.success ? await manager.info(parsed.data) : null;
    if (!room) return reply.code(404).send({ error: "No session with that code" });
    return summary(room);
  });
}
