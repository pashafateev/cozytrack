import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LavaLamp } from "@/components/LavaLamp";

// The metaball field is the engine's CPU hot spot. The design contract is a
// 30fps field under a 60fps composite — i.e. the offscreen field buffer is
// recomputed (putImageData) on exactly every other animation frame, not two
// of every three.

type RafCb = (t: number) => void;

describe("LavaLamp field scheduler", () => {
  let rafQueue: RafCb[];
  let putImageDataCalls: number;

  function makeCtx(canvas: HTMLCanvasElement) {
    return {
      canvas,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      imageSmoothingEnabled: true,
      globalCompositeOperation: "source-over",
      setTransform() {},
      clearRect() {},
      fillRect() {},
      createRadialGradient() {
        return { addColorStop() {} };
      },
      createImageData(w: number, h: number) {
        return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
      },
      putImageData() {
        putImageDataCalls++;
      },
      drawImage() {},
      beginPath() {},
      arc() {},
      ellipse() {},
      fill() {},
      stroke() {},
    };
  }

  beforeEach(() => {
    rafQueue = [];
    putImageDataCalls = 0;

    vi.stubGlobal("Path2D", class {});
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (cb: RafCb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: false,
      media: "",
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 400,
      height: 640,
      top: 0,
      left: 0,
      right: 400,
      bottom: 640,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    } as DOMRect);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        return makeCtx(this) as unknown as CanvasRenderingContext2D;
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("recomputes the field on every other frame (30fps under 60fps)", () => {
    render(React.createElement(LavaLamp, { levels: [0.5] }));

    // The engine schedules its first frame on mount.
    expect(rafQueue.length).toBe(1);

    const t0 = performance.now();
    const frames = 12;
    for (let i = 0; i < frames; i++) {
      const cb = rafQueue.shift();
      expect(cb).toBeTypeOf("function");
      cb!(t0 + (i + 1) * 16.67);
    }

    // 12 composited frames → exactly 6 field recomputes. The reference
    // prototype's modulo-3 gate produced 8 (≈40fps) — the design contract
    // says half rate.
    expect(putImageDataCalls).toBe(frames / 2);
  });
});
