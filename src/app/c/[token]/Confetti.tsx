"use client";

import { useEffect, useRef } from "react";

// One short confetti burst for the gift reveal. A plain canvas (no library), brand colours, ~2 s, then it removes
// itself. Nothing is drawn for people who ask for reduced motion.
const COLORS = ["#F45722", "#FFB23F", "#4E1B96", "#22A06B", "#FF7AA2", "#FFFFFF"];

type Piece = { x: number; y: number; vx: number; vy: number; w: number; h: number; r: number; vr: number; c: string; round: boolean };

export default function Confetti({ fire }: { fire: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const done = useRef(false);

  useEffect(() => {
    if (!fire || done.current) return;
    done.current = true;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.clientWidth, H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // Two bursts from the lower corners, angled up and in, like party poppers around the gift card.
    const pieces: Piece[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 70; i++) {
        const angle = (-90 - side * (18 + Math.random() * 38)) * (Math.PI / 180); // up, and in towards the middle
        const speed = 9 + Math.random() * 9;
        pieces.push({
          x: side < 0 ? W * 0.08 : W * 0.92, y: H * 0.78,
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          w: 6 + Math.random() * 6, h: 4 + Math.random() * 5,
          r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
          c: COLORS[(Math.random() * COLORS.length) | 0], round: Math.random() < 0.3,
        });
      }
    }

    const start = performance.now();
    const LIFE = 2400;
    let raf = 0;
    const frame = (t: number) => {
      const age = t - start;
      ctx.clearRect(0, 0, W, H);
      const fade = age > LIFE - 600 ? Math.max(0, (LIFE - age) / 600) : 1;
      for (const p of pieces) {
        p.vy += 0.32;            // gravity
        p.vx *= 0.985; p.vy *= 0.985; // air
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.h / 2, 0, Math.PI * 2); ctx.fill(); }
        else ctx.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.r * 2)), p.w, p.h * Math.abs(Math.cos(p.r * 2)) + 1);
        ctx.restore();
      }
      if (age < LIFE) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [fire]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{ position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: 20 }}
    />
  );
}
