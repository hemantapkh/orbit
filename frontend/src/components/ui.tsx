import { X } from "lucide-react";
import { type ButtonHTMLAttributes, type ComponentProps, type ReactNode, useEffect, useRef } from "react";
import type { CampaignStatus } from "../lib/api";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variants: Record<Variant, string> = {
  primary:
    "bg-panel text-white shadow-[0_1px_2px_rgba(23,33,30,0.2),inset_0_1px_0_rgba(255,255,255,0.08)] hover:bg-panel-deep disabled:bg-line-strong disabled:text-surface disabled:shadow-none",
  secondary:
    "bg-surface text-ink border border-line shadow-[0_1px_2px_rgba(23,33,30,0.05)] hover:border-line-strong hover:bg-canvas/60 disabled:text-ink-faint",
  ghost: "text-ink-soft hover:text-ink hover:bg-line/60",
  danger: "bg-surface text-status-error border border-status-error/40 hover:bg-status-error/5",
};

export const buttonClass = (variant: Variant = "secondary", size: "sm" | "md" = "md") =>
  cx(
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-[background-color,border-color,box-shadow] duration-150 disabled:cursor-not-allowed",
    size === "sm" ? "h-8 px-3 text-sm" : "h-10 px-4 text-[15px]",
    variants[variant],
  );

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return <button type="button" {...props} className={cx(buttonClass(variant, size), className)} />;
}

export type StatusColor = "green" | "amber" | "red" | "blue" | "off";
const statusColors: Record<StatusColor, string> = {
  green: "bg-status-ok text-status-ok",
  amber: "bg-status-busy text-status-busy",
  red: "bg-status-error text-status-error",
  blue: "bg-status-info text-status-info",
  off: "bg-status-off text-status-off",
};

/** Status dot: the one recurring status signal across Orbit. */
export function StatusDot({ color, live, label }: { color: StatusColor; live?: boolean; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cx("inline-block size-2.5 shrink-0 rounded-full", statusColors[color], live && "status-live")}
    />
  );
}

const campaignDot: Record<CampaignStatus, { color: StatusColor; label: string; live?: boolean }> = {
  draft: { color: "off", label: "Draft" },
  scheduled: { color: "blue", label: "Scheduled" },
  running: { color: "amber", label: "Sending", live: true },
  paused: { color: "amber", label: "Paused" },
  completed: { color: "green", label: "Delivered" },
  cancelled: { color: "red", label: "Cancelled" },
};

export function CampaignStatusTag({ status }: { status: CampaignStatus }) {
  const s = campaignDot[status];
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink-soft">
      <StatusDot color={s.color} live={s.live} />
      {s.label}
    </span>
  );
}

export function PageHeader({
  title,
  lede,
  actions,
}: {
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.015em]">{title}</h1>
        {lede && <p className="mt-1.5 max-w-[62ch] text-ink-soft">{lede}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-sm text-ink-faint">{hint}</p>}
    </div>
  );
}

/** One border, one soft focus ring. Shared by inputs, textareas and selects. */
export const fieldClass =
  "w-full rounded-lg border border-line bg-surface px-3.5 text-[15px] text-ink shadow-[0_1px_2px_rgba(23,33,30,0.04)] transition-[border-color,box-shadow] duration-150 placeholder:text-ink-faint hover:border-line-strong focus:border-accent focus:shadow-[0_0_0_4px_rgba(184,145,58,0.16)] disabled:bg-canvas";
const inputBase = fieldClass;

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={cx(inputBase, "h-10", props.className)} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea {...props} className={cx(inputBase, "py-2.5 leading-relaxed", props.className)} />;
}

export function Notice({ tone = "error", children }: { tone?: "error" | "info"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cx(
        "rounded-lg border px-3.5 py-2.5 text-sm",
        tone === "error"
          ? "border-status-error/30 bg-status-error/5 text-status-error"
          : "border-accent/40 bg-accent-wash text-accent-deep",
      )}
    >
      {children}
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-2xl border border-line bg-surface p-0 text-ink shadow-[0_24px_60px_-20px_rgba(23,33,30,0.45)] backdrop:bg-panel-deep/40 backdrop:backdrop-blur-[2px]"
    >
      {open && (
        <div className="p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="-m-1 rounded p-1 text-ink-faint hover:text-ink"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cx(
        "rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(23,33,30,0.04),0_8px_24px_-12px_rgba(23,33,30,0.08)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded bg-line/70", className)} />;
}
