import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type Bot, type Campaign, type CampaignStatus, type Page } from "../../lib/api";
import { fmt, pct, when } from "../../lib/format";
import { Button, buttonClass, CampaignStatusTag, cx, Input, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";
import { DeliveryBar } from "./DeliveryBar";

const FILTERS: { label: string; statuses: CampaignStatus[] }[] = [
  { label: "All", statuses: [] },
  { label: "Drafts", statuses: ["draft"] },
  { label: "Scheduled", statuses: ["scheduled"] },
  { label: "Sending", statuses: ["running", "paused"] },
  { label: "Finished", statuses: ["completed", "cancelled"] },
];
const PAGE = 25;

const query = (statuses: CampaignStatus[], q: string, offset: number, limit = PAGE) =>
  new URLSearchParams([
    ...statuses.map((s) => ["status", s]),
    ...(q ? [["q", q]] : []),
    ["group", "true"],
    ["limit", String(limit)],
    ["offset", String(offset)],
  ]);

export function CampaignsPage() {
  const [filter, setFilter] = useState(0);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => {
      setQ(search.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(id);
  }, [search]);

  const statuses = FILTERS[filter].statuses;
  const list = useQuery({
    queryKey: ["campaigns", statuses, q, offset],
    queryFn: () => api<Page<Campaign>>(`/campaigns?${query(statuses, q, offset)}`),
    placeholderData: (prev) => prev,
    refetchInterval: (r) => (r.state.data?.items.some((c) => c.status === "running" || c.status === "scheduled") ? 5000 : false),
  });
  const live = useQuery({
    queryKey: ["campaigns", "live"],
    queryFn: () => api<Page<Campaign>>(`/campaigns?${query(["running", "paused"], "", 0, 6)}`),
    refetchInterval: (r) => (r.state.data?.items.length ? 3000 : 30000),
  });
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<Bot[]>("/bots") });
  const botName = (id: number) => bots.data?.find((b) => b.id === id)?.username ?? String(id);
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: number) => api(`/campaigns/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  const showLive = filter === 0 && !q && !!live.data?.items.length;

  return (
    <>
      <PageHeader
        title="Broadcasts"
        lede="One message, sent through any combination of your bots."
        actions={
          <>
            <Link to="/broadcasts/test-groups" className={buttonClass("secondary")}>Test groups</Link>
            <Link to="/broadcasts/new" className={buttonClass("primary")}>New broadcast</Link>
          </>
        }
      />

      {showLive && (
        <section aria-labelledby="live-title" className="mb-8">
          <h2 id="live-title" className="mb-3 text-lg font-semibold">Sending now</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {live.data!.items.map((c) => {
              const s = c.stats;
              const done = s.sent + s.failed + s.blocked + s.skipped;
              return (
                <Link key={c.id} to={`/broadcasts/${c.id}`} className="block">
                  <Panel className="p-4 transition-shadow hover:shadow-[0_1px_2px_rgba(23,33,30,0.06),0_12px_28px_-14px_rgba(23,33,30,0.22)]">
                    <div className="mb-3 flex items-start justify-between gap-3">
                      <p className="min-w-0 truncate font-medium">{c.name}</p>
                      <CampaignStatusTag status={c.status} />
                    </div>
                    <DeliveryBar stats={s} />
                    <p className="mt-2 flex justify-between text-sm text-ink-soft">
                      <span>{s.total ? `${fmt(s.sent)} delivered` : "Preparing recipients…"}</span>
                      <span>{s.total ? `${pct(done, s.total)} done · ${fmt(s.pending)} waiting` : ""}</span>
                    </p>
                  </Panel>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filter broadcasts" className="inline-flex flex-wrap rounded-lg bg-canvas p-1 text-sm ring-1 ring-line">
          {FILTERS.map((f, i) => (
            <button
              key={f.label}
              role="tab"
              aria-selected={filter === i}
              onClick={() => {
                setFilter(i);
                setOffset(0);
              }}
              className={cx(
                "rounded-md px-3 py-1.5 font-medium transition-colors",
                filter === i ? "bg-surface text-ink shadow-[0_1px_3px_rgba(23,33,30,0.12)]" : "text-ink-soft hover:text-ink",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search size={16} className="pointer-events-none absolute top-3 left-3 text-ink-faint" />
          <Input aria-label="Search broadcasts" placeholder="Search by name" className="h-10 pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      {(list.error ?? remove.error) && <div className="mb-4"><Notice>{(list.error ?? remove.error)!.message}</Notice></div>}
      {list.isPending && <Skeleton className="h-60" />}
      {list.data?.items.length === 0 && (
        <Panel className="px-6 py-12 text-center text-ink-soft">
          {q ? `No broadcasts match “${q}”.` : filter === 0 ? "No broadcasts yet. Start one with New broadcast." : `No ${FILTERS[filter].label.toLowerCase()} broadcasts.`}
        </Panel>
      )}
      {!!list.data?.items.length && (
        <Panel className="divide-y divide-line overflow-hidden">
          <div className="hidden grid-cols-[minmax(0,1fr)_130px_200px_130px_44px] gap-x-6 bg-canvas/60 px-5 py-2.5 text-xs font-medium text-ink-faint md:grid">
            <span>Broadcast</span>
            <span>Status</span>
            <span>Result</span>
            <span>Date</span>
            <span />
          </div>
          {list.data.items.map((c) => (
            <Row key={c.id} c={c} botName={botName} onDelete={() => confirmDelete(c) && remove.mutate(c.id)} deleting={remove.isPending} />
          ))}
        </Panel>
      )}
      {list.data && list.data.total > PAGE && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-soft">
          <span>
            {offset + 1}–{Math.min(offset + PAGE, list.data.total)} of {fmt(list.data.total)}
          </span>
          <div className="flex gap-2">
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset(offset - PAGE)}>Previous</Button>
            <Button size="sm" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ c, botName, onDelete, deleting }: { c: Campaign; botName: (id: number) => string; onDelete: () => void; deleting: boolean }) {
  const s = c.stats;
  const audience =
    c.audience.mode === "selected"
      ? `${fmt(c.audience.recipients.length)} selected ${c.audience.recipients.length === 1 ? "person" : "people"}`
      : c.bot_ids.map((id) => `@${botName(id)}`).join(", ") || "No bots selected";
  const date =
    c.status === "scheduled"
      ? `Sends ${when(c.scheduled_at)}`
      : c.finished_at
        ? `Sent ${when(c.finished_at)}`
        : c.started_at
          ? `Started ${when(c.started_at)}`
          : `Edited ${when(c.updated_at)}`;

  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 px-5 py-3.5 hover:bg-canvas/60 md:grid-cols-[minmax(0,1fr)_130px_200px_130px_44px]">
      <Link to={c.status === "draft" ? `/broadcasts/${c.id}/edit` : `/broadcasts/${c.id}`} className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="truncate font-medium group-hover:underline group-hover:underline-offset-4">{c.name}</span>
          {(c.send_count ?? 1) > 1 && (
            <span className="shrink-0 rounded-md bg-accent-wash px-1.5 py-0.5 text-xs font-medium text-accent-deep">
              {c.send_count} sends
            </span>
          )}
        </span>
        <span className="block truncate text-sm text-ink-faint">{audience}</span>
      </Link>
      <span className="self-center"><CampaignStatusTag status={c.status} /></span>
      <div className="text-sm max-md:col-span-2">
        {s.total > 0 ? (
          <>
            <DeliveryBar stats={s} thin />
            <p className="mt-1.5 text-ink-soft">
              {fmt(s.sent)} of {fmt(s.total)} delivered
            </p>
          </>
        ) : (
          <span className="text-ink-faint">—</span>
        )}
      </div>
      <span className="text-sm text-ink-soft max-md:col-span-2">{date}</span>
      <button
        type="button"
        aria-label={`Delete ${c.name}`}
        title={c.status === "running" ? "Pause or stop it before deleting" : "Delete"}
        disabled={c.status === "running" || deleting}
        onClick={onDelete}
        className="justify-self-end rounded-md p-2 text-ink-faint opacity-60 transition-opacity group-hover:opacity-100 hover:bg-status-error/10 hover:text-status-error focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink-faint max-md:hidden"
      >
        <Trash2 size={16} />
      </button>
    </div>
  );
}

/** Shared wording so the list and the detail page warn the same way. */
export function confirmDelete(c: Pick<Campaign, "name" | "status" | "stats">) {
  const history = c.stats.total > 0;
  return confirm(
    history
      ? `Delete "${c.name}" and its delivery history? Messages already delivered stay in people's chats.`
      : `Delete "${c.name}"?`,
  );
}
