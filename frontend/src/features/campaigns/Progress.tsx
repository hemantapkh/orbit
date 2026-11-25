import { useState } from "react";
import type { CampaignStatus, DeliveryStats, ErrorGroup, Outcome, Progress, TimelinePoint } from "../../lib/api";
import { clockTime, duration, fmt, pct, when } from "../../lib/format";
import { cx, fieldClass, Panel } from "../../components/ui";
import { DeliveryBar } from "./DeliveryBar";

/** The headline for a broadcast, shaped by where it is in its life. */
type StatusSubject = { status: CampaignStatus; stats: DeliveryStats; scheduled_at: string | null };

export function StatusPanel({ c, reach, progress }: { c: StatusSubject; reach: number; progress?: Progress }) {
  const s = c.stats;
  const processed = s.sent + s.failed + s.blocked + s.skipped;

  if (c.status === "draft") return <Panel className="p-6 text-ink-soft">Not sent yet.</Panel>;

  if (c.status === "scheduled") {
    const at = c.scheduled_at ? new Date(c.scheduled_at) : null;
    const left = at ? (at.getTime() - Date.now()) / 1000 : null;
    return (
      <Panel className="p-6">
        <p className="text-sm text-ink-soft">Sends in</p>
        <p className="mt-1 text-[40px] leading-none font-semibold tracking-[-0.03em]">{left != null && left > 0 ? duration(left) : "a moment"}</p>
        <p className="mt-3 text-ink-soft">
          {when(c.scheduled_at)} to about <strong className="text-ink">{fmt(reach)}</strong> people. The exact list is read
          at send time.
        </p>
      </Panel>
    );
  }

  if (s.total === 0) {
    return (
      <Panel className="p-6 text-ink-soft">
        {c.status === "running" ? "Preparing the recipient list…" : "No one was reachable on the selected bots."}
      </Panel>
    );
  }

  const live = c.status === "running" || c.status === "paused";
  const finishAt = progress?.eta_seconds ? new Date(Date.now() + progress.eta_seconds * 1000) : null;
  const avgPerMin = progress?.elapsed_seconds ? (processed / progress.elapsed_seconds) * 60 : null;

  return (
    <Panel className="p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div>
          <p className="text-[40px] leading-none font-semibold tracking-[-0.03em]">{pct(s.sent, s.total)}</p>
          <p className="mt-2 text-ink-soft">
            delivered · {fmt(s.sent)} of {fmt(s.total)}
          </p>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          {live ? (
            <>
              <Fact label="Waiting" value={fmt(s.pending)} />
              <Fact
                label={c.status === "paused" ? "Speed" : "Speed now"}
                value={c.status === "paused" ? "Paused" : progress ? `${fmt(Math.round(progress.per_minute))}/min` : "…"}
              />
              <Fact
                label="Time left"
                value={c.status === "paused" ? "—" : progress?.eta_seconds ? `about ${duration(progress.eta_seconds)}` : "…"}
                hint={c.status === "running" && finishAt ? `done around ${clockTime(finishAt)}` : undefined}
              />
            </>
          ) : (
            <>
              <Fact label="Took" value={duration(progress?.elapsed_seconds)} />
              <Fact label="Average speed" value={avgPerMin ? `${fmt(Math.round(avgPerMin))}/min` : "—"} />
            </>
          )}
        </dl>
      </div>
      <DeliveryBar stats={s} />
      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Count label="Delivered" value={s.sent} swatch="bg-status-ok" />
        <Count label="Blocked the bot" value={s.blocked} swatch="bg-status-error/70" />
        <Count label="Failed" value={s.failed} swatch="bg-status-error" />
        <Count label={c.status === "cancelled" ? "Skipped (stopped)" : "Skipped"} value={s.skipped} swatch="bg-line-strong" />
      </dl>
    </Panel>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold">{value}</dd>
      {hint && <dd className="text-xs text-ink-faint">{hint}</dd>}
    </div>
  );
}

function Count({ label, value, swatch }: { label: string; value: number; swatch: string }) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-sm text-ink-soft">
        <span className={`size-2.5 rounded-sm ${swatch}`} />
        {label}
      </dt>
      <dd className="mt-1 text-xl font-semibold">{fmt(value)}</dd>
    </div>
  );
}

// ---- insights: timeline + failure reasons, sharing one set of filters ------------------

const OUTCOMES: { key: Outcome; label: string; color: string }[] = [
  { key: "delivered", label: "Delivered", color: "var(--color-chart-delivered)" },
  { key: "blocked", label: "Blocked", color: "var(--color-chart-blocked)" },
  { key: "unreachable", label: "Unreachable", color: "var(--color-chart-unreachable)" },
  { key: "failed", label: "Failed", color: "var(--color-chart-failed)" },
];
// Reference categorical palette, fixed order. A bot keeps its colour whatever is filtered.
const BOT_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const OTHER = -1;

type Series = { key: string; label: string; color: string };

export function ProgressInsights({ progress, bots }: { progress: Progress; bots: { bot_id: number; username: string }[] }) {
  const [bot, setBot] = useState<number | "all">("all");
  const [outcome, setOutcome] = useState<Outcome | "all">("all");
  const [colorBy, setColorBy] = useState<"outcome" | "bot">("outcome");

  // Colour follows the bot (sorted by id), never its rank in the current view.
  const botOrder = [...bots].sort((a, b) => a.bot_id - b.bot_id);
  const botSlot = new Map(botOrder.map((b, i) => [b.bot_id, i < BOT_COLORS.length ? i : OTHER]));
  const name = (id: number) => bots.find((b) => b.bot_id === id)?.username ?? `bot ${id}`;

  const points = progress.points.filter(
    (p) => (bot === "all" || p.bot_id === bot) && (outcome === "all" || p.outcome === outcome),
  );
  const seriesKey = (p: TimelinePoint) =>
    colorBy === "outcome" ? p.outcome : String(botSlot.get(p.bot_id) === OTHER ? OTHER : p.bot_id);
  const present = new Set(points.map(seriesKey));
  const series: Series[] =
    colorBy === "outcome"
      ? OUTCOMES.filter((o) => present.has(o.key)).map((o) => ({ key: o.key, label: o.label, color: o.color }))
      : [
          ...botOrder
            .filter((b) => botSlot.get(b.bot_id) !== OTHER && present.has(String(b.bot_id)))
            .map((b) => ({ key: String(b.bot_id), label: `@${b.username}`, color: BOT_COLORS[botSlot.get(b.bot_id)!] })),
          ...(present.has(String(OTHER)) ? [{ key: String(OTHER), label: "Other bots", color: "var(--color-ink-faint)" }] : []),
        ];

  const errors = progress.errors.filter(
    (e) => (bot === "all" || e.bot_id === bot) && (outcome === "all" || outcome === outcomeOfError(e)),
  );

  if (!progress.start || !progress.points.length) return null;
  return (
    <section aria-labelledby="insights-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="insights-title" className="text-lg font-semibold">Over time</h2>
        <div className="flex flex-wrap items-center gap-2">
          {bots.length > 1 && (
            <select aria-label="Bot" className={`${fieldClass} h-9 w-auto text-sm`} value={bot} onChange={(e) => setBot(e.target.value === "all" ? "all" : Number(e.target.value))}>
              <option value="all">All bots</option>
              {botOrder.map((b) => (
                <option key={b.bot_id} value={b.bot_id}>@{b.username}</option>
              ))}
            </select>
          )}
          <select aria-label="Outcome" className={`${fieldClass} h-9 w-auto text-sm`} value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome | "all")}>
            <option value="all">All outcomes</option>
            {OUTCOMES.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          {bots.length > 1 && (
            <div role="radiogroup" aria-label="Colour by" className="inline-flex rounded-lg bg-canvas p-1 text-sm ring-1 ring-line">
              {(["outcome", "bot"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={colorBy === k}
                  onClick={() => setColorBy(k)}
                  className={cx("rounded-md px-3 py-1 font-medium", colorBy === k ? "bg-surface text-ink shadow-[0_1px_3px_rgba(23,33,30,0.12)]" : "text-ink-soft hover:text-ink")}
                >
                  By {k}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <TimelineChart progress={progress} points={points} series={series} seriesKey={seriesKey} />
      <ErrorGroups errors={errors} name={bots.length > 1 ? name : null} />
    </section>
  );
}

function outcomeOfError(e: ErrorGroup): Outcome {
  if (e.status === "blocked") return "blocked";
  return e.error.toLowerCase().includes("chat not found") ? "unreachable" : "failed";
}

function TimelineChart({
  progress,
  points,
  series,
  seriesKey,
}: {
  progress: Progress;
  points: TimelinePoint[];
  series: Series[];
  seriesKey: (p: TimelinePoint) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const step = progress.bucket_seconds * 1000;
  const first = new Date(progress.start!).getTime();
  const last = new Date(progress.end!).getTime();
  const slots = Array.from({ length: Math.floor((last - first) / step) + 1 }, (_, i) => first + i * step);
  const index = new Map(slots.map((t, i) => [t, i]));
  const grid = slots.map(() => new Map<string, number>());
  for (const p of points) {
    const i = index.get(new Date(p.t).getTime());
    if (i == null) continue;
    const k = seriesKey(p);
    grid[i].set(k, (grid[i].get(k) ?? 0) + p.count);
  }
  const totals = grid.map((g) => [...g.values()].reduce((a, b) => a + b, 0));
  const max = Math.max(1, ...totals);
  const slice = duration(progress.bucket_seconds);
  const all = totals.reduce((a, b) => a + b, 0);

  return (
    <Panel className="px-5 pt-4 pb-3">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        <span className="text-ink-faint">per {slice}</span>
      </div>
      {all === 0 ? (
        <p className="py-10 text-center text-sm text-ink-soft">Nothing matches these filters.</p>
      ) : (
        <>
          <div className="relative">
            <span className="absolute -top-1 left-0 text-[11px] text-ink-faint">{fmt(max)}</span>
            <div
              className="flex h-44 items-end gap-[2px] border-b border-line pt-4"
              role="img"
              aria-label={`Messages per ${slice}: ${series.map((s) => `${s.label} ${fmt(grid.reduce((n, g) => n + (g.get(s.key) ?? 0), 0))}`).join(", ")}. A table version follows.`}
              onMouseLeave={() => setHover(null)}
            >
              {grid.map((g, i) => (
                <div key={slots[i]} className="flex h-full min-w-[3px] flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
                  {totals[i] > 0 && (
                    <div className={cx("flex flex-col-reverse gap-[2px]", hover === i ? "opacity-100" : "opacity-90")} style={{ height: `${(totals[i] / max) * 100}%` }}>
                      {series
                        .filter((s) => (g.get(s.key) ?? 0) > 0)
                        .map((s, j, shown) => (
                          <div
                            key={s.key}
                            className={cx(j === shown.length - 1 && "rounded-t-[4px]")}
                            style={{ flexGrow: g.get(s.key), minHeight: 2, background: s.color }}
                          />
                        ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {hover != null && totals[hover] > 0 && (
              <div className="pointer-events-none absolute top-0 right-0 min-w-[150px] rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-[0_8px_24px_-12px_rgba(19,26,24,0.35)]">
                <p className="mb-1 font-medium">{clockTime(new Date(slots[hover]))}</p>
                {series.map((s) => (
                  <p key={s.key} className="flex justify-between gap-4 text-ink-soft">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-sm" style={{ background: s.color }} />
                      {s.label}
                    </span>
                    <span className="text-ink">{fmt(grid[hover].get(s.key) ?? 0)}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-ink-faint">
            <span>{clockTime(new Date(first))}</span>
            <span>{clockTime(new Date(last))}</span>
          </div>
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-ink-soft hover:text-ink">Show as table</summary>
            <div className="overflow-x-auto">
              <table className="mt-2 w-full text-left">
                <thead className="text-ink-faint">
                  <tr>
                    <th className="py-1 font-medium">From</th>
                    {series.map((s) => (
                      <th key={s.key} className="py-1 text-right font-medium">{s.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.map((g, i) =>
                    totals[i] ? (
                      <tr key={slots[i]} className="border-t border-line">
                        <td className="py-1">{clockTime(new Date(slots[i]))}</td>
                        {series.map((s) => (
                          <td key={s.key} className="py-1 text-right">{fmt(g.get(s.key) ?? 0)}</td>
                        ))}
                      </tr>
                    ) : null,
                  )}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Panel>
  );
}

/** Undelivered messages grouped by reason, most common first. */
function ErrorGroups({ errors, name }: { errors: ErrorGroup[]; name: ((id: number) => string) | null }) {
  // Merge per-bot rows into one row per reason unless bots are being told apart.
  const rows = new Map<string, { e: ErrorGroup; count: number; bots: Set<number> }>();
  for (const e of errors) {
    const k = `${friendly(e)}|${e.error}`;
    const r = rows.get(k) ?? { e, count: 0, bots: new Set<number>() };
    r.count += e.count;
    r.bots.add(e.bot_id);
    rows.set(k, r);
  }
  const list = [...rows.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  if (!list.length) return null;
  const total = list.reduce((n, r) => n + r.count, 0);
  return (
    <div>
      <h3 className="mb-2 font-semibold">Why messages didn't arrive</h3>
      <Panel className="divide-y divide-line">
        {list.map(({ e, count, bots }) => (
          <div key={`${e.status}:${e.error}`} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-3 text-sm">
            <span className="size-2.5 rounded-sm" style={{ background: OUTCOMES.find((o) => o.key === outcomeOfError(e))!.color }} />
            <div className="min-w-0">
              <p className="truncate">{friendly(e)}</p>
              <p className="truncate text-xs text-ink-faint">
                {e.error}
                {name && ` · ${[...bots].map((b) => `@${name(b)}`).join(", ")}`}
              </p>
            </div>
            <div className="text-right">
              <p className="font-semibold">{fmt(count)}</p>
              <p className="text-xs text-ink-faint">{pct(count, total)}</p>
            </div>
          </div>
        ))}
      </Panel>
    </div>
  );
}
function friendly(e: ErrorGroup): string {
  const m = e.error.toLowerCase();
  if (m.includes("blocked")) return "Blocked the bot";
  if (m.includes("deactivated")) return "Account deleted";
  if (m.includes("chat not found")) return "Chat no longer exists";
  if (m.includes("kicked") || m.includes("not a member")) return "Bot was removed from the chat";
  if (m.includes("too many requests")) return "Rate limited by Telegram";
  if (m.includes("network")) return "Network error";
  if (e.status === "blocked") return "Can't reach this person";
  return "Telegram rejected the message";
}
