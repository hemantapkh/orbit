import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMe, useOrg } from "../../app/auth";
import { api, type OrgInvite, type OrgMember, type OrgMembership } from "../../lib/api";
import { when } from "../../lib/format";
import { setOrgId } from "../../lib/org";
import { Button, Dialog, Field, fieldClass, Input, Notice, PageHeader, Panel } from "../../components/ui";

type Role = OrgMembership["role"];
const ROLES: { value: Role; label: string; help: string }[] = [
  { value: "viewer", label: "Viewer", help: "Sees dashboards, broadcasts and analytics. Can't change anything." },
  { value: "sender", label: "Sender", help: "Creates, tests and sends broadcasts." },
  { value: "admin", label: "Admin", help: "Also manages bots, bot databases and members." },
  { value: "owner", label: "Owner", help: "Everything, including owners and the organization itself." },
];
const roleLabel = (r: Role) => ROLES.find((x) => x.value === r)!.label;

export function SettingsPage() {
  const { org, can } = useOrg();
  const [params, setParams] = useSearchParams();
  if (!org) return null;
  return (
    <div className="max-w-[880px]">
      <PageHeader title="Settings" lede={`${org.name} · your role: ${roleLabel(org.role)}`} />
      <div className="space-y-10">
        <OrganizationSection />
        <MembersSection />
        {can("admin") && <InvitesSection />}
        <AccountSection />
      </div>
      <NewOrgDialog open={params.get("new") === "org"} onClose={() => setParams({}, { replace: true })} />
    </div>
  );
}

function Section({ title, lede, children }: { title: string; lede?: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold">{title}</h2>
      {lede && <p className="mt-0.5 mb-3 text-sm text-ink-soft">{lede}</p>}
      <div className={lede ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

function OrganizationSection() {
  const { org, can } = useOrg();
  const qc = useQueryClient();
  const [name, setName] = useState(org!.name);
  const rename = useMutation({
    mutationFn: () => api(`/orgs/current`, { method: "PATCH", json: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  return (
    <Section title="Organization" lede="Bots, broadcasts, test groups and analytics all belong to it. Members only see this organization's data.">
      <Panel className="p-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            rename.mutate();
          }}
        >
          <div className="min-w-[240px] flex-1">
            <Field label="Name" htmlFor="org-name">
              <Input id="org-name" value={name} maxLength={120} disabled={!can("owner")} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          {can("owner") && (
            <Button type="submit" disabled={rename.isPending || !name.trim() || name.trim() === org!.name}>
              {rename.isSuccess && name.trim() === org!.name ? "Saved" : "Rename"}
            </Button>
          )}
        </form>
        {rename.error && <div className="mt-3"><Notice>{rename.error.message}</Notice></div>}
        {!can("owner") && <p className="mt-2 text-sm text-ink-faint">Only owners can rename the organization.</p>}
      </Panel>
    </Section>
  );
}

function MembersSection() {
  const { org, can } = useOrg();
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const list = useQuery({ queryKey: ["members"], queryFn: () => api<OrgMember[]>("/orgs/current/members") });
  const change = useMutation({
    mutationFn: ({ id, role }: { id: number; role: Role }) => api<OrgMember[]>(`/orgs/current/members/${id}`, { method: "PATCH", json: { role } }),
    onSuccess: (m) => {
      qc.setQueryData(["members"], m);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/orgs/current/members/${id}`, { method: "DELETE" }),
    onSuccess: (_, id) => {
      if (id === me.data?.id) {
        // You left: go to another organization (or the "no organization" screen).
        setOrgId(null);
        qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
        qc.invalidateQueries({ queryKey: ["me"] });
        nav("/");
      } else qc.invalidateQueries({ queryKey: ["members"] });
    },
  });
  const error = change.error ?? remove.error ?? list.error;
  const isOwner = can("owner");

  return (
    <Section title="Members" lede="Roles decide what each person can do in this organization.">
      {error && <div className="mb-3"><Notice>{error.message}</Notice></div>}
      <Panel className="divide-y divide-line">
        {list.data?.map((m) => {
          const self = m.user_id === me.data?.id;
          // Admins manage everyone except owners; only owners touch owners.
          const editable = can("admin") && !self && (isOwner || m.role !== "owner");
          return (
            <div key={m.user_id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {m.name || m.email}
                  {self && <span className="ml-2 text-sm font-normal text-ink-faint">you</span>}
                </p>
                <p className="truncate text-sm text-ink-faint">
                  {m.name && `${m.email} · `}joined {when(m.joined_at)}
                </p>
              </div>
              {editable ? (
                <select
                  aria-label={`Role for ${m.email}`}
                  className={`${fieldClass} h-9 w-auto text-sm`}
                  value={m.role}
                  onChange={(e) => change.mutate({ id: m.user_id, role: e.target.value as Role })}
                >
                  {ROLES.filter((r) => isOwner || r.value !== "owner").map((r) => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-ink-soft">{roleLabel(m.role)}</span>
              )}
              {(editable || self) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    confirm(self ? `Leave ${org!.name}? You'll lose access until someone invites you again.` : `Remove ${m.email} from ${org!.name}?`) &&
                    remove.mutate(m.user_id)
                  }
                >
                  {self ? "Leave" : "Remove"}
                </Button>
              )}
            </div>
          );
        })}
      </Panel>
      <ul className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {ROLES.map((r) => (
          <li key={r.value}>
            <span className="font-medium">{r.label}</span> <span className="text-ink-faint">— {r.help}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function InvitesSection() {
  const { can } = useOrg();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("sender");
  const [created, setCreated] = useState<OrgInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = useQuery({ queryKey: ["invites"], queryFn: () => api<OrgInvite[]>("/orgs/current/invites") });
  const invite = useMutation({
    mutationFn: () => api<OrgInvite>("/orgs/current/invites", { method: "POST", json: { email, role } }),
    onSuccess: (i) => {
      setCreated(i);
      setEmail("");
      qc.invalidateQueries({ queryKey: ["invites"] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api(`/orgs/current/invites/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invites"] }),
  });
  const link = created?.token ? `${window.location.origin}/invite/${created.token}` : null;

  return (
    <Section title="Invite people" lede="Create a one-time link and send it however you like. It works for 7 days; they choose their own password.">
      <Panel className="space-y-4 p-5">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setCreated(null);
            invite.mutate();
          }}
        >
          <div className="min-w-[220px] flex-1">
            <Field label="Email" htmlFor="inv-email">
              <Input id="inv-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </div>
          <div>
            <Field label="Role" htmlFor="inv-role">
              <select id="inv-role" className={`${fieldClass} h-10 w-auto`} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {ROLES.filter((r) => can("owner") || r.value !== "owner").map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </Field>
          </div>
          <Button type="submit" variant="primary" disabled={invite.isPending}>
            {invite.isPending ? "Creating…" : "Create invite link"}
          </Button>
        </form>
        {invite.error && <Notice>{invite.error.message}</Notice>}
        {link && (
          <div className="space-y-2">
            <Notice tone="info">Copy this link now: for security it isn't shown again. Send it only to {created!.email}.</Notice>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas py-1.5 pr-1.5 pl-3">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">{link}</code>
              <Button
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy link"}
              </Button>
            </div>
          </div>
        )}
      </Panel>
      {!!pending.data?.length && (
        <Panel className="mt-3 divide-y divide-line">
          {pending.data.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">{i.email}</span>
              <span className="text-ink-soft">{roleLabel(i.role)}</span>
              <span className="text-ink-faint">expires {when(i.expires_at)}</span>
              <Button size="sm" variant="ghost" aria-label={`Revoke invite for ${i.email}`} onClick={() => revoke.mutate(i.id)}>
                <Trash2 size={14} /> Revoke
              </Button>
            </div>
          ))}
        </Panel>
      )}
    </Section>
  );
}

function AccountSection() {
  const me = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState(me.data?.name ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const saveName = useMutation({
    mutationFn: () => api("/auth/me", { method: "PATCH", json: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
  const password = useMutation({
    mutationFn: () => api("/auth/password", { method: "POST", json: { current_password: current, new_password: next } }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
    },
  });
  return (
    <Section title="Your account" lede={me.data?.email}>
      <div className="grid gap-4 md:grid-cols-2">
        <Panel className="p-5">
          <form
            className="space-y-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              saveName.mutate();
            }}
          >
            <Field label="Your name" htmlFor="me-name" hint="Shown to other members and in activity logs.">
              <Input id="me-name" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button type="submit" disabled={saveName.isPending || name === (me.data?.name ?? "")}>
              {saveName.isSuccess && name === me.data?.name ? "Saved" : "Save name"}
            </Button>
          </form>
        </Panel>
        <Panel className="p-5">
          <form
            className="space-y-4"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              password.mutate();
            }}
          >
            <Field label="Current password" htmlFor="pw-cur">
              <Input id="pw-cur" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label="New password" htmlFor="pw-new" hint="At least 10 characters.">
              <Input id="pw-new" type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            {password.error && <Notice>{password.error.message}</Notice>}
            {password.isSuccess && <Notice tone="info">Password changed.</Notice>}
            <Button type="submit" disabled={password.isPending || next.length < 10 || !current}>
              Change password
            </Button>
          </form>
        </Panel>
      </div>
    </Section>
  );
}

function NewOrgDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api<{ id: number }>("/orgs", { method: "POST", json: { name } }),
    onSuccess: async (o) => {
      setOrgId(o.id);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
      await qc.invalidateQueries({ queryKey: ["me"] });
      setName("");
      onClose();
      nav("/bots");
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="New organization">
      <form
        className="space-y-5"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <p className="text-sm text-ink-soft">A separate space with its own bots, broadcasts and members. You'll be its owner.</p>
        {create.error && <Notice>{create.error.message}</Notice>}
        <Field label="Name" htmlFor="new-org">
          <Input id="new-org" autoFocus required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>Create organization</Button>
        </div>
      </form>
    </Dialog>
  );
}
