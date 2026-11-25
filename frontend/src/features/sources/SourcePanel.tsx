import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type Bot, type BotSourceInfo } from "../../lib/api";
import { ago, fmt } from "../../lib/format";
import { cx, StatusDot, Notice, Panel, Skeleton } from "../../components/ui";
import { IntegrationSnippet } from "../bots/IntegrationKey";
import { DatabaseSetup } from "./DatabaseSetup";

/** Where a bot's subscriber list comes from: pushed through the API, or read from its database. */
export function SourcePanel({ bot }: { bot: Bot }) {
  const qc = useQueryClient();
  const key = ["bots", String(bot.id), "source"];
  const source = useQuery({ queryKey: key, queryFn: () => api<BotSourceInfo>(`/bots/${bot.id}/source`) });
  const [setup, setSetup] = useState(false);

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["bots"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };
  const revert = useMutation({
    mutationFn: () => api(`/bots/${bot.id}/source`, { method: "DELETE" }),
    onSuccess: refreshAll,
  });

  if (source.isPending) return <Skeleton className="h-40" />;
  if (source.error) return <Notice>{source.error.message}</Notice>;
  const s = source.data;
  const kind = setup ? "database" : s.kind;

  function choose(next: "integration" | "database") {
    if (next === kind) return;
    if (next === "database") return setSetup(true);
    if (setup && s.kind === "integration") return setSetup(false);
    if (confirm("Switch back to the integration API? The saved database connection is removed.")) {
      setSetup(false);
      revert.mutate();
    }
  }

  return (
    <Panel className="p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold">Subscriber source</h2>
          <p className="text-sm text-ink-soft">How Orbit learns who this bot can message.</p>
        </div>
        <div role="radiogroup" aria-label="Subscriber source" className="flex rounded-lg bg-canvas p-1 text-sm ring-1 ring-line">
          {(
            [
              ["integration", "Integration API"],
              ["database", "Database"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => choose(value)}
              className={cx("rounded-md px-3.5 py-1.5 font-medium transition-colors", kind === value ? "bg-surface text-ink shadow-[0_1px_3px_rgba(23,33,30,0.12)]" : "text-ink-soft hover:text-ink")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {revert.error && <div className="mb-4"><Notice>{revert.error.message}</Notice></div>}

      {setup ? (
        <DatabaseSetup
          botId={bot.id}
          existing={s.kind === "database" ? s : null}
          onCancel={() => setSetup(false)}
          onSaved={(saved) => {
            qc.setQueryData(key, saved);
            refreshAll();
            setSetup(false);
          }}
        />
      ) : s.kind === "database" ? (
        <DatabaseSummary source={s} onEdit={() => setSetup(true)} />
      ) : (
        <div className="space-y-4">
          <p className="max-w-[68ch] text-sm text-ink-soft">
            The bot reports subscribers with its integration key, currently{" "}
            <code className="font-mono text-ink">{bot.api_key_prefix}…</code>. Send{" "}
            <code className="font-mono">"status": "unsubscribed"</code> when someone opts out. If the bot
            already stores its users in a database, choose <strong className="text-ink">Database</strong> instead.
          </p>
          <IntegrationSnippet />
        </div>
      )}
    </Panel>
  );
}

function DatabaseSummary({ source: s, onEdit }: { source: BotSourceInfo; onEdit: () => void }) {
  const healthy = s.status !== "error";
  const where = [s.schema, s.table].filter(Boolean).join(".");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-3">
          <StatusDot color={healthy ? "green" : "red"} label={healthy ? "Connected" : "Can't read the database"} />
          <span>
            Source: {s.driver} · <span className="font-medium">{where}</span> ·{" "}
            <span className="font-semibold">{fmt(s.cached_count ?? 0)}</span> users
          </span>
        </p>
        <button type="button" onClick={onEdit} className="text-sm font-medium text-accent-deep underline-offset-4 hover:underline">
          Edit mapping
        </button>
      </div>
      {!healthy && s.last_error && (
        <Notice>
          {s.last_error}. Counts show the last successful read until this is fixed.
        </Notice>
      )}
      <p className="text-sm text-ink-faint">
        {s.host ? `${s.host} / ${s.database}` : s.database}. Read live: counts refresh about once a minute, and
        each broadcast reads the list at send time. Checked {ago(s.last_checked_at)}.
      </p>
    </div>
  );
}
