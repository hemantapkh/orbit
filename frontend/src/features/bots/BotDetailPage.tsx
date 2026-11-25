import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, type Bot, type BotWithKey } from "../../lib/api";
import { ago, fmt, when } from "../../lib/format";
import { Button, buttonClass, Dialog, Field, Input, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";
import { BotStatus } from "./BotsPage";
import { ActivityList } from "../activity/ActivityList";
import { SourcePanel } from "../sources/SourcePanel";
import { RevealedKey } from "./IntegrationKey";

export function BotDetailPage() {
  const { botId } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const key = ["bots", botId];
  const bot = useQuery({ queryKey: key, queryFn: () => api<Bot>(`/bots/${botId}`) });
  const [newKey, setNewKey] = useState<string | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);

  const done = (b: Bot) => {
    qc.setQueryData(key, b);
    qc.invalidateQueries({ queryKey: ["bots"], exact: true });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };
  const toggle = useMutation({
    mutationFn: (is_active: boolean) => api<Bot>(`/bots/${botId}`, { method: "PATCH", json: { is_active } }),
    onSuccess: done,
  });
  const refresh = useMutation({
    mutationFn: () => api<Bot>(`/bots/${botId}/refresh`, { method: "POST" }),
    onSuccess: done,
  });
  const rotate = useMutation({
    mutationFn: () => api<BotWithKey>(`/bots/${botId}/rotate-key`, { method: "POST" }),
    onSuccess: (b) => {
      done(b);
      setNewKey(b.api_key);
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/bots/${botId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bots"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      nav("/bots");
    },
  });
  const error = toggle.error ?? refresh.error ?? rotate.error ?? remove.error;

  if (bot.isPending) return <Skeleton className="h-72" />;
  if (bot.error) return <Notice>{bot.error.message}</Notice>;
  const b = bot.data;
  const s = b.subscribers;

  return (
    <>
      <Link to="/bots" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink">
        <ArrowLeft size={15} /> Bots
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <BotStatus bot={b} />
            {b.display_name}
          </span>
        }
        lede={
          <>
            <a href={`https://t.me/${b.username}`} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
              @{b.username}
            </a>
            {b.description && <> — {b.description}</>}
          </>
        }
        actions={
          <>
            <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              {refresh.isPending ? "Checking…" : "Check token"}
            </Button>
            {b.is_active && b.token_valid ? (
              <Link to={`/broadcasts/new?bot=${b.id}`} className={buttonClass("primary")}>
                Broadcast to this bot
              </Link>
            ) : (
              <Button variant="primary" disabled>Broadcast to this bot</Button>
            )}
          </>
        }
      />
      {error && <div className="mb-6"><Notice>{error.message}</Notice></div>}
      {!b.token_valid && (
        <div className="mb-6">
          <Notice>
            Telegram rejected this bot's token the last time it was checked. Broadcasts can't go out
            until you replace it.
          </Notice>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Panel className="p-6">
            <h2 className="mb-5 font-semibold">Subscribers</h2>
            <dl className={`grid grid-cols-2 gap-6 ${s.source === "integration" ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
              <Count label="Active" value={s.active} strong />
              <Count label="Blocked the bot" value={s.blocked} />
              {s.source === "integration" && <Count label="Unsubscribed" value={s.unsubscribed} />}
              <Count label="Unreachable" value={s.unreachable} />
            </dl>
            {s.source_error && (
              <div className="mt-6">
                <Notice>
                  Couldn't read the bot's database: {s.source_error}. These are the last known counts.
                </Notice>
              </div>
            )}
            <p className="mt-6 text-sm text-ink-faint">
              {s.source === "database"
                ? "Counted live from the bot's database, refreshed about once a minute."
                : `Last report from the bot ${ago(b.last_ingest_at)}.`}{" "}
              Blocked and unreachable counts are learned during broadcasts.
            </p>
          </Panel>

        </div>

        <aside className="space-y-6">
          <Panel className="divide-y divide-line text-sm">
            <Row k="Telegram ID" v={String(b.telegram_id)} />
            <Row k="Connected" v={when(b.created_at)} />
            <Row k="Token checked" v={ago(b.last_checked_at)} />
          </Panel>
          <Panel className="space-y-4 p-5">
            <Setting
              title={b.is_active ? "Disable bot" : "Enable bot"}
              body={b.is_active ? "Stops broadcasts and subscriber reports for this bot. Nothing is deleted." : "Resume broadcasts and subscriber reports."}
              action={<Button size="sm" onClick={() => toggle.mutate(!b.is_active)} disabled={toggle.isPending}>{b.is_active ? "Disable" : "Enable"}</Button>}
            />
            <Setting
              title="Replace token"
              body="Use after revoking the token in @BotFather."
              action={<Button size="sm" onClick={() => setTokenOpen(true)}>Replace</Button>}
            />
            <Setting
              title="Rotate integration key"
              body="Used by the integration API. The old key stops working immediately."
              action={<Button size="sm" onClick={() => confirm("Rotate the key? The bot will be rejected until you update it.") && rotate.mutate()}>Rotate</Button>}
            />
            <Setting
              title="Remove bot"
              body="Only possible before it has sent a broadcast. Otherwise, disable it."
              action={<Button size="sm" variant="danger" onClick={() => confirm(`Remove @${b.username} and its subscriber list?`) && remove.mutate()}>Remove</Button>}
            />
          </Panel>
        </aside>
      </div>

      <div className="mt-6 space-y-6">
        <SourcePanel bot={b} />
        <ActivityList entityType="bot" entityId={b.id} />
      </div>

      <Dialog open={!!newKey} onClose={() => setNewKey(null)} title="New integration key">
        {newKey && <RevealedKey apiKey={newKey} />}
      </Dialog>
      <ReplaceTokenDialog open={tokenOpen} onClose={() => setTokenOpen(false)} botId={b.id} onDone={done} />
    </>
  );
}

function ReplaceTokenDialog({ open, onClose, botId, onDone }: { open: boolean; onClose: () => void; botId: number; onDone: (b: Bot) => void }) {
  const [token, setToken] = useState("");
  const save = useMutation({
    mutationFn: () => api<Bot>(`/bots/${botId}`, { method: "PATCH", json: { token: token.trim() } }),
    onSuccess: (b) => {
      onDone(b);
      setToken("");
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Replace bot token">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-5"
      >
        {save.error && <Notice>{save.error.message}</Notice>}
        <Field label="New token" htmlFor="newtoken" hint="It must belong to the same bot.">
          <Input id="newtoken" required autoFocus autoComplete="off" className="font-mono text-sm" value={token} onChange={(e) => setToken(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={save.isPending}>Save token</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Count({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div>
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className={strong ? "mt-1 text-3xl font-semibold tracking-tight" : "mt-1 text-3xl text-ink-soft"}>{fmt(value)}</dd>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 px-5 py-3">
      <span className="text-ink-soft">{k}</span>
      <span>{v}</span>
    </div>
  );
}

function Setting({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-sm text-ink-faint">{body}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}
