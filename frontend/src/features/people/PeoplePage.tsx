import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDown, ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { BotAvatar } from "../../components/BotAvatar";
import { Button, cx, Dialog, fieldClass, Input, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";
import { api, type Bot, type PeoplePage as Page, type PersonCategory, type PersonRow, type PersonDetail } from "../../lib/api";
import { ago, fmt, when } from "../../lib/format";

/** Filters live in the URL, so a filtered list can be bookmarked or shared with the team. */
/** Filters in the panel. Each holds one URL parameter; "" means no filter. */
const FILTERS: { key: string; label: string; options: [string, string][] }[] = [
  { key: "kind", label: "Type", options: [["", "Any"], ["people", "People"], ["groups", "Groups"], ["channels", "Channels"]] },
  {
    key: "status",
    label: "Status",
    options: [
      ["", "Any"],
      ["can_receive", "Can receive"],
      ["blocked", "Blocked the bot"],
      ["deleted", "Deleted account"],
      ["left", "Removed from group"],
      ["unreachable", "Unreachable"],
    ],
  },
  {
    key: "active",
    label: "Last active",
    options: [
      ["", "Any time"],
      ["24h", "In the last 24 hours"],
      ["7d", "In the last 7 days"],
      ["30d", "In the last 30 days"],
      ["90d", "In the last 90 days"],
      ["dormant_30d", "Not for 30 days"],
      ["dormant_90d", "Not for 90 days"],
      ["never", "Never"],
    ],
  },
  { key: "joined", label: "Joined", options: [["", "Any time"], ["24h", "In the last 24 hours"], ["7d", "In the last 7 days"], ["30d", "In the last 30 days"], ["90d", "In the last 90 days"]] },
  { key: "premium", label: "Premium", options: [["", "Any"], ["true", "Premium"], ["false", "Not Premium"]] },
  { key: "multi", label: "Bots used", options: [["", "Any number"], ["true", "2 or more bots"]] },
];
const PANEL_KEYS = [...FILTERS.map((f) => f.key), "language"];

const CATEGORY: Record<PersonCategory, { label: string; dot: string }> = {
  can_receive: { label: "Can receive", dot: "bg-status-ok" },
  blocked: { label: "Blocked the bot", dot: "bg-status-error" },
  deleted: { label: "Deleted account", dot: "bg-status-off" },
  left: { label: "Removed from group", dot: "bg-status-busy" },
  unreachable: { label: "Unreachable", dot: "bg-status-info" },
  excluded: { label: "Left out by the mapping's active flag", dot: "bg-line-strong" },
};

const KIND: Record<string, string> = { private: "Person", group: "Group", supergroup: "Supergroup", channel: "Channel" };
const SIZE = 50;

export function PeoplePage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [term, setTerm] = useState(params.get("q") ?? "");
  const [open, setOpen] = useState<number | null>(null);

  const set = (key: string, value: string) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value) next.set(key, value);
        else next.delete(key);
        if (key !== "page") next.delete("page");
        return next;
      },
      { replace: true },
    );

  // Search as you type, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get("q") ?? "") !== term.trim()) set("q", term.trim());
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<Bot[]>("/bots") });
  const botById = new Map((bots.data ?? []).map((b) => [b.id, b]));

  const qs = new URLSearchParams(params);
  qs.set("size", String(SIZE));
  const list = useQuery({
    queryKey: ["people", qs.toString()],
    queryFn: () => api<Page>(`/people?${qs}`),
    placeholderData: keepPreviousData,
  });

  const filtered = [...params.keys()].some((k) => k !== "page" && k !== "sort");
  const sort = params.get("sort") === "joined" ? "joined" : "last_active";
  const d = list.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / SIZE)) : 1;
  const name = (id: number | string) => `@${botById.get(Number(id))?.username ?? `bot ${id}`}`;

  return (
    <>
      <PageHeader title="People" lede="Everyone your bots know, across all of them. Filter to find a group of people, or open one to see their record." />

      <div className="mb-4 flex flex-wrap gap-2">
        <label className="relative min-w-[200px] flex-[1_1_280px]">
          <span className="sr-only">Search</span>
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint" />
          <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search name, @username or Telegram ID" className="pl-9" />
        </label>
        <select aria-label="Bot" value={params.get("bot") ?? ""} onChange={(e) => set("bot", e.target.value)} className={cx(fieldClass, "h-10 w-auto max-w-[220px]")}>
          <option value="">All bots</option>
          {(bots.data ?? []).map((b) => (
            <option key={b.id} value={b.id}>@{b.username}</option>
          ))}
        </select>
        <FilterPanel params={params} set={set} />
      </div>

      <ActiveFilters
        params={params}
        set={set}
        onClear={() => {
          setTerm("");
          setParams(new URLSearchParams(params.get("sort") ? { sort: params.get("sort")! } : {}), { replace: true });
        }}
        botName={(id) => name(id)}
      />

      {list.error && <Notice>{list.error.message}</Notice>}
      {d && Object.keys(d.errors).length > 0 && (
        <div className="mb-3">
          <Notice>Couldn't read {Object.keys(d.errors).map(name).join(", ")}: {Object.values(d.errors)[0]}. They're left out.</Notice>
        </div>
      )}
      {d && Object.keys(d.skipped).length > 0 && (
        <div className="mb-3">
          <Notice tone="info">
            Left out: {Object.entries(d.skipped).map(([id, fields]) => `${name(id)} (map ${fields.join(", ")})`).join("; ")}. Their database mapping doesn't have the field this filter needs.
          </Notice>
        </div>
      )}

      {list.isPending ? (
        <Skeleton className="h-96" />
      ) : d ? (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-soft">
              <span className="text-lg font-semibold text-ink">{fmt(d.total)}</span> {d.total === 1 ? "match" : "matches"}
              {list.isFetching && <span className="ml-2 text-ink-faint">updating…</span>}
            </p>
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              Sort by
              <select value={sort} onChange={(e) => set("sort", e.target.value === "last_active" ? "" : e.target.value)} className={cx(fieldClass, "h-9 w-auto text-sm")}>
                <option value="last_active">Last active, newest first</option>
                <option value="joined">Joined, newest first</option>
              </select>
            </label>
          </div>
          {d.items.length === 0 ? (
            <Panel className="px-6 py-12 text-center text-ink-soft">
              {filtered ? "Nobody matches these filters." : "No people yet. Connect a bot's database to see who it reaches."}
            </Panel>
          ) : (
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-line text-ink-soft">
                  <tr>
                    <th className="px-5 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Bots</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Language</th>
                    <SortHeader label="Joined" value="joined" sort={sort} onSort={(v) => set("sort", v)} className="px-4" />
                    <SortHeader label="Last active" value="last_active" sort={sort} onSort={(v) => set("sort", v === "last_active" ? "" : v)} className="px-5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {d.items.map((p) => (
                    <tr key={p.chat_id} onClick={() => setOpen(p.chat_id)} className="cursor-pointer hover:bg-canvas/70">
                      <td className="px-5 py-3">
                        <button type="button" className="text-left" onClick={() => setOpen(p.chat_id)}>
                          <span className="block font-medium">
                            {p.name || <span className="text-ink-faint">No name</span>}
                            {p.is_premium && <span className="ml-1.5 rounded bg-accent-wash px-1.5 py-px text-[11px] font-medium text-accent-deep">Premium</span>}
                          </span>
                          <span className="block text-ink-faint">{p.username ? `@${p.username}` : p.chat_id}</span>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {p.bots.map((r) => {
                            const b = botById.get(r.bot_id);
                            return (
                              <span
                                key={r.bot_id}
                                title={`${name(r.bot_id)}: ${CATEGORY[r.category].label}`}
                                className="inline-flex items-center gap-1.5 rounded-full border border-line py-0.5 pr-2 pl-0.5 text-xs"
                              >
                                {b ? <BotAvatar bot={b} size={18} /> : null}
                                <span className={cx("size-1.5 rounded-full", CATEGORY[r.category].dot)} aria-hidden />
                                <span className="max-w-[110px] truncate">{b?.username ?? r.bot_id}</span>
                              </span>
                            );
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-ink-soft">{p.kind ? KIND[p.kind] ?? p.kind : "—"}</td>
                      <td className="px-4 py-3 text-ink-soft">{p.language_code ?? "—"}</td>
                      <td className="px-4 py-3 text-ink-soft" title={when(p.joined_at)}>{p.joined_at ? ago(p.joined_at) : "—"}</td>
                      <td className="px-5 py-3 text-ink-soft" title={when(p.last_active_at)}>{p.last_active_at ? ago(p.last_active_at) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
          {d.total > SIZE && (
            <nav aria-label="Pages" className="mt-4 flex items-center justify-between text-sm text-ink-soft">
              <span>
                {fmt((page - 1) * SIZE + 1)}–{fmt(Math.min(page * SIZE, d.total))} of {fmt(d.total)}
              </span>
              <span className="flex gap-2">
                <Button size="sm" disabled={page <= 1} onClick={() => set("page", String(page - 1))}>
                  <ChevronLeft size={15} /> Previous
                </Button>
                <Button size="sm" disabled={page >= pages} onClick={() => set("page", String(page + 1))}>
                  Next <ChevronRight size={15} />
                </Button>
              </span>
            </nav>
          )}
        </>
      ) : null}

      <PersonDialog chatId={open} onClose={() => setOpen(null)} botById={botById} />
    </>
  );
}

function PersonDialog({ chatId, onClose, botById }: { chatId: number | null; onClose: () => void; botById: Map<number, Bot> }) {
  const q = useQuery({
    queryKey: ["person", chatId],
    queryFn: () => api<PersonDetail>(`/people/${chatId}`),
    enabled: chatId != null,
  });
  const p: PersonRow | null | undefined = q.data?.person;
  const title = p ? p.name || (p.username ? `@${p.username}` : String(p.chat_id)) : "Person";
  return (
    <Dialog open={chatId != null} onClose={onClose} title={title}>
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.error ? (
        <Notice>{q.error.message}</Notice>
      ) : !p ? (
        <p className="text-ink-soft">No bot's database knows this chat any more.</p>
      ) : (
        <div className="space-y-6 text-sm">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Fact label="Telegram ID" value={String(p.chat_id)} />
            <Fact
              label="Username"
              value={p.username ? <a href={`https://t.me/${p.username}`} target="_blank" rel="noreferrer" className="text-accent-deep underline-offset-4 hover:underline">@{p.username}</a> : "—"}
            />
            <Fact label="Type" value={p.kind ? KIND[p.kind] ?? p.kind : "—"} />
            <Fact label="Language" value={p.language_code ?? "—"} />
            <Fact label="Premium" value={p.is_premium == null ? "—" : p.is_premium ? "Yes" : "No"} />
            <Fact label="Last active" value={p.last_active_at ? `${ago(p.last_active_at)}` : "—"} />
          </dl>

          <section>
            <h3 className="mb-2 font-semibold">In each bot</h3>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {p.bots.map((r) => {
                const b = botById.get(r.bot_id);
                return (
                  <li key={r.bot_id} className="flex items-start gap-3 px-3.5 py-3">
                    {b && <BotAvatar bot={b} size={28} />}
                    <div className="min-w-0 flex-1">
                      <Link to={`/bots/${r.bot_id}`} className="font-medium hover:underline">@{b?.username ?? r.bot_id}</Link>
                      <p className="text-ink-faint">
                        joined {r.joined_at ? when(r.joined_at) : "—"} · active {r.last_active_at ? ago(r.last_active_at) : "—"}
                        {r.language_code ? ` · ${r.language_code}` : ""}
                      </p>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-ink-soft">
                      <span className={cx("size-2 rounded-full", CATEGORY[r.category].dot)} aria-hidden />
                      {CATEGORY[r.category].label}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 font-semibold">Broadcasts from Orbit</h3>
            {q.data!.received.length === 0 ? (
              <p className="text-ink-soft">None sent to this chat yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {q.data!.received.map((r) => (
                  <li key={`${r.campaign_id}-${r.bot_id}`} className="flex items-center gap-3 px-3.5 py-2.5">
                    <Link to={`/broadcasts/${r.campaign_id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{r.campaign_name}</Link>
                    <span className="shrink-0 text-ink-faint">@{botById.get(r.bot_id)?.username ?? r.bot_id}</span>
                    <span className={cx("w-20 shrink-0 text-right", r.status === "sent" ? "text-ink-soft" : "text-status-error")} title={r.error ?? undefined}>
                      {r.status === "sent" ? "delivered" : r.status}
                    </span>
                    <span className="w-24 shrink-0 text-right text-ink-faint">{r.at ? ago(r.at) : "—"}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}

function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="mt-0.5 truncate font-medium">{value}</dd>
    </div>
  );
}

/** "Filters" button with a count; opens a small panel with the rest of the filters. */
function FilterPanel({ params, set }: { params: URLSearchParams; set: (k: string, v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const count = PANEL_KEYS.filter((k) => params.get(k)).length;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Button onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cx(count > 0 && "border-accent")}>
        <SlidersHorizontal size={15} />
        Filters
        {count > 0 && <span className="rounded-full bg-accent-wash px-1.5 text-xs font-semibold text-accent-deep">{count}</span>}
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-[min(560px,calc(100vw-32px))] rounded-xl border border-line bg-surface p-4 shadow-[0_18px_40px_-18px_rgba(23,33,30,0.35)]">
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
            {FILTERS.map((f) => (
              <label key={f.key} className="text-sm">
                <span className="mb-1 block text-ink-soft">{f.label}</span>
                <select value={params.get(f.key) ?? ""} onChange={(e) => set(f.key, e.target.value)} className={cx(fieldClass, "h-9 text-sm")}>
                  {f.options.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
            ))}
            <label className="text-sm">
              <span className="mb-1 block text-ink-soft">Language</span>
              <Input key={params.get("language") ?? ""} defaultValue={params.get("language") ?? ""} onBlur={(e) => set("language", e.target.value.trim())} onKeyDown={(e) => e.key === "Enter" && set("language", e.currentTarget.value.trim())} placeholder="Code, e.g. en or ne" className="h-9 text-sm" />
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <Button size="sm" variant="primary" onClick={() => setOpen(false)}>Done</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The filters in use, as chips that remove themselves. Hidden when nothing is filtered. */
function ActiveFilters({ params, set, onClear, botName }: { params: URLSearchParams; set: (k: string, v: string) => void; onClear: () => void; botName: (id: string) => string }) {
  const chips: { key: string; text: string }[] = [];
  if (params.get("q")) chips.push({ key: "q", text: `“${params.get("q")}”` });
  if (params.get("bot")) chips.push({ key: "bot", text: botName(params.get("bot")!) });
  for (const f of FILTERS) {
    const v = params.get(f.key);
    const label = f.options.find(([o]) => o === v)?.[1];
    if (v && label) chips.push({ key: f.key, text: `${f.label}: ${label}` });
  }
  if (params.get("language")) chips.push({ key: "language", text: `Language: ${params.get("language")}` });
  if (!chips.length) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => set(c.key, "")}
          className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-1 pr-2 pl-3 text-sm hover:border-line-strong"
          title="Remove this filter"
        >
          {c.text}
          <X size={13} className="text-ink-faint" />
        </button>
      ))}
      <button type="button" onClick={onClear} className="px-1 text-sm text-accent-deep underline-offset-4 hover:underline">
        Clear all
      </button>
    </div>
  );
}

function SortHeader({ label, value, sort, onSort, className }: { label: string; value: string; sort: string; onSort: (v: string) => void; className?: string }) {
  const on = sort === value;
  return (
    <th className={cx("py-3 font-medium", className)} aria-sort={on ? "descending" : "none"}>
      <button type="button" onClick={() => onSort(value)} className={cx("inline-flex items-center gap-1 hover:text-ink", on && "text-ink")}>
        {label}
        <ArrowDown size={13} className={cx(!on && "opacity-0")} />
      </button>
    </th>
  );
}
