import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bold, Check, ChevronDown, UserRound, X, Code, Italic, Link2, Paperclip, Plus, Strikethrough, Trash2, Underline } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useOrg } from "../../app/auth";
import {
  api,
  type Audience,
  type Bot,
  type BotSourceInfo,
  type CampaignDetail,
  emptyMessage,
  type Media,
  type MessageContent,
  type Estimate,
  type ParseMode,
  type TestGroup,
  type TestSendResult,
} from "../../lib/api";
import { duration, fmt, toLocalInput, when } from "../../lib/format";
import { Button, buttonClass, cx, Dialog, fieldClass, StatusDot, Field, Input, Notice, Panel, Skeleton, Textarea } from "../../components/ui";
import { BotAvatar } from "../../components/BotAvatar";
import { FIELDS, placeholdersIn, withSamples } from "../../lib/personalize";
import { MessagePreview } from "./MessagePreview";
import { PeoplePicker } from "./PeoplePicker";

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

export function CampaignEditorPage() {
  const { campaignId } = useParams();
  const existing = useQuery({
    queryKey: ["campaign", campaignId],
    queryFn: () => api<CampaignDetail>(`/campaigns/${campaignId}`),
    enabled: !!campaignId,
  });
  const bots = useQuery({ queryKey: ["bots"], queryFn: () => api<Bot[]>("/bots") });
  const { can } = useOrg();

  if (!can("sender")) return <Notice>Your role in this organization is read-only, so you can't create or edit broadcasts.</Notice>;
  if (campaignId && existing.isPending) return <Skeleton className="h-96" />;
  if (existing.error) return <Notice>{existing.error.message}</Notice>;
  if (bots.isPending) return <Skeleton className="h-96" />;
  if (bots.error) return <Notice>{bots.error.message}</Notice>;
  return <Editor key={campaignId ?? "new"} initial={existing.data} bots={bots.data} />;
}

function Editor({ initial, bots }: { initial?: CampaignDetail; bots: Bot[] }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const preselect = Number(params.get("bot")) || null;

  const [id, setId] = useState<number | null>(initial?.id ?? null);
  const [name, setName] = useState(initial?.name ?? "");
  const [botIds, setBotIds] = useState<number[]>(initial?.bot_ids ?? (preselect ? [preselect] : []));
  const [message, setMessage] = useState<MessageContent>(initial?.message ?? emptyMessage());
  const [audience, setAudience] = useState<Audience>(initial?.audience ?? { mode: "all", recipients: [] });
  const [launching, setLaunching] = useState<"now" | "schedule" | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const testGroups = useQuery({ queryKey: ["test-groups"], queryFn: () => api<TestGroup[]>("/test-groups") });
  const [pickedGroup, setPickedGroup] = useState<number | null>(null);
  const testGroupId =
    (pickedGroup && testGroups.data?.some((g) => g.id === pickedGroup) ? pickedGroup : null) ??
    testGroups.data?.find((g) => g.is_default)?.id ??
    testGroups.data?.[0]?.id ??
    null;
  const testGroupName = testGroups.data?.find((g) => g.id === testGroupId)?.name ?? "test group";
  const sendTest = useMutation({
    mutationFn: () =>
      api<TestSendResult[]>(`/test-groups/${testGroupId}/send`, {
        method: "POST",
        json: { message, campaign_id: id },
      }),
  });

  const media = useQuery({
    queryKey: ["media", message.media_id],
    queryFn: () => api<Media>(`/media/${message.media_id}`),
    enabled: message.media_id != null,
    staleTime: Infinity,
  });

  const usable = bots.filter((b) => b.is_active && b.token_valid);
  const selected = bots.filter((b) => botIds.includes(b.id));
  // Picked people only count while their bot is still selected.
  const recipients = audience.recipients.filter((r) => botIds.includes(r.bot_id));
  const picking = audience.mode === "selected";
  const reachCount = picking ? recipients.length : selected.reduce((n, b) => n + b.subscribers.active, 0);
  const limit = message.media_id != null ? CAPTION_LIMIT : TEXT_LIMIT;
  const tooLong = message.text.length > limit;
  const isEmpty = !message.text.trim() && message.media_id == null;
  const editingScheduled = initial?.status === "scheduled";

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim() || "Untitled broadcast",
        bot_ids: botIds,
        message,
        audience: { mode: audience.mode, recipients: picking ? recipients : [] },
      };
      return id
        ? api<CampaignDetail>(`/campaigns/${id}`, { method: "PATCH", json: body })
        : api<CampaignDetail>("/campaigns", { method: "POST", json: body });
    },
    onSuccess: (c) => {
      qc.setQueryData(["campaign", String(c.id)], c);
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      setSavedAt(new Date());
      if (!id) {
        setId(c.id);
        nav(`/broadcasts/${c.id}/edit`, { replace: true });
      }
    },
  });

  const patch = (p: Partial<MessageContent>) => setMessage((m) => ({ ...m, ...p }));
  const toggleBot = (bid: number) =>
    setBotIds((ids) => (ids.includes(bid) ? ids.filter((x) => x !== bid) : [...ids, bid]));

  return (
    <>
      <Link to="/broadcasts" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink">
        <ArrowLeft size={15} /> Broadcasts
      </Link>
      <header className="mb-8">
        <label htmlFor="name" className="sr-only">Broadcast name</label>
        <input
          id="name"
          value={name}
          maxLength={160}
          onChange={(e) => setName(e.target.value)}
          placeholder="Untitled broadcast"
          className="w-full rounded-md bg-transparent text-[28px] leading-tight font-semibold tracking-[-0.015em] placeholder:text-ink-faint focus:shadow-[0_0_0_4px_rgba(184,145,58,0.16)] focus:outline-none"
        />
        <p className="mt-1 text-sm text-ink-soft">
          {editingScheduled
            ? `Scheduled for ${when(initial!.scheduled_at)}. Changes apply to that send.`
            : "Only operators see the name. Recipients see the message."}
        </p>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-5">
          <Section
            title="Audience"
            aside={
              bots.length > 0 && (
                <span className="flex gap-3">
                  <button type="button" className="hover:text-ink" onClick={() => setBotIds(usable.map((b) => b.id))}>
                    Select all
                  </button>
                  <button type="button" className="hover:text-ink" onClick={() => setBotIds([])}>
                    Clear
                  </button>
                </span>
              )
            }
          >
            {bots.length === 0 ? (
              <p className="text-ink-soft">
                No bots connected. <Link to="/bots" className="underline underline-offset-4">Connect one</Link> first.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Bots">
                  {bots.map((b) => {
                    const disabled = !b.is_active || !b.token_valid || !b.subscribers.connected;
                    const on = botIds.includes(b.id);
                    const why = !b.is_active ? "disabled" : !b.token_valid ? "token rejected" : !b.subscribers.connected ? "no database" : null;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        aria-pressed={on}
                        disabled={disabled && !on}
                        onClick={() => toggleBot(b.id)}
                        title={why ? `@${b.username}: ${why}` : `@${b.username}`}
                        className={cx(
                          "inline-flex items-center gap-2 rounded-full border py-1.5 pr-3 pl-2.5 text-sm transition-[background-color,border-color,box-shadow]",
                          on
                            ? "border-panel/50 bg-panel/[0.06] text-ink shadow-[0_0_0_3px_rgba(23,51,44,0.07)]"
                            : "border-line bg-surface text-ink hover:border-line-strong",
                          disabled && !on && "cursor-not-allowed opacity-50",
                        )}
                      >
                        <span className="relative">
                          <BotAvatar bot={b} size={20} />
                          {on && (
                            <span className="absolute -right-1 -bottom-1 grid size-3 place-items-center rounded-full bg-panel text-white ring-2 ring-surface">
                              <Check size={8} strokeWidth={4} />
                            </span>
                          )}
                        </span>
                        <span className="font-medium">{b.display_name}</span>
                        <span className="text-ink-faint">{why ?? fmt(b.subscribers.active)}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-5 space-y-4">
                  <div role="radiogroup" aria-label="Who receives it" className="inline-flex rounded-lg bg-canvas p-1 text-sm ring-1 ring-line">
                    {(
                      [
                        ["all", "Everyone on these bots"],
                        ["selected", "Only specific people"],
                      ] as const
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={audience.mode === mode}
                        onClick={() => setAudience((a) => ({ ...a, mode }))}
                        className={cx(
                          "rounded-md px-3.5 py-1.5 font-medium transition-colors",
                          audience.mode === mode ? "bg-surface text-ink shadow-[0_1px_3px_rgba(23,33,30,0.12)]" : "text-ink-soft hover:text-ink",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {picking && (
                    <PeoplePicker
                      bots={selected}
                      value={recipients}
                      onChange={(r) => setAudience((a) => ({ ...a, recipients: r }))}
                    />
                  )}
                </div>
              </>
            )}
          </Section>

          <Section title="Message">
            <MediaPicker media={media.data ?? null} onChange={(m) => patch({ media_id: m?.id ?? null })} />
            <Composer value={message.text} onChange={(text) => patch({ text })} mode={message.parse_mode} />
            <PersonalizationNotes text={message.text} bots={selected} />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm">
              <label className="flex items-center gap-2 text-ink-soft">
                Formatting
                <select
                  className={`${fieldClass} h-9 w-auto`}
                  value={message.parse_mode ?? "none"}
                  onChange={(e) => patch({ parse_mode: e.target.value === "none" ? null : (e.target.value as ParseMode) })}
                >
                  <option value="Markdown">Markdown</option>
                  <option value="HTML">HTML</option>
                  <option value="MarkdownV2">Telegram MarkdownV2</option>
                  <option value="none">Plain text</option>
                </select>
              </label>
              <span className={tooLong ? "font-medium text-status-error" : "text-ink-faint"}>
                {fmt(message.text.length)} / {fmt(limit)}
                {message.media_id != null && " (caption)"}
              </span>
            </div>
          </Section>

          <Section title="Buttons" aside="Optional links under the message">
            <ButtonsEditor value={message.buttons} onChange={(buttons) => patch({ buttons })} />
          </Section>

          <Section title="Options">
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Toggle checked={message.silent} onChange={(silent) => patch({ silent })} label="Send silently" hint="Arrives without a notification sound." />
              <Toggle checked={message.disable_link_preview} onChange={(v) => patch({ disable_link_preview: v })} label="Hide link previews" hint="Applies to text-only messages." />
              <Toggle checked={message.protect_content} onChange={(v) => patch({ protect_content: v })} label="Protect content" hint="Recipients can't forward or save it." />
            </div>
          </Section>
        </div>

        <aside className="space-y-6 lg:sticky lg:top-8 lg:self-start">
          <ReachCard bots={selected} picked={picking ? recipients.length : null} />
          <section aria-label="Preview">
            <h2 className="mb-3 font-semibold">Preview</h2>
            <MessagePreview message={{ ...message, text: withSamples(message.text) }} media={media.data ?? null} />
            {placeholdersIn(message.text).length > 0 && (
              <p className="mt-2 text-xs text-ink-faint">Showing sample values. Each person sees their own.</p>
            )}
          </section>
          {(sendTest.data || sendTest.error) && (
            <TestResults
              groupName={testGroupName}
              results={sendTest.data}
              error={sendTest.error}
              bots={bots}
              onDismiss={() => sendTest.reset()}
            />
          )}
        </aside>
      </div>

      {/* Pinned to the bottom edge; the negative bottom margin cancels the page padding so
          the bar never lifts off the edge at the end of the page. */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-10 -mb-8 border-t border-line bg-canvas/95 px-4 py-4 backdrop-blur sm:-mx-8 sm:px-8 md:-mb-12">
        {save.error && <div className="mb-3"><Notice>{save.error.message}</Notice></div>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-ink-faint">{savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : "Not saved yet"}</span>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save draft"}
            </Button>
            {testGroupId ? (
              <div className="inline-flex">
                <Button
                  className="rounded-r-none"
                  title={`Send to ${testGroupName}`}
                  onClick={() => sendTest.mutate()}
                  disabled={isEmpty || tooLong || sendTest.isPending}
                >
                  {sendTest.isPending ? "Sending test…" : "Send test"}
                </Button>
                {/* Chevron only: a transparent native select sits on top, so it stays accessible. */}
                <div className="relative grid w-9 place-items-center rounded-r-lg border border-l-0 border-line bg-surface text-ink-soft shadow-[0_1px_2px_rgba(23,33,30,0.05)] hover:bg-canvas/60 focus-within:shadow-[0_0_0_4px_rgba(184,145,58,0.16)]">
                  <ChevronDown size={16} aria-hidden />
                  <select
                    aria-label={`Test group: ${testGroupName}`}
                    title={`Test group: ${testGroupName}`}
                    value={testGroupId}
                    onChange={(e) => {
                      if (e.target.value === "manage") nav("/broadcasts/test-groups");
                      else setPickedGroup(Number(e.target.value));
                    }}
                    className="absolute inset-0 cursor-pointer opacity-0"
                  >
                    {testGroups.data?.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({g.members.length})
                      </option>
                    ))}
                    <option value="manage">Manage test groups…</option>
                  </select>
                </div>
              </div>
            ) : (
              <Link to="/broadcasts/test-groups" className={buttonClass("secondary")}>
                Set up a test group
              </Link>
            )}
            <Button disabled={!botIds.length || isEmpty || tooLong || (picking && !recipients.length)} onClick={() => setLaunching("schedule")}>
              {editingScheduled ? "Change schedule" : "Schedule"}
            </Button>
            <Button variant="primary" disabled={!botIds.length || isEmpty || tooLong || (picking && !recipients.length)} onClick={() => setLaunching("now")}>
              Send now
            </Button>
          </div>
        </div>
      </div>

      <LaunchDialog
        mode={launching}
        onClose={() => setLaunching(null)}
        audience={reachCount}
        picked={picking}
        botCount={botIds.length}
        initialTime={initial?.scheduled_at ?? null}
        beforeLaunch={() => save.mutateAsync()}
        onLaunched={(cid) => {
          qc.invalidateQueries({ queryKey: ["campaigns"] });
          qc.invalidateQueries({ queryKey: ["overview"] });
          nav(`/broadcasts/${cid}`);
        }}
      />
    </>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Panel className="p-5">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h2 className="font-semibold">{title}</h2>
        {aside && <span className="text-sm text-ink-soft">{aside}</span>}
      </div>
      {children}
    </Panel>
  );
}

function Composer({ value, onChange, mode }: { value: string; onChange: (v: string) => void; mode: ParseMode }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function wrap(open: string, close: string) {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const next = value.slice(0, s) + open + value.slice(s, e) + close + value.slice(e);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + open.length, e + open.length);
    });
  }

  function link() {
    const url = prompt("Link address", "https://");
    if (!url || !/^(https?|tg):\/\//.test(url)) return;
    if (mode === "Markdown") wrap("[", `](${url})`);
    else wrap(`<a href="${url.replace(/"/g, "&quot;")}">`, "</a>");
  }

  type Tool = [typeof Bold, string, () => void];
  const tools: Tool[] =
    mode === "Markdown"
      ? [
          [Bold, "Bold", () => wrap("**", "**")],
          [Italic, "Italic", () => wrap("_", "_")],
          [Strikethrough, "Strikethrough", () => wrap("~~", "~~")],
          [Code, "Code", () => wrap("`", "`")],
          [Link2, "Link", link],
        ]
      : mode === "HTML"
        ? [
            [Bold, "Bold", () => wrap("<b>", "</b>")],
            [Italic, "Italic", () => wrap("<i>", "</i>")],
            [Underline, "Underline", () => wrap("<u>", "</u>")],
            [Strikethrough, "Strikethrough", () => wrap("<s>", "</s>")],
            [Code, "Code", () => wrap("<code>", "</code>")],
            [Link2, "Link", link],
          ]
        : [];
  const html = tools.length > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-[0_1px_2px_rgba(23,33,30,0.04)] transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_4px_rgba(184,145,58,0.16)]">
      <div className="flex items-center gap-0.5 border-b border-line px-1.5 py-1">
        {tools.map(([Icon, label, fn]) => (
          <button key={label} type="button" onClick={fn} title={label} aria-label={label} className="rounded p-1.5 text-ink-soft hover:bg-line/60 hover:text-ink">
            <Icon size={16} />
          </button>
        ))}
        {html && <span className="mx-1 h-5 w-px bg-line" aria-hidden />}
        <PersonalizeMenu onPick={(token) => wrap(token, "")} />
      </div>
      <Textarea
        ref={ref}
        rows={9}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Write the message your subscribers will receive."
        className="rounded-none border-0 shadow-none focus:border-0 focus:shadow-none"
        aria-label="Message text"
      />
    </div>
  );
}

function MediaPicker({ media, onChange }: { media: Media | null; onChange: (m: Media | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api<Media>("/media", { method: "POST", body: form });
    },
    onSuccess: onChange,
  });
  return (
    <div className="mb-3">
      {media ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-3.5 py-2.5 text-sm">
          <span className="min-w-0 truncate">
            <span className="text-ink-soft">{media.kind === "animation" ? "GIF" : media.kind[0].toUpperCase() + media.kind.slice(1)}:</span>{" "}
            {media.filename}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Remove</Button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => input.current?.click()} disabled={upload.isPending}>
          <Paperclip size={15} /> {upload.isPending ? "Uploading…" : "Attach photo, video or file"}
        </Button>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept="image/*,video/*,application/pdf,.zip,.doc,.docx,.xls,.xlsx,.csv,.txt"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = "";
        }}
      />
      {upload.error && <div className="mt-2"><Notice>{upload.error.message}</Notice></div>}
    </div>
  );
}

function ButtonsEditor({ value, onChange }: { value: MessageContent["buttons"]; onChange: (v: MessageContent["buttons"]) => void }) {
  const set = (i: number, p: Partial<{ text: string; url: string }>) => onChange(value.map((b, j) => (j === i ? { ...b, ...p } : b)));
  return (
    <div className="space-y-2">
      {value.map((b, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-2">
          <Input aria-label={`Button ${i + 1} label`} placeholder="Label" maxLength={64} value={b.text} onChange={(e) => set(i, { text: e.target.value })} />
          <Input aria-label={`Button ${i + 1} link`} placeholder="https://" value={b.url} onChange={(e) => set(i, { url: e.target.value })} />
          <Button variant="ghost" aria-label={`Remove button ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 size={16} />
          </Button>
        </div>
      ))}
      {value.length < 10 && (
        <Button size="sm" variant="ghost" onClick={() => onChange([...value, { text: "", url: "https://" }])}>
          <Plus size={15} /> Add button
        </Button>
      )}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" className="mt-1 size-4 accent-[#1e3a33]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block">{label}</span>
        <span className="block text-sm text-ink-faint">{hint}</span>
      </span>
    </label>
  );
}

/** Who this broadcast reaches, per bot, and roughly how long sending takes. */
function ReachCard({ bots, picked }: { bots: Bot[]; picked: number | null }) {
  const ids = bots.map((b) => b.id);
  const est = useQuery({
    queryKey: ["estimate", ids],
    queryFn: () => api<Estimate>(`/campaigns/estimate?${ids.map((i) => `bot_ids=${i}`).join("&")}`),
    enabled: ids.length > 0 && picked == null,
    placeholderData: (prev) => prev,
  });
  const total = picked ?? est.data?.recipients ?? 0;
  const perBot = new Map(est.data?.bots.map((b) => [b.bot_id, b.recipients]));

  return (
    <Panel className="p-5">
      <h2 className="text-sm text-ink-soft">Reach</h2>
      {!bots.length ? (
        <p className="mt-1 text-sm text-ink-soft">Choose at least one bot to see who this reaches.</p>
      ) : (
        <>
          <p className="mt-1 text-[32px] leading-none font-semibold tracking-[-0.02em]">{fmt(total)}</p>
          <p className="mt-1.5 text-sm text-ink-soft">
            {picked != null ? `selected ${picked === 1 ? "person" : "people"}` : "people who can receive it right now"}
          </p>
          {picked == null && bots.length > 1 && (
            <ul className="mt-4 space-y-1.5 text-sm">
              {bots.map((b) => (
                <li key={b.id} className="flex justify-between gap-3">
                  <span className="truncate text-ink-soft">@{b.username}</span>
                  <span className="font-medium">{perBot.has(b.id) ? fmt(perBot.get(b.id)!) : "…"}</span>
                </li>
              ))}
            </ul>
          )}
          {picked == null && est.data && est.data.recipients > 0 && (
            <p className="mt-4 border-t border-line pt-3 text-sm text-ink-soft">
              Sending takes about <strong className="text-ink">{duration(est.data.seconds)}</strong> at Telegram's rate
              {bots.length > 1 ? ", with bots sending in parallel." : "."}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}

function TestResults({
  groupName,
  results,
  error,
  bots,
  onDismiss,
}: {
  groupName: string;
  results: TestSendResult[] | undefined;
  error: Error | null;
  bots: Bot[];
  onDismiss: () => void;
}) {
  const botName = (id: number) => bots.find((b) => b.id === id)?.username ?? `bot ${id}`;
  const delivered = results?.filter((r) => r.delivered).length ?? 0;
  return (
    <Panel className="space-y-3 p-4" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Test sent to {groupName}</h2>
          {results && (
            <p className="text-sm text-ink-soft">
              {delivered} of {results.length} delivered
            </p>
          )}
        </div>
        <button type="button" onClick={onDismiss} aria-label="Dismiss test results" className="-m-1 rounded p-1 text-ink-faint hover:text-ink">
          <X size={16} />
        </button>
      </div>
      {error && <Notice>{error.message}</Notice>}
      {results && (
        <ul className="divide-y divide-line rounded-lg border border-line text-sm" aria-label="Test results">
          {results.map((r) => (
            <li key={`${r.bot_id}:${r.chat_id}`} className="flex items-start gap-2.5 px-3 py-2">
              <span className="pt-1.5"><StatusDot color={r.delivered ? "green" : "red"} /></span>
              <span className="min-w-0">
                <span className="block truncate">{r.label || r.chat_id}</span>
                <span className={cx("block text-xs", r.delivered ? "text-ink-faint" : "text-status-error")}>
                  {r.delivered ? `Delivered via @${botName(r.bot_id)}` : r.error}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function LaunchDialog({
  mode,
  onClose,
  audience,
  picked,
  botCount,
  initialTime,
  beforeLaunch,
  onLaunched,
}: {
  mode: "now" | "schedule" | null;
  onClose: () => void;
  audience: number;
  picked: boolean;
  botCount: number;
  initialTime: string | null;
  beforeLaunch: () => Promise<CampaignDetail>;
  onLaunched: (id: number) => void;
}) {
  const [time, setTime] = useState(() =>
    toLocalInput(initialTime ? new Date(initialTime) : new Date(Date.now() + 60 * 60 * 1000)),
  );
  const launch = useMutation({
    mutationFn: async () => {
      const c = await beforeLaunch();
      const scheduled_at = mode === "schedule" ? new Date(time).toISOString() : null;
      return api<CampaignDetail>(`/campaigns/${c.id}/launch`, { method: "POST", json: { scheduled_at } });
    },
    onSuccess: (c) => onLaunched(c.id),
  });
  const close = () => {
    launch.reset();
    onClose();
  };
  const reach = picked
    ? `${fmt(audience)} selected ${audience === 1 ? "person" : "people"}`
    : `${fmt(audience)} active subscriber${audience === 1 ? "" : "s"} across ${botCount} bot${botCount === 1 ? "" : "s"}`;

  return (
    <Dialog open={mode !== null} onClose={close} title={mode === "schedule" ? "Schedule broadcast" : "Send broadcast now"}>
      <div className="space-y-5">
        {launch.error && <Notice>{launch.error.message}</Notice>}
        {mode === "schedule" ? (
          <>
            <Field label="Send at" htmlFor="sendat" hint={`In your timezone (${Intl.DateTimeFormat().resolvedOptions().timeZone}). Goes to ${reach}, counted at send time.`}>
              <Input id="sendat" type="datetime-local" value={time} min={toLocalInput(new Date())} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </>
        ) : (
          <p className="text-ink-soft">
            This goes out to <strong className="text-ink">{reach}</strong> right away. You can pause or
            cancel while it's sending, but messages already delivered stay delivered.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => launch.mutate()} disabled={launch.isPending || (mode === "schedule" && !time)}>
            {launch.isPending ? "Starting…" : mode === "schedule" ? "Schedule" : `Send to ${fmt(audience)}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Insert {first_name} etc. at the cursor. */
function PersonalizeMenu({ onPick }: { onPick: (token: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onBlur={(e) => !e.currentTarget.parentElement?.contains(e.relatedTarget) && setOpen(false)}
        className="inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-sm text-ink-soft hover:bg-line/60 hover:text-ink"
      >
        <UserRound size={15} /> Personalize
      </button>
      {open && (
        <div role="menu" className="absolute top-full left-0 z-20 mt-1 w-64 rounded-lg border border-line bg-surface py-1 text-sm shadow-[0_16px_40px_-16px_rgba(19,26,24,0.45)]">
          {FIELDS.map((f) => (
            <button
              key={f.key}
              role="menuitem"
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(f.key === "first_name" ? "{first_name|there}" : `{${f.key}}`);
                setOpen(false);
              }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-canvas"
            >
              <span>{f.label}</span>
              <code className="font-mono text-xs text-ink-faint">{f.key === "first_name" ? "{first_name|there}" : `{${f.key}}`}</code>
            </button>
          ))}
          <p className="border-t border-line px-3 pt-2 pb-1.5 text-xs text-ink-faint">
            Text after <code className="font-mono">|</code> is used when someone has no value, e.g. “Hi there”.
          </p>
        </div>
      )}
    </div>
  );
}

/** Which selected bots can't fill a placeholder, and what those people will see instead. */
function PersonalizationNotes({ text, bots }: { text: string; bots: Bot[] }) {
  const uses = placeholdersIn(text);
  const sources = useQueries({
    queries: uses.length
      ? bots.map((b) => ({ queryKey: ["bots", String(b.id), "source"], queryFn: () => api<BotSourceInfo>(`/bots/${b.id}/source`), staleTime: 60_000 }))
      : [],
  });
  if (!uses.length) return null;
  const notes: string[] = [];
  bots.forEach((b, i) => {
    const map = sources[i]?.data?.column_map as Record<string, string | null> | undefined;
    if (!map) return;
    for (const u of uses) {
      const has = u.field === "full_name" ? !!(map.first_name || map.last_name) : !!map[u.field];
      if (!has) {
        const label = FIELDS.find((f) => f.key === u.field)!.label.toLowerCase();
        notes.push(`@${b.username} has no ${label} mapped, so people there see ${u.fallback ? `“${u.fallback}”` : "nothing"} instead.`);
      }
    }
  });
  return (
    <div className="mt-2 space-y-1 text-sm">
      <p className="text-ink-soft">
        Personalized: each person sees their own {[...new Set(uses.map((u) => FIELDS.find((f) => f.key === u.field)!.label.toLowerCase()))].join(", ")}.
        {uses.some((u) => u.fallback === null) && " People with no value see nothing there; add a fallback like {first_name|there}."}
      </p>
      {[...new Set(notes)].map((n) => (
        <p key={n} className="text-accent-deep">{n}</p>
      ))}
    </div>
  );
}
