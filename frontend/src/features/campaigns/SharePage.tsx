import { useQuery } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { useEffect } from "react";
import { useParams } from "react-router";
import { OrbitLogo, OrbitLoading, OrbitMark } from "../../components/brand";
import { api, ApiError, type PublicBroadcast } from "../../lib/api";
import { fmt, when } from "../../lib/format";
import { CampaignStatusTag, Panel } from "../../components/ui";
import { DeliveryBar } from "./DeliveryBar";
import { withSamples } from "../../lib/personalize";
import { MessagePreview } from "./MessagePreview";
import { ProgressInsights, StatusPanel } from "./Progress";

/** Head tags for a link-only page: don't leak the URL onwards, don't get indexed. */
function usePrivatePage(title: string) {
  useEffect(() => {
    const tags = [
      Object.assign(document.createElement("meta"), { name: "referrer", content: "no-referrer" }),
      Object.assign(document.createElement("meta"), { name: "robots", content: "noindex, nofollow" }),
    ];
    tags.forEach((t) => document.head.appendChild(t));
    return () => tags.forEach((t) => t.remove());
  }, []);
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export function SharePage() {
  const { token } = useParams();
  const q = useQuery({
    queryKey: ["share", token],
    queryFn: () => api<PublicBroadcast>(`/public/shares/${token}`),
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
    refetchInterval: (r) => {
      const s = r.state.data?.status;
      return s === "running" ? 3000 : s === "scheduled" || s === "paused" ? 15000 : false;
    },
  });
  usePrivatePage(q.data ? `${q.data.name} · Orbit` : "Shared broadcast · Orbit");

  if (q.isPending) return <OrbitLoading label="Loading broadcast" />;
  if (q.error) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="grid min-h-screen place-items-center bg-canvas px-4">
        <div className="max-w-sm text-center">
          <OrbitMark size={40} tone="mono" className="mx-auto text-line-strong" />
          <h1 className="mt-5 text-xl font-semibold">{gone ? "This link isn't shared anymore" : "Couldn't load this broadcast"}</h1>
          <p className="mt-2 text-ink-soft">
            {gone ? "The owner may have stopped sharing it or replaced the link. Ask them for a new one." : q.error.message}
          </p>
        </div>
      </div>
    );
  }

  const b = q.data;
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1120px] items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <OrbitLogo size={22} />
          <span className="inline-flex items-center gap-1.5 rounded-full bg-canvas px-3 py-1 text-xs font-medium text-ink-soft ring-1 ring-line">
            <Eye size={13} /> Read-only view
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-[1120px] px-4 py-8 sm:px-8 md:py-10">
        <div className="mb-8">
          <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">{b.name}</h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-soft">
            <CampaignStatusTag status={b.status} />
            <span>{b.audience_mode === "selected" ? `To ${fmt(b.reach)} selected people` : `To ${b.bots.length} bot${b.bots.length === 1 ? "" : "s"}`}</span>
            {b.started_at && <span>Started {when(b.started_at)}</span>}
          </p>
        </div>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-8">
            <StatusPanel c={b} reach={b.reach} progress={b.progress} />
            <ProgressInsights progress={b.progress} bots={b.bots} />
            {b.bots.length > 1 && b.stats.total > 0 && (
              <section>
                <h2 className="mb-3 text-lg font-semibold">By bot</h2>
                <Panel className="divide-y divide-line">
                  {b.bots.map((x) => (
                    <div key={x.bot_id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-4 px-5 py-3 text-sm">
                      <span className="truncate font-medium">@{x.username}</span>
                      <DeliveryBar stats={x.stats} thin />
                      <span className="text-ink-soft">
                        {fmt(x.stats.sent)} / {fmt(x.stats.total)}
                      </span>
                    </div>
                  ))}
                </Panel>
              </section>
            )}
          </div>
          <aside className="space-y-3 lg:sticky lg:top-8 lg:self-start">
            <h2 className="text-lg font-semibold">Message</h2>
            {b.message ? (
              <MessagePreview message={{ ...b.message, text: withSamples(b.message.text) }} media={b.media} mediaSrc={`/api/public/shares/${token}/media`} />
            ) : (
              <Panel className="p-5 text-sm text-ink-soft">The sender chose not to share the message itself.</Panel>
            )}
          </aside>
        </div>
        <p className="mt-12 text-center text-xs text-ink-faint">Shared from Orbit. Numbers update live while it's sending.</p>
      </main>
    </div>
  );
}
