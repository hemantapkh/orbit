import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Notice } from "../../components/ui";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-sm text-ink-soft hover:bg-line/60 hover:text-ink"
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {done ? "Copied" : label}
    </button>
  );
}

export function RevealedKey({ apiKey }: { apiKey: string }) {
  return (
    <div className="space-y-3">
      <Notice tone="info">
        This is the only time the integration key is shown. Store it with the bot's other secrets.
      </Notice>
      <div className="flex items-center gap-2 rounded-lg border border-line bg-canvas py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{apiKey}</code>
        <CopyButton value={apiKey} />
      </div>
    </div>
  );
}

export function IntegrationSnippet({ apiKey }: { apiKey?: string }) {
  const key = apiKey ?? "orb_…";
  const code = `curl -X POST ${window.location.origin}/api/integration/v1/subscribers \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"subscribers": [
        {"chat_id": 123456789, "username": "ana", "first_name": "Ana"},
        {"chat_id": 987654321, "status": "unsubscribed"}
      ]}'`;
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-xl bg-panel-deep p-4 text-[13px] leading-relaxed text-panel-ink">
        <code className="font-mono">{code}</code>
      </pre>
      <div className="absolute top-2 right-2 rounded bg-surface">
        <CopyButton value={code} />
      </div>
    </div>
  );
}
