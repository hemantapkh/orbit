import { useQueryClient } from "@tanstack/react-query";
import { Bot, LayoutGrid, LogOut, Megaphone } from "lucide-react";
import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { ErrorBoundary } from "./errors";
import { api } from "../lib/api";
import { cx } from "../components/ui";
import { OrbitLogo } from "../components/brand";
import { useMe } from "./auth";

/** Modules register here as they ship. Only real, working sections appear. */
const NAV = [
  { to: "/", label: "Overview", icon: LayoutGrid, end: true },
  { to: "/bots", label: "Bots", icon: Bot },
  { to: "/broadcasts", label: "Broadcasts", icon: Megaphone },
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
      <aside className="bg-panel text-panel-ink md:flex md:h-dvh md:flex-col md:overflow-y-auto md:overscroll-contain">
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
      <main ref={mainRef} className="md:h-dvh md:overflow-y-auto md:overscroll-contain">
        <div className="mx-auto w-full max-w-[1120px] px-4 py-8 sm:px-8 md:py-12">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
