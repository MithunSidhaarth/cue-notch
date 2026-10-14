// How much the notch moves. Windows has a switch for it (Accessibility → Visual
// effects → Animation effects), which Cue follows unless Settings → General →
// Motion says otherwise: someone can want Windows calm and Cue lively.

/** "" follows Windows, "full" always animates, "reduced" never does. */
let pref = "";

/** True when springs, pops and level bars should stand still. */
export function reducedMotion(): boolean {
  if (pref === "full") return false;
  if (pref === "reduced") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Called when settings load or change. The stylesheet reads `data-rm` on the root. */
export function applyMotion(next: string | undefined) {
  pref = next ?? "";
  if (typeof document !== "undefined") document.documentElement.toggleAttribute("data-rm", reducedMotion());
}
