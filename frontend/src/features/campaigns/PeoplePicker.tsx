import { useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Bot, type Person, type Recipient } from "../../lib/api";
import { Button, cx, fieldClass, Input, Notice } from "../../components/ui";

export function personLabel(p: Pick<Person, "first_name" | "last_name" | "username">) {
  const name = [p.first_name, p.last_name].filter(Boolean).join(" ");
  return [name, p.username && `@${p.username}`].filter(Boolean).join(" ") || "Unnamed";
}

/** Search a bot's users and hand-pick who receives this broadcast. */
export function PeoplePicker({
  bots,
  value,
  onChange,
}: {
  bots: Bot[];
  value: Recipient[];
  onChange: (v: Recipient[]) => void;
}) {
  const [botId, setBotId] = useState<number | null>(bots[0]?.id ?? null);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    if (!bots.some((b) => b.id === botId)) setBotId(bots[0]?.id ?? null);
  }, [bots, botId]);
  useEffect(() => {
    const id = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);

  const results = useQuery({
    queryKey: ["people", botId, term],
    queryFn: () => api<Person[]>(`/bots/${botId}/people?q=${encodeURIComponent(term)}`),
    enabled: !!botId && term.length > 0,
    placeholderData: (prev) => prev,
  });

  const has = (bid: number, cid: number) => value.some((r) => r.bot_id === bid && r.chat_id === cid);
  const botName = (id: number) => bots.find((b) => b.id === id)?.username ?? id;

  if (!bots.length) return <p className="text-sm text-ink-soft">Pick a bot above first.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {bots.length > 1 && (
          <select aria-label="Search the users of" className={`${fieldClass} h-10 w-auto`} value={botId ?? ""} onChange={(e) => setBotId(Number(e.target.value))}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>@{b.username}</option>
            ))}
          </select>
        )}
        <div className="relative min-w-[220px] flex-1">
          <Search size={16} className="pointer-events-none absolute top-3 left-3 text-ink-faint" />
          <Input
            aria-label="Search people"
            placeholder="Search by name, @username or Telegram ID"
            className="h-10 pl-9"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

      {results.error && <Notice>{results.error.message}</Notice>}
      {term && results.data && (
        <div className="max-h-64 divide-y divide-line overflow-y-auto rounded-lg border border-line bg-surface">
          {results.data.length === 0 && <p className="px-4 py-3 text-sm text-ink-soft">No one matches “{term}”.</p>}
          {results.data.map((p) => {
            const added = has(botId!, p.chat_id);
            return (
              <div key={p.chat_id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0">
                  <span className={cx("block truncate", !p.reachable && "text-ink-faint")}>{personLabel(p)}</span>
                  <span className="block text-xs text-ink-faint">
                    ID {p.chat_id}
                    {!p.reachable && " · blocked the bot or opted out"}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant={added ? "ghost" : "secondary"}
                  disabled={added || !p.reachable}
                  onClick={() => onChange([...value, { bot_id: botId!, chat_id: p.chat_id, label: personLabel(p) }])}
                >
                  {added ? "Added" : "Add"}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Selected people">
          {value.map((r) => (
            <li key={`${r.bot_id}:${r.chat_id}`} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-1 pl-3 text-sm shadow-[0_1px_2px_rgba(23,33,30,0.04)]">
              <span>{r.label || r.chat_id}</span>
              {bots.length > 1 && <span className="text-ink-faint">via @{botName(r.bot_id)}</span>}
              <button
                type="button"
                aria-label={`Remove ${r.label || r.chat_id}`}
                onClick={() => onChange(value.filter((x) => !(x.bot_id === r.bot_id && x.chat_id === r.chat_id)))}
                className="rounded-full p-1 text-ink-faint hover:bg-line hover:text-ink"
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-soft">No one picked yet. Search above and add people, for example your own account to test.</p>
      )}
    </div>
  );
}
