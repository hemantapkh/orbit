/** The organization the console is working in. Sent to the API as X-Org-Id. */
const KEY = "orbit.org";
let current: number | null = (() => {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
})();

export const getOrgId = () => current;

export function setOrgId(id: number | null) {
  current = id;
  try {
    if (id) localStorage.setItem(KEY, String(id));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: still works for this tab */
  }
}

export type Role = "viewer" | "sender" | "admin" | "owner";
const RANK: Record<Role, number> = { viewer: 0, sender: 1, admin: 2, owner: 3 };
export const atLeast = (role: string | undefined, min: Role) => !!role && RANK[role as Role] >= RANK[min];
