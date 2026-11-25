/** Orbit brand marks. Geometry mirrors public/brand/*.svg (32-unit grid). See docs/brand.md. */

const RING = "M25.925 14.781A10 10 0 1 1 17.219 6.075";

type Tone = "color" | "inverse" | "mono";
const TONES: Record<Tone, { body: string; node: string }> = {
  color: { body: "#17332C", node: "#C0912F" }, // on light backgrounds
  inverse: { body: "#EEF3F0", node: "#E2B04A" }, // on the deep-green panel or dark backgrounds
  mono: { body: "currentColor", node: "currentColor" },
};

export function OrbitMark({ size = 28, tone = "color", className }: { size?: number; tone?: Tone; className?: string }) {
  const c = TONES[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={className}>
      <path d={RING} fill="none" stroke={c.body} strokeWidth="3.5" strokeLinecap="round" />
      <circle cx="16" cy="16" r="4.2" fill={c.body} />
      <circle className="orbit-node" cx="23.071" cy="8.929" r="3.4" fill={c.node} />
    </svg>
  );
}

/** Mark + wordmark. The wordmark is live text in the product typeface. */
export function OrbitLogo({ tone = "color", size = 26 }: { tone?: Tone; size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5" aria-label="Orbit" role="img">
      <OrbitMark size={size} tone={tone} />
      <span
        aria-hidden
        className="font-semibold tracking-[-0.02em]"
        style={{ fontSize: size * 0.69, color: tone === "inverse" ? "#F3F6F4" : tone === "mono" ? "currentColor" : "var(--color-ink)" }}
      >
        Orbit
      </span>
    </span>
  );
}

/** Full-screen loading state: the satellite travels the ring once a second and a half. */
export function OrbitLoading({ label = "Loading Orbit" }: { label?: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4">
        <span className="orbit-spin">
          <OrbitMark size={44} />
        </span>
        <span className="text-sm text-ink-faint">{label}…</span>
      </div>
    </div>
  );
}
