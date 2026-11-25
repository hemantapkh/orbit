const num = new Intl.NumberFormat();
export const fmt = (n: number) => num.format(n);

export function pct(part: number, whole: number) {
  if (!whole) return "0%";
  const p = (part / whole) * 100;
  return `${p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)}%`;
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
export const when = (iso: string | null) => (iso ? dateTime.format(new Date(iso)) : "—");

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function ago(iso: string | null) {
  if (!iso) return "never";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(Math.round(s), "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
}

/** Value for <input type="datetime-local"> in the viewer's timezone. */
export function toLocalInput(d: Date) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
