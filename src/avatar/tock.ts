// Tock — Cue's pet: the notch's own capsule shape as a small creature.
// Original to Cue (design/mascots.html). Drawn in Canvas 2D from a handful of
// shapes; every expression is a pose of the same body, eyes and accessories.
//
// The public surface mirrors what island.ts already drives (setState, anim,
// triggerEmote, update, draw, busy…), so the island needs no rewiring. Things
// that only made sense for the old character (outfits, turning into a box)
// are accepted and ignored.

import type { BotEmoteName, BotStateName } from "../core/layout";
import { reducedMotion } from "../core/motion";

export type RGB = readonly [number, number, number]; // components 0…1
export type EyeShape =
  | "pill" | "wide" | "dot" | "line" | "flat" | "happy" | "closed"
  | "spiral" | "heart" | "star" | "tired" | "wink" | "cup";
export type BadgeKind = "dots" | "bang" | "question" | "dot";
export interface Badge { kind: BadgeKind; color: RGB }
type Ease = (t: number) => number;
export type TweenKey = readonly [target: number, durationMs: number, ease: Ease];

const AMBER: RGB = [1, 0.69, 0];
const RED: RGB = [1, 0.353, 0.31];
const INK_DEFAULT = "#16120a";

export function hexToRGB(hex: string): RGB {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
const css = (c: RGB, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** A critically-damped-ish spring with a bounded step: never explodes on a long frame. */
class Spring {
  v: number; t: number; vel = 0;
  private k: number; private d: number;
  constructor(v: number, k = 260, d = 22) { this.v = v; this.t = v; this.k = k; this.d = d; }
  step(dt: number) {
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) { this.vel += (this.k * (this.t - this.v) - this.d * this.vel) * h; this.v += this.vel * h; }
  }
  get settled() { return Math.abs(this.t - this.v) < 0.002 && Math.abs(this.vel) < 0.01; }
  kick(v: number) { this.vel += v; }
}

/** States that keep moving on their own; everything else rests once its springs settle. */
const LIVELY = new Set<BotStateName>(["working", "thinking", "searching", "approval", "question", "ratelimit", "sleeping", "dizzy"]);

const reduced = reducedMotion;

export class TockEngine {
  state: BotStateName = "idle";
  /** −1…1, where the pointer is relative to Tock (island.ts sets these every frame). */
  lookX = 0;
  lookY = 0;
  /** A pill's colour while one is focused; null = Tock's own amber. */
  bodyColor: RGB | null = null;
  /** Extra room above the body for bubbles and zzz, in px. */
  particleOverhang = 0;
  isMini = false;
  /** Island compatibility (the old character could turn into a box). */
  morph = 0; slotH = 0; slotHTarget = 0; slotHVel = 0;
  tgEs = 1;
  eyeOverride: EyeShape | null = null;
  /** The eyes' colour; null = the usual ink. Two sessions side by side each get their own. */
  eyeColor: string | null = null;
  eyeOverrideUntil = 0;
  onDizzy: (() => void) | null = null;

  private time = 0;
  private sx = new Spring(1, 300, 18);
  private sy = new Spring(1, 300, 18);
  private oy = new Spring(0, 220, 20);
  private es = new Spring(1, 400, 26);
  private gx = new Spring(0, 90, 16);
  private gy = new Spring(0, 90, 16);
  private col: RGB = AMBER;
  private blinkAt = 0;
  private blinkUntil = 0;
  private emote: BotEmoteName | null = null;
  private emoteUntil = 0;
  private badge: Badge | null = null;
  private dancing = false;
  private danceLevel = 0;
  private slaps: number[] = [];

  setState(s: BotStateName, instant = false) {
    if (s === this.state) return;
    this.state = s;
    if (instant) return;
    // Each change of mood gets a small physical reaction.
    if (s === "finished") { this.sy.kick(-3); this.oy.kick(-1.6); this.triggerEmote("happy"); }
    else if (s === "approval" || s === "question") { this.sx.kick(1.6); this.sy.kick(-1.6); }
    else if (s === "error") { this.sy.kick(2.2); }
  }

  setBadge(b: Badge | null) { this.badge = b; }
  setPermanentEmote(e: BotEmoteName) { this.emote = e; this.emoteUntil = Number.POSITIVE_INFINITY; }
  permanentEye: EyeShape | null = null;
  setOutfit(_o: unknown, _animate?: boolean) { /* Tock wears accessories by situation, not outfits. */ }
  setDancing(on: boolean) { this.dancing = on; }
  applyDance(_ctx: CanvasRenderingContext2D, _w: number, _h: number) { /* dancing is part of draw() */ }
  animateMorph(_v: number) {}
  resetMorph() {}

  /** island.ts pulses the eyes and body with the voice level through these. */
  anim(prop: string, keys: readonly TweenKey[]) {
    const peak = keys[0]?.[0];
    if (peak == null) return;
    if (prop === "es") this.es.kick((peak - 1) * 18);
    else if (prop === "sy") this.sy.kick((peak - 1) * 22);
    else if (prop === "sx") this.sx.kick((peak - 1) * 22);
    else if (prop === "oy") this.oy.kick(peak * 10);
  }

  triggerEmote(e: BotEmoteName) {
    this.emote = e;
    this.emoteUntil = this.time + (e === "yawn" ? 2.2 : 1.6);
    if (e === "happy" || e === "proud") this.oy.kick(-1.4);
    if (e === "surprised") { this.es.kick(6); this.sy.kick(-2); }
  }
  blink() { this.blinkUntil = this.time + 0.13; }
  /** A poke: a squash; three quick ones make Tock dizzy. */
  slap() {
    this.sy.kick(3); this.sx.kick(-2.4);
    this.slaps = [...this.slaps.filter((t) => this.time - t < 1.2), this.time];
    if (this.slaps.length >= 3) { this.slaps = []; this.onDizzy?.(); }
    else this.triggerEmote("annoyed");
  }
  gulp() { this.sy.kick(-3); this.es.kick(4); }

  get busy(): boolean {
    return LIVELY.has(this.state) || this.dancing || this.danceLevel > 0.01 || this.time < this.emoteUntil || this.time < this.blinkUntil ||
      !this.sx.settled || !this.sy.settled || !this.oy.settled || !this.es.settled || !this.gx.settled || !this.gy.settled ||
      Math.abs(this.col[0] - this.target()[0]) > 0.004;
  }

  private target(): RGB {
    if (this.state === "error") return RED;
    // A near-white pill (VS Code, Cursor) would bleach Tock: it stays amber.
    const c = this.bodyColor;
    return c && Math.min(c[0], c[1], c[2]) < 0.7 ? c : AMBER;
  }

  update(dt: number) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const still = reduced();
    this.danceLevel += ((this.dancing ? 1 : 0) - this.danceLevel) * Math.min(1, dt * 6);
    // Eyes glide toward the pointer, or look where the mood says.
    const s = this.state;
    const look = s === "thinking" ? [0.6, 0.6] : s === "searching" ? [Math.sin(this.time * 2.2), 0] : s === "sleeping" ? [0, 0] : [this.lookX, this.lookY];
    this.gx.t = look[0]; this.gy.t = look[1];
    this.es.t = this.tgEs;
    for (const sp of [this.sx, this.sy, this.oy, this.es, this.gx, this.gy]) { sp.step(dt); if (still) { sp.v = sp.t; sp.vel = 0; } }
    // Body colour eases to the pill's colour or red.
    const k = Math.min(1, dt * 8);
    this.col = mix(this.col, this.target(), still ? 1 : k);
    if (!still && this.time > this.blinkAt) {
      this.blinkUntil = this.time + 0.12;
      this.blinkAt = this.time + 2.6 + Math.random() * 3.4;
    }
  }

  draw(x: CanvasRenderingContext2D, W: number, H: number) {
    const t = reduced() ? 0 : this.time;
    const s = this.state;
    const dance = this.danceLevel;
    // Body box: a capsule about two-thirds of the canvas wide.
    const bw = W * (this.isMini ? 0.62 : 0.56);
    const bh = bw * 0.6;
    const cx = W / 2;
    const top = this.particleOverhang;
    const room = H - top;
    let cy = top + room * 0.56;
    // Moods that move the whole body.
    let rot = 0;
    let breathe = 1 + 0.018 * Math.sin(t * 2);
    if (s === "sleeping") { breathe = 1 + 0.04 * Math.sin(t * 1.1); cy += bh * 0.06; }
    if (s === "working") rot = Math.sin(t * 5) * 0.035;
    if (s === "approval") rot = Math.sin(t * 16) * 0.05 * (Math.sin(t * 2) > 0 ? 1 : 0.2);
    if (s === "question") rot = 0.14;
    if (s === "dizzy") rot = Math.sin(t * 6) * 0.18;
    if (s === "error") rot = -0.08;
    if (dance > 0.01) { rot += Math.sin(t * 4.2) * 0.12 * dance; cy -= Math.abs(Math.sin(t * 4.2)) * bh * 0.16 * dance; }
    cy += this.oy.v * bh * 0.3;

    const sx = this.sx.v * (2 - breathe);
    const sy = this.sy.v * breathe;

    // Contact shadow.
    if (!this.isMini) {
      x.fillStyle = "rgba(0,0,0,.28)";
      x.beginPath();
      x.ellipse(cx, top + room * 0.56 + bh * 0.58, bw * 0.36 * (1 - (top + room * 0.56 - cy) / bh * 0.3), bh * 0.08, 0, 0, Math.PI * 2);
      x.fill();
    }

    x.save();
    x.translate(cx, cy + bh / 2);
    x.rotate(rot);
    x.scale(sx, sy);
    x.translate(0, -bh / 2);

    // Body: warm gradient, soft gloss on top.
    const c = this.col;
    const g = x.createLinearGradient(0, -bh / 2, 0, bh / 2);
    g.addColorStop(0, css(mix(c, [1, 1, 1], 0.22)));
    g.addColorStop(1, css(mix(c, [0.7, 0.25, 0], 0.18)));
    x.fillStyle = g;
    x.beginPath();
    x.roundRect(-bw / 2, -bh / 2, bw, bh, bh / 2);
    x.fill();
    if (!this.isMini) {
      x.fillStyle = "rgba(255,255,255,.28)";
      x.beginPath();
      x.ellipse(-bw * 0.12, -bh * 0.3, bw * 0.24, bh * 0.1, -0.08, 0, Math.PI * 2);
      x.fill();
    }

    this.drawFace(x, bw, bh, t);
    if (dance > 0.3) this.drawHeadphones(x, bw, bh);
    x.restore();

    if (!this.isMini) this.drawAbove(x, cx, cy - bh * 0.05, bw, bh, t);
  }

  private eyeShape(): EyeShape {
    if (this.eyeOverride && (this.time < this.eyeOverrideUntil)) return this.eyeOverride;
    if (this.permanentEye) return this.permanentEye;
    if (this.time < this.emoteUntil && this.emote) {
      return ({ love: "heart", surprised: "wide", proud: "happy", wink: "wink", yawn: "closed", happy: "happy", annoyed: "flat" } as const)[this.emote];
    }
    switch (this.state) {
      case "approval": return "wide";
      case "finished": return "happy";
      case "error": return "star";
      case "ratelimit": return "tired";
      case "sleeping": return "closed";
      case "dizzy": return "spiral";
      case "working": return "flat";
      default: return "pill";
    }
  }

  private drawFace(x: CanvasRenderingContext2D, bw: number, bh: number, t: number) {
    const eye = this.eyeShape();
    const blinking = this.time < this.blinkUntil && (eye === "pill" || eye === "wide");
    const gap = bw * 0.17;
    const ex0 = this.gx.v * bw * 0.06;
    const ey = -bh * 0.06 + this.gy.v * -bh * 0.08;
    const es = this.es.v;
    const ew = bh * 0.17 * es;
    const INK = this.eyeColor ?? INK_DEFAULT;
    x.fillStyle = INK;
    x.strokeStyle = INK;
    x.lineCap = "round";
    x.lineJoin = "round";
    x.lineWidth = Math.max(1.2, bh * 0.11);
    for (const side of [-1, 1]) {
      const ex = side * gap + ex0;
      switch (blinking ? "closed" : eye) {
        case "happy":
          x.beginPath(); x.moveTo(ex - ew * 0.8, ey + bh * 0.06); x.lineTo(ex, ey - bh * 0.08); x.lineTo(ex + ew * 0.8, ey + bh * 0.06); x.stroke(); break;
        case "closed": case "line":
          x.beginPath(); x.moveTo(ex - ew * 0.8, ey + bh * 0.02); x.quadraticCurveTo(ex, ey + bh * 0.09, ex + ew * 0.8, ey + bh * 0.02); x.stroke(); break;
        case "flat":
          x.beginPath(); x.roundRect(ex - ew / 2, ey - bh * 0.05, ew, bh * 0.14, bh * 0.07); x.fill(); break;
        case "tired":
          x.beginPath(); x.roundRect(ex - ew / 2, ey - bh * 0.02, ew, bh * 0.2, bh * 0.07); x.fill();
          x.fillStyle = css(this.col); x.fillRect(ex - ew, ey - bh * 0.12, ew * 2, bh * 0.12); x.fillStyle = INK; break;
        case "star": // error: crossed eyes
          x.beginPath(); x.moveTo(ex - ew * 0.6, ey - ew * 0.6); x.lineTo(ex + ew * 0.6, ey + ew * 0.6); x.moveTo(ex + ew * 0.6, ey - ew * 0.6); x.lineTo(ex - ew * 0.6, ey + ew * 0.6); x.stroke(); break;
        case "spiral":
          x.beginPath(); for (let a = 0; a < Math.PI * 4; a += 0.3) { const r = (a / (Math.PI * 4)) * ew * 0.75; const px = ex + Math.cos(a + t * 6) * r, py = ey + Math.sin(a + t * 6) * r; if (a === 0) x.moveTo(px, py); else x.lineTo(px, py); } x.stroke(); break;
        case "heart": {
          const r = ew * 0.45; x.beginPath(); x.moveTo(ex, ey + r * 1.4); x.bezierCurveTo(ex - r * 2.2, ey - r * 0.2, ex - r * 0.8, ey - r * 1.8, ex, ey - r * 0.6); x.bezierCurveTo(ex + r * 0.8, ey - r * 1.8, ex + r * 2.2, ey - r * 0.2, ex, ey + r * 1.4); x.fillStyle = "#e5484d"; x.fill(); x.fillStyle = INK; break;
        }
        default: {
          if (eye === "wink" && side < 0) { x.beginPath(); x.moveTo(ex - ew * 0.8, ey); x.lineTo(ex + ew * 0.8, ey); x.stroke(); break; }
          const wide = eye === "wide" ? 1.3 : 1;
          const h = bh * 0.4 * es * wide;
          x.beginPath(); x.roundRect(ex - ew / 2, ey - h / 2, ew, h, ew / 2); x.fill();
          if (!this.isMini) { x.fillStyle = "rgba(255,255,255,.85)"; x.beginPath(); x.arc(ex + ew * 0.12, ey - h * 0.22, ew * 0.18, 0, Math.PI * 2); x.fill(); x.fillStyle = INK; }
        }
      }
    }
    // Blush when happy or loved.
    const glad = eye === "happy" || eye === "heart" || this.state === "finished";
    if (glad && !this.isMini) {
      x.fillStyle = "rgba(255,90,90,.35)";
      for (const side of [-1, 1]) { x.beginPath(); x.ellipse(side * gap * 1.75 + ex0, ey + bh * 0.16, bh * 0.1, bh * 0.06, 0, 0, Math.PI * 2); x.fill(); }
    }
    // A mouth only when it means something: surprise, a yawn, an error.
    if (!this.isMini && (eye === "wide" && this.emote === "surprised" || this.emote === "yawn" && this.time < this.emoteUntil)) {
      x.beginPath(); x.ellipse(ex0, ey + bh * 0.2, bh * 0.05, bh * 0.07, 0, 0, Math.PI * 2); x.fill();
    } else if (!this.isMini && this.state === "error") {
      x.beginPath(); x.moveTo(ex0 - bh * 0.08, ey + bh * 0.24); x.quadraticCurveTo(ex0, ey + bh * 0.16, ex0 + bh * 0.08, ey + bh * 0.24); x.stroke();
    }
  }

  private drawHeadphones(x: CanvasRenderingContext2D, bw: number, bh: number) {
    x.strokeStyle = "rgba(240,238,232,.95)";
    x.lineWidth = bh * 0.1;
    x.beginPath();
    x.moveTo(-bw / 2 - bh * 0.02, -bh * 0.02);
    x.quadraticCurveTo(0, -bh * 1.05, bw / 2 + bh * 0.02, -bh * 0.02);
    x.stroke();
    x.fillStyle = "#ff7ab6";
    for (const side of [-1, 1]) { x.beginPath(); x.roundRect(side * (bw / 2 + bh * 0.02) - bh * 0.13, -bh * 0.2, bh * 0.26, bh * 0.42, bh * 0.1); x.fill(); }
  }

  /** Bubbles and particles above Tock: what it wants you to notice. */
  private drawAbove(x: CanvasRenderingContext2D, cx: number, cy: number, bw: number, bh: number, t: number) {
    const s = this.state;
    const bx = cx + bw * 0.42;
    const by = cy - bh * 0.62;
    const bubble = (fill: string, glyph: string) => {
      const r = bh * 0.3;
      x.fillStyle = fill;
      x.beginPath(); x.roundRect(bx - r, by - r * 0.85, r * 2, r * 1.7, r * 0.6); x.fill();
      x.fillStyle = "#111";
      x.font = `800 ${Math.round(r * 1.25)}px "Segoe UI", system-ui, sans-serif`;
      x.textAlign = "center"; x.textBaseline = "middle";
      x.fillText(glyph, bx, by + r * 0.05);
    };
    if (s === "approval") bubble("#ffb000", "!");
    else if (s === "question") bubble("#7ad7f0", "?");
    else if (s === "thinking" || s === "working" || s === "searching" || this.badge?.kind === "dots") {
      for (let i = 0; i < 3; i++) {
        const on = (Math.floor(t * 4) % 3) === i;
        x.fillStyle = on ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.35)";
        x.beginPath(); x.arc(cx - bh * 0.18 + i * bh * 0.18, cy - bh * 0.62, bh * 0.055, 0, Math.PI * 2); x.fill();
      }
    } else if (s === "sleeping") {
      x.fillStyle = "rgba(205,214,255,.9)";
      x.font = `700 ${Math.round(bh * 0.22)}px "Segoe UI", system-ui, sans-serif`;
      for (let i = 0; i < 3; i++) {
        const p = (t * 0.35 + i / 3) % 1;
        x.globalAlpha = 1 - p; x.fillText("z", bx + p * bh * 0.4, by - p * bh * 0.5);
      }
      x.globalAlpha = 1;
    } else if (s === "ratelimit") {
      x.fillStyle = "#8fd0ff";
      const p = (t * 0.6) % 1;
      x.beginPath(); x.ellipse(cx + bw * 0.34, cy - bh * 0.1 + p * bh * 0.4, bh * 0.05, bh * 0.08, 0, 0, Math.PI * 2); x.fill();
    } else if (s === "finished" && this.time < this.emoteUntil) {
      const cols = ["#ffb000", "#7ab8ff", "#ff7ab6"];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + t * 2, r = bw * 0.55;
        x.fillStyle = cols[i % 3];
        x.beginPath(); x.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.45, bh * 0.045, 0, Math.PI * 2); x.fill();
      }
    }
  }
}

// ── Mini Tocks: one per pill, coloured by its integration ──────────────────────

import type { AgentTask } from "../core/state";

interface Mini { canvas: HTMLCanvasElement; engine: TockEngine; cssSize: number; taskId: string; dancing?: () => boolean }
const live = new Map<HTMLCanvasElement, Mini>();

export function createMiniBot(task: AgentTask, bodySize: number, dancing?: () => boolean, eyeColor?: string): HTMLElement {
  const slot = document.createElement("div");
  slot.className = "mini-bot";
  slot.style.width = `${bodySize}px`;
  slot.style.height = `${bodySize}px`;
  const canvas = document.createElement("canvas");
  const size = bodySize * 1.4;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.style.margin = `${(bodySize - size) / 2}px`;
  slot.append(canvas);
  const engine = new TockEngine();
  engine.isMini = true;
  engine.bodyColor = hexToRGB(task.color);
  engine.setState(task.state, true);
  if (eyeColor) {
    // The split capsule: an amber Tock for each session, told apart by its eyes.
    engine.bodyColor = null;
    engine.eyeColor = eyeColor;
  }
  if (task.emote) engine.setPermanentEmote(task.emote);
  if (task.miniEye) engine.permanentEye = task.miniEye;
  live.set(canvas, { canvas, engine, cssSize: size, taskId: task.id, dancing });
  return slot;
}

export function pruneMiniBots() {
  for (const [canvas] of live) if (!canvas.isConnected) live.delete(canvas);
}

export function syncMiniBotStates(tasks: AgentTask[]) {
  for (const mb of live.values()) {
    const task = tasks.find((x) => x.id === mb.taskId);
    if (!task) continue;
    mb.engine.setState(task.state);
    mb.engine.bodyColor = hexToRGB(task.color);
  }
}

export function tickMiniBots(dt: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const mb of live.values()) {
    const ctx = mb.canvas.getContext("2d");
    if (!ctx) continue;
    mb.engine.setDancing(mb.dancing?.() ?? false);
    mb.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, mb.cssSize, mb.cssSize);
    mb.engine.draw(ctx, mb.cssSize, mb.cssSize);
  }
}

// ── Hello: Tock's launch greeting in the open island ───────────────────────────

/** Tock hops in, waves its eyes, says hello, and hands over to the compact island. */
export class Hello {
  onComplete: (() => void) | null = null;
  private engine = new TockEngine();
  private t0 = 0;
  private running = false;
  private hovering = false;

  start() {
    this.t0 = performance.now();
    this.running = true;
    this.engine.setState("idle", true);
    this.engine.triggerEmote("happy");
  }
  interrupt() { this.running = false; }
  hover() { this.hovering = true; }
  leave() { this.hovering = false; }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.running) return;
    const W = 640, H = 150;
    const e = (performance.now() - this.t0) / 1000;
    this.engine.update(1 / 60);
    if (e > 0.5 && e < 0.55) this.engine.triggerEmote("happy");
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    const slide = Math.min(1, e / 0.6);
    ctx.globalAlpha = slide;
    ctx.translate(W / 2 - 150, (1 - slide) * -30);
    this.engine.draw(ctx, 130, 130);
    ctx.restore();
    ctx.globalAlpha = Math.min(1, Math.max(0, (e - 0.4) / 0.4));
    ctx.fillStyle = "#f3f1ec";
    ctx.font = `600 26px "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.fillText("Hi, I'm Tock.", W / 2 - 10, 62);
    ctx.fillStyle = "#85847f";
    ctx.font = `400 14px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`;
    ctx.fillText("I live up here. Hover me any time.", W / 2 - 10, 92);
    ctx.globalAlpha = 1;
    if (e > 2.6 && !this.hovering) { this.running = false; this.onComplete?.(); }
  }
}
