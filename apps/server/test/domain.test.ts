import { describe, expect, it } from "vitest";
import { checkIdentity } from "../src/auth/domain.js";
import { safeReturnTo } from "../src/routes/auth.js";

const base = { sub: "1", email: "ada@spotflow.one", email_verified: true, hd: "spotflow.one", name: "Ada" };

describe("checkIdentity", () => {
  it("accepts verified spotflow.one workspace accounts", () => {
    expect(checkIdentity(base, "spotflow.one")).toEqual({ ok: true, sub: "1", email: "ada@spotflow.one", name: "Ada" });
  });
  it("rejects unverified emails", () => {
    expect(checkIdentity({ ...base, email_verified: false }, "spotflow.one")).toMatchObject({ ok: false });
  });
  it("rejects other domains and look-alikes", () => {
    expect(checkIdentity({ ...base, email: "ada@gmail.com", hd: undefined }, "spotflow.one")).toMatchObject({
      ok: false,
    });
    expect(checkIdentity({ ...base, email: "ada@evilspotflow.one" }, "spotflow.one")).toMatchObject({ ok: false });
    expect(checkIdentity({ ...base, email: "ada@spotflow.one.evil.com" }, "spotflow.one")).toMatchObject({ ok: false });
  });
  it("requires the Workspace hd claim, not just the email suffix", () => {
    expect(checkIdentity({ ...base, hd: undefined }, "spotflow.one")).toMatchObject({
      ok: false,
      reason: "wrong_domain",
    });
  });
});

describe("safeReturnTo", () => {
  it("only allows same-site paths", () => {
    expect(safeReturnTo("/join/ABCDEF")).toBe("/join/ABCDEF");
    expect(safeReturnTo("//evil.com")).toBe("/");
    expect(safeReturnTo("https://evil.com")).toBe("/");
    expect(safeReturnTo("/\\evil.com")).toBe("/");
  });
});
