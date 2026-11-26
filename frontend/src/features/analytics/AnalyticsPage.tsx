import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Chart } from "../../components/chart/Chart";
import { axis, base, C, zoom } from "../../components/chart/theme";
import {
  api,
  type AnalyticsRange,
  type AudienceAnalytics,
  type Bot,
  type Breakdown,
  type BroadcastAnalytics,
  type ColumnChoice,
} from "../../lib/api";
import { downloadCsv } from "../../lib/csv";
import { duration, fmt, pct, when } from "../../lib/format";
import { CampaignStatusTag, cx, fieldClass, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";
import { botColor } from "../../components/BotAvatar";

const RANGES: { key: AnalyticsRange; label: string; long: string }[] = [
  { key: "7d", label: "7D", long: "last 7 days" },
  { key: "30d", label: "30D", long: "last 30 days" },
  { key: "90d", label: "90D", long: "last 90 days" },
  { key: "12m", label: "12M", long: "last 12 months" },
  { key: "all", label: "All", long: "all time" },
];

type BotInfo = { id: number; username: string; color: string };
type Unit = AudienceAnalytics["period"]["unit"];

const today = () => new Date().toISOString().slice(0, 10);
const fileName = (what: string, range: string) => `orbit-${what}-${range}-${today()}.csv`;

function bucketLabel(iso: string, unit: Unit) {
  const d = new Date(`${iso}T00:00:00Z`);
  return unit === "month"
    ? d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" })
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

// ---- page ----------------------------------------------------------------------------

export function AnalyticsPage() {
  const [tab, setTab] = useState<"audience" | "broadcasts">("audience");
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const [picked, setPicked] = useState<number[] | null>(null); // null = all connected bots
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<Bot[]>("/bots") });
  const connected = (bots.data ?? []).filter((b) => b.subscribers.connected).sort((a, b) => a.id - b.id);
  // Colour follows the bot (by id order), not what's currently selected.
  const info: BotInfo[] = connected.map((b) => ({ id: b.id, username: b.username, color: botColor(b.id) }));
  const selected = picked ?? connected.map((b) => b.id);
  const qs = new URLSearchParams([["range", range], ...(picked ? picked.map((id) => ["bot", String(id)]) : [])]);
  const long = RANGES.find((r) => r.key === range)!.long;

  const toggle = (id: number) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
    setPicked(next.length === connected.length ? null : next);
  };

  return (
    <>
      <PageHeader title="Analytics" lede="Who your bots reach, how that's changing, and how broadcasts perform." />

      <div className="mb-5 flex gap-1 border-b border-line" role="tablist" aria-label="Analytics">
        {(
          [
            ["audience", "Audience"],
            ["broadcasts", "Broadcasts"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cx("-mb-px border-b-2 px-3 py-2.5 text-[15px]", tab === k ? "border-accent font-medium text-ink" : "border-transparent text-ink-soft hover:text-ink")}
          >
            {label}
          </button>
        ))}
      </div>

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
                  <span className="size-2.5 rounded-full" style={{ background: on ? b.color : "var(--color-line-strong)" }} />@{b.username}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {bots.isPending ? (
        <Skeleton className="h-96" />
      ) : connected.length === 0 ? (
        <Panel className="px-6 py-12 text-center text-ink-soft">
          Connect a bot's database first; analytics are read from it.{" "}
          <Link to="/bots" className="underline underline-offset-4">Go to Bots</Link>
        </Panel>
      ) : selected.length === 0 ? (
        <Panel className="px-6 py-12 text-center text-ink-soft">Pick at least one bot.</Panel>
      ) : tab === "audience" ? (
        <AudienceTab qs={qs} range={range} picked={picked} bots={info} selected={selected} long={long} />
      ) : (
        <BroadcastsTab qs={qs} range={range} picked={picked} />
      )}
    </>
  );
}

function CsvButton({ onClick, label = "CSV" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-ink-soft hover:bg-line/60 hover:text-ink">
      <Download size={14} /> {label}
    </button>
  );
}

function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-canvas p-1 text-sm ring-1 ring-line">
      {options.map(([k, text]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={cx("rounded-md px-3 py-1 font-medium", value === k ? "bg-surface text-ink shadow-[0_1px_3px_rgba(23,33,30,0.12)]" : "text-ink-soft hover:text-ink")}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Dashed vertical lines where broadcasts started; hover one to see its name. */
function markers(d: AudienceAnalytics, labels: string[]) {
  const byBucket = new Map<string, string[]>();
  for (const m of d.broadcasts) byBucket.set(m.bucket, [...(byBucket.get(m.bucket) ?? []), m.name]);
  const data = [...byBucket.entries()]
    .filter(([b]) => d.period.buckets.includes(b))
    .map(([b, names]) => ({ xAxis: labels[d.period.buckets.indexOf(b)], name: names.join(", ") }));
  return {
    silent: false,
    symbol: "none",
    lineStyle: { color: C.faint, type: "dashed", width: 1 },
    label: { show: false },
    emphasis: { label: { show: true, formatter: "📣 {b}", position: "insideEndTop", color: C.ink, fontSize: 11 } },
    tooltip: { show: false },
    data,
  };
}

// ---- audience ------------------------------------------------------------------------

function AudienceTab({ qs, range, picked, bots, selected, long }: { qs: URLSearchParams; range: AnalyticsRange; picked: number[] | null; bots: BotInfo[]; selected: number[]; long: string }) {
  const q = useQuery({
    queryKey: ["analytics", range, picked],
    queryFn: () => api<AudienceAnalytics>(`/analytics/audience?${qs}`),
    placeholderData: (prev) => prev,
  });
  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.error) return <Notice>{q.error.message}</Notice>;
  const d = q.data;
  const name = (id: number) => bots.find((b) => b.id === id)?.username ?? `bot ${id}`;
  const k = d.kpis;
  const change = k.new_people != null && k.new_people_previous ? (k.new_people - k.new_people_previous) / k.new_people_previous : null;

  return (
    <div className="space-y-8">
      {Object.keys(d.errors).length > 0 && (
        <Notice>
          Couldn't read {Object.keys(d.errors).map((id) => `@${name(Number(id))}`).join(", ")}: {Object.values(d.errors)[0]}. Numbers leave
          {Object.keys(d.errors).length === 1 ? " it" : " them"} out.
        </Notice>
      )}

      <div className="flex justify-end">
        <CsvButton label="Download summary" onClick={() => exportSummary(d, bots, long)} />
      </div>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="People" value={fmt(k.people)} note={d.bots.length > 1 ? `${fmt(k.subscriptions)} subscriptions across ${d.bots.length} bots` : "can receive broadcasts"} />
        <Kpi
          label={`New in the ${long}`}
          value={k.new_people == null ? "—" : fmt(k.new_people)}
          note={k.new_people == null ? "Map “Joined at” to track sign-ups" : change == null ? "no sign-ups in the period before" : `${change >= 0 ? "▲" : "▼"} ${pct(Math.abs(change), 1)} vs the period before`}
        />
        <Kpi label="On 2 or more bots" value={fmt(k.multi_bot_people)} note={k.people ? `${pct(k.multi_bot_people, k.people)} of people` : "—"} />
        <Kpi label={`Blocked in the ${long}`} value={fmt(k.blocked)} note="learned while sending" />
      </dl>

      <GrowthSection d={d} bots={bots} name={name} range={range} />
      <NetGrowthSection d={d} range={range} />
      <div className="grid gap-8 lg:grid-cols-2">
        <ReachSection d={d} name={name} range={range} />
        <ChatTypesSection d={d} name={name} range={range} />
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <OverlapSection d={d} name={name} range={range} />
        <LanguagesSection d={d} name={name} range={range} />
      </div>
      <BreakdownSection bots={bots.filter((b) => selected.includes(b.id))} />
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

function growthGrid(d: AudienceAnalytics) {
  const index = new Map(d.period.buckets.map((b, i) => [b, i]));
  const grid = d.period.buckets.map(() => new Map<number, number>());
  for (const p of d.growth.points) {
    const i = index.get(p.t);
    if (i != null) grid[i].set(p.bot_id, (grid[i].get(p.bot_id) ?? 0) + p.count);
  }
  const totals = grid.map((g) => [...g.values()].reduce((a, b) => a + b, 0));
  const base0 = Object.values(d.growth.before_start).reduce((a, b) => a + b, 0);
  const cumulative = totals.reduce<number[]>((acc, n) => [...acc, (acc.at(-1) ?? base0) + n], []);
  return { grid, totals, cumulative };
}

function GrowthSection({ d, bots, name, range }: { d: AudienceAnalytics; bots: BotInfo[]; name: (id: number) => string; range: string }) {
  const [mode, setMode] = useState<"new" | "total">("new");
  const unit = d.period.unit;
  const labels = d.period.buckets.map((b) => bucketLabel(b, unit));
  const series = bots.filter((b) => d.bots.includes(b.id) && !d.growth.missing_joined_at.includes(b.id) && !(String(b.id) in d.errors));
  const { grid, totals, cumulative } = growthGrid(d);
  const long = labels.length > 31;

  const option = useMemo(() => {
    const common = {
      ...base,
      tooltip: { ...base.tooltip, trigger: "axis", axisPointer: { type: mode === "new" ? "shadow" : "line" } },
      grid: { left: 8, right: 8, top: 36, bottom: long ? 36 : 8, containLabel: true },
      xAxis: { ...axis, type: "category", data: labels, boundaryGap: mode === "new", splitLine: { show: false } },
      yAxis: { ...axis, type: "value", minInterval: 1, scale: mode === "total" },
      dataZoom: zoom(long),
    };
    if (mode === "new")
      return {
        ...common,
        legend: { ...base.legend, data: series.map((s) => `@${s.username}`) },
        series: series.map((s, j) => ({
          name: `@${s.username}`,
          type: "bar",
          stack: "new",
          barMaxWidth: 32,
          itemStyle: { color: s.color, borderColor: C.surface, borderWidth: 1, borderRadius: j === series.length - 1 ? [4, 4, 0, 0] : 0 },
          emphasis: { focus: "series" },
          data: grid.map((g) => g.get(s.id) ?? 0),
          ...(j === 0 ? { markLine: markers(d, labels) } : {}),
        })),
      };
    return {
      ...common,
      legend: { ...base.legend, data: ["Sign-ups to date"] },
      series: [
        {
          name: "Sign-ups to date",
          type: "line",
          data: cumulative,
          showSymbol: false,
          lineStyle: { width: 2, color: C.panel },
          itemStyle: { color: C.panel },
          areaStyle: { color: "rgba(23,51,44,0.06)" },
          markLine: markers(d, labels),
        },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, mode, JSON.stringify(series.map((s) => s.id))]);

  return (
    <section aria-labelledby="growth-title">
      <SectionHead title="Growth">
        {series.length > 0 && (
          <CsvButton
            onClick={() =>
              downloadCsv(fileName("growth", range), [
                [unit === "day" ? "date" : unit === "week" ? "week_starting" : "month", ...series.map((s) => `@${s.username}`), "total_new", "signups_to_date"],
                ...d.period.buckets.map((b, i) => [b, ...series.map((s) => grid[i].get(s.id) ?? 0), totals[i], cumulative[i]]),
              ])
            }
          />
        )}
        <Segmented label="Show" value={mode} onChange={setMode} options={[["new", `New per ${unit}`], ["total", "Total over time"]]} />
      </SectionHead>
      <Panel className="px-5 pt-4 pb-3">
        {series.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-soft">
            None of the selected bots has <strong className="text-ink">Joined at</strong> mapped, so sign-ups can't be shown. Add it under the bot's database mapping.
          </p>
        ) : (
          <>
            <Chart option={option} height={300} label={mode === "new" ? `New sign-ups per ${unit} by bot` : "Sign-ups to date"} />
            <p className="mt-1 text-xs text-ink-faint">
              By join date, counting people still in each bot's database who match its filters. Dashed lines mark broadcasts; hover to see which.
              {d.growth.missing_joined_at.length > 0 && ` Not included: ${d.growth.missing_joined_at.map((id) => `@${name(id)}`).join(", ")} (no “Joined at”).`}
            </p>
            <DataTable
              head={[unit === "day" ? "Day" : unit === "week" ? "Week of" : "Month", ...series.map((s) => `@${s.username}`), "To date"]}
              rows={d.period.buckets.map((_, i) => [labels[i], ...series.map((s) => fmt(grid[i].get(s.id) ?? 0)), fmt(cumulative[i])])}
            />
          </>
        )}
      </Panel>
    </section>
  );
}

/** New sign-ups above the axis, blocks below, and the net as a line: is the audience really growing? */
function NetGrowthSection({ d, range }: { d: AudienceAnalytics; range: string }) {
  const unit = d.period.unit;
  const labels = d.period.buckets.map((b) => bucketLabel(b, unit));
  const { totals } = growthGrid(d);
  const hasGrowth = d.kpis.new_people != null;
  const blockedBy = new Map(d.blocked.map((b) => [b.t, b.count]));
  const blocked = d.period.buckets.map((b) => blockedBy.get(b) ?? 0);
  const net = totals.map((n, i) => n - blocked[i]);
  const long = labels.length > 31;
  if (!hasGrowth && !blocked.some(Boolean)) return null;

  const option = {
    ...base,
    legend: { ...base.legend, data: [...(hasGrowth ? ["New", "Net"] : []), "Blocked"] },
    tooltip: { ...base.tooltip, trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 8, right: 8, top: 36, bottom: long ? 36 : 8, containLabel: true },
    xAxis: { ...axis, type: "category", data: labels, splitLine: { show: false } },
    yAxis: { ...axis, type: "value", minInterval: 1 },
    dataZoom: zoom(long),
    series: [
      ...(hasGrowth
        ? [{ name: "New", type: "bar", stack: "net", barMaxWidth: 32, itemStyle: { color: C.delivered, borderRadius: [4, 4, 0, 0] }, data: totals, markLine: markers(d, labels) }]
        : []),
      { name: "Blocked", type: "bar", stack: "net", barMaxWidth: 32, itemStyle: { color: C.blocked, borderRadius: [0, 0, 4, 4] }, data: blocked.map((b) => -b) },
      ...(hasGrowth ? [{ name: "Net", type: "line", data: net, showSymbol: false, lineStyle: { width: 2, color: C.ink }, itemStyle: { color: C.ink } }] : []),
    ],
  };

  return (
    <section aria-labelledby="net-title">
      <SectionHead title="Net growth">
        <CsvButton
          onClick={() =>
            downloadCsv(fileName("net-growth", range), [
              [unit === "day" ? "date" : unit === "week" ? "week_starting" : "month", "new", "blocked", "net"],
              ...d.period.buckets.map((b, i) => [b, hasGrowth ? totals[i] : "", blocked[i], hasGrowth ? net[i] : ""]),
            ])
          }
        />
      </SectionHead>
      <Panel className="px-5 pt-4 pb-3">
        <Chart option={option} height={260} label={`New sign-ups and blocks per ${unit}`} />
        <p className="mt-1 text-xs text-ink-faint">
          {hasGrowth ? "New sign-ups above the line, people who blocked a bot below it; the line is the difference." : "People who blocked a bot, per period. Map “Joined at” to compare with sign-ups."}
        </p>
      </Panel>
    </section>
  );
}

function OverlapSection({ d, name, range }: { d: AudienceAnalytics; name: (id: number) => string; range: string }) {
  const dist = Object.entries(d.overlap.by_bot_count).map(([k, v]) => [Number(k), v] as const);
  const total = dist.reduce((n, [, v]) => n + v, 0);
  const ids = Object.keys(d.overlap.per_bot).map(Number).sort((a, b) => a - b);
  const pair = (a: number, b: number) => d.overlap.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a))?.people ?? 0;
  const maxPair = Math.max(1, ...d.overlap.pairs.map((p) => p.people));
  const names = ids.map((id) => `@${name(id)}`);

  const option = {
    ...base,
    toolbox: { ...base.toolbox, feature: { saveAsImage: base.toolbox.feature.saveAsImage } },
    tooltip: {
      ...base.tooltip,
      formatter: (p: { value: [number, number, number] }) => {
        const [x, y, n] = p.value;
        if (x === y) return `${names[x]}: ${fmt(n)} people`;
        const smaller = Math.min(d.overlap.per_bot[ids[x]], d.overlap.per_bot[ids[y]]);
        return `${names[x]} and ${names[y]} share <b>${fmt(n)}</b> people<br/>${pct(n, smaller)} of the smaller bot`;
      },
    },
    grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
    xAxis: { ...axis, type: "category", data: names, splitArea: { show: false }, axisLabel: { ...axis.axisLabel, interval: 0 } },
    yAxis: { ...axis, type: "category", data: names, inverse: true, splitArea: { show: false } },
    visualMap: { show: false, min: 0, max: maxPair, inRange: { color: C.sequential }, seriesIndex: 0 },
    series: [
      {
        type: "heatmap",
        data: ids.flatMap((a, x) => ids.filter((b) => b !== a).map((b) => [x, ids.indexOf(b), pair(a, b)])),
        label: { show: true, color: C.ink, fontSize: 11, formatter: (p: { value: number[] }) => fmt(p.value[2]) },
        itemStyle: { borderColor: C.surface, borderWidth: 2, borderRadius: 4 },
        emphasis: { itemStyle: { borderColor: C.ink, borderWidth: 1 } },
      },
      {
        type: "heatmap",
        data: ids.map((a, x) => [x, x, d.overlap.per_bot[a]]),
        label: { show: true, color: C.faint, fontSize: 11, formatter: (p: { value: number[] }) => fmt(p.value[2]) },
        itemStyle: { color: "#f3f5f3", borderColor: C.surface, borderWidth: 2, borderRadius: 4 },
      },
    ],
  };

  return (
    <section aria-labelledby="overlap-title">
      <SectionHead title="Overlap between bots">
        {ids.length > 1 && (
          <CsvButton
            onClick={() =>
              downloadCsv(fileName("overlap", range), [
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
                  <span key={k} style={{ flexGrow: v, background: C.sequential[Math.min(5, 1 + i * 2)] }} />
                ))}
              </div>
              <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                {dist.map(([k, v], i) => (
                  <li key={k} className="inline-flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm" style={{ background: C.sequential[Math.min(5, 1 + i * 2)] }} />
                    <span className="text-ink-soft">{k === 1 ? "Only 1 bot" : `${k} bots`}</span>
                    <span className="font-medium">{fmt(v)}</span>
                    <span className="text-ink-faint">({pct(v, total)})</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 text-sm text-ink-soft">Shared people, bot by bot</p>
              <Chart option={option} height={Math.max(160, 64 + ids.length * 44)} label={`Shared people between ${ids.length} bots`} />
              <p className="mt-1 text-xs text-ink-faint">Grey cells: each bot's own total. Hover a cell for its share of the smaller bot.</p>
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

function HBars({ rows, label, color = C.panel }: { rows: { label: string; value: number; share: string }[]; label: string; color?: string }) {
  const option = {
    ...base,
    toolbox: { ...base.toolbox, feature: { saveAsImage: base.toolbox.feature.saveAsImage } },
    tooltip: { ...base.tooltip, trigger: "item", formatter: (p: { name: string; value: number; dataIndex: number }) => `${p.name}: <b>${fmt(p.value)}</b> (${rows[p.dataIndex].share})` },
    grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true },
    xAxis: { ...axis, type: "value", minInterval: 1, axisLabel: { show: false }, splitLine: { show: false } },
    yAxis: { ...axis, type: "category", inverse: true, data: rows.map((r) => r.label), axisLabel: { ...axis.axisLabel, color: C.soft, fontSize: 12 } },
    series: [
      {
        type: "bar",
        data: rows.map((r) => r.value),
        barMaxWidth: 14,
        itemStyle: { color, borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", color: C.ink, fontSize: 11, formatter: (p: { value: number }) => fmt(p.value) },
      },
    ],
  };
  return <Chart option={option} height={Math.max(120, rows.length * 30 + 16)} label={label} />;
}

function LanguagesSection({ d, name, range }: { d: AudienceAnalytics; name: (id: number) => string; range: string }) {
  const items = d.languages.items;
  const total = items.reduce((n, i) => n + i.people, 0) + d.languages.unknown;
  const missingAll = d.languages.missing_language.length === d.bots.length;
  return (
    <section aria-labelledby="lang-title">
      <SectionHead title="Languages">
        {items.length > 0 && (
          <CsvButton
            onClick={() =>
              downloadCsv(fileName("languages", range), [
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
          <p className="text-sm text-ink-soft">Map <strong className="text-ink">Language</strong> in a bot's database mapping to see this.</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-soft">No language recorded for these people.</p>
        ) : (
          <HBars label="People by language" rows={items.map((i) => ({ label: languageName(i.code), value: i.people, share: pct(i.people, total) }))} />
        )}
        {!missingAll && (d.languages.unknown > 0 || d.languages.missing_language.length > 0) && (
          <p className="mt-3 text-xs text-ink-faint">
            {d.languages.unknown > 0 && `${fmt(d.languages.unknown)} with no language recorded. `}
            {d.languages.missing_language.length > 0 && `Not included: ${d.languages.missing_language.map((id) => `@${name(id)}`).join(", ")}.`}
          </p>
        )}
      </Panel>
    </section>
  );
}

const REACH: { key: "active" | "blocked" | "unreachable" | "left" | "deleted"; label: string; color: string }[] = [
  { key: "active", label: "Can receive", color: C.delivered },
  { key: "blocked", label: "Blocked the bot", color: C.blocked },
  { key: "unreachable", label: "Unreachable", color: C.unreachable },
  { key: "left", label: "Removed from group", color: C.failed },
  { key: "deleted", label: "Deleted account", color: C.deleted },
];

/** Per bot: who can receive a broadcast now, and why the rest can't. */
function ReachSection({ d, name, range }: { d: AudienceAnalytics; name: (id: number) => string; range: string }) {
  const ids = d.bots.filter((id) => d.reach[id]);
  const option = {
    ...base,
    legend: { ...base.legend, data: REACH.map((r) => r.label) },
    tooltip: { ...base.tooltip, trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    xAxis: { ...axis, type: "value", minInterval: 1, axisLabel: { ...axis.axisLabel, formatter: (v: number) => fmt(v) } },
    yAxis: { ...axis, type: "category", inverse: true, data: ids.map((id) => `@${name(id)}`), axisLabel: { ...axis.axisLabel, color: C.soft, fontSize: 12 } },
    series: REACH.map((r) => ({
      name: r.label,
      type: "bar",
      stack: "reach",
      barMaxWidth: 18,
      itemStyle: { color: r.color, borderColor: C.surface, borderWidth: 1 },
      data: ids.map((id) => d.reach[id][r.key]),
    })),
  };
  return (
    <section aria-labelledby="reach-title">
      <SectionHead title="Who can receive">
        <CsvButton
          onClick={() =>
            downloadCsv(fileName("reach", range), [
              ["bot", ...REACH.map((r) => r.key)],
              ...ids.map((id) => [`@${name(id)}`, ...REACH.map((r) => d.reach[id][r.key])]),
            ])
          }
        />
      </SectionHead>
      <Panel className="p-5">
        <Chart option={option} height={Math.max(140, ids.length * 40 + 56)} label="Who each bot can reach" />
        <p className="mt-3 text-xs text-ink-faint">
          Right now, from each bot's own records and Orbit's sends. Blocks and removals show up here once the bot's database maps its status.
        </p>
      </Panel>
    </section>
  );
}

const TYPE_LABELS: Record<string, string> = { private: "People", group: "Groups", supergroup: "Supergroups", channel: "Channels" };

/** Reachable chats by type, the combined size of the groups, and the Premium share. */
function ChatTypesSection({ d, name, range }: { d: AudienceAnalytics; name: (id: number) => string; range: string }) {
  const types: Record<string, number> = {};
  for (const counts of Object.values(d.chat_types.per_bot))
    for (const [k, n] of Object.entries(counts)) types[k] = (types[k] ?? 0) + n;
  const rows = Object.entries(types).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((n, [, v]) => n + v, 0);
  const members = Object.values(d.chat_types.group_members).reduce((n, v) => n + v, 0);
  const premium = Object.values(d.premium.premium).reduce((n, v) => n + v, 0);
  const people = Object.values(d.premium.people).reduce((n, v) => n + v, 0);
  const noTypes = d.chat_types.missing.length === d.bots.length;
  const noPremium = d.premium.missing.length === d.bots.length;
  const missing = [...new Set([...d.chat_types.missing, ...d.premium.missing])];
  return (
    <section aria-labelledby="types-title">
      <SectionHead title="Chats and Premium">
        {rows.length > 0 && (
          <CsvButton
            onClick={() =>
              downloadCsv(fileName("chat-types", range), [
                ["type", "chats", "share"],
                ...rows.map(([k, v]) => [k, v, (v / total).toFixed(4)]),
              ])
            }
          />
        )}
      </SectionHead>
      <Panel className="p-5">
        {noTypes && noPremium ? (
          <p className="text-sm text-ink-soft">
            Map <strong className="text-ink">Chat type</strong> and <strong className="text-ink">Premium</strong> in a bot's database mapping to see this.
          </p>
        ) : (
          <>
            {!noTypes && rows.length > 0 && (
              <HBars label="Reachable chats by type" rows={rows.map(([k, v]) => ({ label: TYPE_LABELS[k] ?? k, value: v, share: pct(v, total) }))} />
            )}
            <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
              {!noTypes && (
                <div>
                  <dt className="text-ink-faint">Members in those groups</dt>
                  <dd className="mt-0.5 text-lg font-semibold">{members ? fmt(members) : "—"}</dd>
                </div>
              )}
              {!noPremium && (
                <div>
                  <dt className="text-ink-faint">Telegram Premium</dt>
                  <dd className="mt-0.5 text-lg font-semibold">
                    {people ? pct(premium, people) : "—"}
                    <span className="ml-1.5 text-sm font-normal text-ink-faint">{fmt(premium)} of {fmt(people)} people</span>
                  </dd>
                </div>
              )}
            </dl>
          </>
        )}
        {missing.length > 0 && !(noTypes && noPremium) && (
          <p className="mt-3 text-xs text-ink-faint">Not included: {missing.map((id) => `@${name(id)}`).join(", ")}.</p>
        )}
      </Panel>
    </section>
  );
}

/** Pick a bot and any column (its own table or a linked one) to see how its people split. */
function BreakdownSection({ bots }: { bots: BotInfo[] }) {
  const [botId, setBotId] = useState<number | null>(null);
  const bot = bots.find((b) => b.id === botId) ?? bots[0];
  const [column, setColumn] = useState<string>("");
  const cols = useQuery({
    queryKey: ["analytics-columns", bot?.id],
    queryFn: () => api<ColumnChoice[]>(`/analytics/columns?bot=${bot!.id}`),
    enabled: !!bot,
    staleTime: 5 * 60_000,
  });
  const data = useQuery({
    queryKey: ["analytics-breakdown", bot?.id, column],
    queryFn: () => api<Breakdown>(`/analytics/breakdown?bot=${bot!.id}&column=${encodeURIComponent(column)}`),
    enabled: !!bot && !!column,
  });
  if (!bot) return null;
  const tables = [...new Set((cols.data ?? []).map((c) => c.table))];
  const b = data.data;
  const rows = b
    ? [
        ...(b.grouped_by_month ? [...b.items].sort((x, y) => x.value.localeCompare(y.value)) : b.items).map((i) => ({ label: i.value, value: i.people, share: pct(i.people, b.total) })),
        ...(b.other ? [{ label: "Other values", value: b.other, share: pct(b.other, b.total) }] : []),
        ...(b.empty ? [{ label: "Empty", value: b.empty, share: pct(b.empty, b.total) }] : []),
      ]
    : [];

  return (
    <section aria-labelledby="breakdown-title">
      <SectionHead title="Breakdown">
        {b && (
          <CsvButton
            onClick={() =>
              downloadCsv(`orbit-breakdown-${bot.username}-${b.column}-${today()}.csv`, [["value", "people", "share"], ...rows.map((r) => [r.label, r.value, r.share])])
            }
          />
        )}
      </SectionHead>
      <Panel className="p-5">
        <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-soft">Split</span>
          {bots.length > 1 ? (
            <select aria-label="Bot" className={`${fieldClass} h-9 w-auto`} value={bot.id} onChange={(e) => { setBotId(Number(e.target.value)); setColumn(""); }}>
              {bots.map((x) => (
                <option key={x.id} value={x.id}>@{x.username}</option>
              ))}
            </select>
          ) : (
            <span className="font-medium">@{bot.username}</span>
          )}
          <span className="text-ink-soft">people by</span>
          <select aria-label="Column" className={`${fieldClass} h-9 w-auto min-w-[200px]`} value={column} onChange={(e) => setColumn(e.target.value)} disabled={!cols.data}>
            <option value="">{cols.isPending ? "Loading columns…" : "Choose a column"}</option>
            {tables.map((t) => (
              <optgroup key={t} label={t}>
                {(cols.data ?? []).filter((c) => c.table === t).map((c) => (
                  <option key={c.ref} value={c.ref}>{c.name} ({c.type})</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        {cols.error && <Notice>{cols.error.message}</Notice>}
        {data.error && <Notice>{data.error.message}</Notice>}
        {!column ? (
          <p className="text-sm text-ink-soft">Any column works: user type, plan, a premium flag, a referral code, a date (grouped by month)…</p>
        ) : data.isPending ? (
          <Skeleton className="h-40" />
        ) : b ? (
          <>
            <HBars label={`People by ${b.column}`} rows={rows} color={bot.color} />
            <p className="mt-2 text-xs text-ink-faint">
              {fmt(b.total)} reachable people on @{bot.username}. {b.items.length >= 20 && "Showing the 20 most common values."} {b.grouped_by_month && "Dates grouped by month."}
            </p>
          </>
        ) : null}
      </Panel>
    </section>
  );
}

function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-ink-soft hover:text-ink">Show as table</summary>
      <div className="max-h-80 overflow-auto">
        <table className="mt-2 w-full text-left">
          <thead className="text-ink-faint">
            <tr>
              {head.map((h, i) => (
                <th key={h} className={cx("py-1 font-medium", i > 0 && "text-right")}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-line">
                {r.map((c, j) => (
                  <td key={j} className={cx("py-1", j > 0 && "text-right")}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function exportSummary(d: AudienceAnalytics, bots: BotInfo[], long: string) {
  const name = (id: number) => `@${bots.find((b) => b.id === id)?.username ?? id}`;
  const k = d.kpis;
  downloadCsv(fileName("summary", d.period.range), [
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

// ---- broadcasts --------------------------------------------------------------------------

type SortKey = "started" | "name" | "total" | "delivery_rate" | "block_rate" | "seconds";

function BroadcastsTab({ qs, range, picked }: { qs: URLSearchParams; range: AnalyticsRange; picked: number[] | null }) {
  const nav = useNavigate();
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "started", desc: true });
  const q = useQuery({
    queryKey: ["analytics-broadcasts", range, picked],
    queryFn: () => api<BroadcastAnalytics>(`/analytics/broadcasts?${qs}`),
    placeholderData: (prev) => prev,
  });
  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.error) return <Notice>{q.error.message}</Notice>;
  const items = q.data.items;
  if (!items.length) return <Panel className="px-6 py-12 text-center text-ink-soft">No broadcasts started in this period through the selected bots.</Panel>;

  const sent = items.reduce((n, i) => n + i.sent, 0);
  const blocked = items.reduce((n, i) => n + i.blocked, 0);
  const processed = items.reduce((n, i) => n + i.sent + i.blocked + i.failed, 0);
  const labels = items.map((i) => i.name);
  const option = {
    ...base,
    legend: { ...base.legend, data: ["Delivered", "Blocked the bot"] },
    tooltip: {
      ...base.tooltip,
      trigger: "axis",
      axisPointer: { type: "shadow" },
      valueFormatter: (v: number) => `${(v * 100).toFixed(1)}%`,
    },
    grid: { left: 8, right: 8, top: 36, bottom: items.length > 12 ? 36 : 8, containLabel: true },
    xAxis: { ...axis, type: "category", data: labels, axisLabel: { ...axis.axisLabel, width: 90, overflow: "truncate", interval: 0, rotate: items.length > 6 ? 30 : 0 } },
    yAxis: { ...axis, type: "value", max: 1, axisLabel: { ...axis.axisLabel, formatter: (v: number) => `${v * 100}%` } },
    dataZoom: zoom(items.length > 12),
    series: [
      { name: "Delivered", type: "bar", barMaxWidth: 22, itemStyle: { color: C.delivered, borderRadius: [4, 4, 0, 0] }, data: items.map((i) => i.delivery_rate ?? 0) },
      { name: "Blocked the bot", type: "bar", barMaxWidth: 22, itemStyle: { color: C.blocked, borderRadius: [4, 4, 0, 0] }, data: items.map((i) => i.block_rate ?? 0) },
    ],
  };

  const sorted = [...items].sort((a, b) => {
    const av = a[sort.key] ?? -1;
    const bv = b[sort.key] ?? -1;
    const c = av < bv ? -1 : av > bv ? 1 : 0;
    return sort.desc ? -c : c;
  });
  const th = (key: SortKey, text: string, right = true) => (
    <th className={cx("px-4 py-2.5 font-medium", right && "text-right")}>
      <button type="button" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))} className="hover:text-ink">
        {text}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );
  const rate = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

  return (
    <div className="space-y-8">
      <dl className="grid gap-4 sm:grid-cols-3">
        <Kpi label="Broadcasts" value={fmt(items.length)} note={`${fmt(processed)} messages processed`} />
        <Kpi label="Delivered" value={processed ? pct(sent, processed) : "—"} note={`${fmt(sent)} messages`} />
        <Kpi label="Blocked the bot" value={processed ? pct(blocked, processed) : "—"} note={`${fmt(blocked)} people found blocked`} />
      </dl>

      <section aria-labelledby="perf-title">
        <SectionHead title="Delivery and blocks per broadcast">
          <CsvButton
            onClick={() =>
              downloadCsv(fileName("broadcasts", range), [
                ["id", "name", "status", "started", "finished", "messages", "delivered", "blocked", "failed", "delivery_rate", "block_rate", "seconds"],
                ...items.map((i) => [i.id, i.name, i.status, i.started, i.finished ?? "", i.total, i.sent, i.blocked, i.failed, i.delivery_rate ?? "", i.block_rate ?? "", i.seconds ?? ""]),
              ])
            }
          />
        </SectionHead>
        <Panel className="px-5 pt-4 pb-3">
          <Chart option={option} height={280} label="Delivery and block rate per broadcast" onClick={(p) => nav(`/broadcasts/${items[p.dataIndex].id}`)} />
          <p className="mt-1 text-xs text-ink-faint">Oldest first. Click a bar to open the broadcast. Rates are of messages that finished (delivered, blocked or failed).</p>
        </Panel>
      </section>

      <Panel className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-line text-ink-soft">
            <tr>
              {th("name", "Broadcast", false)}
              {th("started", "Started", false)}
              {th("total", "Messages")}
              {th("delivery_rate", "Delivered")}
              {th("block_rate", "Blocked")}
              {th("seconds", "Took")}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {sorted.map((i) => (
              <tr key={i.id} className="hover:bg-canvas/60">
                <td className="px-4 py-2.5">
                  <Link to={`/broadcasts/${i.id}`} className="font-medium hover:underline">{i.name}</Link>
                  <div className="mt-0.5"><CampaignStatusTag status={i.status} /></div>
                </td>
                <td className="px-4 py-2.5 text-ink-soft">{when(i.started)}</td>
                <td className="px-4 py-2.5 text-right">{fmt(i.total)}</td>
                <td className="px-4 py-2.5 text-right font-medium">{rate(i.delivery_rate)}</td>
                <td className="px-4 py-2.5 text-right">{rate(i.block_rate)}</td>
                <td className="px-4 py-2.5 text-right text-ink-soft">{i.seconds == null ? "—" : duration(i.seconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
