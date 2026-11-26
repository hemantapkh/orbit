import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Pencil, Share2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useOrg } from "../../app/auth";
import { api, type CampaignDetail, type Delivery, type Media, type Page, type Progress, type RelatedSend } from "../../lib/api";
import { fmt, when } from "../../lib/format";
import { Button, buttonClass, CampaignStatusTag, cx, Dialog, Notice, PageHeader, Panel, Skeleton } from "../../components/ui";
import { ActivityList } from "../activity/ActivityList";
import { confirmDelete } from "./CampaignsPage";
import { DeliveryBar } from "./DeliveryBar";
import { ProgressInsights, StatusPanel } from "./Progress";
import { withSamples } from "../../lib/personalize";
import { MessagePreview } from "./MessagePreview";

export function CampaignDetailPage() {
  const { campaignId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const key = ["campaign", campaignId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<CampaignDetail>(`/campaigns/${campaignId}`),
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return s === "running" ? 3000 : s === "scheduled" ? 15000 : s === "paused" ? 15000 : false;
    },
  });
  const progress = useQuery({
    queryKey: ["campaign-progress", campaignId, q.data?.status],
    queryFn: () => api<Progress>(`/campaigns/${campaignId}/progress`),
    enabled: !!q.data && q.data.status !== "draft",
    refetchInterval: () => (q.data?.status === "running" ? 3000 : q.data?.status === "paused" ? 15000 : false),
  });
  const media = useQuery({
    queryKey: ["media", q.data?.message.media_id],
    queryFn: () => api<Media>(`/media/${q.data!.message.media_id}`),
    enabled: q.data?.message.media_id != null,
    staleTime: Infinity,
  });

  const act = useMutation({
    mutationFn: (action: string) => api<CampaignDetail>(`/campaigns/${campaignId}/${action}`, { method: "POST" }),
    onSuccess: (c, action) => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      if (action === "duplicate") nav(`/broadcasts/${c.id}/edit`);
      else if (action === "unschedule") nav(`/broadcasts/${c.id}/edit`);
      else qc.setQueryData(key, c);
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/campaigns/${campaignId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["campaigns"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      nav("/broadcasts");
    },
  });

  const [sharing, setSharing] = useState(false);
  const { can } = useOrg();

  if (q.isPending) return <Skeleton className="h-96" />;
  if (q.error) return <Notice>{q.error.message}</Notice>;
  const c = q.data;
  const s = c.stats;

  const actions = (
    <>
      {c.status === "draft" && (
        <>
          <Button variant="danger" onClick={() => confirmDelete(c) && remove.mutate()}>Delete</Button>
          <Link to={`/broadcasts/${c.id}/edit`} className={buttonClass("primary")}>Edit draft</Link>
        </>
      )}
      {c.status === "scheduled" && (
        <>
          <Button onClick={() => act.mutate("unschedule")}>Unschedule and edit</Button>
          <Button variant="danger" onClick={() => confirm("Cancel this scheduled broadcast?") && act.mutate("cancel")}>Cancel</Button>
        </>
      )}
      {c.status === "running" && <Button onClick={() => act.mutate("pause")}>Pause</Button>}
      {c.status === "paused" && <Button variant="primary" onClick={() => act.mutate("resume")}>Resume</Button>}
      {(c.status === "running" || c.status === "paused") && (
        <Button variant="danger" onClick={() => confirm("Stop this broadcast? Messages not yet sent will be skipped.") && act.mutate("cancel")}>
          Stop
        </Button>
      )}
      {c.status !== "draft" && (
        <Button onClick={() => setSharing(true)}>
          <Share2 size={15} /> {c.share ? "Shared" : "Share"}
        </Button>
      )}
      {c.status !== "draft" && c.status !== "running" && (
        <Button variant="danger" onClick={() => confirmDelete(c) && remove.mutate()}>Delete</Button>
      )}
      {c.status !== "draft" && (
        <Button variant={c.status === "completed" || c.status === "cancelled" ? "primary" : "secondary"} onClick={() => act.mutate("duplicate")}>
          Send again
        </Button>
      )}
    </>
  );

  return (
    <>
      <Link to="/broadcasts" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-soft hover:text-ink">
        <ArrowLeft size={15} /> Broadcasts
      </Link>
      <PageHeader
        title={can("sender") ? <EditableTitle campaignId={c.id} name={c.name} onSaved={(d) => qc.setQueryData(key, d)} /> : c.name}
        lede={
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <CampaignStatusTag status={c.status} />
            <span className="text-sm">
              {c.audience.mode === "selected"
                ? `To ${fmt(c.audience.recipients.length)} selected ${c.audience.recipients.length === 1 ? "person" : "people"}`
                : c.audience.kinds?.length
                  ? `To ${c.audience.kinds.join(" and ")} on the selected bots`
                  : "To everyone on the selected bots"}
            </span>
            {c.sends.length > 1 && (
              <span className="text-sm">
                Send {c.sends.findIndex((x) => x.id === c.id) + 1} of {c.sends.length} of this message
              </span>
            )}
          </span>
        }
        actions={can("sender") ? actions : undefined}
      />
      {(act.error ?? remove.error) && <div className="mb-6"><Notice>{(act.error ?? remove.error)!.message}</Notice></div>}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-8">
          <StatusPanel
            c={c}
            reach={c.audience.mode === "selected" ? c.audience.recipients.length : c.bots.reduce((n, b) => n + b.audience, 0)}
            progress={progress.data}
          />
          {progress.data && <ProgressInsights progress={progress.data} bots={c.bots} />}

          <section>
            <h2 className="mb-3 text-lg font-semibold">By bot</h2>
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[15px]">
                <thead className="border-b border-line text-sm text-ink-soft">
                  <tr>
                    <th className="px-5 py-3 font-medium">Bot</th>
                    <th className="w-[38%] px-5 py-3 font-medium">Progress</th>
                    <th className="px-5 py-3 text-right font-medium">Delivered</th>
                    <th className="px-5 py-3 text-right font-medium">Not delivered</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {c.bots.map((b) => (
                    <tr key={b.bot_id}>
                      <td className="px-5 py-3">
                        <Link to={`/bots/${b.bot_id}`} className="font-medium hover:underline">@{b.username}</Link>
                        {b.error && <p className="mt-0.5 max-w-[36ch] text-sm text-status-error">{b.error}</p>}
                      </td>
                      <td className="px-5 py-3">
                        {b.stats.total ? <DeliveryBar stats={b.stats} thin /> : <span className="text-sm text-ink-faint">{fmt(b.audience)} active now</span>}
                      </td>
                      <td className="px-5 py-3 text-right font-semibold">{fmt(b.stats.sent)}</td>
                      <td className="px-5 py-3 text-right text-ink-soft">{fmt(b.stats.failed + b.stats.blocked + b.stats.skipped)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </section>

          {s.failed + s.blocked > 0 && <Problems campaignId={c.id} bots={c.bots} />}

          {c.sends.length > 1 && <Sends current={c.id} sends={c.sends} bots={c.bots} />}

          <ActivityList entityType="campaign" entityId={c.id} />
        </div>

        <aside className="space-y-6 lg:sticky lg:top-8 lg:self-start">
          <section aria-label="Message">
            <h2 className="mb-3 text-lg font-semibold">Message</h2>
            <MessagePreview message={{ ...c.message, text: withSamples(c.message.text) }} media={media.data ?? null} />
          </section>
          <Panel className="divide-y divide-line text-sm">
            <Row k="Created" v={when(c.created_at)} />
            {c.scheduled_at && <Row k={c.started_at ? "Scheduled for" : "Sends at"} v={when(c.scheduled_at)} />}
            <Row k="Started" v={when(c.started_at)} />
            <Row k="Finished" v={when(c.finished_at)} />
          </Panel>
        </aside>
      </div>
      <ShareDialog
        open={sharing}
        onClose={() => setSharing(false)}
        c={c}
        onChange={(d) => {
          qc.setQueryData(key, d);
          qc.invalidateQueries({ queryKey: ["activity", "campaign", c.id] });
        }}
      />
    </>
  );
}

function Problems({ campaignId, bots }: { campaignId: number; bots: CampaignDetail["bots"] }) {
  const [status, setStatus] = useState<"failed" | "blocked">("failed");
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["deliveries", campaignId, status, offset],
    queryFn: () => api<Page<Delivery>>(`/campaigns/${campaignId}/deliveries?status=${status}&limit=50&offset=${offset}`),
  });
  const name = (id: number) => bots.find((b) => b.bot_id === id)?.username ?? id;
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="font-semibold">Undelivered messages</h2>
        <div className="flex rounded-lg bg-canvas p-1 text-sm ring-1 ring-line">
          {(["failed", "blocked"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => {
                setStatus(s);
                setOffset(0);
              }}
              className={cx("rounded-md px-3 py-1 font-medium transition-colors", status === s ? "bg-surface text-ink shadow-[0_1px_3px_rgba(23,33,30,0.12)]" : "text-ink-soft hover:text-ink")}
            >
              {s === "failed" ? "Failed" : "Blocked"}
            </button>
          ))}
        </div>
      </div>
      <Panel className="divide-y divide-line text-sm">
        {q.data?.items.length === 0 && <p className="px-5 py-4 text-ink-soft">None.</p>}
        {q.data?.items.map((d) => (
          <div key={d.id} className="grid gap-x-4 gap-y-0.5 px-5 py-3 sm:grid-cols-[120px_140px_minmax(0,1fr)]">
            <span className="text-ink-soft">@{name(d.bot_id)}</span>
            <span>Chat {d.chat_id}</span>
            <span className="text-ink-soft">{d.error}</span>
          </div>
        ))}
      </Panel>
      {q.data && q.data.total > 50 && (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" disabled={offset === 0} onClick={() => setOffset(offset - 50)}>Previous</Button>
          <Button size="sm" disabled={offset + 50 >= q.data.total} onClick={() => setOffset(offset + 50)}>Next</Button>
        </div>
      )}
    </section>
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

function Sends({ current, sends, bots }: { current: number; sends: RelatedSend[]; bots: CampaignDetail["bots"] }) {
  const name = (id: number) => bots.find((b) => b.bot_id === id)?.username ?? `bot ${id}`;
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">Every send of this message</h2>
      <Panel className="divide-y divide-line">
        {sends.map((x, i) => (
          <Link
            key={x.id}
            to={x.status === "draft" ? `/broadcasts/${x.id}/edit` : `/broadcasts/${x.id}`}
            aria-current={x.id === current ? "page" : undefined}
            className={cx(
              "grid gap-x-6 gap-y-1 px-5 py-3.5 text-sm hover:bg-canvas/70 sm:grid-cols-[60px_minmax(0,1fr)_120px_150px]",
              x.id === current && "bg-accent-wash/40",
            )}
          >
            <span className="font-medium">#{i + 1}</span>
            <span className="min-w-0 truncate text-ink-soft">
              {x.audience_mode === "selected" ? "Selected people" : "Everyone"} on{" "}
              {x.bot_ids.map((id) => `@${name(id)}`).join(", ") || "no bots"}
            </span>
            <CampaignStatusTag status={x.status} />
            <span className="text-right text-ink-soft">
              {x.stats.total ? `${fmt(x.stats.sent)} of ${fmt(x.stats.total)} delivered` : when(x.started_at ?? x.created_at)}
            </span>
          </Link>
        ))}
      </Panel>
    </section>
  );
}

/** The broadcast's name, editable in place at any stage. */
function EditableTitle({ campaignId, name, onSaved }: { campaignId: number; name: string; onSaved: (d: CampaignDetail) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const save = useMutation({
    mutationFn: (n: string) => api<CampaignDetail>(`/campaigns/${campaignId}`, { method: "PATCH", json: { name: n } }),
    onSuccess: (d) => {
      onSaved(d);
      setEditing(false);
    },
  });
  const commit = () => {
    const n = value.trim();
    if (!n || n === name) {
      setValue(name);
      setEditing(false);
      return;
    }
    save.mutate(n);
  };
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(name);
          setEditing(true);
        }}
        className="group -mx-1 inline-flex max-w-full items-center gap-2 rounded-md px-1 text-left hover:bg-line/50"
        title="Rename"
      >
        <span className="truncate">{name}</span>
        <Pencil size={16} className="shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
        <span className="sr-only">Rename</span>
      </button>
    );
  }
  return (
    <span className="block">
      <input
        autoFocus
        aria-label="Broadcast name"
        value={value}
        maxLength={160}
        disabled={save.isPending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setValue(name);
            setEditing(false);
          }
        }}
        className="-mx-1 w-full rounded-md bg-surface px-1 font-semibold shadow-[0_0_0_4px_rgba(184,145,58,0.16)] outline-none"
      />
      {save.error && <span className="mt-1 block text-sm font-normal text-status-error">{save.error.message}</span>}
    </span>
  );
}

function ShareDialog({
  open,
  onClose,
  c,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  c: CampaignDetail;
  onChange: (d: CampaignDetail) => void;
}) {
  const [hide, setHide] = useState(c.share?.hide_message ?? false);
  const [copied, setCopied] = useState(false);
  const update = useMutation({
    mutationFn: (body: { hide_message: boolean; regenerate?: boolean }) =>
      api<CampaignDetail>(`/campaigns/${c.id}/share`, { method: "PUT", json: body }),
    onSuccess: onChange,
  });
  const stop = useMutation({
    mutationFn: () => api<CampaignDetail>(`/campaigns/${c.id}/share`, { method: "DELETE" }),
    onSuccess: onChange,
  });
  const url = c.share ? `${window.location.origin}/share/${c.share.token}` : null;
  const error = update.error ?? stop.error;

  return (
    <Dialog open={open} onClose={onClose} title="Share a read-only view">
      <div className="space-y-5">
        <p className="text-sm text-ink-soft">
          Anyone with the link can watch progress and results, live. They can't pause, edit or send anything,
          and never see who it went to: no names, usernames or Telegram IDs.
        </p>
        {error && <Notice>{error.message}</Notice>}
        <label className="flex cursor-pointer items-start gap-3 text-[15px]">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-[#17332c]"
            checked={hide}
            onChange={(e) => {
              setHide(e.target.checked);
              if (c.share) update.mutate({ hide_message: e.target.checked });
            }}
          />
          <span>
            Hide the message itself
            <span className="block text-sm text-ink-faint">Viewers see the numbers only. Useful before a scheduled send.</span>
          </span>
        </label>

        {url ? (
          <>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas py-1.5 pr-1.5 pl-3">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">{url}</code>
              <Button
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
            <div className="flex flex-wrap justify-between gap-2 border-t border-line pt-4">
              <Button
                variant="ghost"
                onClick={() => confirm("Replace the link? The current one stops working immediately.") && update.mutate({ hide_message: hide, regenerate: true })}
                disabled={update.isPending}
              >
                Replace link
              </Button>
              <Button variant="danger" onClick={() => stop.mutate()} disabled={stop.isPending}>
                Stop sharing
              </Button>
            </div>
          </>
        ) : (
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => update.mutate({ hide_message: hide })} disabled={update.isPending}>
              {update.isPending ? "Creating…" : "Create link"}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
