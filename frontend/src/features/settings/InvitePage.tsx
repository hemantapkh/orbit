import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { OrbitLoading, OrbitLogo, OrbitMark } from "../../components/brand";
import { Button, Field, Input, Notice } from "../../components/ui";
import { type Admin, api, ApiError, type InvitePreview } from "../../lib/api";
import { setOrgId } from "../../lib/org";

const ROLE = { owner: "an owner", admin: "an admin", sender: "a sender", viewer: "a viewer" } as const;

/** Public: accept an invite. New people set a password; existing accounts sign in first. */
export function InvitePage() {
  const { token } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<InvitePreview>(`/invites/${token}`),
    retry: false,
  });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Admin>("/auth/me"), retry: false });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (invite.isPending || me.isPending) return <OrbitLoading label="Opening invite" />;
  if (invite.error) {
    return (
      <Centered>
        <OrbitMark size={40} tone="mono" className="mx-auto text-line-strong" />
        <h1 className="mt-5 text-center text-xl font-semibold">This invite can't be used</h1>
        <p className="mt-2 text-center text-ink-soft">It may have expired, been used already, or been revoked. Ask for a new link.</p>
      </Centered>
    );
  }
  const inv = invite.data;
  const signedInAs = me.data?.email;
  const rightAccount = signedInAs === inv.email;

  async function accept(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (inv.has_account && !rightAccount) {
        await api("/auth/login", { method: "POST", json: { email: inv.email, password } });
      }
      const r = await api<{ org_id: number }>(`/invites/${token}/accept`, {
        method: "POST",
        json: inv.has_account ? {} : { name, password },
      });
      setOrgId(r.org_id);
      qc.clear();
      nav("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Centered>
      <OrbitLogo />
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Join {inv.org_name}</h1>
      <p className="mt-2 text-ink-soft">
        You've been invited as {ROLE[inv.role]} for <strong className="text-ink">{inv.email}</strong>.
      </p>
      <div className="mt-6 space-y-5">
        {error && <Notice>{error}</Notice>}
        {rightAccount ? (
          <Button variant="primary" className="w-full" onClick={() => accept()} disabled={busy}>
            {busy ? "Joining…" : `Join ${inv.org_name}`}
          </Button>
        ) : inv.has_account ? (
          <form onSubmit={accept} className="space-y-5">
            {signedInAs && <Notice tone="info">You're signed in as {signedInAs}. Sign in as {inv.email} to accept.</Notice>}
            <Field label={`Password for ${inv.email}`} htmlFor="pw">
              <Input id="pw" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" className="w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in and join"}
            </Button>
          </form>
        ) : (
          <form onSubmit={accept} className="space-y-5">
            <Field label="Your name" htmlFor="name" hint="Shown to other members.">
              <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Choose a password" htmlFor="pw" hint="At least 10 characters.">
              <Input id="pw" type="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" className="w-full" disabled={busy || password.length < 10}>
              {busy ? "Creating your account…" : "Create account and join"}
            </Button>
          </form>
        )}
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
