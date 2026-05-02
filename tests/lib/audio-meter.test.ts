import { describe, expect, it } from "vitest";
import {
  CLIP_MIN_FRAMES,
  CLIP_THRESHOLD,
  SMOOTHING_PREV_WEIGHT,
  SMOOTHING_TARGET_WEIGHT,
  advanceClipHold,
  shapeLevel,
  smoothLevel,
  type ClipHoldState,
} from "@/lib/audio-meter";

describe("audio meter math", () => {
  it("when levels are shaped, output must stay clamped and monotonic from 0 to 1", () => {
    expect(shapeLevel(0)).toBe(0);
    expect(shapeLevel(1)).toBe(1);
    expect(shapeLevel(-0.5)).toBe(0);
    expect(shapeLevel(1.5)).toBe(1);

    const shaped = [0.01, 0.1, 0.25, 0.5, 0.75, 0.99].map(shapeLevel);
    for (let index = 1; index < shaped.length; index += 1) {
      expect(shaped[index]).toBeGreaterThan(shaped[index - 1]);
    }
  });

  it("when levels are smoothed upward, the value must converge without overshooting and use the documented weights", () => {
    const firstStep = smoothLevel(10, 110);
    expect(firstStep).toBeCloseTo(
      10 * SMOOTHING_PREV_WEIGHT + 110 * SMOOTHING_TARGET_WEIGHT,
    );

    let level = 0;
    for (let index = 0; index < 20; index += 1) {
      const next = smoothLevel(level, 100);
      expect(next).toBeGreaterThanOrEqual(level);
      expect(next).toBeLessThanOrEqual(100);
      level = next;
    }
    expect(level).toBeGreaterThan(99);
  });

  it("when levels are smoothed downward, the value must converge without undershooting", () => {
    let level = 100;
    for (let index = 0; index < 20; index += 1) {
      const next = smoothLevel(level, 0);
      expect(next).toBeLessThanOrEqual(level);
      expect(next).toBeGreaterThanOrEqual(0);
      level = next;
    }
    expect(level).toBeLessThan(1);
  });

  it("when clipping latches, the indicator must remain visible for exactly the configured hold frames", () => {
    let state: ClipHoldState = { consecutiveClipFrames: 0, holdFrames: 0 };
    const visible: boolean[] = [];

    for (let index = 0; index < CLIP_MIN_FRAMES; index += 1) {
      const step = advanceClipHold(state, CLIP_THRESHOLD, CLIP_MIN_FRAMES);
      state = step.state;
      visible.push(step.isClipping);
    }

    for (let index = 0; index < CLIP_MIN_FRAMES; index += 1) {
      const step = advanceClipHold(state, 0, CLIP_MIN_FRAMES);
      state = step.state;
      visible.push(step.isClipping);
    }

    const release = advanceClipHold(state, 0, CLIP_MIN_FRAMES);

    expect(visible).toEqual([false, true, true, false]);
    expect(release.isClipping).toBe(false);
    expect(release.state.holdFrames).toBe(0);
  });

  it("when stats are missing, clip hold state must advance exactly like a below-threshold sample", () => {
    const state: ClipHoldState = {
      consecutiveClipFrames: CLIP_MIN_FRAMES,
      holdFrames: 3,
    };

    const missingStats = advanceClipHold(state, undefined, 4);
    const belowThreshold = advanceClipHold(state, CLIP_THRESHOLD - 0.01, 4);

    expect(missingStats).toEqual(belowThreshold);
  });
});
