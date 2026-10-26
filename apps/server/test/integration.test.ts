import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { eq } from "drizzle-orm";
import type { ClientToServerEvents, ServerToClientEvents, SessionView } from "@spotflow-games/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { gameSessions, scoreEvents, sessionParticipants } from "../src/db/schema.js";
import { GameRegistry } from "../src/games/registry.js";
import { testEngine } from "./helpers.js";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

let ctx: Awaited<ReturnType<typeof buildApp>>;
let base: string;
const sockets: Client[] = [];

const headers = { "content-type": "application/json", "x-requested-with": "spotflow-games" };
const csrfOnly = { "x-requested-with": "spotflow-games" };

async function signIn(email: string, name: string) {
  const res = await fetch(`${base}/api/auth/dev-login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, name }),
  });
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

function socketFor(cookie: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const s: Client = connect(base, { extraHeaders: { cookie }, transports: ["websocket"], forceNew: true });
    sockets.push(s);
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
}

const emit = <T>(s: Client, event: keyof ClientToServerEvents, payload: object) =>
  new Promise<{ ok: true; data: T } | { ok: false; error: string }>((resolve) =>
    (s.emit as (e: string, p: object, cb: (r: never) => void) => void)(event, payload, resolve),
  );

beforeAll(async () => {
  const config = loadConfig({ ...process.env, DEV_LOGIN: "true", ADMIN_EMAILS: "admin@spotflow.one" });
  ctx = await buildApp(config, { registry: new GameRegistry().register(testEngine), logger: false });
  await ctx.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = ctx.app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await ctx.app.close();
});

describe("auth", () => {
  it("rejects non-spotflow accounts", async () => {
    const res = await fetch(`${base}/api/auth/dev-login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "someone@gmail.com" }),
    });
    expect(res.status).toBe(403);
  });

  it("requires sign-in for the API and sockets", async () => {
    expect((await fetch(`${base}/api/me`)).status).toBe(401);
    await expect(socketFor("sg_session=nope")).rejects.toThrow("unauthorized");
  });

  it("rejects state-changing requests without the CSRF header", async () => {
    const cookie = await signIn("csrf@spotflow.one", "Csrf");
    const res = await fetch(`${base}/api/me`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ displayName: "X" }),
    });
    expect(res.status).toBe(403);
  });

  it("saves profile changes and validates avatars", async () => {
    const cookie = await signIn("ada@spotflow.one", "Ada");
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    expect(me).toMatchObject({ email: "ada@spotflow.one", displayName: "Ada", avatar: null, isAdmin: false });

    const bad = await fetch(`${base}/api/me/avatar`, {
      method: "PUT",
      headers: { ...headers, cookie },
      body: JSON.stringify({ ...{ skin: 9 }, hairStyle: "<script>" }),
    });
    expect(bad.status).toBe(400);

    const avatar = {
      skin: 4,
      hairStyle: "curly",
      hairColor: 2,
      eyes: "wink",
      mouth: "grin",
      shirt: 3,
      accessory: "glasses",
      background: 5,
    };
    const ok = await fetch(`${base}/api/me/avatar`, {
      method: "PUT",
      headers: { ...headers, cookie },
      body: JSON.stringify(avatar),
    });
    expect((await ok.json()).avatar).toEqual(avatar);
  });
});

describe("quizzes", () => {
  it("lists curated quizzes without leaking questions or answers", async () => {
    const cookie = await signIn("quizzer@spotflow.one", "Quizzer");
    const list = await (await fetch(`${base}/api/quizzes`, { headers: { cookie } })).json();
    expect(list.length).toBeGreaterThanOrEqual(4);
    expect(list[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      questionCount: 10,
      curated: true,
    });
    expect(JSON.stringify(list)).not.toContain("correctIndex");
  });
});

describe("a full session over sockets", () => {
  it("runs lobby to completed and persists results once", async () => {
    const hostCookie = await signIn("host@spotflow.one", "Host");
    const playerCookie = await signIn("player@spotflow.one", "Player");

    const created = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { ...headers, cookie: hostCookie },
      body: JSON.stringify({ gameType: "quiz" }),
    });
    expect(created.status).toBe(201);
    const { code, id } = await created.json();
    expect(code).toMatch(/^[A-Z2-9]{6}$/);

    const host = await socketFor(hostCookie);
    const player = await socketFor(playerCookie);
    const latest: Record<string, SessionView> = {};
    host.on("session:state", (v) => (latest.host = v));
    player.on("session:state", (v) => (latest.player = v));

    expect(await emit(host, "session:join", { code })).toMatchObject({ ok: true });
    const joined = await emit<SessionView>(player, "session:join", { code: code.toLowerCase() });
    expect(joined.ok && joined.data.participants.map((p) => p.displayName)).toEqual(["Host", "Player"]);

    // A second tab for the same account is the same participant.
    const player2 = await socketFor(playerCookie);
    await emit(player2, "session:join", { code });
    expect((await ctx.manager.info(code))!.playerCount).toBe(2);

    expect(await emit(player, "session:start", { code })).toEqual({ ok: false, error: "Only the host can do that" });
    expect(await emit(host, "session:start", { code })).toMatchObject({ ok: true });

    await emit(player, "game:action", { code, action: { type: "point" } });
    await emit(player2, "game:action", { code, action: { type: "point" } }); // duplicate, ignored
    await emit(host, "game:action", { code, action: { type: "finish" } });
    await ctx.manager.flushSaves();
    await new Promise((r) => setTimeout(r, 50));

    expect(latest.player?.status).toBe("completed");
    const [session] = await ctx.db.select().from(gameSessions).where(eq(gameSessions.id, id));
    expect(session!.status).toBe("completed");
    const events = await ctx.db.select().from(scoreEvents).where(eq(scoreEvents.sessionId, id));
    expect(events).toHaveLength(1);
    expect(events[0]!.points).toBe(100);
    const parts = await ctx.db.select().from(sessionParticipants).where(eq(sessionParticipants.sessionId, id));
    const winner = parts.find((p) => p.finalRank === 1);
    expect(winner?.finalScore).toBe(100);

    const profile = await (
      await fetch(`${base}/api/profiles/${winner!.userId}`, { headers: { cookie: hostCookie } })
    ).json();
    expect(profile.stats.find((s: { gameType: string }) => s.gameType === "quiz")).toEqual({
      gameType: "quiz",
      played: 1,
      wins: 1,
      points: 100,
    });
  });

  it("refuses unknown codes and blocks late joiners", async () => {
    const hostCookie = await signIn("host2@spotflow.one", "Host2");
    const lateCookie = await signIn("late@spotflow.one", "Late");
    const { code } = await (
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { ...headers, cookie: hostCookie },
        body: JSON.stringify({ gameType: "quiz" }),
      })
    ).json();
    const host = await socketFor(hostCookie);
    const late = await socketFor(lateCookie);
    expect(await emit(late, "session:join", { code: "ZZZZZZ" })).toEqual({
      ok: false,
      error: "No session with that code",
    });
    await emit(host, "session:join", { code });
    await emit(host, "session:start", { code });
    expect(await emit(late, "session:join", { code })).toEqual({ ok: false, error: "This game has already started" });
  });

  it("lets admins deactivate accounts, which ends their sign-in", async () => {
    const adminCookie = await signIn("admin@spotflow.one", "Admin");
    const leaverCookie = await signIn("leaver@spotflow.one", "Leaver");
    const leaver = await (await fetch(`${base}/api/me`, { headers: { cookie: leaverCookie } })).json();
    const forbidden = await fetch(`${base}/api/admin/users/${leaver.id}/deactivate`, {
      method: "POST",
      headers: { ...csrfOnly, cookie: leaverCookie },
    });
    expect(forbidden.status).toBe(403);
    const ok = await fetch(`${base}/api/admin/users/${leaver.id}/deactivate`, {
      method: "POST",
      headers: { ...csrfOnly, cookie: adminCookie },
    });
    expect(ok.status).toBe(200);
    expect((await fetch(`${base}/api/me`, { headers: { cookie: leaverCookie } })).status).toBe(401);
    const again = await fetch(`${base}/api/auth/dev-login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: "leaver@spotflow.one" }),
    });
    expect(again.status).toBe(403);
  });
});
