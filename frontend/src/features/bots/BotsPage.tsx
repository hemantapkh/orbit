import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { BotAvatar } from "../../components/BotAvatar";
import { useOrg } from "../../app/auth";
import { api, type Bot } from "../../lib/api";
import { fmt } from "../../lib/format";
import { Button, cx, Dialog, Field, Input, StatusDot, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";

export function BotsPage() {
  const [connecting, setConnecting] = useState(false);
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<Bot[]>("/bots") });
  const { can } = useOrg();
  const qc = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => api<Bot[]>("/bots/refresh", { method: "POST" }),
    onSuccess: (fresh) => {
      qc.setQueryData(["bots"], fresh);
      qc.invalidateQueries({ queryKey: ["overview"] });
      qc.invalidateQueries({ queryKey: ["bots"], exact: false, refetchType: "none" });
    },
  });

  return (
    <>
      <PageHeader
        title="Bots"
        lede="Each bot keeps its own code and database. Orbit sends with the bot's token and reads who it can reach from its database, read-only."
        actions={
          <>
            {!!bots.data?.length && can("sender") && (
              <Button onClick={() => refresh.mutate()} disabled={refresh.isPending} title="Re-check every bot with Telegram and recount audiences">
                <RefreshCw size={15} className={cx(refresh.isPending && "animate-spin")} />
                {refresh.isPending ? "Refreshing…" : "Refresh"}
              </Button>
            )}
            {can("admin") && <Button variant="primary" onClick={() => setConnecting(true)}>Connect a bot</Button>}
          </>
        }
      />
      {(bots.error ?? refresh.error) && <div className="mb-4"><Notice>{(bots.error ?? refresh.error)!.message}</Notice></div>}
      {bots.isPending && <Skeleton className="h-48" />}
      {bots.data?.length === 0 && (
        <Panel className="px-6 py-12 text-center text-ink-soft">
          No bots connected yet. Use <strong className="text-ink">Connect a bot</strong> and paste a token from @BotFather.
        </Panel>
      )}
      {!!bots.data?.length && (
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left">
            <thead className="border-b border-line text-sm text-ink-soft">
              <tr>
                <th className="px-5 py-3 font-medium">Bot</th>
                <th className="px-5 py-3 text-right font-medium">Active</th>
                <th className="px-5 py-3 text-right font-medium">Blocked</th>
                <th className="px-5 py-3 text-right font-medium">Unreachable</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {bots.data.map((b) => (
                <tr key={b.id} className="hover:bg-canvas/70">
                  <td className="px-5 py-3.5">
                    <Link to={`/bots/${b.id}`} className="flex items-center gap-3">
                      <span className="relative">
                        <BotAvatar bot={b} size={36} />
                        <span className="absolute -right-0.5 -bottom-0.5 grid place-items-center rounded-full bg-surface p-[2px]">
                          <BotStatus bot={b} />
                        </span>
                      </span>
                      <span>
                        <span className="block font-medium">{b.display_name}</span>
                        <span className="block text-sm text-ink-faint">
                          @{b.username}
                          {!b.subscribers.connected ? (
                            <> · database not connected</>
                          ) : b.subscribers.source_error ? (
                            <span className="text-status-error"> · database unreachable</span>
                          ) : null}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-right font-semibold">{fmt(b.subscribers.active)}</td>
                  <td className="px-5 py-3.5 text-right text-ink-soft">{fmt(b.subscribers.blocked)}</td>
                  <td className="px-5 py-3.5 text-right text-ink-soft">
                    {fmt(b.subscribers.unreachable)}
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
  const nav = useNavigate();
  const [token, setToken] = useState("");
  const connect = useMutation({
    mutationFn: () => api<Bot>("/bots", { method: "POST", json: { token: token.trim() } }),
    onSuccess: (bot) => {
      qc.invalidateQueries({ queryKey: ["bots"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      setToken("");
      onClose();
      nav(`/bots/${bot.id}?connect=database`); // next step: connect the bot's database
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

  return (
    <Dialog open={open} onClose={close} title="Connect a bot">
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
          <div className="flex justify-end gap-2">
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={connect.isPending || !token.trim()}>
              {connect.isPending ? "Checking token…" : "Connect bot"}
            </Button>
          </div>
      </form>
    </Dialog>
  );
}
