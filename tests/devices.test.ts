import { describe, expect, it } from "vitest";
import {
  isBuiltInMic,
  isSelectedMicBuiltIn,
  resolveDefaultDevice,
} from "@/lib/devices";

function dev(
  deviceId: string,
  label: string,
  groupId = "",
): MediaDeviceInfo {
  return {
    deviceId,
    label,
    groupId,
    kind: "audioinput",
    toJSON() {
      return this;
    },
  } as MediaDeviceInfo;
}

describe("isBuiltInMic", () => {
  it("matches built-in keywords", () => {
    expect(isBuiltInMic("MacBook Pro Microphone")).toBe(true);
    expect(isBuiltInMic("Built-in Audio")).toBe(true);
    expect(isBuiltInMic("Internal Microphone")).toBe(true);
  });

  it("does not match the literal 'default' label any more", () => {
    expect(isBuiltInMic("Default - Focusrite Scarlett 2i2")).toBe(false);
    expect(isBuiltInMic("Default")).toBe(false);
  });

  it("does not match real interface labels", () => {
    expect(isBuiltInMic("Focusrite Scarlett 2i2")).toBe(false);
    expect(isBuiltInMic("Shure MV7")).toBe(false);
  });
});

describe("resolveDefaultDevice", () => {
  it("resolves 'default' to its underlying device by groupId", () => {
    const devices = [
      dev("default", "Default - Focusrite Scarlett 2i2", "g1"),
      dev("abc123", "Focusrite Scarlett 2i2", "g1"),
      dev("xyz789", "MacBook Pro Microphone", "g2"),
    ];
    const resolved = resolveDefaultDevice(devices, "default");
    expect(resolved?.deviceId).toBe("abc123");
  });

  it("falls back to label parsing when groupIds don't match", () => {
    const devices = [
      dev("default", "Default - Focusrite Scarlett 2i2", ""),
      dev("abc123", "Focusrite Scarlett 2i2", ""),
    ];
    const resolved = resolveDefaultDevice(devices, "default");
    expect(resolved?.deviceId).toBe("abc123");
  });

  it("returns the device itself for non-default selections", () => {
    const devices = [
      dev("default", "Default - Focusrite Scarlett 2i2", "g1"),
      dev("abc123", "Focusrite Scarlett 2i2", "g1"),
    ];
    const resolved = resolveDefaultDevice(devices, "abc123");
    expect(resolved?.deviceId).toBe("abc123");
  });

  it("returns the default entry itself when nothing else matches", () => {
    const devices = [dev("default", "Default", "")];
    const resolved = resolveDefaultDevice(devices, "default");
    expect(resolved?.deviceId).toBe("default");
  });

  it("does not match an unrelated device when the parsed fallback label is empty", () => {
    // Chrome can briefly expose "Default - " during device transitions; an
    // empty parsed name must not match every label via endsWith("").
    const devices = [
      dev("default", "Default - ", ""),
      dev("abc123", "Focusrite Scarlett 2i2", ""),
      dev("xyz789", "MacBook Pro Microphone", ""),
    ];
    const resolved = resolveDefaultDevice(devices, "default");
    expect(resolved?.deviceId).toBe("default");
  });
});

describe("isSelectedMicBuiltIn", () => {
  it("does NOT warn when default resolves to a real interface", () => {
    const devices = [
      dev("default", "Default - Focusrite Scarlett 2i2", "g1"),
      dev("abc123", "Focusrite Scarlett 2i2", "g1"),
      dev("xyz789", "MacBook Pro Microphone", "g2"),
    ];
    expect(isSelectedMicBuiltIn(devices, "default")).toBe(false);
  });

  it("warns when default resolves to the MacBook built-in mic", () => {
    const devices = [
      dev("default", "Default - MacBook Pro Microphone", "g2"),
      dev("xyz789", "MacBook Pro Microphone", "g2"),
    ];
    expect(isSelectedMicBuiltIn(devices, "default")).toBe(true);
  });

  it("warns when the user explicitly picks the built-in mic", () => {
    const devices = [
      dev("default", "Default - Focusrite Scarlett 2i2", "g1"),
      dev("abc123", "Focusrite Scarlett 2i2", "g1"),
      dev("xyz789", "MacBook Pro Microphone", "g2"),
    ];
    expect(isSelectedMicBuiltIn(devices, "xyz789")).toBe(true);
  });

  it("does not warn for an unknown deviceId", () => {
    const devices = [dev("abc123", "Focusrite Scarlett 2i2", "g1")];
    expect(isSelectedMicBuiltIn(devices, "missing")).toBe(false);
  });

  it("when a USB mic shares the default label stem, no built-in warning must appear", () => {
    const devices = [
      dev("default", "Default - Shure MV7", ""),
      dev("abc123", "USB Audio - Shure MV7", ""),
      dev("xyz789", "MacBook Pro Microphone", ""),
    ];
    expect(isSelectedMicBuiltIn(devices, "default")).toBe(false);
  });

  it("when the device list is empty, lookup must return empty results without throwing", () => {
    expect(resolveDefaultDevice([], "default")).toBeUndefined();
    expect(isSelectedMicBuiltIn([], "default")).toBe(false);
  });

  it("when multiple default-like entries exist, the selected default must resolve gracefully", () => {
    const devices = [
      dev("default", "Default - Shure MV7", "g1"),
      dev("communications", "Default - MacBook Pro Microphone", "g2"),
      dev("abc123", "Shure MV7", "g1"),
      dev("xyz789", "MacBook Pro Microphone", "g2"),
    ];

    expect(resolveDefaultDevice(devices, "default")?.deviceId).toBe("abc123");
    expect(isSelectedMicBuiltIn(devices, "default")).toBe(false);
  });
});
