import { useQueryClient } from "@tanstack/react-query";
import { Bot, Building2, ChartColumn, Check, ChevronsUpDown, LayoutGrid, LogOut, Megaphone, Plus, Settings } from "lucide-react";
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
  { to: "/broadcasts", label: "Broadcasts", icon: Megaphone },
  { to: "/analytics", label: "Analytics", icon: ChartColumn },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Shell() {
  const me = useMe();
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
        <div className="flex items-center justify-between px-5 pt-4 pb-2 md:pt-6">
          <OrbitLogo tone="inverse" size={26} />
        </div>
        <OrgSwitcher />
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
        <div className="mt-auto hidden border-t border-white/10 px-5 py-4 md:block">
          <p className="truncate text-sm text-panel-ink">{me.data?.name || me.data?.email}</p>
          <p className="truncate text-xs text-panel-muted">{me.data?.email}</p>
          <button
            type="button"
            onClick={signOut}
            className="mt-3 inline-flex items-center gap-2 text-sm text-panel-muted hover:text-panel-ink"
          >
            <LogOut size={15} /> Sign out
          </button>
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

/** Which organization you're working in. Switching reloads everything for that org. */
function OrgSwitcher() {
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

  return (
    <div ref={ref} className="relative px-3 pb-3">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-lg bg-white/[0.06] px-3 py-2 text-left ring-1 ring-white/10 hover:bg-white/[0.1]"
      >
        <Building2 size={16} className="shrink-0 text-panel-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-white">{org.name}</span>
          <span className="block text-xs text-panel-muted">{ROLE_LABEL[org.role]}</span>
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-panel-muted" />
      </button>
      {open && (
        <div role="menu" className="absolute right-3 left-3 z-30 mt-1.5 overflow-hidden rounded-lg border border-line bg-surface py-1 text-sm text-ink shadow-[0_16px_40px_-16px_rgba(19,26,24,0.45)]">
          <p className="px-3 pt-1.5 pb-1 text-xs text-ink-faint">Organizations</p>
          {orgs.map((o) => (
            <button key={o.id} role="menuitem" type="button" onClick={() => switchTo(o.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-canvas">
              <span className="min-w-0 flex-1 truncate">{o.name}</span>
              <span className="text-xs text-ink-faint">{ROLE_LABEL[o.role]}</span>
              <Check size={14} className={o.id === org.id ? "text-panel" : "invisible"} />
            </button>
          ))}
          <div className="my-1 border-t border-line" />
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              nav("/settings?new=org");
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-ink-soft hover:bg-canvas hover:text-ink"
          >
            <Plus size={14} /> New organization
          </button>
        </div>
      )}
    </div>
  );
}
