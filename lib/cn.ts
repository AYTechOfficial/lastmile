import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/* Server-safe class merger — ui.tsx is a client module, so server
   components import cn from here instead. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
