import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bold, Code, Italic, Link2, Paperclip, Plus, Strikethrough, Trash2, Underline } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  api,
  type Audience,
  type Bot,
  type CampaignDetail,
  emptyMessage,
  type Media,
  type MessageContent,
} from "../../lib/api";
import { fmt, toLocalInput, when } from "../../lib/format";
import { Button, cx, Dialog, fieldClass, Field, Input, Notice, PageHeader, Panel, Skeleton, Textarea } from "../../components/ui";
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
      <PageHeader
        title={id ? "Edit broadcast" : "New broadcast"}
        lede={editingScheduled ? `Scheduled for ${when(initial!.scheduled_at)}. Changes apply to that send.` : undefined}
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-8">
          <Field label="Name" htmlFor="name" hint="Only you and other operators see this.">
            <Input id="name" placeholder="November product update" value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Section
            title="Audience"
            aside={
              botIds.length > 0 &&
              (picking ? `${fmt(reachCount)} ${reachCount === 1 ? "person" : "people"} picked` : `${fmt(reachCount)} active subscribers`)
            }
          >
            {bots.length === 0 ? (
              <p className="text-ink-soft">
                No bots connected. <Link to="/bots" className="underline underline-offset-4">Connect one</Link> first.
              </p>
            ) : (
              <>
                <div className="mb-2 flex gap-3 text-sm">
                  <button type="button" className="text-ink-soft hover:text-ink" onClick={() => setBotIds(usable.map((b) => b.id))}>
                    Select all
                  </button>
                  <button type="button" className="text-ink-soft hover:text-ink" onClick={() => setBotIds([])}>
                    Clear
                  </button>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {bots.map((b) => {
                    const disabled = !b.is_active || !b.token_valid;
                    const on = botIds.includes(b.id);
                    return (
                      <label
                        key={b.id}
                        className={cx(
                          "flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-3 transition-[border-color,box-shadow,background-color]",
                          on
                            ? "border-panel/60 bg-panel/[0.035] shadow-[0_0_0_3px_rgba(30,58,51,0.08)]"
                            : "border-line bg-surface hover:border-line-strong",
                          disabled && "cursor-not-allowed opacity-55",
                        )}
                      >
                        <input
                          type="checkbox"
                          className="size-4 accent-[#1e3a33]"
                          checked={on}
                          disabled={disabled && !on}
                          onChange={() => toggleBot(b.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{b.display_name}</span>
                          <span className="block truncate text-sm text-ink-faint">
                            @{b.username}
                            {disabled && (b.is_active ? " · token rejected" : " · disabled")}
                          </span>
                        </span>
                        <span className="text-sm font-semibold">{fmt(b.subscribers.active)}</span>
                      </label>
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
            <Composer value={message.text} onChange={(text) => patch({ text })} html={message.parse_mode === "HTML"} />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm">
              <label className="flex items-center gap-2 text-ink-soft">
                Formatting
                <select
                  className={`${fieldClass} h-9 w-auto`}
                  value={message.parse_mode ?? "none"}
                  onChange={(e) => patch({ parse_mode: e.target.value === "none" ? null : (e.target.value as "HTML") })}
                >
                  <option value="HTML">HTML</option>
                  <option value="MarkdownV2">MarkdownV2</option>
                  <option value="none">Plain text</option>
                </select>
              </label>
              <span className={tooLong ? "font-medium text-status-error" : "text-ink-faint"}>
                {fmt(message.text.length)} / {fmt(limit)}
                {message.media_id != null && " (caption)"}
              </span>
            </div>
          </Section>

          <Section title="Buttons" aside="Link buttons shown under the message">
            <ButtonsEditor value={message.buttons} onChange={(buttons) => patch({ buttons })} />
          </Section>

          <Section title="Delivery options">
            <div className="space-y-3">
              <Toggle checked={message.silent} onChange={(silent) => patch({ silent })} label="Send silently" hint="Arrives without a notification sound." />
              <Toggle checked={message.disable_link_preview} onChange={(v) => patch({ disable_link_preview: v })} label="Hide link previews" hint="Applies to text-only messages." />
              <Toggle checked={message.protect_content} onChange={(v) => patch({ protect_content: v })} label="Protect content" hint="Recipients can't forward or save it." />
            </div>
          </Section>
        </div>

        <aside className="space-y-6 lg:sticky lg:top-8 lg:self-start">
          <MessagePreview message={message} media={media.data ?? null} botName={selected[0] ? `@${selected[0].username}` : undefined} />
          <TestSend bots={selected.length ? selected : usable} message={message} disabled={isEmpty || tooLong} />
        </aside>
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 mt-10 border-t border-line bg-canvas/95 px-4 py-4 backdrop-blur sm:-mx-8 sm:px-8">
        {save.error && <div className="mb-3"><Notice>{save.error.message}</Notice></div>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-ink-faint">{savedAt ? `Saved ${savedAt.toLocaleTimeString()}` : "Not saved yet"}</span>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save draft"}
            </Button>
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
    <section>
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="font-semibold">{title}</h2>
        {aside && <span className="text-sm text-ink-soft">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Composer({ value, onChange, html }: { value: string; onChange: (v: string) => void; html: boolean }) {
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
    if (url && /^(https?|tg):\/\//.test(url)) wrap(`<a href="${url.replace(/"/g, "&quot;")}">`, "</a>");
  }

  const tools: [typeof Bold, string, () => void][] = [
    [Bold, "Bold", () => wrap("<b>", "</b>")],
    [Italic, "Italic", () => wrap("<i>", "</i>")],
    [Underline, "Underline", () => wrap("<u>", "</u>")],
    [Strikethrough, "Strikethrough", () => wrap("<s>", "</s>")],
    [Code, "Code", () => wrap("<code>", "</code>")],
    [Link2, "Link", link],
  ];

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-[0_1px_2px_rgba(23,33,30,0.04)] transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_4px_rgba(184,145,58,0.16)]">
      {html && (
        <div className="flex gap-0.5 border-b border-line px-1.5 py-1">
          {tools.map(([Icon, label, fn]) => (
            <button key={label} type="button" onClick={fn} title={label} aria-label={label} className="rounded p-1.5 text-ink-soft hover:bg-line/60 hover:text-ink">
              <Icon size={16} />
            </button>
          ))}
        </div>
      )}
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

const TEST_CHAT_KEY = "orbit.testChatId";

function TestSend({ bots, message, disabled }: { bots: Bot[]; message: MessageContent; disabled: boolean }) {
  const [botId, setBotId] = useState<number | null>(bots[0]?.id ?? null);
  const [chatId, setChatId] = useState(() => {
    try {
      return localStorage.getItem(TEST_CHAT_KEY) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    if (!bots.some((b) => b.id === botId)) setBotId(bots[0]?.id ?? null);
  }, [bots, botId]);

  const send = useMutation({
    mutationFn: () => {
      try {
        localStorage.setItem(TEST_CHAT_KEY, chatId);
      } catch {
        /* storage unavailable */
      }
      return api(`/campaigns/test-send`, { method: "POST", json: { bot_id: botId, chat_id: Number(chatId), message } });
    },
  });

  if (!bots.length) return null;
  return (
    <Panel className="space-y-3 p-4">
      <h2 className="font-semibold">Send a test</h2>
      <p className="text-sm text-ink-soft">Deliver this message to one chat, usually your own, before it goes to everyone.</p>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <select
          aria-label="Bot to send from"
          className={`${fieldClass} h-10`}
          value={botId ?? ""}
          onChange={(e) => setBotId(Number(e.target.value))}
        >
          {bots.map((b) => (
            <option key={b.id} value={b.id}>@{b.username}</option>
          ))}
        </select>
        <Input aria-label="Your Telegram user ID" placeholder="Your user ID" inputMode="numeric" value={chatId} onChange={(e) => setChatId(e.target.value.trim())} />
      </div>
      <Button className="w-full" onClick={() => send.mutate()} disabled={disabled || !botId || !/^-?\d+$/.test(chatId) || send.isPending}>
        {send.isPending ? "Sending…" : "Send test"}
      </Button>
      {send.isSuccess && <Notice tone="info">Test sent. Check Telegram.</Notice>}
      {send.error && <Notice>{send.error.message}</Notice>}
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
