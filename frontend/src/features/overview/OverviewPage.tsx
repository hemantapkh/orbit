import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { BotAvatar } from "../../components/BotAvatar";
import { api, type Overview } from "../../lib/api";
import { ago, fmt, pct } from "../../lib/format";
import { buttonClass, CampaignStatusTag, cx, StatusDot, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";

export function OverviewPage() {
  const q = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/overview"),
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHeader title="Overview" />
      {q.error && <Notice>{q.error.message}</Notice>}
      {q.isPending && <Skeleton className="h-64" />}
      {q.data && (q.data.total_bots === 0 ? <NoBots /> : <Board data={q.data} />)}
    </>
  );
}

function NoBots() {
  return (
    <Panel className="px-6 py-14 text-center">
      <h2 className="text-lg font-semibold">Connect your first bot</h2>
      <p className="mx-auto mt-2 max-w-[48ch] text-ink-soft">
        Add a bot with its token from @BotFather, then connect the bot's database so Orbit can see
        who it can reach.
      </p>
      <Link to={"/bots"} className={`mt-6 ${buttonClass("primary")}`}>Connect a bot</Link>
    </Panel>
  );
}

type Line = Overview["bots"][number];
const LOSS: { key: "blocked" | "deleted" | "left" | "unreachable"; label: string }[] = [
  { key: "blocked", label: "blocked" },
  { key: "deleted", label: "deleted" },
  { key: "left", label: "removed" },
  { key: "unreachable", label: "unreachable" },
];

/** Sum a per-bot number over the bots that have it; null when none do. */
function total(bots: Line[], pick: (b: Line) => number | null | undefined) {
  const have = bots.map(pick).filter((v): v is number => v != null);
  return have.length ? have.reduce((a, b) => a + b, 0) : null;
}

function Board({ data }: { data: Overview }) {
  const bots = data.bots;
  const multi = bots.length > 1;
  const joined = total(bots, (b) => b.joined_24h);
  const joinedBefore = total(bots, (b) => b.joined_prev_24h);
  const active = total(bots, (b) => b.active_24h);
  const activeWeek = total(bots, (b) => b.active_7d);
  const lostBy = Object.fromEntries(LOSS.map((l) => [l.key, total(bots, (b) => (b.lost_24h ? (b.lost_24h[l.key] ?? 0) : null))]));
  const lost = total(bots, (b) => (b.lost_24h ? Object.values(b.lost_24h).reduce((a, n) => a + (n ?? 0), 0) : null));
  const change = joined != null && joinedBefore ? (joined - joinedBefore) / joinedBefore : null;

  return (
    <div className="space-y-10">
      <dl className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1fr]">
        <Figure
          label="Can receive"
          value={fmt(data.unique_people)}
          note={multi ? `people · ${fmt(data.total_active_subscribers)} subscriptions across ${bots.length} bots` : "people right now"}
          large
        />
        <Figure
          label="Joined · 24 h"
          value={joined == null ? "—" : fmt(joined)}
          note={
            joined == null
              ? "Map “Joined at” to see sign-ups"
              : change == null
                ? joinedBefore === 0 ? "none the 24 h before" : "sign-ups"
                : `${change >= 0 ? "▲" : "▼"} ${pct(Math.abs(change), 1)} vs the 24 h before`
          }
        />
        <Figure
          label="Active · 24 h"
          value={active == null ? "—" : fmt(active)}
          note={active == null ? "Map “Last active” to see activity" : `${fmt(activeWeek ?? 0)} in the last 7 days`}
        />
        <Figure
          label="Lost · 24 h"
          value={lost == null ? "—" : fmt(lost)}
          note={
            lost == null
              ? "Map “Status changed at” to date losses"
              : lost === 0
                ? "nobody blocked or left"
                : LOSS.filter((l) => lostBy[l.key]).map((l) => `${fmt(lostBy[l.key]!)} ${l.label}`).join(" · ")
          }
        />
      </dl>

      <Attention bots={bots} />

      <section aria-labelledby="lines-title">
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 id="lines-title" className="text-lg font-semibold">Bots</h2>
          <Legend />
        </div>
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-line text-ink-soft">
              <tr>
                <th className="px-5 py-3 font-medium">Bot</th>
                <th className="w-[30%] px-5 py-3 font-medium">Can receive</th>
                <th className="px-4 py-3 text-right font-medium">Joined 24 h</th>
                <th className="px-4 py-3 text-right font-medium">Active 24 h</th>
                <th className="px-4 py-3 text-right font-medium">Active 7 d</th>
                <th className="px-4 py-3 text-right font-medium">Blocked</th>
                <th className="px-5 py-3 text-right font-medium">Deleted</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {bots.map((b) => (
                <BotRow key={b.id} b={b} widest={Math.max(1, ...bots.map((x) => x.total))} />
              ))}
            </tbody>
          </table>
        </Panel>
      </section>

      <section aria-labelledby="recent-title">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="recent-title" className="text-lg font-semibold">Recent broadcasts</h2>
          <Link to="/broadcasts" className="text-sm text-ink-soft underline-offset-4 hover:underline">
            All broadcasts
          </Link>
        </div>
        {data.recent_campaigns.length === 0 ? (
          <p className="text-ink-soft">Nothing sent yet.</p>
        ) : (
          <Panel className="divide-y divide-line">
            {data.recent_campaigns.map((c) => (
              <Link
                key={c.id}
                to={`/broadcasts/${c.id}`}
                className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-5 py-3.5 hover:bg-canvas/70"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                <CampaignStatusTag status={c.status} />
                <span className="w-36 text-right text-sm text-ink-soft">
                  {c.stats.total ? `${fmt(c.stats.sent)} of ${fmt(c.stats.total)} delivered` : "—"}
                </span>
                <span className="w-28 text-right text-sm text-ink-faint">
                  {ago(c.finished_at ?? c.started_at ?? c.scheduled_at)}
                </span>
              </Link>
            ))}
          </Panel>
        )}
      </section>
    </div>
  );
}

function Figure({ label, value, note, large }: { label: string; value: string; note: string; large?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className={cx("mt-2 leading-none font-semibold", large ? "text-[44px] tracking-[-0.03em]" : "text-[30px] tracking-[-0.02em]")}>
        {value}
      </dd>
      <dd className="mt-2 text-sm text-ink-faint">{note}</dd>
    </div>
  );
}

const num = (v: number | null) => (v == null ? <span className="text-ink-faint">—</span> : fmt(v));

function BotRow({ b, widest }: { b: Line; widest: number }) {
  const dot = !b.is_active ? "off" : !b.token_valid || b.source_error ? "red" : "green";
  const dotLabel = !b.is_active ? "Disabled" : !b.token_valid ? "Token rejected" : b.source_error ? "Can't read the bot's database" : "Online";
  const gone = b.unreachable + b.left + b.deleted;
  return (
    <tr className="hover:bg-canvas/70">
      <td className="px-5 py-3.5">
        <Link to={`/bots/${b.id}`} className="flex items-center gap-3">
          <span className="relative shrink-0">
            <BotAvatar bot={b} size={34} />
            <span className="absolute -right-0.5 -bottom-0.5 grid place-items-center rounded-full bg-surface p-[2px]">
              <StatusDot color={dot} label={dotLabel} />
            </span>
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium">{b.display_name}</span>
            <span className="block truncate text-ink-faint">@{b.username}</span>
          </span>
        </Link>
      </td>
      <td className="px-5 py-3.5">
        <div className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-base font-semibold">{fmt(b.active)}</span>
          <div
            className="flex h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-canvas"
            title={`${fmt(b.active)} can receive · ${fmt(b.blocked)} blocked · ${fmt(gone)} unreachable`}
          >
            <span className="flex h-full" style={{ width: `${Math.max(3, (b.total / widest) * 100)}%` }}>
              <span className="bg-panel" style={{ flexGrow: b.active }} />
              <span className="bg-status-error/70" style={{ flexGrow: b.blocked }} />
              <span className="bg-line-strong" style={{ flexGrow: gone }} />
            </span>
          </div>
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          {b.source_error ? "last known, database unreachable" : !b.connected ? "database not connected" : b.total ? `${pct(b.active, b.total)} of everyone it knows` : "no subscribers yet"}
        </p>
      </td>
      <td className="px-4 py-3.5 text-right">
        {num(b.joined_24h)}
        {b.joined_24h != null && b.joined_prev_24h != null && (
          <span className="block text-xs text-ink-faint">{fmt(b.joined_prev_24h)} the day before</span>
        )}
      </td>
      <td className="px-4 py-3.5 text-right">{num(b.active_24h)}</td>
      <td className="px-4 py-3.5 text-right">{num(b.active_7d)}</td>
      <td className="px-4 py-3.5 text-right text-ink-soft">
        {fmt(b.blocked)}
        {!!b.lost_24h?.blocked && <span className="block text-xs text-status-error">+{fmt(b.lost_24h.blocked)} today</span>}
      </td>
      <td className="px-5 py-3.5 text-right text-ink-soft">
        {fmt(b.deleted)}
        {!!b.lost_24h?.deleted && <span className="block text-xs text-ink-faint">+{fmt(b.lost_24h.deleted)} today</span>}
      </td>
    </tr>
  );
}

/** Only shown when something needs fixing: a rejected token, an unreadable database, a gap
 * in the mapping that hides blocks until the next broadcast. */
function Attention({ bots }: { bots: Line[] }) {
  const items: { id: number; text: string }[] = [];
  for (const b of bots) {
    if (!b.is_active) continue;
    if (!b.token_valid) items.push({ id: b.id, text: `Telegram rejected @${b.username}'s token. It can't send until you replace it.` });
    if (!b.connected) items.push({ id: b.id, text: `@${b.username} has no database connected, so Orbit can't see who it reaches.` });
    else if (b.source_error) items.push({ id: b.id, text: `Can't read @${b.username}'s database: ${b.source_error}` });
    else if (!b.maps_status) items.push({ id: b.id, text: `@${b.username}'s mapping has no status, so blocks only show up after a broadcast.` });
  }
  if (!items.length) return null;
  return (
    <section aria-labelledby="attention-title">
      <h2 id="attention-title" className="mb-3 text-lg font-semibold">Needs attention</h2>
      <Panel className="divide-y divide-line">
        {items.map((i) => (
          <Link key={`${i.id}-${i.text}`} to={`/bots/${i.id}`} className="flex items-center gap-3 px-5 py-3 text-sm hover:bg-canvas/70">
            <span className="size-2 shrink-0 rounded-full bg-status-error" aria-hidden />
            <span className="min-w-0 flex-1">{i.text}</span>
            <span className="shrink-0 text-ink-faint">Open</span>
          </Link>
        ))}
      </Panel>
    </section>
  );
}

function Legend() {
  const item = (cls: string, text: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2.5 rounded-sm ${cls}`} />
      {text}
    </span>
  );
  return (
    <div className="hidden gap-4 text-xs text-ink-soft sm:flex">
      {item("bg-panel", "Can receive")}
      {item("bg-status-error/70", "Blocked the bot")}
      {item("bg-line-strong", "Unreachable")}
    </div>
  );
}
