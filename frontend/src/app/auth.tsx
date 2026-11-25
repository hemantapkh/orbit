import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { type Admin, api, ApiError } from "../lib/api";
import { atLeast, getOrgId, type Role, setOrgId } from "../lib/org";
import { OrbitLoading, OrbitLogo, OrbitMark } from "../components/brand";
import { Button, Field, Input, Notice } from "../components/ui";

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api<Admin>("/auth/me"),
    retry: (n, err) => !(err instanceof ApiError && err.status === 401) && n < 2,
    staleTime: 5 * 60_000,
  });
}

/** The organization you're working in, and your role there. */
export function useOrg() {
  const me = useMe();
  const orgs = me.data?.orgs ?? [];
  const current = orgs.find((o) => o.id === getOrgId()) ?? orgs[0] ?? null;
  return {
    org: current,
    orgs,
    role: current?.role,
    can: (min: Role) => atLeast(current?.role, min),
  };
}

export function RequireOperator({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) return <OrbitLoading />;
  if (me.error instanceof ApiError && me.error.status === 401) return <SignIn />;
  if (me.error) return <ServiceDown message={me.error.message} />;
  const orgs = me.data.orgs;
  if (!orgs.length) return <NoOrganization />;
  // Keep the remembered organization only if you're still a member of it.
  if (!orgs.some((o) => o.id === getOrgId())) setOrgId(orgs[0].id);
  return <>{children}</>;
}

function NoOrganization() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const org = await api<{ id: number }>("/orgs", { method: "POST", json: { name } });
      setOrgId(org.id);
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create it");
    }
  }
  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4">
      <form onSubmit={create} className="w-full max-w-sm space-y-5">
        <OrbitLogo />
        <h1 className="text-xl font-semibold">You're not in an organization yet</h1>
        <p className="text-ink-soft">Ask someone to invite you, or start your own.</p>
        {error && <Notice>{error}</Notice>}
        <Field label="Organization name" htmlFor="orgname">
          <Input id="orgname" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full">Create organization</Button>
      </form>
    </div>
  );
}

function SignIn() {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api<Admin>("/auth/login", { method: "POST", json: { email, password } });
      qc.setQueryData(["me"], me);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="relative hidden overflow-hidden bg-panel p-12 text-panel-ink md:flex md:flex-col md:justify-between">
        <OrbitLogo tone="inverse" />
        <OrbitMark size={440} tone="inverse" className="pointer-events-none absolute -right-28 -bottom-28 opacity-[0.07]" />
        <div className="relative">
          <p className="text-[34px] leading-[1.1] font-semibold tracking-[-0.025em] text-white">
            Everything connected.
            <br />
            One place.
          </p>
          <p className="mt-4 max-w-[38ch] text-panel-muted">
            Manage your Telegram bots, their subscribers and every broadcast from one console.
          </p>
        </div>
      </div>
      <div className="flex items-center justify-center px-4 py-16">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5">
          <div className="md:hidden"><OrbitLogo /></div>
          <h1 className="text-2xl font-semibold tracking-tight">Sign in to Orbit</h1>
          <p className="-mt-3 text-ink-soft">Use your operator account.</p>
          {error && <Notice>{error}</Notice>}
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" htmlFor="password">
            <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" className="w-full" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}

function ServiceDown({ message }: { message: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4">
      <div className="max-w-sm text-center">
        <OrbitMark size={40} tone="mono" className="mx-auto text-ink-faint" />
        <h1 className="mt-5 text-xl font-semibold">Orbit can't reach its server</h1>
        <p className="mt-2 text-ink-soft">{message}. Check that the API is running, then try again.</p>
        <Button className="mt-6" variant="primary" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    </div>
  );
}
