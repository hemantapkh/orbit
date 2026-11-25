import type { DeliveryStats } from "../../lib/api";
import { cx } from "../../components/ui";

export function DeliveryBar({ stats, thin }: { stats: DeliveryStats; thin?: boolean }) {
  const segs: [number, string][] = [
    [stats.sent, "bg-status-ok"],
    [stats.blocked, "bg-status-error/70"],
    [stats.failed, "bg-status-error"],
    [stats.skipped, "bg-line-strong"],
    [stats.pending, "bg-transparent"],
  ];
  return (
    <div
      className={cx("flex overflow-hidden rounded-full bg-line/70", thin ? "h-1.5" : "h-3")}
      role="img"
      aria-label={`${stats.sent} delivered, ${stats.blocked} blocked, ${stats.failed} failed, ${stats.pending} waiting`}
    >
      {segs.map(([n, cls], i) =>
        n > 0 ? <span key={i} className={cx(cls, "transition-[flex-grow] duration-500")} style={{ flexGrow: n }} /> : null,
      )}
    </div>
  );
}
