import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type ActivityEntry } from "../../lib/api";
import { ago, when } from "../../lib/format";
import { Panel } from "../../components/ui";

function describe(e: ActivityEntry): string {
  const d = e.details as Record<string, string | number | boolean | null | string[]>;
  switch (e.action) {
    case "campaign.created": return "created this broadcast";
    case "campaign.resend_created": return "created this as a resend";
    case "campaign.launched": return "sent it";
    case "campaign.scheduled": return `scheduled it for ${when(d.scheduled_at as string)}`;
    case "campaign.unscheduled": return "unscheduled it";
    case "campaign.paused": return "paused sending";
    case "campaign.resumed": return "resumed sending";
    case "campaign.cancelled": return "stopped it";
    case "campaign.deleted": return "deleted it";
    case "campaign.renamed": return `renamed it to “${d.name}”`;
    case "campaign.shared": return d.hide_message ? "shared a read-only link (message hidden)" : "shared a read-only link";
    case "campaign.share_regenerated": return "replaced the share link (the old one stopped working)";
    case "campaign.share_updated": return d.hide_message ? "hid the message on the shared page" : "showed the message on the shared page";
    case "campaign.unshared": return "stopped sharing";
    case "campaign.test_sent": return `sent a test to ${d.group} (${d.delivered} of ${d.total} delivered)`;
    case "campaign.started": return d.audience === "selected" ? "started sending to the selected people" : "started sending";
    case "campaign.completed": return "finished sending";
    case "bot.connected": return "connected the bot";
    case "bot.updated": {
      if (d.is_active === false) return "disabled the bot";
      if (d.is_active === true) return "enabled the bot";
      const changed = (d.changed as string[] | undefined) ?? [];
      return changed.includes("token") ? "replaced the bot token" : `updated ${changed.join(", ") || "settings"}`;
    }
    case "bot.key_rotated": return "rotated the integration key";
    case "bot.removed": return "removed the bot";
    case "source.saved": return `connected the database table ${d.table}`;
    case "source.removed": return "disconnected the bot's database";
    case "source.failed": return `couldn't read the bot's database: ${d.error}`;
    default: return e.action;
  }
}

export function ActivityList({
  entityType,
  entityId,
  initial = 30,
}: {
  entityType: "bot" | "campaign";
  entityId: number;
  /** entries shown before "Show all" */
  initial?: number;
}) {
  const [all, setAll] = useState(false);
  const q = useQuery({
    queryKey: ["activity", entityType, entityId],
    queryFn: () => api<ActivityEntry[]>(`/activity?entity_type=${entityType}&entity_id=${entityId}&limit=30`),
    refetchInterval: 10_000,
  });
  if (!q.data?.length) return null;
  const shown = all ? q.data : q.data.slice(0, initial);
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">Activity</h2>
      <Panel className="px-5 py-2">
        <ol className="divide-y divide-line text-sm">
          {shown.map((e) => (
            <li key={e.id} className="flex items-baseline justify-between gap-4 py-2.5">
              <span className="min-w-0">
                <span className={e.actor_email ? "font-medium" : "text-ink-soft"}>{e.actor_email ?? "Orbit"}</span>{" "}
                <span className={e.action === "source.failed" ? "text-status-error" : "text-ink-soft"}>{describe(e)}</span>
              </span>
              <time dateTime={e.created_at} title={when(e.created_at)} className="shrink-0 text-ink-faint">
                {ago(e.created_at)}
              </time>
            </li>
          ))}
        </ol>
      </Panel>
      {q.data.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="mt-2 text-sm text-ink-soft underline-offset-4 hover:text-ink hover:underline">
          Show all activity
        </button>
      )}
    </section>
  );
}
