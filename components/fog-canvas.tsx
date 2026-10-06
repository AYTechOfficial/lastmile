"use client";

import { useEffect, useRef } from "react";

/* Full-bleed volumetric cloud/smoke for the hero, rendered as a single WebGL
   quad. Why this can never show seams or borders (the failure of the previous
   implementation):
   - the canvas is one opaque quad covering an oversized container (-15% top and
     bottom), so the parallax drift can never expose an edge;
   - every fade (bottom dissolve, scroll dissolve) is computed inside the
     shader against the exact page background color, not by CSS masks that end
     at a rectangle boundary;
   - the canvas is resized from its layout box via ResizeObserver, so it tracks
     the real viewport at any width.
   The field is the domain-warped smoke with lit ridge filaments, plus a
   black edge fade that dissolves the smoke into ink at the top of the frame
   and down both sides.
   GL init is re-entrant: if the context is lost (StrictMode remount, driver
   reset, backgrounded webview), it is rebuilt from scratch on restore. */

const VERT = `
attribute vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;

uniform vec2  uRes;
uniform float uTime;
uniform vec2  uMouse;    // -1..1, already smoothed on the CPU side
uniform float uScroll;   // 0..1 — how far the hero has been scrolled away

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm5(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p * 2.02;
    a *= 0.5;
  }
  return v;
}

float fbm3(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = m * p * 2.02;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;            // 0..1, y up
  float aspect = uRes.x / uRes.y;
  vec2 st = vec2(uv.x * aspect, uv.y);

  float t = uTime;
  vec2 drift = uMouse * 0.10;

  // —— domain-warped smoke: q warps the sample site, r warps the warp ——
  vec2 q = vec2(
    fbm5(st * 0.95 + vec2(0.0, t * 0.07) + drift),
    fbm3(st * 0.95 + vec2(5.2, 1.3) - t * 0.055)
  );
  vec2 r = vec2(
    fbm5(st * 1.35 + 2.9 * q + vec2(1.7, 9.2) + t * 0.045 + drift.yx),
    fbm3(st * 1.35 + 2.9 * q + vec2(8.3, 2.8) - t * 0.03)
  );
  float base = fbm5(st * 0.9 + 3.2 * r + vec2(t * 0.016, -t * 0.02));
  // partial S-curve: carve voids and pop the billows apart without crushing
  // the luminous mid-tones entirely
  float sb = base * base * (3.0 - 2.0 * base);
  base = mix(base, sb, 0.55);
  // streaky filaments — the veins that make it read as smoke, not blur
  float vein = 1.0 - abs(2.0 * fbm5(st * 1.35 + 2.4 * r.yx + vec2(-t * 0.03, t * 0.022)) - 1.0);
  float f = base * 0.72 + pow(vein, 2.4) * 0.72;

  // —— density shaping (canvas space) ——————————————————————————————————
  // the wrapper oversizes the section by 15% top and bottom, so the VISIBLE
  // hero maps to uv.y ∈ [0.115, 0.885]. The envelope is exactly 0 at the
  // section's bottom edge — the smoke merges into the page background there,
  // never a hard cut — and rises to full strength behind the headline area.
  float visBot = 0.115;
  float visTop = 0.885;
  float edge = smoothstep(visBot, visBot + 0.10, uv.y);              // 0 at the seam
  float vert = 0.56 + 0.44 * smoothstep(visBot + 0.05, visTop, uv.y); // fuller toward the top
  float env = edge * vert;

  // a soft clearing behind the headline (in-hero y ≈ 38% from the top)
  vec2 cc = vec2(0.5 * aspect, 0.615);
  vec2 cd = (st - cc) / vec2(1.05, 0.50);
  float clearing = 1.0 - 0.42 * exp(-dot(cd, cd));

  float density = f * env * clearing * 1.32;

  // black edge fade: the smoke dissolves into pure ink at the top of the
  // frame and down both sides, so the composition stays clean at any size
  float topFade = 1.0 - smoothstep(0.82, 0.915, uv.y);
  float sideFade = smoothstep(0.0, 0.09, uv.x) * (1.0 - smoothstep(0.91, 1.0, uv.x));
  density *= topFade * sideFade;

  density *= (1.0 - 0.72 * uScroll);
  // faint ambient haze so the dark field never reads as empty flat black
  density += 0.05 * fbm3(st * 0.85 + r * 0.6) * env * (1.0 - uScroll);

  float d = clamp(density, 0.0, 1.0);

  // —— color ramp: ink → deep iris → iris → pale ridge light ——————————
  // the ramp output IS the final color; alpha only dissolves the lowest
  // densities into the page background (a second ink-mix here would crush
  // every mid-tone back to black)
  vec3 col = mix(vec3(0.027, 0.031, 0.043), vec3(0.075, 0.078, 0.19), smoothstep(0.02, 0.30, d));
  col = mix(col, vec3(0.17, 0.165, 0.46), smoothstep(0.30, 0.52, d));
  col = mix(col, vec3(0.46, 0.45, 0.93), smoothstep(0.52, 0.76, d));
  col = mix(col, vec3(0.80, 0.80, 1.00), smoothstep(0.76, 0.92, d));
  col = mix(col, vec3(0.97, 0.97, 1.00), smoothstep(0.92, 1.00, d));
  // a restrained cyan breath inside the mid densities only
  float cy = smoothstep(0.48, 0.78, fbm3(st * 0.95 + r * 0.9 + vec2(t * 0.025, 0.0)));
  col = mix(col, vec3(0.22, 0.71, 0.86), 0.07 * cy * smoothstep(0.35, 0.65, d));

  // page background is --ink (#07080b); the smoke composites over it here so
  // the canvas edges match the page exactly
  vec3 ink = vec3(0.0275, 0.0314, 0.0431);
  float a = smoothstep(0.0, 0.10, d);
  gl_FragColor = vec4(mix(ink, col, a), 1.0);
}
`;

/* ————— engine ————— */

const GL_ATTRS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  powerPreference: "low-power",
  preserveDrawingBuffer: false,
};

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function FogCanvas({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    if (!canvas) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fine = window.matchMedia("(pointer: fine)");

    let disposed = false;
    let gl: WebGLRenderingContext | null = null;
    let uRes: WebGLUniformLocation | null = null;
    let uTime: WebGLUniformLocation | null = null;
    let uMouse: WebGLUniformLocation | null = null;
    let uScroll: WebGLUniformLocation | null = null;

    let dprCap = 1.5;
    let W = 0;
    let H = 0;
    let raf = 0;
    let running = false;
    let inView = true;
    const start = performance.now();

    // smoothed pointer, -1..1
    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const onPointer = (e: PointerEvent) => {
      if (!fine.matches) return;
      mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.ty = -((e.clientY / window.innerHeight) * 2 - 1);
    };

    function initGL(): boolean {
      gl = canvas.getContext("webgl", GL_ATTRS);
      if (!gl || gl.isContextLost()) return false;
      const vs = compile(gl, gl.VERTEX_SHADER, VERT);
      const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
      if (!vs || !fs) return false;
      const prog = gl.createProgram()!;
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]), // one oversized triangle
        gl.STATIC_DRAW,
      );
      const loc = gl.getAttribLocation(prog, "aPos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      uRes = gl.getUniformLocation(prog, "uRes");
      uTime = gl.getUniformLocation(prog, "uTime");
      uMouse = gl.getUniformLocation(prog, "uMouse");
      uScroll = gl.getUniformLocation(prog, "uScroll");
      gl.clearColor(7 / 255, 8 / 255, 11 / 255, 1); // --ink #07080b
      return true;
    }

    function resize() {
      if (!gl) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (w === W && h === H) return;
      W = w;
      H = h;
      canvas.width = W;
      canvas.height = H;
      gl.viewport(0, 0, W, H);
    }

    function draw(now: number) {
      if (!gl) return;
      const time = reduceMotion.matches ? 12.0 : (now - start) / 1000;
      // ease the pointer so the fog reacts like fluid, not a mirror
      mouse.x += (mouse.tx - mouse.x) * 0.035;
      mouse.y += (mouse.ty - mouse.y) * 0.035;
      const rect = canvas.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      // the wrapper sits 11.54% of its own height above the section top
      // (15% oversize on a 130%-height box) — subtract it so scroll starts at 0
      const scroll = Math.min(1, Math.max(0, (-rect.top - 0.1154 * rect.height) / vh));
      gl.uniform2f(uRes, W, H);
      gl.uniform1f(uTime, time);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform1f(uScroll, scroll);
      if (scroll < 1) gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* adaptive resolution: if frames run long, shed pixels before frames */
    let frames = 0;
    let acc = 0;
    let last = 0;
    function loop(now: number) {
      if (!running || disposed || !gl) return;
      if (last) {
        acc += now - last;
        frames++;
        if (frames >= 90) {
          if (acc / frames > 30 && dprCap > 0.7) {
            dprCap = Math.max(0.7, dprCap - 0.25);
            resize();
          }
          frames = 0;
          acc = 0;
        }
      }
      last = now;
      draw(now);
      raf = requestAnimationFrame(loop);
    }

    function play() {
      if (running || disposed || !gl) return;
      if (reduceMotion.matches) {
        resize();
        draw(performance.now()); // a single composed frame, no loop
        return;
      }
      running = true;
      last = 0;
      raf = requestAnimationFrame(loop);
    }

    function pause() {
      running = false;
      cancelAnimationFrame(raf);
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
        if (inView && !document.hidden) play();
        else pause();
      },
      { rootMargin: "120px" },
    );

    const onVis = () => {
      if (document.hidden) pause();
      else if (inView) play();
    };

    const ro = new ResizeObserver(() => {
      resize();
      if (reduceMotion.matches && !running) draw(performance.now());
    });

    const onLost = (e: Event) => {
      e.preventDefault();
      pause();
      gl = null; // everything is rebuilt on restore
    };
    const onRestored = () => {
      if (disposed) return;
      if (initGL()) {
        resize();
        if (inView && !document.hidden) play();
      }
    };

    window.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("visibilitychange", onVis);
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    io.observe(canvas);
    ro.observe(canvas);

    if (initGL()) {
      resize();
      play();
    }
    // if init failed because the context was (or became) lost, the restore
    // listener rebuilds everything when the context comes back

    return () => {
      disposed = true;
      pause();
      io.disconnect();
      ro.disconnect();
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      // deliberately NOT calling loseContext(): React StrictMode remounts the
      // effect on the same canvas, and getContext() would hand back the dead
      // context. The context is reclaimed with the canvas element itself.
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={className}
      style={{ width: "100%", height: "100%", display: "block" }}
    />
  );
}
