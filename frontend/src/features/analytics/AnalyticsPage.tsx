import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api, type AnalyticsRange, type AudienceAnalytics, type Bot } from "../../lib/api";
import { downloadCsv } from "../../lib/csv";
import { fmt, pct } from "../../lib/format";
import { cx, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";
import { BOT_COLORS } from "../campaigns/Progress";

const RANGES: { key: AnalyticsRange; label: string; long: string }[] = [
  { key: "7d", label: "7D", long: "last 7 days" },
  { key: "30d", label: "30D", long: "last 30 days" },
  { key: "90d", label: "90D", long: "last 90 days" },
  { key: "12m", label: "12M", long: "last 12 months" },
  { key: "all", label: "All", long: "all time" },
];

type BotInfo = { id: number; username: string; color: string };

const today = () => new Date().toISOString().slice(0, 10);
const fileName = (what: string, d: AudienceAnalytics) => `orbit-${what}-${d.period.range}-${today()}.csv`;

function CsvButton({ onClick, label = "CSV" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-ink-soft hover:bg-line/60 hover:text-ink"
    >
      <Download size={14} /> {label}
    </button>
  );
}

export function AnalyticsPage() {
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const [picked, setPicked] = useState<number[] | null>(null); // null = all connected bots
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<Bot[]>("/bots") });
  const connected = (bots.data ?? []).filter((b) => b.subscribers.connected).sort((a, b) => a.id - b.id);
  // Colour follows the bot (by id order), not what's currently selected.
  const info: BotInfo[] = connected.map((b, i) => ({ id: b.id, username: b.username, color: BOT_COLORS[i % BOT_COLORS.length] }));
  const selected = picked ?? connected.map((b) => b.id);

  const qs = new URLSearchParams([["range", range], ...(picked ? picked.map((id) => ["bot", String(id)]) : [])]);
  const data = useQuery({
    queryKey: ["analytics", range, picked],
    queryFn: () => api<AudienceAnalytics>(`/analytics/audience?${qs}`),
    enabled: !!bots.data && selected.length > 0,
    placeholderData: (prev) => prev,
  });

  const toggle = (id: number) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    setPicked(next.length === connected.length ? null : next);
  };
  const long = RANGES.find((r) => r.key === range)!.long;

  return (
    <>
      <PageHeader
        title="Analytics"
        lede="Who your bots reach, how that's changing, and where audiences overlap."
        actions={data.data && <CsvButton label="Download summary" onClick={() => exportSummary(data.data!, info, long)} />}
      />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div role="radiogroup" aria-label="Time range" className="inline-flex rounded-lg bg-canvas p-1 text-sm ring-1 ring-line">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              role="radio"
              aria-checked={range === r.key}
              title={r.long}
              onClick={() => setRange(r.key)}
              className={cx("rounded-md px-3 py-1.5 font-medium", range === r.key ? "bg-surface text-ink shadow-[0_1px_3px_rgba(23,33,30,0.12)]" : "text-ink-soft hover:text-ink")}
            >
              {r.label}
            </button>
          ))}
        </div>
        {info.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Bots">
            {info.map((b) => {
              const on = selected.includes(b.id);
              return (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(b.id)}
                  className={cx(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
                    on ? "border-line-strong bg-surface text-ink" : "border-line bg-transparent text-ink-faint",
                  )}
                >
                  <span className="size-2.5 rounded-full" style={{ background: on ? b.color : "var(--color-line-strong)" }} />
                  @{b.username}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {bots.isPending || (data.isPending && selected.length > 0) ? (
        <Skeleton className="h-96" />
      ) : connected.length === 0 ? (
        <Panel className="px-6 py-12 text-center text-ink-soft">
          Connect a bot's database first; analytics are read from it. <Link to="/bots" className="underline underline-offset-4">Go to Bots</Link>
        </Panel>
      ) : selected.length === 0 ? (
        <Panel className="px-6 py-12 text-center text-ink-soft">Pick at least one bot.</Panel>
      ) : data.error ? (
        <Notice>{data.error.message}</Notice>
      ) : data.data ? (
        <Dashboard d={data.data} bots={info} long={long} />
      ) : null}
    </>
  );
}

function Dashboard({ d, bots, long }: { d: AudienceAnalytics; bots: BotInfo[]; long: string }) {
  const name = (id: number) => bots.find((b) => b.id === id)?.username ?? `bot ${id}`;
  const k = d.kpis;
  const change = k.new_people != null && k.new_people_previous ? (k.new_people - k.new_people_previous) / k.new_people_previous : null;
  return (
    <div className={cx("space-y-8")}>
      {Object.keys(d.errors).length > 0 && (
        <Notice>
          Couldn't read {Object.keys(d.errors).map((id) => `@${name(Number(id))}`).join(", ")}: {Object.values(d.errors)[0]}. Numbers leave
          {Object.keys(d.errors).length === 1 ? " it" : " them"} out.
        </Notice>
      )}

      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="People" value={fmt(k.people)} note={d.bots.length > 1 ? `${fmt(k.subscriptions)} subscriptions across ${d.bots.length} bots` : "can receive broadcasts"} />
        <Kpi
          label={`New in the ${long}`}
          value={k.new_people == null ? "—" : fmt(k.new_people)}
          note={
            k.new_people == null
              ? "Map “Joined at” to track sign-ups"
              : change == null
                ? "no sign-ups in the period before"
                : `${change >= 0 ? "▲" : "▼"} ${pct(Math.abs(change), 1)} vs the period before`
          }
        />
        <Kpi
          label="On 2 or more bots"
          value={fmt(k.multi_bot_people)}
          note={k.people ? `${pct(k.multi_bot_people, k.people)} of people` : "—"}
        />
        <Kpi label={`Blocked in the ${long}`} value={fmt(k.blocked)} note="learned while sending" />
      </dl>

      <Growth d={d} bots={bots} name={name} />

      <div className="grid gap-8 lg:grid-cols-2">
        <OverlapView d={d} bots={bots} name={name} />
        <LanguagesView d={d} name={name} />
      </div>

      <BlockedView d={d} />
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Panel className="p-5">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className="mt-2 text-[30px] leading-none font-semibold tracking-[-0.02em]">{value}</dd>
      <dd className="mt-2 text-sm text-ink-faint">{note}</dd>
    </Panel>
  );
}

// ---- charts --------------------------------------------------------------------------

const unitLabel = { day: "day", week: "week", month: "month" } as const;

function bucketLabel(iso: string, unit: "day" | "week" | "month") {
  const d = new Date(`${iso}T00:00:00Z`);
  return unit === "month"
    ? d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function Growth({ d, bots, name }: { d: AudienceAnalytics; bots: BotInfo[]; name: (id: number) => string }) {
  const [mode, setMode] = useState<"new" | "total">("new");
  const [hover, setHover] = useState<number | null>(null);
  const unit = d.period.unit;
  const buckets = d.period.buckets;
  const series = bots.filter((b) => d.bots.includes(b.id) && !d.growth.missing_joined_at.includes(b.id) && !(String(b.id) in d.errors));
  const grid = buckets.map(() => new Map<number, number>());
  const index = new Map(buckets.map((b, i) => [b, i]));
  for (const p of d.growth.points) {
    const i = index.get(p.t);
    if (i != null) grid[i].set(p.bot_id, (grid[i].get(p.bot_id) ?? 0) + p.count);
  }
  const totals = grid.map((g) => [...g.values()].reduce((a, b) => a + b, 0));
  const base = Object.values(d.growth.before_start).reduce((a, b) => a + b, 0);
  const cumulative = totals.reduce<number[]>((acc, n) => [...acc, (acc.at(-1) ?? base) + n], []);
  const values = mode === "new" ? totals : cumulative;
  const max = Math.max(1, ...values);
  const min = mode === "total" ? Math.min(...cumulative) : 0;

  return (
    <section aria-labelledby="growth-title">
      <SectionHead title="Growth">
        <div className="flex items-center gap-2">
        {series.length > 0 && (
          <CsvButton
            onClick={() =>
              downloadCsv(fileName("growth", d), [
                [unit === "day" ? "date" : unit === "week" ? "week_starting" : "month", ...series.map((s) => `@${s.username}`), "total_new", "signups_to_date"],
                ...buckets.map((b, i) => [b, ...series.map((s) => grid[i].get(s.id) ?? 0), totals[i], cumulative[i]]),
              ])
            }
          />
        )}
        <div role="radiogroup" aria-label="Show" className="inline-flex rounded-lg bg-canvas p-1 text-sm ring-1 ring-line">
          {(
            [
              ["new", `New per ${unitLabel[unit]}`],
              ["total", "Total over time"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={mode === k}
              onClick={() => setMode(k)}
              className={cx("rounded-md px-3 py-1 font-medium", mode === k ? "bg-surface text-ink shadow-[0_1px_3px_rgba(23,33,30,0.12)]" : "text-ink-soft hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
        </div>
      </SectionHead>
      <Panel className="px-5 pt-4 pb-3">
        {series.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-soft">
            None of the selected bots has <strong className="text-ink">Joined at</strong> mapped, so sign-ups can't be shown.
            Add it under the bot's database mapping.
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
              {mode === "new" ? (
                series.map((s) => (
                  <span key={s.id} className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm" style={{ background: s.color }} />@{s.username}
                  </span>
                ))
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 rounded bg-panel" />
                  Sign-ups to date{series.length > 1 ? ", all selected bots" : ""}
                </span>
              )}
            </div>
            <div className="relative" onMouseLeave={() => setHover(null)}>
              <span className="absolute -top-1 left-0 text-[11px] text-ink-faint">{fmt(max)}</span>
              {mode === "new" ? (
                <div className="flex h-56 items-end gap-[2px] border-b border-line pt-4" role="img" aria-label={`New sign-ups per ${unit}. A table version follows.`}>
                  {grid.map((g, i) => (
                    <div key={buckets[i]} className="flex h-full min-w-[3px] flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
                      {totals[i] > 0 && (
                        <div className="flex flex-col-reverse gap-[2px]" style={{ height: `${(totals[i] / max) * 100}%` }}>
                          {series
                            .filter((s) => (g.get(s.id) ?? 0) > 0)
                            .map((s, j, shown) => (
                              <div key={s.id} className={cx(j === shown.length - 1 && "rounded-t-[4px]")} style={{ flexGrow: g.get(s.id), minHeight: 2, background: s.color }} />
                            ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <Line values={cumulative} min={min} max={max} hover={hover} onHover={setHover} />
              )}
              {hover != null && (
                <div className="pointer-events-none absolute top-0 right-0 min-w-[170px] rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-[0_8px_24px_-12px_rgba(19,26,24,0.35)]">
                  <p className="mb-1 font-medium">
                    {unit === "day" ? "" : `${unit === "week" ? "Week of" : ""} `}
                    {bucketLabel(buckets[hover], unit)}
                  </p>
                  {mode === "new" ? (
                    <>
                      {series.map((s) => (
                        <p key={s.id} className="flex justify-between gap-4 text-ink-soft">
                          <span>@{s.username}</span>
                          <span className="text-ink">{fmt(grid[hover].get(s.id) ?? 0)}</span>
                        </p>
                      ))}
                      {series.length > 1 && (
                        <p className="mt-1 flex justify-between gap-4 border-t border-line pt-1 font-medium">
                          <span>Total</span>
                          <span>{fmt(totals[hover])}</span>
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="flex justify-between gap-4 text-ink-soft">
                      <span>Sign-ups to date</span>
                      <span className="text-ink">{fmt(cumulative[hover])}</span>
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-ink-faint">
              <span>{bucketLabel(buckets[0], unit)}</span>
              <span>{bucketLabel(buckets[buckets.length - 1], unit)}</span>
            </div>
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-ink-soft hover:text-ink">Show as table</summary>
              <div className="overflow-x-auto">
                <table className="mt-2 w-full text-left">
                  <thead className="text-ink-faint">
                    <tr>
                      <th className="py-1 font-medium">{unit === "day" ? "Day" : unit === "week" ? "Week of" : "Month"}</th>
                      {series.map((s) => (
                        <th key={s.id} className="py-1 text-right font-medium">@{s.username}</th>
                      ))}
                      <th className="py-1 text-right font-medium">To date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grid.map((g, i) => (
                      <tr key={buckets[i]} className="border-t border-line">
                        <td className="py-1">{bucketLabel(buckets[i], unit)}</td>
                        {series.map((s) => (
                          <td key={s.id} className="py-1 text-right">{fmt(g.get(s.id) ?? 0)}</td>
                        ))}
                        <td className="py-1 text-right">{fmt(cumulative[i])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
        {d.growth.missing_joined_at.length > 0 && series.length > 0 && (
          <p className="mt-3 text-sm text-ink-faint">
            Not included: {d.growth.missing_joined_at.map((id) => `@${name(id)}`).join(", ")}, because “Joined at” isn't mapped.
          </p>
        )}
        <p className="mt-2 text-xs text-ink-faint">By join date, counting people still in each bot's database who match its filters.</p>
      </Panel>
    </section>
  );
}

/** One series line: sign-ups to date. Crosshair + point on hover. */
function Line({ values, min, max, hover, onHover }: { values: number[]; min: number; max: number; hover: number | null; onHover: (i: number) => void }) {
  const W = 1000;
  const H = 220;
  const lo = Math.max(0, min - (max - min) * 0.1);
  const x = (i: number) => (values.length === 1 ? W / 2 : (i / (values.length - 1)) * W);
  const y = (v: number) => H - ((v - lo) / Math.max(1, max - lo)) * (H - 8) - 4;
  const path = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <div className="relative h-56 border-b border-line pt-4">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible" role="img" aria-label="Sign-ups to date over time. A table version follows.">
        <path d={path} fill="none" stroke="var(--color-panel)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="var(--color-line-strong)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      {hover != null && (
        <span
          className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-panel ring-2 ring-surface"
          style={{ left: `${(x(hover) / W) * 100}%`, top: `calc(1rem + (100% - 1rem) * ${(y(values[hover]) / H).toFixed(4)})` }}
        />
      )}
      <div className="absolute inset-0 flex">
        {values.map((_, i) => (
          <div key={i} className="h-full flex-1" onMouseEnter={() => onHover(i)} />
        ))}
      </div>
    </div>
  );
}

function OverlapView({ d, bots, name }: { d: AudienceAnalytics; bots: BotInfo[]; name: (id: number) => string }) {
  const dist = Object.entries(d.overlap.by_bot_count).map(([k, v]) => [Number(k), v] as const);
  const total = dist.reduce((n, [, v]) => n + v, 0);
  const ids = Object.keys(d.overlap.per_bot).map(Number).sort((a, b) => a - b);
  const pair = (a: number, b: number) => d.overlap.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))?.people ?? 0;
  const maxPair = Math.max(1, ...d.overlap.pairs.map((p) => p.people));
  // Sequential: one hue (brand green), light to dark by share of the largest pair.
  const shade = ["#eef3f0", "#cfe0d7", "#9fc2b0", "#5f9a80", "#2f6b54", "#17332c"];

  return (
    <section aria-labelledby="overlap-title">
      <SectionHead title="Overlap between bots">
        {ids.length > 1 && (
          <CsvButton
            onClick={() =>
              downloadCsv(fileName("overlap", d), [
                ["bot_a", "bot_b", "shared_people", "bot_a_people", "bot_b_people", "share_of_smaller_bot"],
                ...d.overlap.pairs.map((p) => {
                  const a = d.overlap.per_bot[p.a];
                  const b = d.overlap.per_bot[p.b];
                  return [`@${name(p.a)}`, `@${name(p.b)}`, p.people, a, b, Math.min(a, b) ? (p.people / Math.min(a, b)).toFixed(4) : 0];
                }),
                [],
                ["on_number_of_bots", "people"],
                ...dist.map(([k, v]) => [k, v]),
              ])
            }
          />
        )}
      </SectionHead>
      <Panel className="space-y-5 p-5">
        {ids.length < 2 ? (
          <p className="text-sm text-ink-soft">Select two or more bots to see who they share.</p>
        ) : (
          <>
            <div>
              <p className="mb-2 text-sm text-ink-soft">People by how many of these bots they follow</p>
              <div className="flex h-3 gap-[2px] overflow-hidden rounded-full" role="img" aria-label={dist.map(([k, v]) => `${k} bot${k > 1 ? "s" : ""}: ${v}`).join(", ")}>
                {dist.map(([k, v], i) => (
                  <span key={k} style={{ flexGrow: v, background: shade[Math.min(shade.length - 1, 1 + i * 2)] }} />
                ))}
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                {dist.map(([k, v], i) => (
                  <li key={k} className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm" style={{ background: shade[Math.min(shade.length - 1, 1 + i * 2)] }} />
                    <span className="text-ink-soft">{k === 1 ? "Only 1 bot" : `${k} bots`}</span>
                    <span className="font-medium">{fmt(v)}</span>
                    <span className="text-ink-faint">({pct(v, total)})</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="overflow-x-auto">
              <p className="mb-2 text-sm text-ink-soft">Shared people, bot by bot</p>
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th />
                    {ids.map((id) => (
                      <th key={id} className="px-1 pb-1.5 text-left text-xs font-medium text-ink-soft">
                        <span className="inline-flex items-center gap-1">
                          <span className="size-2 rounded-full" style={{ background: bots.find((b) => b.id === id)?.color }} />@{name(id)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ids.map((r) => (
                    <tr key={r}>
                      <th className="pr-2 text-left text-xs font-medium whitespace-nowrap text-ink-soft">@{name(r)}</th>
                      {ids.map((c) => {
                        if (r === c)
                          return (
                            <td key={c} className="p-0.5">
                              <div className="rounded-md bg-canvas px-2 py-2 text-ink-faint" title={`${fmt(d.overlap.per_bot[r])} people on @${name(r)}`}>
                                {fmt(d.overlap.per_bot[r])}
                              </div>
                            </td>
                          );
                        const n = pair(r, c);
                        const level = Math.min(shade.length - 1, Math.round((n / maxPair) * (shade.length - 1)));
                        const smaller = Math.min(d.overlap.per_bot[r], d.overlap.per_bot[c]);
                        return (
                          <td key={c} className="p-0.5">
                            <div
                              className={cx("rounded-md px-2 py-2", level >= 4 ? "text-white" : "text-ink")}
                              style={{ background: shade[level] }}
                              title={`@${name(r)} and @${name(c)} share ${fmt(n)} people (${pct(n, smaller)} of the smaller bot)`}
                            >
                              <span className="font-medium">{fmt(n)}</span>
                              <span className={cx("ml-1 text-xs", level >= 4 ? "text-white/75" : "text-ink-faint")}>{pct(n, smaller)}</span>
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-ink-faint">Grey cells: each bot's own total. Percentages are of the smaller bot in the pair.</p>
            </div>
          </>
        )}
      </Panel>
    </section>
  );
}

const languageName = (() => {
  const names = new Intl.DisplayNames(undefined, { type: "language" });
  return (code: string) => {
    if (code === "other") return "Other";
    try {
      return names.of(code) ?? code;
    } catch {
      return code;
    }
  };
})();

function LanguagesView({ d, name }: { d: AudienceAnalytics; name: (id: number) => string }) {
  const items = d.languages.items;
  const max = Math.max(1, ...items.map((i) => i.people));
  const total = items.reduce((n, i) => n + i.people, 0) + d.languages.unknown;
  const missingAll = d.languages.missing_language.length === d.bots.length;
  return (
    <section aria-labelledby="lang-title">
      <SectionHead title="Languages">
        {items.length > 0 && (
          <CsvButton
            onClick={() =>
              downloadCsv(fileName("languages", d), [
                ["language_code", "language", "people", "share"],
                ...items.map((i) => [i.code, languageName(i.code), i.people, (i.people / total).toFixed(4)]),
                ...(d.languages.unknown ? [["", "Not recorded", d.languages.unknown, (d.languages.unknown / total).toFixed(4)]] : []),
              ])
            }
          />
        )}
      </SectionHead>
      <Panel className="p-5">
        {missingAll ? (
          <p className="text-sm text-ink-soft">
            Map <strong className="text-ink">Language</strong> in a bot's database mapping to see this.
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-soft">No language recorded for these people.</p>
        ) : (
          <ul className="space-y-2" aria-label="People by language">
            {items.map((i) => (
              <li key={i.code} className="grid grid-cols-[110px_minmax(0,1fr)_auto] items-center gap-3 text-sm">
                <span className="truncate" title={i.code}>{languageName(i.code)}</span>
                <span className="h-2.5 overflow-hidden rounded-full bg-canvas">
                  <span className="block h-full rounded-full bg-panel" style={{ width: `${(i.people / max) * 100}%` }} />
                </span>
                <span className="w-24 text-right">
                  <span className="font-medium">{fmt(i.people)}</span> <span className="text-ink-faint">{pct(i.people, total)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {!missingAll && (d.languages.unknown > 0 || d.languages.missing_language.length > 0) && (
          <p className="mt-4 text-xs text-ink-faint">
            {d.languages.unknown > 0 && `${fmt(d.languages.unknown)} with no language recorded. `}
            {d.languages.missing_language.length > 0 &&
              `Not included: ${d.languages.missing_language.map((id) => `@${name(id)}`).join(", ")}.`}
          </p>
        )}
      </Panel>
    </section>
  );
}

function BlockedView({ d }: { d: AudienceAnalytics }) {
  const unit = d.period.unit;
  const byT = new Map(d.blocked.map((b) => [b.t, b.count]));
  const values = d.period.buckets.map((b) => byT.get(b) ?? 0);
  const max = Math.max(1, ...values);
  const [hover, setHover] = useState<number | null>(null);
  if (!values.some(Boolean)) return null;
  return (
    <section aria-labelledby="blocked-title">
      <SectionHead title="Blocks over time">
        <CsvButton
          onClick={() =>
            downloadCsv(fileName("blocks", d), [
              [unit === "day" ? "date" : unit === "week" ? "week_starting" : "month", "blocked"],
              ...d.period.buckets.map((b, i) => [b, values[i]]),
            ])
          }
        />
      </SectionHead>
      <Panel className="px-5 pt-4 pb-3">
        <p className="mb-3 text-xs text-ink-soft">People found to have blocked a bot, per {unitLabel[unit]}, while sending.</p>
        <div className="relative" onMouseLeave={() => setHover(null)}>
          <div className="flex h-28 items-end gap-[2px] border-b border-line" role="img" aria-label={`Blocks per ${unit}: ${values.reduce((a, b) => a + b, 0)} in total.`}>
            {values.map((v, i) => (
              <div key={d.period.buckets[i]} className="flex h-full min-w-[3px] flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
                {v > 0 && <div className="rounded-t-[4px] bg-chart-blocked" style={{ height: `${(v / max) * 100}%`, minHeight: 2 }} />}
              </div>
            ))}
          </div>
          {hover != null && (
            <div className="pointer-events-none absolute top-0 right-0 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-[0_8px_24px_-12px_rgba(19,26,24,0.35)]">
              {bucketLabel(d.period.buckets[hover], unit)}: <span className="font-medium">{fmt(values[hover])}</span> blocked
            </div>
          )}
        </div>
        <div className="mt-1.5 flex justify-between text-[11px] text-ink-faint">
          <span>{bucketLabel(d.period.buckets[0], unit)}</span>
          <span>{bucketLabel(d.period.buckets[d.period.buckets.length - 1], unit)}</span>
        </div>
      </Panel>
    </section>
  );
}

function exportSummary(d: AudienceAnalytics, bots: BotInfo[], long: string) {
  const name = (id: number) => `@${bots.find((b) => b.id === id)?.username ?? id}`;
  const k = d.kpis;
  downloadCsv(fileName("summary", d), [
    ["metric", "value"],
    ["period", long],
    ["from", d.period.start],
    ["to", d.period.end],
    ["bots", d.bots.map(name).join(" ")],
    ["people", k.people],
    ["subscriptions", k.subscriptions],
    ["people_on_2_or_more_bots", k.multi_bot_people],
    ["new_people", k.new_people ?? ""],
    ["new_people_previous_period", k.new_people_previous ?? ""],
    ["blocked", k.blocked],
    [],
    ["bot", "people"],
    ...Object.entries(d.overlap.per_bot).map(([id, n]) => [name(Number(id)), n]),
  ]);
}
