import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { api, type Bot, type BotSourceInfo, type ConnectionInfo } from "../../lib/api";
import { ago, fmt } from "../../lib/format";
import { Button, Field, Input, Notice, Panel, Skeleton, StatusDot } from "../../components/ui";
import { DatabaseSetup } from "./DatabaseSetup";

type Mode = "view" | "setup" | "mapping" | "connection";

/** The bot's database connection: where Orbit reads who the bot can reach. */
export function SourcePanel({ bot }: { bot: Bot }) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const key = ["bots", String(bot.id), "source"];
  const source = useQuery({ queryKey: key, queryFn: () => api<BotSourceInfo>(`/bots/${bot.id}/source`) });
  const [mode, setMode] = useState<Mode>(params.get("connect") === "database" ? "setup" : "view");

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["bots"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };
  const done = (saved?: BotSourceInfo) => {
    if (saved) qc.setQueryData(key, saved);
    refreshAll();
    setMode("view");
    if (params.has("connect")) setParams({}, { replace: true });
  };
  const disconnect = useMutation({
    mutationFn: () => api(`/bots/${bot.id}/source`, { method: "DELETE" }),
    onSuccess: () => done(),
  });

  if (source.isPending) return <Skeleton className="h-40" />;
  if (source.error) return <Notice>{source.error.message}</Notice>;
  const s = source.data;
  const connected = s.kind === "database";

  return (
    <Panel className="p-6">
      <div className="mb-5">
        <h2 className="font-semibold">Bot database</h2>
        <p className="text-sm text-ink-soft">
          Orbit reads who this bot can reach from its own database, read-only, live.
        </p>
      </div>
      {disconnect.error && <div className="mb-4"><Notice>{disconnect.error.message}</Notice></div>}

      {mode === "setup" || mode === "mapping" ? (
        <DatabaseSetup
          botId={bot.id}
          existing={connected ? s : null}
          start={mode === "mapping" ? "map" : "connect"}
          onCancel={() => done()}
          onSaved={done}
        />
      ) : mode === "connection" && connected ? (
        <ChangeConnection botId={bot.id} source={s} onCancel={() => setMode("view")} onSaved={done} onEditMapping={() => setMode("mapping")} />
      ) : connected ? (
        <Summary
          source={s}
          onEditMapping={() => setMode("mapping")}
          onChangeConnection={() => setMode("connection")}
          onDisconnect={() =>
            confirm("Disconnect this bot's database? Its audience will be empty until you connect one again.") &&
            disconnect.mutate()
          }
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-dashed border-line-strong px-5 py-5">
          <p className="max-w-[56ch] text-sm text-ink-soft">
            No database connected yet. Connect the bot's Postgres database and pick the table where it
            stores its users. Nothing is copied; Orbit reads it when it needs to.
          </p>
          <Button variant="primary" onClick={() => setMode("setup")}>Connect database</Button>
        </div>
      )}
    </Panel>
  );
}

function Summary({
  source: s,
  onEditMapping,
  onChangeConnection,
  onDisconnect,
}: {
  source: BotSourceInfo;
  onEditMapping: () => void;
  onChangeConnection: () => void;
  onDisconnect: () => void;
}) {
  const healthy = s.status !== "error";
  const where = [s.schema, s.table].filter(Boolean).join(".") + (s.joins?.length ? ` + ${s.joins.map((j) => j.table).join(", ")}` : "");
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-3">
        <StatusDot color={healthy ? "green" : "red"} label={healthy ? "Connected" : "Can't read the database"} />
        <span>
          Source: {s.driver} · <span className="font-medium">{where}</span> ·{" "}
          <span className="font-semibold">{fmt(s.cached_count ?? 0)}</span> users
        </span>
      </p>
      {!healthy && s.last_error && (
        <Notice>{s.last_error}. Counts show the last successful read until this is fixed.</Notice>
      )}
      <p className="text-sm text-ink-faint">
        {s.host ? `${s.host} / ${s.database}` : s.database}. Counts refresh about once a minute, and each
        broadcast reads the list at send time. Checked {ago(s.last_checked_at)}.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onEditMapping}>Edit mapping</Button>
        <Button size="sm" onClick={onChangeConnection}>Change connection</Button>
        <Button size="sm" variant="ghost" onClick={onDisconnect}>Disconnect</Button>
      </div>
    </div>
  );
}

/** Swap the database URL only. The saved table, mapping and filters are kept and re-checked. */
function ChangeConnection({
  botId,
  source,
  onCancel,
  onSaved,
  onEditMapping,
}: {
  botId: number;
  source: BotSourceInfo;
  onCancel: () => void;
  onSaved: (s: BotSourceInfo) => void;
  onEditMapping: () => void;
}) {
  const [url, setUrl] = useState("");
  const test = useMutation({
    mutationFn: () => api<ConnectionInfo>("/sources/test", { method: "POST", json: { database_url: url.trim() } }),
  });
  const save = useMutation({
    mutationFn: () =>
      api<BotSourceInfo>(`/bots/${botId}/source`, {
        method: "PUT",
        json: {
          database_url: url.trim(),
          table: source.table,
          schema: source.schema,
          column_map: source.column_map,
          filters: source.filters,
          joins: source.joins,
        },
      }),
    onSuccess: onSaved,
  });
  return (
    <form
      className="max-w-[640px] space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field
        label="New database URL"
        htmlFor="newurl"
        hint="Your table, mapping and filters stay as they are. Orbit checks them against the new database before saving."
      >
        <Input
          id="newurl"
          required
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-sm"
          placeholder="postgresql://readonly:password@db.example.com:5432/botdb"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            test.reset();
            save.reset();
          }}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => test.mutate()} disabled={!url.trim() || test.isPending}>
          {test.isPending ? "Connecting…" : "Test connection"}
        </Button>
        {test.isSuccess && (
          <span className="flex items-center gap-2 text-sm text-ink-soft" role="status">
            <StatusDot color="green" /> Connected to {test.data.driver} · {test.data.host ? `${test.data.host} / ` : ""}
            {test.data.database}
          </span>
        )}
        {test.error && (
          <span className="flex items-center gap-2 text-sm text-status-error" role="alert">
            <StatusDot color="red" /> {test.error.message}
          </span>
        )}
      </div>
      {save.error && (
        <Notice>
          {save.error.message}.{" "}
          <button type="button" className="underline underline-offset-4" onClick={onEditMapping}>
            Edit the mapping
          </button>{" "}
          if the new database is laid out differently.
        </Notice>
      )}
      <div className="flex justify-end gap-2 border-t border-line pt-4">
        <Button onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={!url.trim() || save.isPending}>
          {save.isPending ? "Checking and saving…" : "Save connection"}
        </Button>
      </div>
    </form>
  );
}
