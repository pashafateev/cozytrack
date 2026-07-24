"use client";

/**
 * LavaLamp — the Sunset studio centerpiece.
 *
 * React port of the design handoff's `lava-lamp.js` web-component engine
 * (metaball wax canvas sandwiched between two SVG layers). The physics,
 * palette, and perf constants are kept exactly; the reference engine's
 * internal 3-voice speech simulation is replaced by per-participant levels
 * passed in as props (0..1, index-aligned with the room's speaker order).
 *
 * The component always renders "bare": no internal backdrop — it sits over
 * the room's own aurora/starfield and casts a radial halo whose color tracks
 * the loudest speaker's hue, so the glow itself identifies the speaker.
 *
 * Sizing contract: the parent must give this component a box with
 * aspect-ratio 400/640 (the canvas scale assumes it).
 *
 * `prefers-reduced-motion`: the wax freezes (one static field render) and
 * ripples/bubbles/halo animation are disabled.
 */

import { useEffect, useRef } from "react";
import { SPEAKER_WAX_RGB } from "@/lib/speaker-hues";

// ---------- Constants ported verbatim from lava-lamp.js ----------

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

// Interior wax bounds within the 400×640 viewBox, and the glass clip path.
const IB = { x: 118, y: 68, w: 164, h: 363 };
const INTERIOR =
  "M 118 431 C 124 300 151 184 158 106 Q 200 68 242 106 C 249 184 276 300 282 431 Z";

const PAL_TOP = [150, 100, 255] as const;
const PAL_MID = [255, 60, 130] as const;
const PAL_BOT = [255, 150, 60] as const;
const CORE_TOP = [255, 215, 235] as const;
const CORE_BOT = [255, 190, 120] as const;

// "Gooey" mode — the only mode the app ships. (The reference engine also
// carries a snappier "classic": nb 7, thr 0.90, soft 2.4, vEase 1.6, tvk 0.115.)
const MODE = { nb: 9, thr: 0.82, soft: 1.9, vEase: 0.9, tvk: 0.055, ripples: true };

// Perspective taper: interior x-coordinates squeeze toward the neck.
const taper = (y: number) => 0.45 + 0.55 * y;

// Audio easing per frame (attack while rising, release while falling).
const ATTACK = 0.12;
const RELEASE = 0.04;

// ---------- SVG shells (bare variant: vessel + base + glass, no backdrop) ----------

let lampInstanceCounter = 0;

function backSvg(uid: string): string {
  return `<svg viewBox="0 0 400 640" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;display:block">
    <defs>
      <linearGradient id="liquid-${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3b2a72"/><stop offset="0.38" stop-color="#6d2160"/><stop offset="0.72" stop-color="#a83648"/><stop offset="1" stop-color="#d9622e"/>
      </linearGradient>
      <linearGradient id="metalB-${uid}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#17102b"/><stop offset="0.38" stop-color="#372a63"/><stop offset="0.50" stop-color="#4a3a80"/><stop offset="0.66" stop-color="#241a45"/><stop offset="1" stop-color="#110d22"/>
      </linearGradient>
      <linearGradient id="metalShadeB-${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(0,0,0,0)"/><stop offset="1" stop-color="rgba(0,0,0,0.40)"/>
      </linearGradient>
    </defs>
    <ellipse cx="200" cy="612" rx="122" ry="11" fill="rgba(4,2,14,0.55)"/>
    <path d="M 149 452 L 251 452 C 253 486 270 544 293 597 Q 297 607 285 607 L 115 607 Q 103 607 107 597 C 130 544 147 486 149 452 Z" fill="url(#metalB-${uid})"/>
    <path d="M 149 452 L 251 452 C 253 486 270 544 293 597 Q 297 607 285 607 L 115 607 Q 103 607 107 597 C 130 544 147 486 149 452 Z" fill="url(#metalShadeB-${uid})"/>
    <path d="M 112 434 C 118 300 146 180 154 102 Q 200 60 246 102 C 254 180 282 300 288 434 Z" fill="url(#liquid-${uid})"/>
  </svg>`;
}

function frontSvg(uid: string): string {
  return `<svg viewBox="0 0 400 640" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;display:block">
    <defs>
      <linearGradient id="shadeL-${uid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(12,6,32,0.50)"/><stop offset="1" stop-color="rgba(12,6,32,0)"/></linearGradient>
      <linearGradient id="shadeR-${uid}" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="rgba(12,6,32,0.50)"/><stop offset="1" stop-color="rgba(12,6,32,0)"/></linearGradient>
      <linearGradient id="specV-${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(255,255,255,0)"/><stop offset="0.10" stop-color="rgba(255,255,255,0.55)"/><stop offset="0.5" stop-color="rgba(255,255,255,0.14)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/>
      </linearGradient>
      <linearGradient id="sheen-${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(255,255,255,0.07)"/><stop offset="0.28" stop-color="rgba(255,255,255,0.015)"/><stop offset="0.85" stop-color="rgba(255,255,255,0.02)"/><stop offset="1" stop-color="rgba(255,255,255,0.06)"/>
      </linearGradient>
      <linearGradient id="metalF-${uid}" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#17102b"/><stop offset="0.38" stop-color="#372a63"/><stop offset="0.50" stop-color="#4a3a80"/><stop offset="0.66" stop-color="#241a45"/><stop offset="1" stop-color="#110d22"/>
      </linearGradient>
      <linearGradient id="metalShadeF-${uid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(0,0,0,0)"/><stop offset="1" stop-color="rgba(0,0,0,0.40)"/></linearGradient>
      <filter id="soft1-${uid}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.2"/></filter>
      <filter id="soft3-${uid}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3"/></filter>
    </defs>
    <path d="M 118 428 C 124 300 151 186 158 108 L 172 108 C 165 186 137 300 131 428 Z" fill="url(#shadeL-${uid})" filter="url(#soft3-${uid})" opacity="0.6"/>
    <path d="M 282 428 C 276 300 249 186 242 108 L 228 108 C 235 186 263 300 269 428 Z" fill="url(#shadeR-${uid})" filter="url(#soft3-${uid})" opacity="0.6"/>
    <path d="M 163 126 C 157 210 141 300 136 380" stroke="url(#specV-${uid})" stroke-width="9" fill="none" stroke-linecap="round" filter="url(#soft3-${uid})" opacity="0.75"/>
    <path d="M 162 130 C 156 210 142 296 137 366" stroke="url(#specV-${uid})" stroke-width="3" fill="none" stroke-linecap="round" filter="url(#soft1-${uid})" opacity="0.85"/>
    <path d="M 239 132 C 245 196 251 254 255 306" stroke="url(#specV-${uid})" stroke-width="5" fill="none" stroke-linecap="round" filter="url(#soft3-${uid})" opacity="0.38"/>
    <path d="M 112 434 C 118 300 146 180 154 102 Q 200 60 246 102 C 254 180 282 300 288 434 Z" fill="url(#sheen-${uid})"/>
    <path d="M 112 434 C 118 300 146 180 154 102 Q 200 60 246 102 C 254 180 282 300 288 434 Z" fill="none" stroke="rgba(235,205,255,0.30)" stroke-width="2"/>
    <path d="M 116 426 L 284 426 Q 292 426 292 434 L 292 446 Q 292 452 284 452 L 116 452 Q 108 452 108 446 L 108 434 Q 108 426 116 426 Z" fill="url(#metalF-${uid})"/>
    <path d="M 116 426 L 284 426 Q 292 426 292 434 L 292 446 Q 292 452 284 452 L 116 452 Q 108 452 108 446 L 108 434 Q 108 426 116 426 Z" fill="url(#metalShadeF-${uid})" opacity="0.5"/>
    <line x1="114" y1="429" x2="286" y2="429" stroke="rgba(200,170,255,0.20)" stroke-width="1.5"/>
    <path d="M 174 30 L 226 30 C 231 30 233 32 234 37 L 247 90 Q 249 100 240 100 L 160 100 Q 151 100 153 90 L 166 37 C 167 32 169 30 174 30 Z" fill="url(#metalF-${uid})"/>
    <path d="M 174 30 L 226 30 C 231 30 233 32 234 37 L 247 90 Q 249 100 240 100 L 160 100 Q 151 100 153 90 L 166 37 C 167 32 169 30 174 30 Z" fill="url(#metalShadeF-${uid})" opacity="0.45"/>
    <line x1="156" y1="97" x2="244" y2="97" stroke="rgba(190,160,255,0.22)" stroke-width="1.5"/>
    <g id="recBadge-${uid}">
      <circle cx="200" cy="520" r="27" fill="rgba(255,77,125,0.10)" stroke="#ff5e8a" stroke-width="2.5"/>
      <rect x="193" y="504" width="14" height="23" rx="7" fill="#ff5e8a"/>
      <path d="M 186 519 a 14 14 0 0 0 28 0" fill="none" stroke="#ff8fb0" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="200" y1="533" x2="200" y2="539" stroke="#ff8fb0" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="192" y1="539" x2="208" y2="539" stroke="#ff8fb0" stroke-width="2.5" stroke-linecap="round"/>
    </g>
  </svg>`;
}

// ---------- Engine state ----------

interface Blob_ {
  pool?: boolean;
  x0?: number;
  x: number;
  y: number;
  r: number;
  re: number;
  heat?: number;
  vy?: number;
  ph?: number;
  ws?: number;
  wob?: number;
}

interface Bubble {
  x: number;
  y: number;
  r: number;
  v: number;
  ph: number;
  c: readonly [number, number, number] | number[];
}

interface Ripple {
  x: number;
  r: number;
  life: number;
  col: readonly [number, number, number] | number[];
}

export interface LavaLampProps {
  /**
   * Per-speaker target levels in [0, 1], index-aligned with the room's
   * speaker order (same order as chips/dots). Hues cycle through the
   * Sunset speaker palette by index.
   */
  levels?: ReadonlyArray<number>;
  /** Home/pre-join mode: levels forced to 0, calm drift, gray badge. */
  idle?: boolean;
  /** Recording — the mic badge on the base glows red and softly pulses. */
  rec?: boolean;
  /** Ease the wax mid-palette toward the loudest speaker's hue. */
  tint?: boolean;
  seed?: number;
  className?: string;
}

export function LavaLamp({
  levels,
  idle = false,
  rec = false,
  tint = true,
  seed = 0,
  className = "",
}: LavaLampProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const haloRef = useRef<HTMLDivElement>(null);

  const uidRef = useRef<string | null>(null);
  if (uidRef.current === null) uidRef.current = `ll${lampInstanceCounter++}`;
  const uid = uidRef.current;

  // Latest props, readable from the animation loop without re-subscribing.
  const levelsRef = useRef<ReadonlyArray<number>>(levels ?? []);
  const idleRef = useRef(idle);
  const recRef = useRef(rec);
  const tintRef = useRef(tint);
  useEffect(() => {
    levelsRef.current = levels ?? [];
  }, [levels]);
  useEffect(() => {
    idleRef.current = idle;
  }, [idle]);
  useEffect(() => {
    recRef.current = rec;
  }, [rec]);
  useEffect(() => {
    tintRef.current = tint;
  }, [tint]);

  // REC badge base state — red when recording, grayed otherwise. The pulse
  // itself runs inside the frame loop.
  useEffect(() => {
    const badge = rootRef.current?.querySelector<SVGGElement>(`#recBadge-${uid}`);
    if (!badge) return;
    if (rec) {
      badge.style.filter = "";
      badge.setAttribute("opacity", "1");
    } else {
      badge.style.filter = "grayscale(1)";
      badge.setAttribute("opacity", "0.4");
    }
  }, [rec, uid]);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const halo = haloRef.current;
    if (!root || !canvas || !halo) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // No 2D canvas (test DOMs) — render the SVG shell only.

    const off = document.createElement("canvas");
    const octx = off.getContext("2d");
    if (!octx) return;

    // Deterministic per-instance randomness for blob layout.
    let rngSeed = 11 + (seed || 0);
    const rng = () => ((rngSeed = (rngSeed * 16807) % 2147483647) / 2147483647);

    const gw = 96;
    const gh = Math.round((96 * IB.h) / IB.w);
    off.width = gw;
    off.height = gh;
    const img = octx.createImageData(gw, gh);
    const rowCol = new Float32Array(gh * 3);
    const coreCol = new Float32Array(gh * 3);
    const mid: number[] = [PAL_MID[0], PAL_MID[1], PAL_MID[2]];
    const interior = new Path2D(INTERIOR);
    const badge = root.querySelector<SVGGElement>(`#recBadge-${uid}`);

    function buildRows() {
      for (let gy = 0; gy < gh; gy++) {
        const k = gy / (gh - 1);
        let a: readonly number[], b: readonly number[], kk: number;
        if (k < 0.5) {
          a = PAL_TOP;
          b = mid;
          kk = k * 2;
        } else {
          a = mid;
          b = PAL_BOT;
          kk = (k - 0.5) * 2;
        }
        rowCol[gy * 3] = lerp(a[0], b[0], kk);
        rowCol[gy * 3 + 1] = lerp(a[1], b[1], kk);
        rowCol[gy * 3 + 2] = lerp(a[2], b[2], kk);
        coreCol[gy * 3] = lerp(CORE_TOP[0], CORE_BOT[0], k);
        coreCol[gy * 3 + 1] = lerp(CORE_TOP[1], CORE_BOT[1], k);
        coreCol[gy * 3 + 2] = lerp(CORE_TOP[2], CORE_BOT[2], k);
      }
    }
    buildRows();

    const blobs: Blob_[] = [{ pool: true, x: 0.5, y: 0.92, r: 0.3, re: 0.3 }];
    for (let i = 0; i < MODE.nb; i++) {
      blobs.push({
        x0: 0.22 + rng() * 0.56,
        x: 0,
        y: 0.14 + rng() * 0.7,
        r: 0.09 + rng() * 0.085,
        re: 0.1,
        heat: rng(),
        vy: 0,
        ph: rng() * Math.PI * 2,
        ws: 0.25 + rng() * 0.5,
        wob: rng() * Math.PI * 2,
      });
    }

    const bubbles: Bubble[] = [];
    const ripples: Ripple[] = [];
    // Per-voice eased levels + onset bookkeeping, sized lazily to the
    // largest speaker count seen.
    let lvls: number[] = [];
    let prev: number[] = [];
    let cool: number[] = [];
    let quiet = 0;
    let smix = 0;
    let scale = 1;
    let fieldReady = false;
    let haloCol = "";
    let visible = true;
    let raf = 0;
    let fc = 0;
    let last = performance.now() / 1000;
    let t = 0;

    function fit() {
      const r = root!.getBoundingClientRect();
      if (!r.width) return;
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const w = Math.round(r.width * dpr);
      const h = Math.round(r.height * dpr);
      // Guard: only touch canvas dims when the size actually changed —
      // setting .width clears the canvas and forces a full repaint.
      if (w === canvas!.width && h === canvas!.height) return;
      canvas!.width = w;
      canvas!.height = h;
      scale = w / 400;
    }

    function renderField(level: number) {
      const n = blobs.length;
      const unit = Math.min(gw, gh);
      const px = new Float32Array(n),
        py = new Float32Array(n),
        pr2 = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        const b = blobs[j];
        px[j] = (0.5 + (b.x - 0.5) * taper(b.y)) * gw;
        py[j] = b.y * gh;
        const r = b.re * unit;
        pr2[j] = r * r;
      }
      const d = img.data;
      const glow = 0.88 + level * 0.3;
      let i = 0;
      for (let gy = 0; gy < gh; gy++) {
        const cr = rowCol[gy * 3],
          cg = rowCol[gy * 3 + 1],
          cb = rowCol[gy * 3 + 2];
        const kr = coreCol[gy * 3],
          kg = coreCol[gy * 3 + 1],
          kb = coreCol[gy * 3 + 2];
        for (let gx = 0; gx < gw; gx++) {
          let f = 0;
          for (let j = 0; j < n; j++) {
            const dx = gx - px[j],
              dy = gy - py[j];
            f += pr2[j] / (dx * dx + dy * dy + 1);
          }
          let a = (f - MODE.thr) * MODE.soft;
          if (a <= 0) {
            d[i + 3] = 0;
            i += 4;
            continue;
          }
          if (a > 1) a = 1;
          const core = Math.min(0.82, clamp((f - 3.4) / 4.6, 0, 1)) * glow;
          const rim = 1 - Math.max(0, 1 - Math.abs(f - 1.25) / 0.55) * 0.28;
          d[i] = (cr + (kr - cr) * core) * rim;
          d[i + 1] = (cg + (kg - cg) * core) * rim;
          d[i + 2] = (cb + (kb - cb) * core) * rim;
          d[i + 3] = a * 255;
          i += 4;
        }
      }
      octx!.putImageData(img, 0, 0);
    }

    function paint(calm: number) {
      const c = ctx!;
      c.setTransform(scale, 0, 0, scale, 0, 0);
      c.clearRect(0, 0, 400, 640);
      const heat = c.createRadialGradient(200, 434, 4, 200, 434, 150);
      heat.addColorStop(
        0,
        `rgba(255,160,95,${(0.24 + smix * 0.34) * (1 - 0.4 * calm)})`,
      );
      heat.addColorStop(1, "rgba(255,160,95,0)");
      c.fillStyle = heat;
      c.fillRect(IB.x, IB.y, IB.w, IB.h);
      c.imageSmoothingEnabled = true;
      // Metaball field is the CPU hot spot — recompute at ~2/3 of frames,
      // composite every frame (30fps field under a 60fps composite).
      if (fc !== 1 || !fieldReady) {
        renderField(smix);
        fieldReady = true;
      }
      c.drawImage(off, IB.x, IB.y, IB.w, IB.h);
      for (const r of ripples) {
        const cx = IB.x + (0.5 + (r.x - 0.5) * taper(0.86)) * IB.w;
        const cy = IB.y + 0.86 * IB.h;
        c.strokeStyle = `rgba(${r.col[0]},${r.col[1]},${r.col[2]},${(r.life * 0.35).toFixed(3)})`;
        c.lineWidth = 2;
        c.beginPath();
        c.ellipse(cx, cy, r.r, r.r * 0.32, 0, 0, Math.PI * 2);
        c.stroke();
      }
      for (const b of bubbles) {
        const tx = 0.5 + (b.x + 0.02 * Math.sin(t * 1.2 + b.ph) - 0.5) * taper(b.y);
        const bx = IB.x + tx * IB.w,
          by = IB.y + b.y * IB.h;
        c.fillStyle = `rgba(${b.c[0]},${b.c[1]},${b.c[2]},0.38)`;
        c.beginPath();
        c.arc(bx, by, b.r, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "rgba(255,255,255,0.35)";
        c.beginPath();
        c.arc(bx - b.r * 0.3, by - b.r * 0.35, b.r * 0.32, 0, Math.PI * 2);
        c.fill();
      }
      c.globalCompositeOperation = "destination-in";
      c.fillStyle = "#fff";
      c.fill(interior);
      c.globalCompositeOperation = "source-over";
    }

    function setHalo(calm: number) {
      const qc = (x: number) => Math.round(x / 8) * 8;
      const col = `${qc(mid[0])},${qc(mid[1])},${qc(mid[2])}`;
      if (col !== haloCol) {
        haloCol = col;
        halo!.style.background = `radial-gradient(closest-side, rgba(${col},0.50), rgba(${col},0.22) 45%, rgba(${col},0) 74%)`;
      }
      halo!.style.opacity = (0.5 + smix * 0.5 - calm * 0.15).toFixed(3);
    }

    function frame(nowMs: number) {
      raf = requestAnimationFrame(frame);
      const now = nowMs / 1000;
      let dt = Math.min(0.05, Math.max(0.001, now - last));
      last = now;
      dt *= 0.5; // half-speed world clock — real lava-lamp pace
      if (!visible || document.hidden || !canvas!.width) return;
      t += dt;
      fc = (fc + 1) % 3;

      // Voices — eased toward the prop-fed analyser levels.
      const targets = idleRef.current ? [] : levelsRef.current;
      const n = Math.max(targets.length, lvls.length);
      while (lvls.length < n) {
        lvls.push(0);
        prev.push(0);
        cool.push(0);
      }
      let mix = 0,
        active = -1,
        best = 0.15;
      for (let v = 0; v < n; v++) {
        const tgt = clamp(targets[v] ?? 0, 0, 1);
        lvls[v] += (tgt - lvls[v]) * (tgt > lvls[v] ? ATTACK : RELEASE);
        mix = Math.max(mix, lvls[v]);
        if (lvls[v] > best) {
          best = lvls[v];
          active = v;
        }
        cool[v] = Math.max(0, cool[v] - dt);
        if (MODE.ripples && lvls[v] > 0.3 && prev[v] <= 0.3 && cool[v] <= 0) {
          ripples.push({
            x: 0.3 + (v % 3) * 0.2,
            r: 8,
            life: 1,
            col: SPEAKER_WAX_RGB[v % SPEAKER_WAX_RGB.length],
          });
          cool[v] = 1.1;
        }
        prev[v] = lvls[v];
      }
      // Silence settle — after ~1.5s below 0.06 the room visibly relaxes.
      if (mix < 0.06) quiet += dt;
      else quiet = 0;
      const calm = clamp((quiet - 1.5) / 2.5, 0, 1);
      smix += (mix - smix) * Math.min(1, dt * 1.3);
      const energy = (1 + smix * 1.6) * (1 - 0.4 * calm);

      // Speaker tint — wax mid-palette eases toward the loudest speaker.
      const target =
        tintRef.current && active >= 0
          ? SPEAKER_WAX_RGB[active % SPEAKER_WAX_RGB.length]
          : PAL_MID;
      const ek = Math.min(1, dt * 0.9);
      let moved = false;
      for (let i = 0; i < 3; i++) {
        const d = (target[i] - mid[i]) * ek;
        if (Math.abs(d) > 0.05) {
          mid[i] += d;
          moved = true;
        }
      }
      if (moved) buildRows();

      // Throttled non-canvas writes (halo, badge) — every 3rd frame.
      if (fc === 0) {
        setHalo(calm);
        if (badge && recRef.current) {
          badge.setAttribute("opacity", (0.8 + 0.2 * Math.sin(t * 1.6)).toFixed(3));
        }
      }

      // Blobs
      for (const b of blobs) {
        if (b.pool) {
          b.y = 0.9 + 0.02 * Math.sin(t * 0.35);
          b.re = b.r * (1 + smix * 0.1 + 0.02 * Math.sin(t * 0.9));
          continue;
        }
        if (b.y > 0.7) b.heat! += dt * 0.04 * energy;
        else if (b.y < 0.3) b.heat! -= dt * 0.047 * energy;
        else b.heat! -= dt * 0.012;
        b.heat = clamp(b.heat!, 0, 1);
        const tv = (b.heat - 0.46) * MODE.tvk * energy;
        b.vy! += (tv - b.vy!) * Math.min(1, dt * MODE.vEase);
        b.y = clamp(b.y - b.vy! * dt, 0.1, 0.94);
        b.x =
          b.x0! +
          Math.sin(t * b.ws! * 0.6 + b.ph!) * (0.03 + smix * 0.02) +
          0.012 * Math.sin(t * 0.45 + b.wob!);
        b.re = b.r * (1 + smix * 0.12 + 0.035 * Math.sin(t * 0.8 + b.wob!));
      }

      // Bubbles: sparse neutral ambient + per-speaker colored streams.
      if (Math.random() < dt * 0.22 * (1 - 0.7 * calm) && bubbles.length < 24) {
        bubbles.push({
          x: 0.25 + Math.random() * 0.5,
          y: 0.96,
          r: 2 + Math.random() * 2.4,
          v: 0.028 + Math.random() * 0.022,
          ph: Math.random() * 6,
          c: [255, 220, 205],
        });
      }
      for (let v = 0; v < n; v++) {
        if (
          !idleRef.current &&
          lvls[v] > 0.2 &&
          Math.random() < dt * lvls[v] * 1.6 &&
          bubbles.length < 30
        ) {
          bubbles.push({
            x: 0.22 + (v % 3) * 0.2 + Math.random() * 0.16,
            y: 0.96,
            r: 2.2 + Math.random() * 2.8,
            v: 0.03 + Math.random() * 0.025,
            ph: Math.random() * 6,
            c: SPEAKER_WAX_RGB[v % SPEAKER_WAX_RGB.length],
          });
        }
      }
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const b = bubbles[i];
        b.y -= b.v * (1 + smix * 0.25) * dt;
        if (b.y < 0.05) bubbles.splice(i, 1);
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        r.r += dt * 40;
        r.life -= dt * 0.55;
        if (r.life <= 0) ripples.splice(i, 1);
      }

      paint(calm);
    }

    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let ro: ResizeObserver | null = null;
    let io: IntersectionObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        fit();
        // A resize clears the canvas; repaint immediately in static mode.
        if (reduced && canvas.width) {
          fieldReady = false;
          paint(0);
        }
      });
      ro.observe(root);
    }
    fit();

    if (reduced) {
      // Reduced motion: one static field, no ripples/bubbles, resting halo.
      // Advance the world once so the wax reads mid-drift, not stacked.
      t = 8;
      for (const b of blobs) {
        if (b.pool) continue;
        b.x = b.x0! + Math.sin(t * b.ws! * 0.6 + b.ph!) * 0.03;
        b.re = b.r;
      }
      setHalo(0);
      if (canvas.width) paint(0);
      return () => {
        ro?.disconnect();
      };
    }

    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((es) => {
        for (const e of es) visible = e.isIntersecting;
      });
      io.observe(root);
    }

    setHalo(0);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      io?.disconnect();
    };
    // The engine mounts once; live inputs stream in through refs.
  }, [seed, uid]);

  return (
    <div
      ref={rootRef}
      className={`relative w-full h-full ${className}`}
      style={{ contain: "layout" }}
      aria-hidden="true"
    >
      <div
        ref={haloRef}
        className="absolute pointer-events-none"
        style={{ inset: "-45% -75%", opacity: 0.5 }}
      />
      <div
        className="absolute inset-0"
        dangerouslySetInnerHTML={{ __html: backSvg(uid) }}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full block"
      />
      <div
        className="absolute inset-0"
        dangerouslySetInnerHTML={{ __html: frontSvg(uid) }}
      />
    </div>
  );
}
