import { useQueryClient } from "@tanstack/react-query";
import { Bot, ChartColumn, Check, ChevronsUpDown, LayoutGrid, LogOut, Megaphone, Plus, Settings, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { ErrorBoundary } from "./errors";
import { api } from "../lib/api";
import { cx } from "../components/ui";
import { OrbitLogo } from "../components/brand";
import { useMe, useOrg } from "./auth";
import { setOrgId } from "../lib/org";

/** Modules register here as they ship. Only real, working sections appear. */
const NAV = [
  { to: "/", label: "Overview", icon: LayoutGrid, end: true },
  { to: "/bots", label: "Bots", icon: Bot },
  { to: "/people", label: "People", icon: Users },
  { to: "/broadcasts", label: "Broadcasts", icon: Megaphone },
  { to: "/analytics", label: "Analytics", icon: ChartColumn },
];

export function Shell() {
  const mainRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // Each page starts at the top (main keeps its own scroll position otherwise).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [pathname]);
  const qc = useQueryClient();

  async function signOut() {
    await api("/auth/logout", { method: "POST" });
    qc.clear();
    window.location.assign("/");
  }

  return (
    // Desktop: the window never scrolls, only <main> does, so the sidebar and any sticky
    // bars inside main can't drift. Phones keep normal page scrolling.
    <div className="min-h-screen md:grid md:h-dvh md:grid-cols-[232px_minmax(0,1fr)] md:overflow-hidden">
      <aside className="bg-panel text-panel-ink md:flex md:h-dvh md:flex-col md:overflow-y-auto md:overscroll-none">
        <div className="flex items-center justify-between px-5 py-4 md:py-6">
          <OrbitLogo tone="inverse" size={26} />
        </div>
        <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cx(
                  "relative flex shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-[15px] transition-colors",
                  isActive
                    ? "bg-white/[0.08] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] before:absolute before:top-2.5 before:bottom-2.5 before:-left-3 before:w-[3px] before:rounded-r before:bg-accent max-md:before:hidden"
                    : "text-panel-muted hover:text-panel-ink",
                )
              }
            >
              <Icon size={17} strokeWidth={1.75} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-white/10 p-3 md:mt-auto">
          <AccountMenu onSignOut={signOut} />
        </div>
      </aside>
      <main ref={mainRef} className="md:h-dvh md:overflow-y-auto md:overscroll-none">
        <div className="mx-auto w-full max-w-[1120px] px-4 py-8 sm:px-8 md:py-12">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}

const ROLE_LABEL = { owner: "Owner", admin: "Admin", sender: "Sender", viewer: "Viewer" } as const;

/** Bottom-left: who you are, which organization you're in, and everything account-related. */
function AccountMenu({ onSignOut }: { onSignOut: () => void }) {
  const me = useMe();
  const { org, orgs } = useOrg();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  if (!org) return null;

  const switchTo = (id: number) => {
    setOpen(false);
    if (id === org.id) return;
    setOrgId(id);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "me" });
    nav("/");
  };
  const go = (to: string) => {
    setOpen(false);
    nav(to);
  };
  const item = "flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-canvas";

  return (
    <div ref={ref} className="relative">
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-30 mb-2 w-full min-w-[220px] overflow-hidden rounded-lg border border-line bg-surface py-1 text-sm text-ink shadow-[0_-16px_40px_-16px_rgba(19,26,24,0.45)]">
          <div className="border-b border-line px-3 pt-1.5 pb-2">
            <p className="truncate font-medium">{me.data?.name || me.data?.email}</p>
            {me.data?.name && <p className="truncate text-xs text-ink-faint">{me.data.email}</p>}
          </div>
          <p className="px-3 pt-2 pb-1 text-xs text-ink-faint">Organizations</p>
          {orgs.map((o) => (
            <button key={o.id} role="menuitem" type="button" onClick={() => switchTo(o.id)} className={item}>
              <span className="min-w-0 flex-1 truncate">{o.name}</span>
              <span className="text-xs text-ink-faint">{ROLE_LABEL[o.role]}</span>
              <Check size={14} className={o.id === org.id ? "text-panel" : "invisible"} />
            </button>
          ))}
          <button role="menuitem" type="button" onClick={() => go("/settings?new=org")} className={`${item} text-ink-soft hover:text-ink`}>
            <Plus size={14} /> New organization
          </button>
          <div className="my-1 border-t border-line" />
          <button role="menuitem" type="button" onClick={() => go("/settings")} className={`${item} text-ink-soft hover:text-ink`}>
            <Settings size={14} /> Settings
          </button>
          <button role="menuitem" type="button" onClick={onSignOut} className={`${item} text-ink-soft hover:text-ink`}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      )}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-white/[0.08]"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.1] text-sm font-semibold text-white">
          {org.name.trim().charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-white">{org.name}</span>
          <span className="block truncate text-xs text-panel-muted">
            {ROLE_LABEL[org.role]} · {me.data?.email}
          </span>
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-panel-muted" />
      </button>
    </div>
  );
}
