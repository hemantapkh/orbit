import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { api, type Bot, type BotWithKey } from "../../lib/api";
import { ago, fmt } from "../../lib/format";
import { Button, Dialog, Field, Input, StatusDot, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";
import { IntegrationSnippet, RevealedKey } from "./IntegrationKey";

export function BotsPage() {
  const [connecting, setConnecting] = useState(false);
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<Bot[]>("/bots") });

  return (
    <>
      <PageHeader
        title="Bots"
        lede="Each bot keeps its own code and database. It reports subscribers here with its integration key, and Orbit sends broadcasts with its token."
        actions={<Button variant="primary" onClick={() => setConnecting(true)}>Connect a bot</Button>}
      />
      {bots.error && <Notice>{bots.error.message}</Notice>}
      {bots.isPending && <Skeleton className="h-48" />}
      {bots.data?.length === 0 && (
        <Panel className="px-6 py-12 text-center text-ink-soft">
          No bots connected yet. Use <strong className="text-ink">Connect a bot</strong> and paste a token from @BotFather.
        </Panel>
      )}
      {!!bots.data?.length && (
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <thead className="border-b border-line text-sm text-ink-soft">
              <tr>
                <th className="px-5 py-3 font-medium">Bot</th>
                <th className="px-5 py-3 text-right font-medium">Active</th>
                <th className="px-5 py-3 text-right font-medium">Blocked</th>
                <th className="px-5 py-3 text-right font-medium">Unsubscribed</th>
                <th className="px-5 py-3 font-medium">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {bots.data.map((b) => (
                <tr key={b.id} className="hover:bg-canvas/70">
                  <td className="px-5 py-3.5">
                    <Link to={`/bots/${b.id}`} className="flex items-center gap-3">
                      <BotStatus bot={b} />
                      <span>
                        <span className="block font-medium">{b.display_name}</span>
                        <span className="block text-sm text-ink-faint">@{b.username}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-right font-semibold">{fmt(b.subscribers.active)}</td>
                  <td className="px-5 py-3.5 text-right text-ink-soft">{fmt(b.subscribers.blocked)}</td>
                  <td className="px-5 py-3.5 text-right text-ink-soft">
                    {fmt(b.subscribers.unsubscribed + b.subscribers.unreachable)}
                  </td>
                  <td className="px-5 py-3.5 text-sm text-ink-soft">
                    {b.subscribers.source === "database" ? (
                      b.subscribers.source_error ? (
                        <span className="text-status-error">Database unreachable</span>
                      ) : (
                        "Database, live"
                      )
                    ) : (
                      `API, last report ${ago(b.last_ingest_at)}`
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <ConnectBotDialog open={connecting} onClose={() => setConnecting(false)} />
    </>
  );
}

export function BotStatus({ bot }: { bot: Bot }) {
  if (!bot.is_active) return <StatusDot color="off" label="Disabled" />;
  if (!bot.token_valid) return <StatusDot color="red" label="Token rejected by Telegram" />;
  if (bot.subscribers.source_error) return <StatusDot color="red" label="Can't read the bot's database" />;
  return <StatusDot color="green" label="Online" />;
}

function ConnectBotDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [token, setToken] = useState("");
  const [description, setDescription] = useState("");
  const connect = useMutation({
    mutationFn: () => api<BotWithKey>("/bots", { method: "POST", json: { token: token.trim(), description } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bots"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setToken("");
      setDescription("");
    },
  });
  const close = () => {
    connect.reset();
    onClose();
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    connect.mutate();
  }

  const created = connect.data;
  return (
    <Dialog open={open} onClose={close} title={created ? `@${created.username} is connected` : "Connect a bot"}>
      {created ? (
        <div className="space-y-5">
          <RevealedKey apiKey={created.api_key} />
          <div className="space-y-2">
            <p className="text-sm text-ink-soft">
              Have the bot report subscribers as they arrive, up to 1,000 per call. Or connect
              the bot's own database from its page instead.
            </p>
            <IntegrationSnippet apiKey={created.api_key} />
          </div>
          <div className="flex justify-end">
            <Button variant="primary" onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          {connect.error && <Notice>{connect.error.message}</Notice>}
          <Field label="Bot token" htmlFor="token" hint="From @BotFather. Orbit checks it with Telegram and stores it encrypted.">
            <Input
              id="token"
              required
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="123456789:AA…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="font-mono text-sm"
            />
          </Field>
          <Field label="Note" htmlFor="desc" hint="Optional. What this bot is for, so teammates know.">
            <Input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={connect.isPending || !token.trim()}>
              {connect.isPending ? "Checking token…" : "Connect bot"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
