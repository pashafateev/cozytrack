import { describe, it, expect } from "vitest";
import {
  isHostSender,
  parseParticipantRole,
} from "../src/lib/transport/participant-role";

describe("parseParticipantRole", () => {
  it("returns 'host' when metadata declares role: host", () => {
    expect(parseParticipantRole(JSON.stringify({ role: "host" }))).toBe("host");
  });

  it("returns 'guest' when metadata declares role: guest", () => {
    expect(parseParticipantRole(JSON.stringify({ role: "guest" }))).toBe(
      "guest",
    );
  });

  it("returns null for unknown role values", () => {
    expect(parseParticipantRole(JSON.stringify({ role: "admin" }))).toBeNull();
    expect(parseParticipantRole(JSON.stringify({ role: 42 }))).toBeNull();
  });

  it("returns null when metadata is missing", () => {
    expect(parseParticipantRole(undefined)).toBeNull();
    expect(parseParticipantRole("")).toBeNull();
  });

  it("returns null for unparseable JSON", () => {
    expect(parseParticipantRole("not-json")).toBeNull();
  });

  it("returns null when JSON parses to a non-object", () => {
    expect(parseParticipantRole(JSON.stringify("host"))).toBeNull();
    expect(parseParticipantRole(JSON.stringify(null))).toBeNull();
    expect(parseParticipantRole(JSON.stringify(["host"]))).toBeNull();
  });

  it("ignores extra fields", () => {
    expect(
      parseParticipantRole(JSON.stringify({ role: "host", extra: "x" })),
    ).toBe("host");
  });
});

describe("isHostSender", () => {
  it("accepts senders whose metadata declares role: host", () => {
    expect(isHostSender(JSON.stringify({ role: "host" }))).toBe(true);
  });

  it("rejects guest senders", () => {
    expect(isHostSender(JSON.stringify({ role: "guest" }))).toBe(false);
  });

  it("rejects senders with no metadata (no token claim)", () => {
    expect(isHostSender(undefined)).toBe(false);
    expect(isHostSender("")).toBe(false);
  });

  it("rejects senders with malformed metadata", () => {
    // A malicious guest could try to spoof by sending malformed JSON. The
    // parser must reject — the trust boundary is the LiveKit-signed token,
    // not the data-channel payload.
    expect(isHostSender("{bogus")).toBe(false);
    expect(isHostSender(JSON.stringify({ role: "HOST" }))).toBe(false);
  });
});
