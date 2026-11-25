import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Trash2, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { api, type Bot, type TestGroup, type TestMember } from "../../lib/api";
import { Button, cx, Field, fieldClass, Input, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";
import { PeoplePicker } from "./PeoplePicker";

const KIND: Record<string, string> = { private: "Person", group: "Group", supergroup: "Group", channel: "Channel" };

export function TestGroupsPage() {
  const groups = useQuery({ queryKey: ["test-groups"], queryFn: () => api<TestGroup[]>("/test-groups") });
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<Bot[]>("/bots") });
  const [selected, setSelected] = useState<number | "new" | null>(null);

  const current = selected === "new" ? null : groups.data?.find((g) => g.id === (selected ?? groups.data?.[0]?.id));
  const editing = selected === "new" || current;

  return (
    <>
      <Link to="/broadcasts" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink">
        <ArrowLeft size={15} /> Broadcasts
      </Link>
      <PageHeader
        title="Test groups"
        lede="People, groups or channels that get a broadcast before everyone else. Use Send test in the composer to reach them in one click."
        actions={<Button variant="primary" onClick={() => setSelected("new")}>New test group</Button>}
      />
      {(groups.error ?? bots.error) && <Notice>{(groups.error ?? bots.error)!.message}</Notice>}
      {(groups.isPending || bots.isPending) && <Skeleton className="h-64" />}
      {groups.data && bots.data && (
        groups.data.length === 0 && selected !== "new" ? (
          <Panel className="px-6 py-12 text-center">
            <p className="text-ink-soft">No test groups yet. Start with one that contains your own account.</p>
            <Button className="mt-5" variant="primary" onClick={() => setSelected("new")}>New test group</Button>
          </Panel>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
            <nav aria-label="Test groups" className="space-y-1">
              {groups.data.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setSelected(g.id)}
                  aria-current={current?.id === g.id ? "true" : undefined}
                  className={cx(
                    "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[15px]",
                    current?.id === g.id && selected !== "new" ? "bg-surface font-medium shadow-[0_1px_3px_rgba(23,33,30,0.1)] ring-1 ring-line" : "text-ink-soft hover:text-ink",
                  )}
                >
                  <span className="truncate">{g.name}</span>
                  <span className="shrink-0 text-xs text-ink-faint">{g.is_default ? "default" : g.members.length}</span>
                </button>
              ))}
            </nav>
            {editing && (
              <GroupEditor
                key={selected === "new" ? "new" : current!.id}
                group={selected === "new" ? null : current!}
                bots={bots.data}
                onSaved={(g) => setSelected(g.id)}
                onDeleted={() => setSelected(null)}
              />
            )}
          </div>
        )
      )}
    </>
  );
}

function GroupEditor({
  group,
  bots,
  onSaved,
  onDeleted,
}: {
  group: TestGroup | null;
  bots: Bot[];
  onSaved: (g: TestGroup) => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(group?.name ?? "");
  const [isDefault, setIsDefault] = useState(group?.is_default ?? false);
  const [members, setMembers] = useState<TestMember[]>(group?.members ?? []);
  const usable = bots.filter((b) => b.is_active && b.token_valid);

  const save = useMutation({
    mutationFn: () => {
      const body = { name, members, is_default: isDefault };
      return group
        ? api<TestGroup>(`/test-groups/${group.id}`, { method: "PUT", json: body })
        : api<TestGroup>("/test-groups", { method: "POST", json: body });
    },
    onSuccess: (g) => {
      qc.invalidateQueries({ queryKey: ["test-groups"] });
      onSaved(g);
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/test-groups/${group!.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["test-groups"] });
      onDeleted();
    },
  });
  const botName = (id: number) => bots.find((b) => b.id === id)?.username ?? `bot ${id}`;
  const add = (m: TestMember) =>
    setMembers((ms) => (ms.some((x) => x.bot_id === m.bot_id && x.chat_id === m.chat_id) ? ms : [...ms, m]));

  return (
    <Panel className="space-y-7 p-6">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-5"
      >
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Field label="Name" htmlFor="tg-name">
            <Input id="tg-name" required maxLength={120} placeholder="QA team" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <label className="flex h-10 items-center gap-2 text-[15px]">
            <input type="checkbox" className="size-4 accent-[#17332c]" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Default for Send test
          </label>
        </div>

        <section>
          <h3 className="mb-2 font-semibold">Members</h3>
          {members.length === 0 ? (
            <p className="text-sm text-ink-soft">No one yet. Add people, groups or channels below.</p>
          ) : (
            <ul className="divide-y divide-line rounded-lg border border-line">
              {members.map((m) => (
                <li key={`${m.bot_id}:${m.chat_id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{m.label || m.chat_id}</span>
                    <span className="block text-ink-faint">
                      {KIND[m.kind] ?? m.kind} · ID {m.chat_id} · via @{botName(m.bot_id)}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${m.label || m.chat_id}`}
                    onClick={() => setMembers((ms) => ms.filter((x) => x !== m))}
                    className="rounded-md p-1.5 text-ink-faint hover:bg-line hover:text-ink"
                  >
                    <X size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {save.error && <Notice>{save.error.message}</Notice>}
        <div className="flex flex-wrap justify-between gap-2">
          {group ? (
            <Button variant="danger" onClick={() => confirm(`Delete ${group.name}?`) && remove.mutate()}>
              <Trash2 size={15} /> Delete group
            </Button>
          ) : (
            <span />
          )}
          <Button type="submit" variant="primary" disabled={save.isPending || !name.trim()}>
            {save.isPending ? "Saving…" : group ? "Save changes" : "Create group"}
          </Button>
        </div>
      </form>

      <section className="space-y-5 border-t border-line pt-6">
        <h3 className="font-semibold">Add members</h3>
        <div>
          <p className="mb-2 text-sm text-ink-soft">Search a bot's users:</p>
          <PeoplePicker
            bots={usable}
            showSelected={false}
            value={members.filter((m) => m.kind === "private").map(({ bot_id, chat_id, label }) => ({ bot_id, chat_id, label }))}
            onChange={(picked) => picked.forEach((r) => add({ ...r, kind: "private" }))}
          />
        </div>
        <AddByChatId bots={usable} onAdd={add} />
        <p className="text-sm text-ink-faint">Members are saved when you press {group ? "Save changes" : "Create group"}.</p>
      </section>
    </Panel>
  );
}

/** Groups and channels aren't in the subscriber list; add them by ID and let Telegram confirm. */
function AddByChatId({ bots, onAdd }: { bots: Bot[]; onAdd: (m: TestMember) => void }) {
  const [botId, setBotId] = useState<number | null>(bots[0]?.id ?? null);
  const [chatId, setChatId] = useState("");
  const check = useMutation({
    mutationFn: () => api<TestMember>("/test-groups/resolve", { method: "POST", json: { bot_id: botId, chat_id: Number(chatId) } }),
    onSuccess: (m) => {
      onAdd(m);
      setChatId("");
    },
  });
  if (!bots.length) return null;
  return (
    <div>
      <p className="mb-2 text-sm text-ink-soft">
        Or add a person, group or channel by its chat ID. Orbit checks with Telegram that the bot can reach it.
      </p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          check.mutate();
        }}
      >
        {bots.length > 1 && (
          <select aria-label="Send through" className={`${fieldClass} h-10 w-auto`} value={botId ?? ""} onChange={(e) => setBotId(Number(e.target.value))}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>via @{b.username}</option>
            ))}
          </select>
        )}
        <Input
          aria-label="Chat ID"
          placeholder="Chat ID, e.g. -1001234567890"
          inputMode="numeric"
          className="h-10 w-64"
          value={chatId}
          onChange={(e) => {
            setChatId(e.target.value.trim());
            check.reset();
          }}
        />
        <Button type="submit" disabled={!botId || !/^-?\d+$/.test(chatId) || check.isPending}>
          {check.isPending ? "Checking…" : "Check and add"}
        </Button>
      </form>
      {check.error && <div className="mt-2"><Notice>{check.error.message}</Notice></div>}
    </div>
  );
}
