# Orbit brand

**Name:** Orbit · **Tagline:** Everything connected. One place.

## Mark

A solid core (central control) inside a thick orbit ring. The ring breaks at the upper
right, where a single satellite node sits: one connected service, in motion. It doubles
as the "O" of the wordmark.

Geometry, 32-unit grid: core r 4.2 at the centre; ring r 10, stroke 3.5, round caps, with
a 76° gap centred at 45°; satellite r 3.4 on the ring line. The favicon uses a heavier
ring (stroke 4) for 16 px legibility. No gradients, no shadows, no outlines.

## Files (`frontend/public/brand/`)

| File | Use |
| --- | --- |
| `orbit-logo-light-bg.svg` | Primary logo on light backgrounds |
| `orbit-logo-dark-bg.svg` | Primary logo on dark or deep-green backgrounds |
| `orbit-logo-mono.svg` | One colour, inherits `currentColor` |
| `orbit-mark.svg` / `-dark.svg` / `-mono.svg` | Icon alone |
| `orbit-app-icon.svg` | App icon (deep-green tile); `../apple-touch-icon.png` is its 180 px export |
| `../favicon.svg` | Browser tab |

The wordmark in the SVG files is live text set in Schibsted Grotesk; outline it before
using the files outside the browser. In the app, use `<OrbitLogo>` / `<OrbitMark>` from
`src/components/brand.tsx`.

Keep clear space around the mark equal to the satellite's diameter. Don't recolour the
satellite separately in mono contexts, rotate the mark, or add Telegram's paper plane.

## Colour

| Token | Hex | Role |
| --- | --- | --- |
| Deep green (`panel`) | `#17332C` | Brand primary, navigation, primary buttons |
| Ink | `#131A18` | Text |
| Accent | `#C0912F` (on dark `#E2B04A`) | The satellite; focus and selection, used sparingly |
| Canvas | `#F3F5F3` | App background |
| Surface | `#FFFFFF` | Panels, inputs |
| Status ok / busy / error / info | `#2F9A5E` / `#D98E1F` / `#C8483A` / `#4F6FAE` | Status dots and delivery bars only |

## Type

Schibsted Grotesk (variable) for everything, with tabular figures for numbers. Headings
semibold with slight negative tracking; sentence case everywhere; no all-caps labels.
