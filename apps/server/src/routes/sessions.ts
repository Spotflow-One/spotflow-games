import type { FastifyInstance } from "fastify";
import { GAME_INFO, sessionCodeSchema, type SessionSummary } from "@spotflow-games/shared";
import { requireUser } from "../auth/plugin.js";
import type { GameRegistry } from "../games/registry.js";
import type { SessionManager } from "../sessions/manager.js";
import type { Room } from "../sessions/room.js";

const summary = (room: Room, hostName: string): SessionSummary => ({
  id: room.id,
  code: room.code,
  gameType: room.gameType,
  status: room.status,
  hostId: room.hostId,
  hostName,
  playerCount: room.participants.size,
  createdAt: room.createdAt.toISOString(),
});

export function sessionRoutes(app: FastifyInstance, deps: { manager: SessionManager; registry: GameRegistry }) {
  const { manager, registry } = deps;
  const hostName = (room: Room) => room.participants.get(room.hostId)?.displayName ?? "Host";

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
    return manager
      .liveRooms()
      .filter((r) => r.status === "lobby" || r.status === "ready")
      .map((r) => summary(r, hostName(r)));
  });

  app.post("/api/sessions", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const room = await manager.create(user.id, req.body as never);
    return reply.code(201).send(summary(room, user.displayName));
  });

  app.get("/api/sessions/:code", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const parsed = sessionCodeSchema.safeParse((req.params as { code: string }).code);
    const room = parsed.success ? manager.get(parsed.data) : undefined;
    if (!room) return reply.code(404).send({ error: "No session with that code" });
    return summary(room, hostName(room));
  });
}
