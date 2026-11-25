import { useState } from "react";
import type { CampaignDetail, ErrorGroup, Progress, TimelineBucket } from "../../lib/api";
import { clockTime, duration, fmt, pct, when } from "../../lib/format";
import { cx, Panel } from "../../components/ui";
import { DeliveryBar } from "./DeliveryBar";

/** The headline for a broadcast, shaped by where it is in its life. */
export function StatusPanel({ c, progress }: { c: CampaignDetail; progress?: Progress }) {
  const s = c.stats;
  const processed = s.sent + s.failed + s.blocked + s.skipped;
  const reach = c.audience.mode === "selected" ? c.audience.recipients.length : c.bots.reduce((n, b) => n + b.audience, 0);

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

/** Messages processed per time slice: delivered (bottom) and not delivered (top). */
export function TimelineChart({ progress }: { progress: Progress }) {
  const data = progress.timeline;
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.delivered + d.not_delivered));
  if (!data.some((d) => d.delivered + d.not_delivered > 0)) return null;
  const slice = duration(progress.bucket_seconds);
  const h = hover != null ? data[hover] : null;

  return (
    <section aria-labelledby="timeline-title">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="timeline-title" className="text-lg font-semibold">Over time</h2>
        <div className="flex gap-4 text-xs text-ink-soft">
          <Legend swatch="bg-chart-delivered" label="Delivered" />
          <Legend swatch="bg-chart-missed" label="Not delivered" />
          <span className="text-ink-faint">per {slice}</span>
        </div>
      </div>
      <Panel className="px-5 pt-5 pb-3">
        <div className="relative">
          <span className="absolute -top-1 left-0 text-[11px] text-ink-faint">{fmt(max)}</span>
          <div
            className="flex h-40 items-end gap-[2px] border-b border-line pt-4"
            role="img"
            aria-label={`Messages per ${slice}: ${fmt(data.reduce((n, d) => n + d.delivered, 0))} delivered, ${fmt(
              data.reduce((n, d) => n + d.not_delivered, 0),
            )} not delivered. A table version follows.`}
            onMouseLeave={() => setHover(null)}
          >
            {data.map((d, i) => (
              <Bar key={d.start} d={d} max={max} active={hover === i} onEnter={() => setHover(i)} />
            ))}
          </div>
          {h && (
            <div className="pointer-events-none absolute top-0 right-0 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-[0_8px_24px_-12px_rgba(19,26,24,0.35)]">
              <p className="font-medium">{clockTime(h.start)}</p>
              <p className="text-ink-soft">
                <span className="mr-1.5 inline-block size-2 rounded-sm bg-chart-delivered" />
                {fmt(h.delivered)} delivered
              </p>
              <p className="text-ink-soft">
                <span className="mr-1.5 inline-block size-2 rounded-sm bg-chart-missed" />
                {fmt(h.not_delivered)} not delivered
              </p>
            </div>
          )}
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-ink-faint">
          <span>{clockTime(data[0].start)}</span>
          <span>{clockTime(data[data.length - 1].start)}</span>
        </div>
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer text-ink-soft hover:text-ink">Show as table</summary>
          <table className="mt-2 w-full text-left">
            <thead className="text-ink-faint">
              <tr>
                <th className="py-1 font-medium">From</th>
                <th className="py-1 text-right font-medium">Delivered</th>
                <th className="py-1 text-right font-medium">Not delivered</th>
              </tr>
            </thead>
            <tbody>
              {data
                .filter((d) => d.delivered + d.not_delivered > 0)
                .map((d) => (
                  <tr key={d.start} className="border-t border-line">
                    <td className="py-1">{clockTime(d.start)}</td>
                    <td className="py-1 text-right">{fmt(d.delivered)}</td>
                    <td className="py-1 text-right">{fmt(d.not_delivered)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      </Panel>
    </section>
  );
}

function Bar({ d, max, active, onEnter }: { d: TimelineBucket; max: number; active: boolean; onEnter: () => void }) {
  const total = d.delivered + d.not_delivered;
  return (
    // Hit target is the full column height, wider than the visible mark.
    <div className="flex h-full min-w-[3px] flex-1 flex-col justify-end" onMouseEnter={onEnter}>
      {total > 0 && (
        <div className={cx("flex flex-col gap-[2px] transition-opacity", active ? "opacity-100" : "opacity-90")} style={{ height: `${(total / max) * 100}%` }}>
          {d.not_delivered > 0 && (
            <div className="rounded-t-[4px] bg-chart-missed" style={{ flexGrow: d.not_delivered, minHeight: 2 }} />
          )}
          {d.delivered > 0 && (
            <div className={cx("bg-chart-delivered", d.not_delivered === 0 && "rounded-t-[4px]")} style={{ flexGrow: d.delivered, minHeight: 2 }} />
          )}
        </div>
      )}
    </div>
  );
}

function Legend({ swatch, label }: { swatch: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2.5 rounded-sm ${swatch}`} />
      {label}
    </span>
  );
}

/** Undelivered messages grouped by reason, most common first. */
export function ErrorGroups({ errors }: { errors: ErrorGroup[] }) {
  if (!errors.length) return null;
  const total = errors.reduce((n, e) => n + e.count, 0);
  return (
    <section aria-labelledby="errors-title">
      <h2 id="errors-title" className="mb-3 text-lg font-semibold">Why messages didn't arrive</h2>
      <Panel className="divide-y divide-line">
        {errors.map((e) => (
          <div key={`${e.status}:${e.error}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-3 text-sm">
            <div className="min-w-0">
              <p className="truncate">{friendly(e)}</p>
              <p className="truncate text-xs text-ink-faint">{e.error}</p>
            </div>
            <div className="text-right">
              <p className="font-semibold">{fmt(e.count)}</p>
              <p className="text-xs text-ink-faint">{pct(e.count, total)}</p>
            </div>
          </div>
        ))}
      </Panel>
    </section>
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
