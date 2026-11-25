import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { BotAvatar } from "../../components/BotAvatar";
import { api, type Overview } from "../../lib/api";
import { ago, fmt, pct } from "../../lib/format";
import { buttonClass, CampaignStatusTag, StatusDot, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";

export function OverviewPage() {
  const q = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Overview>("/overview"),
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHeader
        title="Overview"
        actions={
          <Link to={"/broadcasts/new"} className={buttonClass("primary")}>New broadcast</Link>
        }
      />
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

function Board({ data }: { data: Overview }) {
  const widest = Math.max(1, ...data.bots.map((b) => b.total));
  return (
    <div className="space-y-10">
      <dl className="flex flex-wrap gap-x-12 gap-y-4">
        <Figure label="Active subscribers" value={fmt(data.total_active_subscribers)} large />
        <Figure label="People across all bots" value={fmt(data.unique_people)} />
        <Figure label="Connected bots" value={fmt(data.total_bots)} />
      </dl>

      <section aria-labelledby="lines-title">
        <div className="mb-3 flex items-baseline justify-between gap-4">
          <h2 id="lines-title" className="text-lg font-semibold">Subscribers by bot</h2>
          <Legend />
        </div>
        <Panel className="divide-y divide-line">
          {data.bots.map((b) => {
            const dot = !b.is_active ? "off" : !b.token_valid || b.source_error ? "red" : "green";
            const dotLabel = !b.is_active
              ? "Disabled"
              : !b.token_valid
                ? "Token rejected"
                : b.source_error
                  ? "Can't read the bot's database"
                  : "Online";
            const gone = b.unreachable;
            return (
              <Link
                key={b.id}
                to={`/bots/${b.id}`}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-4 hover:bg-canvas/70 sm:grid-cols-[auto_minmax(150px,220px)_minmax(0,1fr)_auto]"
              >
                <span className="relative">
                  <BotAvatar bot={b} size={34} />
                  <span className="absolute -right-0.5 -bottom-0.5 grid place-items-center rounded-full bg-surface p-[2px]">
                    <StatusDot color={dot} label={dotLabel} />
                  </span>
                </span>
                <div className="min-w-0">
                  <p className="truncate font-medium">{b.display_name}</p>
                  <p className="truncate text-sm text-ink-faint">@{b.username}</p>
                </div>
                <div className="col-span-3 col-start-1 row-start-2 sm:col-span-1 sm:col-start-3 sm:row-start-1">
                  <div
                    className="flex h-3 overflow-hidden rounded-full bg-canvas"
                    style={{ width: `${Math.max(4, (b.total / widest) * 100)}%` }}
                    title={`${fmt(b.active)} active · ${fmt(b.blocked)} blocked · ${fmt(gone)} left`}
                  >
                    <span className="bg-panel" style={{ flexGrow: b.active }} />
                    <span className="bg-status-error/70" style={{ flexGrow: b.blocked }} />
                    <span className="bg-line-strong" style={{ flexGrow: gone }} />
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold">{fmt(b.active)}</p>
                  <p className="text-xs text-ink-faint">
                    {b.source_error
                      ? "last known, database unreachable"
                      : !b.connected
                        ? "database not connected"
                        : b.total
                        ? `${pct(b.active, b.total)} reachable`
                        : "no subscribers yet"}
                  </p>
                </div>
              </Link>
            );
          })}
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

function Figure({ label, value, large }: { label: string; value: string; large?: boolean }) {
  return (
    <div>
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className={large ? "text-[44px] leading-none font-semibold tracking-[-0.03em]" : "mt-2 text-[26px] leading-none font-semibold tracking-[-0.02em] text-ink-soft"}>
        {value}
      </dd>
    </div>
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
      {item("bg-panel", "Active")}
      {item("bg-status-error/70", "Blocked the bot")}
      {item("bg-line-strong", "Unreachable")}
    </div>
  );
}
