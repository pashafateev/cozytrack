import { describe, expect, it } from "vitest";
import { shouldInterceptAnchorClick } from "../src/hooks/useNavigationGuard";

const ORIGIN = "https://app.cozytrack.test";
const STUDIO_PATH = "/studio/abc123";

function click(overrides: Partial<Parameters<typeof shouldInterceptAnchorClick>[0]> = {}) {
  return shouldInterceptAnchorClick(
    {
      href: "/dashboard",
      target: null,
      hasDownload: false,
      modifierPressed: false,
      button: 0,
      ...overrides,
    },
    ORIGIN,
    STUDIO_PATH,
  );
}

describe("shouldInterceptAnchorClick", () => {
  it("intercepts a plain in-app navigation away from the studio", () => {
    expect(click({ href: "/dashboard" })).toBe(true);
    expect(click({ href: "/" })).toBe(true);
    expect(click({ href: `${ORIGIN}/dashboard` })).toBe(true);
  });

  it("does not intercept clicks targeting a different tab/window", () => {
    expect(click({ target: "_blank" })).toBe(false);
    expect(click({ target: "external" })).toBe(false);
  });

  it("does not intercept modified clicks (open-in-new-tab gestures)", () => {
    expect(click({ modifierPressed: true })).toBe(false);
  });

  it("ignores non-primary mouse buttons", () => {
    expect(click({ button: 1 })).toBe(false);
    expect(click({ button: 2 })).toBe(false);
  });

  it("does not intercept download links", () => {
    expect(click({ hasDownload: true })).toBe(false);
  });

  it("does not intercept non-http(s) schemes", () => {
    expect(click({ href: "mailto:hello@cozytrack.test" })).toBe(false);
    expect(click({ href: "tel:+15555550123" })).toBe(false);
    expect(click({ href: "javascript:void(0)" })).toBe(false);
    expect(click({ href: "blob:https://example.com/abc" })).toBe(false);
  });

  it("does not intercept cross-origin links", () => {
    expect(click({ href: "https://example.com/anywhere" })).toBe(false);
  });

  it("does not intercept same-pathname links (in-page anchors / re-clicks)", () => {
    expect(click({ href: STUDIO_PATH })).toBe(false);
    expect(click({ href: `${STUDIO_PATH}#invite` })).toBe(false);
    expect(click({ href: `${ORIGIN}${STUDIO_PATH}` })).toBe(false);
  });

  it("does not intercept anchors without an href", () => {
    expect(click({ href: null })).toBe(false);
    expect(click({ href: "" })).toBe(false);
  });

  it("treats target='_self' the same as no target", () => {
    expect(click({ target: "_self" })).toBe(true);
    expect(click({ target: "" })).toBe(true);
  });

  it("intercepts query-only navigation that changes pathname", () => {
    expect(click({ href: "/dashboard?from=studio" })).toBe(true);
  });
});
