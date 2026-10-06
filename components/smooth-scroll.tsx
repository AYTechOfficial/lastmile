"use client";

import { ReactLenis } from "lenis/react";
import type { ReactNode } from "react";
import "lenis/dist/lenis.css";

export function SmoothScroll({
  children,
  root = true,
}: {
  children: ReactNode;
  root?: boolean;
}) {
  return (
    <ReactLenis
      root={root}
      options={{
        lerp: 0.095,
        anchors: true,
        wheelMultiplier: 1,
        touchMultiplier: 1.4,
      }}
    >
      {children}
    </ReactLenis>
  );
}
