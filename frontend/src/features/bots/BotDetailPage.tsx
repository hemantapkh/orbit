import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, type Bot } from "../../lib/api";
import { ago, fmt, when } from "../../lib/format";
import { Button, Dialog, Field, Input, Notice, Panel, Skeleton } from "../../components/ui";
import { ActivityList } from "../activity/ActivityList";
import { SourcePanel } from "../sources/SourcePanel";
import { BotAvatar } from "../../components/BotAvatar";
import { BotStatus } from "./BotsPage";

export function BotDetailPage() {
  const { botId } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const key = ["bots", botId];
  const bot = useQuery({ queryKey: key, queryFn: () => api<Bot>(`/bots/${botId}`) });
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
  const remove = useMutation({
    mutationFn: () => api(`/bots/${botId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bots"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      nav("/bots");
    },
  });
  const error = toggle.error ?? refresh.error ?? remove.error;

  if (bot.isPending) return <Skeleton className="h-72" />;
  if (bot.error) return <Notice>{bot.error.message}</Notice>;
  const b = bot.data;
  const s = b.subscribers;

  return (
    <div className="max-w-[880px]">
      <Link to="/bots" className="mb-5 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink">
        <ArrowLeft size={15} /> Bots
      </Link>

      <header className="mb-8 flex flex-wrap items-center gap-5">
        <BotAvatar bot={b} size={72} />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[28px] leading-tight font-semibold tracking-[-0.015em]">
            {b.display_name}
            <span className="inline-flex items-center gap-1.5 text-sm font-normal text-ink-soft">
              <BotStatus bot={b} />
              {!b.is_active ? "Disabled" : !b.token_valid ? "Token rejected" : s.source_error ? "Database unreachable" : "Online"}
            </span>
          </h1>
          <p className="mt-1 text-sm text-ink-soft">
            <a href={`https://t.me/${b.username}`} target="_blank" rel="noreferrer" className="font-medium text-ink underline-offset-4 hover:underline">
              @{b.username}
            </a>
            <span className="text-ink-faint"> · ID {b.telegram_id} · added {when(b.created_at)}</span>
          </p>
          {b.about && <p className="mt-2 max-w-[64ch] text-ink-soft">{b.about}</p>}
        </div>
      </header>

      <div className="space-y-8">
        {error && <Notice>{error.message}</Notice>}
        {!b.token_valid && (
          <Notice>
            Telegram rejected this bot's token the last time it was checked, so it can't send. Replace
            the token in Settings below.
          </Notice>
        )}

        <section aria-labelledby="audience">
          <h2 id="audience" className="mb-3 text-lg font-semibold">Audience</h2>
          <Panel>
            <div className="flex flex-wrap items-end gap-x-10 gap-y-4 px-6 pt-6 pb-5">
              <div>
                <p className="text-[40px] leading-none font-semibold tracking-[-0.03em]">{fmt(s.active)}</p>
                <p className="mt-2 text-sm text-ink-soft">
                  {s.source_error ? "can receive broadcasts (last known)" : "can receive broadcasts"}
                </p>
              </div>
              <dl className="flex gap-8 pb-0.5 text-sm">
                <Small label="Blocked the bot" value={s.blocked} />
                <Small label="Unreachable" value={s.unreachable} />
              </dl>
            </div>
            <div className="border-t border-line px-6 py-5">
              <SourcePanel bot={b} />
            </div>
          </Panel>
        </section>

        <section aria-labelledby="telegram">
          <h2 id="telegram" className="mb-3 text-lg font-semibold">On Telegram</h2>
          <Panel className="divide-y divide-line">
            <div className="px-5 py-4">
              <p className="text-sm font-medium">Description</p>
              <p className="text-xs text-ink-faint">What people see in an empty chat, before they press Start.</p>
              <p className="mt-2 text-sm whitespace-pre-wrap text-ink-soft">{b.telegram_description || "Not set."}</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-sm font-medium">About</p>
              <p className="text-xs text-ink-faint">Shown on the bot's profile.</p>
              <p className="mt-2 text-sm text-ink-soft">{b.about || "Not set."}</p>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
              <span className="text-ink-faint">Photo, name and texts are managed in Telegram. Orbit refreshes them when you press Check now.</span>
              <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="font-medium text-accent-deep underline-offset-4 hover:underline">
                Edit in @BotFather
              </a>
            </div>
          </Panel>
        </section>

        <section aria-labelledby="settings">
          <h2 id="settings" className="mb-3 text-lg font-semibold">Settings</h2>
          <Panel className="divide-y divide-line">
            <Setting
              title="Token"
              body={b.token_valid ? `Accepted by Telegram, checked ${ago(b.last_checked_at)}` : "Rejected by Telegram"}
            >
              <Button size="sm" variant="ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
                {refresh.isPending ? "Checking…" : "Check now"}
              </Button>
              <Button size="sm" onClick={() => setTokenOpen(true)}>Replace</Button>
            </Setting>
            <Setting
              title={b.is_active ? "Enabled" : "Disabled"}
              body={b.is_active ? "Included in broadcasts." : "Left out of broadcasts. Nothing is deleted."}
            >
              <Button size="sm" onClick={() => toggle.mutate(!b.is_active)} disabled={toggle.isPending}>
                {b.is_active ? "Disable" : "Enable"}
              </Button>
            </Setting>
            <Setting title="Remove bot" body="Only before it has sent a broadcast. After that, disable it instead.">
              <Button
                size="sm"
                variant="danger"
                onClick={() => confirm(`Remove @${b.username} from Orbit?`) && remove.mutate()}
              >
                Remove
              </Button>
            </Setting>
          </Panel>
        </section>

        <ActivityList entityType="bot" entityId={b.id} initial={5} />
      </div>

      <ReplaceTokenDialog open={tokenOpen} onClose={() => setTokenOpen(false)} botId={b.id} onDone={done} />
    </div>
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
        <Field label="New token" htmlFor="newtoken" hint="From @BotFather, after revoking the old one. It must belong to the same bot.">
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

function Small({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold text-ink-soft">{fmt(value)}</dd>
    </div>
  );
}

function Setting({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4">
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-ink-faint">{body}</p>
      </div>
      <div className="flex shrink-0 gap-2">{children}</div>
    </div>
  );
}
