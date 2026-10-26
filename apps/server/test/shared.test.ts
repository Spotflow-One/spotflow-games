import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import type { ClientToServerEvents, ServerToClientEvents, SessionView } from "@spotflow-games/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { gameSessions, sessionParticipants } from "../src/db/schema.js";
import { GameError, type GameEngine } from "../src/games/contract.js";
import { GameRegistry } from "../src/games/registry.js";
import { testEngine } from "./helpers.js";

/**
 * Two server instances sharing one Redis, like several copies of the server on Vercel.
 * Players connect to different instances and must still play the same game.
 */
type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const redisUrl = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";

/** Ends the game when its timer fires, so tests can see timers work across instances. */
const timerEngine: GameEngine<{ ms: number }, { fired: number; by: string }> = {
  type: "draw",
  rulesVersion: 1,
  minPlayers: 1,
  parseConfig: (raw) => ({ ms: Number((raw as { ms?: number })?.ms ?? 150) }),
  start(ctx, config) {
    ctx.setTimer("end", config.ms);
    return { fired: 0, by: "" };
  },
  handleAction(ctx, state, userId, action) {
    const a = action as { type?: string; n?: number };
    if (a.type === "stroke") {
      ctx.appendLog({ n: a.n, by: userId });
      ctx.broadcastState();
    } else if (a.type === "sync") {
      ctx.sendLog(userId, (entries) => ({ type: "sync", entries }));
    } else throw new GameError("Unknown action");
  },
  onTimer(ctx, state, name) {
    if (name === "end") {
      state.fired++;
      ctx.finish();
    }
  },
  viewFor: (state) => ({ fired: state.fired }),
};

/** Reads held controls on a timer, like a real-time game's tick, and finishes when told to. */
const inputEngine: GameEngine<object, { seen: Record<string, unknown> }> = {
  type: "truths",
  rulesVersion: 1,
  minPlayers: 1,
  acceptsInput: true,
  parseConfig: () => ({}),
  start(ctx) {
    ctx.setTimer("tick", 50);
    return { seen: {} };
  },
  handleAction() {
    throw new GameError("Unknown action");
  },
  onTimer(ctx, state) {
    for (const [id, { value }] of ctx.inputs()) state.seen[id] = value;
    ctx.broadcastState();
    if (Object.values(state.seen).some((v) => (v as { go?: boolean })?.go)) ctx.finish();
    else ctx.setTimer("tick", 50);
  },
  viewFor: (state) => ({ seen: state.seen }),
};

type Instance = Awaited<ReturnType<typeof buildApp>> & { base: string };
const instances: Instance[] = [];
const sockets: Client[] = [];
const headers = { "content-type": "application/json", "x-requested-with": "spotflow-games" };

async function startInstance(): Promise<Instance> {
  const config = loadConfig({ ...process.env, DEV_LOGIN: "true", REDIS_URL: redisUrl });
  const app = await buildApp(config, {
    registry: new GameRegistry().register(testEngine).register(timerEngine).register(inputEngine),
    logger: false,
  });
  await app.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.app.server.address() as { port: number };
  const inst = { ...app, base: `http://127.0.0.1:${port}` };
  instances.push(inst);
  return inst;
}

async function signIn(inst: Instance, email: string, name: string) {
  const res = await fetch(`${inst.base}/api/auth/dev-login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, name }),
  });
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function socketFor(inst: Instance, cookie: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const s: Client = connect(inst.base, { extraHeaders: { cookie }, transports: ["websocket"], forceNew: true });
    sockets.push(s);
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}

const emit = <T>(s: Client, event: keyof ClientToServerEvents, payload: object) =>
  new Promise<{ ok: true; data: T } | { ok: false; error: string }>((resolve) =>
    (s.emit as (e: string, p: object, cb: (r: never) => void) => void)(event, payload, resolve),
  );

function nextState(s: Client, match: (v: SessionView) => boolean, timeoutMs = 3000) {
  return new Promise<SessionView>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting for state")), timeoutMs);
    const on = (v: SessionView) => {
      if (!match(v)) return;
      clearTimeout(t);
      s.off("session:state", on);
      resolve(v);
    };
    s.on("session:state", on);
  });
}

async function createSession(inst: Instance, cookie: string, gameType: string, config: object = {}) {
  const res = await fetch(`${inst.base}/api/sessions`, {
    method: "POST",
    headers: { ...headers, cookie },
    body: JSON.stringify({ gameType, config, hostPlays: true, allowLateJoin: false }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

let a: Instance;
let b: Instance;

beforeAll(async () => {
  const redis = new Redis(redisUrl);
  await redis.flushdb();
  await redis.quit();
  a = await startInstance();
  b = await startInstance();
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  for (const inst of instances) await inst.app.close().catch(() => {});
});

describe("sessions shared through Redis", () => {
  it("lets players on different instances play the same game", async () => {
    const hostCookie = await signIn(a, "shared-host@spotflow.one", "Host");
    const playerCookie = await signIn(b, "shared-player@spotflow.one", "Player");
    const code = await createSession(a, hostCookie, "quiz");

    // The lobby is visible from the other instance.
    const lobbies = (await (await fetch(`${b.base}/api/sessions`, { headers: { cookie: playerCookie } })).json()) as {
      code: string;
    }[];
    expect(lobbies.map((l) => l.code)).toContain(code);

    const host = await socketFor(a, hostCookie);
    const player = await socketFor(b, playerCookie);
    expect((await emit(host, "session:join", { code })).ok).toBe(true);
    const seenByHost = nextState(host, (v) => v.participants.length === 2);
    const joined = await emit<SessionView>(player, "session:join", { code });
    expect(joined.ok).toBe(true);
    // A change made on instance B reaches the host on instance A.
    await seenByHost;

    const started = nextState(player, (v) => v.status === "in_progress");
    expect((await emit(host, "session:start", { code })).ok).toBe(true);
    await started;

    const scored = nextState(host, (v) => v.participants.some((p) => p.score === 100));
    expect((await emit(player, "game:action", { code, action: { type: "point" } })).ok).toBe(true);
    await scored;

    const done = nextState(player, (v) => v.status === "completed");
    expect((await emit(host, "game:action", { code, action: { type: "finish" } })).ok).toBe(true);
    const final = await done;
    expect(final.participants.find((p) => p.displayName === "Player")?.rank).toBe(1);

    const [row] = await a.db.select().from(gameSessions).where(eq(gameSessions.code, code));
    expect(row!.status).toBe("completed");
    const parts = await a.db.select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, row!.id));
    expect(parts).toHaveLength(2);
  });

  it("serializes concurrent changes to one room across instances", async () => {
    const cookies = await Promise.all(
      Array.from({ length: 8 }, (_, i) => signIn(i % 2 ? a : b, `shared-p${i}@spotflow.one`, `P${i}`)),
    );
    const code = await createSession(a, cookies[0]!, "quiz");
    const clients = await Promise.all(cookies.map((c, i) => socketFor(i % 2 ? a : b, c)));
    const results = await Promise.all(clients.map((s) => emit(s, "session:join", { code })));
    expect(results.every((r) => r.ok)).toBe(true);
    // No join was lost to a race between instances.
    expect((await b.manager.info(code))!.playerCount).toBe(8);
  });

  it("fires game timers, even when the instance that set them is gone", async () => {
    const c = await startInstance();
    const hostCookie = await signIn(c, "timer-host@spotflow.one", "Timer Host");
    const code = await createSession(c, hostCookie, "draw", { ms: 1000 });
    const host = await socketFor(c, hostCookie);
    expect((await emit(host, "session:join", { code })).ok).toBe(true);
    expect((await emit(host, "session:start", { code })).ok).toBe(true);
    // Instance C set the timer, then stops before it is due. A or B must pick it up.
    host.disconnect();
    await c.app.close();
    expect((await a.manager.info(code))!.status).toBe("in_progress");

    const watcherCookie = await signIn(a, "timer-host@spotflow.one", "Timer Host");
    const watcher = await socketFor(a, watcherCookie);
    const finished = nextState(watcher, (v) => v.status === "completed", 6000);
    expect((await emit(watcher, "session:join", { code })).ok).toBe(true);
    const view = await finished;
    expect((view.game as { fired: number }).fired).toBe(1);
  });

  it("keeps the game log outside the snapshot and sends it on request", async () => {
    const cookie = await signIn(a, "drawer@spotflow.one", "Drawer");
    const code = await createSession(a, cookie, "draw", { ms: 60_000 });
    const s = await socketFor(b, cookie);
    expect((await emit(s, "session:join", { code })).ok).toBe(true);
    expect((await emit(s, "session:start", { code })).ok).toBe(true);
    for (let n = 1; n <= 3; n++) await emit(s, "game:action", { code, action: { type: "stroke", n } });
    const sync = new Promise<unknown>((resolve) => s.once("game:event", (e) => resolve(e.event)));
    await emit(s, "game:action", { code, action: { type: "sync" } });
    expect(await sync).toEqual({ type: "sync", entries: [1, 2, 3].map((n) => ({ n, by: expect.any(String) })) });
  });

  it("delivers held controls to the game from any instance, without an ack", async () => {
    const hostCookie = await signIn(a, "input-host@spotflow.one", "Input Host");
    const playerCookie = await signIn(b, "input-player@spotflow.one", "Input Player");
    const code = await createSession(a, hostCookie, "truths");
    const host = await socketFor(a, hostCookie);
    const player = await socketFor(b, playerCookie);
    expect((await emit(host, "session:join", { code })).ok).toBe(true);
    expect((await emit(player, "session:join", { code })).ok).toBe(true);
    expect((await emit(host, "session:start", { code })).ok).toBe(true);

    // Oversized input is dropped; later input replaces earlier.
    player.emit("game:input", { code, input: { pad: "x".repeat(500) } });
    player.emit("game:input", { code, input: { step: 1 } });
    await nextState(host, (v) => JSON.stringify(v.game).includes('"step":1'));
    const done = nextState(host, (v) => v.status === "completed", 4000);
    player.emit("game:input", { code, input: { go: true } });
    const final = await done;
    expect(JSON.stringify(final.game)).not.toContain("pad");
  });
});
