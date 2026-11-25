import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, type Bot, type Campaign, type CampaignStatus, type Page } from "../../lib/api";
import { fmt, when } from "../../lib/format";
import { Button, buttonClass, CampaignStatusTag, cx, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";
import { DeliveryBar } from "./DeliveryBar";

const FILTERS: { label: string; statuses: CampaignStatus[] }[] = [
  { label: "All", statuses: [] },
  { label: "Drafts", statuses: ["draft"] },
  { label: "Scheduled", statuses: ["scheduled"] },
  { label: "In progress", statuses: ["running", "paused"] },
  { label: "Finished", statuses: ["completed", "cancelled"] },
];
const PAGE = 25;

export function CampaignsPage() {
  const [filter, setFilter] = useState(0);
  const [offset, setOffset] = useState(0);
  const statuses = FILTERS[filter].statuses;
  const qs = new URLSearchParams([...statuses.map((s) => ["status", s]), ["limit", String(PAGE)], ["offset", String(offset)]]);
  const list = useQuery({
    queryKey: ["campaigns", statuses, offset],
    queryFn: () => api<Page<Campaign>>(`/campaigns?${qs}`),
    refetchInterval: (q) => (q.state.data?.items.some((c) => c.status === "running" || c.status === "scheduled") ? 3000 : false),
  });
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<Bot[]>("/bots") });
  const botName = (id: number) => bots.data?.find((b) => b.id === id)?.username;

  return (
    <>
      <PageHeader
        title="Broadcasts"
        lede="One message, sent through any combination of your bots."
        actions={<Link to="/broadcasts/new" className={buttonClass("primary")}>New broadcast</Link>}
      />
      <div role="tablist" aria-label="Filter broadcasts" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
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
              "-mb-px shrink-0 border-b-2 px-3 py-2.5 text-[15px]",
              filter === i ? "border-accent font-medium text-ink" : "border-transparent text-ink-soft hover:text-ink",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {list.error && <Notice>{list.error.message}</Notice>}
      {list.isPending && <Skeleton className="h-60" />}
      {list.data?.items.length === 0 && (
        <Panel className="px-6 py-12 text-center text-ink-soft">
          {filter === 0 ? "No broadcasts yet. Start one with New broadcast." : "Nothing here."}
        </Panel>
      )}
      {!!list.data?.items.length && (
        <Panel className="divide-y divide-line">
          {list.data.items.map((c) => (
            <Link
              key={c.id}
              to={c.status === "draft" ? `/broadcasts/${c.id}/edit` : `/broadcasts/${c.id}`}
              className="grid gap-x-6 gap-y-2 px-5 py-4 hover:bg-canvas/70 md:grid-cols-[minmax(0,1fr)_120px_220px]"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{c.name}</p>
                <p className="truncate text-sm text-ink-faint">
                  {c.source_campaign_id && <span className="text-accent-deep">Resend · </span>}
                  {c.audience.mode === "selected" && `${c.audience.recipients.length} selected on `}
                  {c.bot_ids.map((id) => `@${botName(id) ?? id}`).join(", ") || "No bots selected"}
                </p>
              </div>
              <div className="self-center"><CampaignStatusTag status={c.status} /></div>
              <div className="self-center text-sm">
                {c.stats.total > 0 ? (
                  <>
                    <DeliveryBar stats={c.stats} thin />
                    <p className="mt-1.5 text-ink-soft">
                      {fmt(c.stats.sent)} of {fmt(c.stats.total)} delivered
                    </p>
                  </>
                ) : (
                  <p className="text-ink-soft">
                    {c.status === "scheduled" ? `Sends ${when(c.scheduled_at)}` : `Edited ${when(c.updated_at)}`}
                  </p>
                )}
              </div>
            </Link>
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
