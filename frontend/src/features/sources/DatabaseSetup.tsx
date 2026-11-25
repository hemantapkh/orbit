import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Plus, Search, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  api,
  type BotSourceInfo,
  type ColumnInfo,
  type ColumnMap,
  type ConnectionInfo,
  type FilterOp,
  type Introspection,
  type MappedField,
  type RelationInfo,
  type SourceFilter,
  type SourceJoin,
  type SourcePreview,
  type TableInfo,
} from "../../lib/api";
import { fmt } from "../../lib/format";
import { Button, cx, Field, fieldClass, Input, StatusDot, Notice } from "../../components/ui";

type Step = "connect" | "table" | "map";

const FIELDS: { key: MappedField; label: string; help: string }[] = [
  { key: "chat_id", label: "Telegram user ID", help: "The numeric ID messages are sent to. Required." },
  { key: "username", label: "Username", help: "The @handle, shown in previews and reports." },
  { key: "first_name", label: "First name", help: "Shown in previews." },
  { key: "last_name", label: "Last name", help: "Shown in previews." },
  { key: "language_code", label: "Language", help: "Two-letter code such as en or ne." },
  { key: "joined_at", label: "Joined at", help: "When the user first started the bot." },
  { key: "is_active", label: "Active flag", help: "Rows where this is false or 0 are left out." },
];

const OPS: { value: FilterOp; label: string; needsValue: boolean }[] = [
  { value: "eq", label: "equals", needsValue: true },
  { value: "neq", label: "doesn't equal", needsValue: true },
  { value: "is_true", label: "is true", needsValue: false },
  { value: "is_false", label: "is false", needsValue: false },
  { value: "not_null", label: "has a value", needsValue: false },
  { value: "is_null", label: "is empty", needsValue: false },
];

const selectCls = `${fieldClass} h-10`;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function DatabaseSetup({
  botId,
  existing,
  onCancel,
  onSaved,
}: {
  botId: number;
  existing: BotSourceInfo | null;
  onCancel: () => void;
  onSaved: (s: BotSourceInfo) => void;
}) {
  const [step, setStep] = useState<Step>("connect");
  const [url, setUrl] = useState("");
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [table, setTable] = useState<TableInfo | null>(null);

  // A blank URL while editing means "keep the saved connection".
  const connection = url.trim() ? { database_url: url.trim() } : existing ? { bot_id: botId } : null;

  const test = useMutation({ mutationFn: () => api<ConnectionInfo>("/sources/test", { method: "POST", json: connection }) });
  const introspect = useMutation({
    mutationFn: () => api<Introspection>("/sources/introspect", { method: "POST", json: connection }),
    onSuccess: (data) => {
      setTables(data.tables);
      const saved = existing && !url.trim()
        ? data.tables.find((t) => t.name === existing.table && (t.schema ?? null) === (existing.schema ?? null))
        : undefined;
      if (saved) {
        setTable(saved);
        setStep("map");
      } else {
        setStep("table");
      }
    },
  });

  return (
    <div>
      <Steps step={step} onJump={(s) => (s === "connect" || tables) && setStep(s)} canMap={!!table} />
      {step === "connect" && (
        <div className="max-w-[640px] space-y-5">
          <Field
            label="Database URL"
            htmlFor="dburl"
            hint={
              <>
                Use a read-only database user. Orbit only runs SELECT queries, opens every session
                read-only, and stops any query after 15 seconds. The URL is stored encrypted and never shown again.
              </>
            }
          >
            <Input
              id="dburl"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
              placeholder={existing ? "Leave blank to keep the saved connection" : "postgresql://readonly:password@db.example.com:5432/botdb"}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                test.reset();
                introspect.reset();
              }}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => test.mutate()} disabled={!connection || test.isPending}>
              {test.isPending ? "Connecting…" : "Test connection"}
            </Button>
            <ConnectionResult test={test} />
          </div>
          {introspect.error && <Notice>{introspect.error.message}</Notice>}
          <div className="flex justify-end gap-2 border-t border-line pt-5">
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="primary" onClick={() => introspect.mutate()} disabled={!connection || introspect.isPending}>
              {introspect.isPending ? "Reading tables…" : "Choose a table"}
            </Button>
          </div>
        </div>
      )}
      {step === "table" && tables && (
        <TablePicker
          tables={tables}
          selected={table}
          onBack={() => setStep("connect")}
          onPick={(t) => {
            setTable(t);
            setStep("map");
          }}
        />
      )}
      {step === "map" && table && connection && (
        <Mapping
          key={`${table.schema}.${table.name}`}
          botId={botId}
          table={table}
          tables={tables ?? []}
          connection={connection}
          existing={existing && existing.table === table.name && existing.schema === table.schema ? existing : null}
          keepUrl={!url.trim()}
          url={url.trim()}
          onBack={() => setStep("table")}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

function Steps({ step, onJump, canMap }: { step: Step; onJump: (s: Step) => void; canMap: boolean }) {
  const steps: [Step, string][] = [
    ["connect", "Connection"],
    ["table", "Table"],
    ["map", "Mapping"],
  ];
  const at = steps.findIndex(([s]) => s === step);
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      {steps.map(([s, label], i) => {
        const done = i < at;
        const reachable = i <= at || (s === "map" && canMap);
        return (
          <li key={s} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-6 bg-line-strong" aria-hidden />}
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onJump(s)}
              aria-current={s === step ? "step" : undefined}
              className={cx(
                "flex items-center gap-2 rounded px-1 py-0.5",
                s === step ? "font-medium text-ink" : reachable ? "text-ink-soft hover:text-ink" : "text-ink-faint",
              )}
            >
              <span
                className={cx(
                  "grid size-5 place-items-center rounded-full text-[11px] font-semibold",
                  s === step ? "bg-panel text-panel-ink" : done ? "bg-accent-wash text-accent-deep" : "bg-line text-ink-faint",
                )}
              >
                {done ? <Check size={12} strokeWidth={3} /> : i + 1}
              </span>
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function ConnectionResult({ test }: { test: { data?: ConnectionInfo; error: Error | null; isSuccess: boolean } }) {
  if (test.error)
    return (
      <span className="flex items-start gap-2 text-sm text-status-error" role="alert">
        <span className="pt-1"><StatusDot color="red" /></span>
        {test.error.message}
      </span>
    );
  if (test.isSuccess && test.data)
    return (
      <span className="flex items-center gap-2 text-sm text-ink-soft" role="status">
        <StatusDot color="green" />
        Connected to {test.data.driver}
        {test.data.server_version && ` ${test.data.server_version}`} · {test.data.host ? `${test.data.host} / ` : ""}
        {test.data.database}
      </span>
    );
  return null;
}

function TablePicker({
  tables,
  selected,
  onPick,
  onBack,
}: {
  tables: TableInfo[];
  selected: TableInfo | null;
  onPick: (t: TableInfo) => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = tables.filter((t) => `${t.schema ?? ""}.${t.name}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search size={16} className="pointer-events-none absolute top-3 left-3 text-ink-faint" />
        <Input autoFocus placeholder={`Search ${tables.length} tables and views`} className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tables" />
      </div>
      <div className="max-h-[420px] divide-y divide-line overflow-y-auto rounded-xl border border-line">
        {shown.length === 0 && <p className="px-4 py-6 text-sm text-ink-soft">No tables match “{q}”.</p>}
        {shown.map((t) => {
          const hasId = !!t.suggested.chat_id;
          const isSel = selected?.name === t.name && selected?.schema === t.schema;
          return (
            <button
              key={`${t.schema}.${t.name}`}
              type="button"
              onClick={() => onPick(t)}
              className={cx("grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 text-left hover:bg-canvas", isSel && "bg-accent-wash/50")}
            >
              <span className="min-w-0">
                <span className="block truncate">
                  {t.schema && <span className="text-ink-faint">{t.schema}.</span>}
                  <span className="font-medium">{t.name}</span>
                  {t.kind === "view" && <span className="ml-2 rounded bg-line px-1.5 py-0.5 text-xs text-ink-soft">view</span>}
                </span>
                <span className="block truncate text-sm text-ink-faint">
                  {t.columns.length} columns{hasId && ` · looks like it has Telegram IDs in ${t.suggested.chat_id}`}
                </span>
              </span>
              <span className="text-right text-sm text-ink-soft">
                {t.row_estimate != null ? `${t.schema ? "about " : ""}${fmt(t.row_estimate)} rows` : ""}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex justify-between">
        <Button onClick={onBack}>Back</Button>
      </div>
    </div>
  );
}

function Mapping({
  botId,
  table,
  tables,
  connection,
  existing,
  keepUrl,
  url,
  onBack,
  onSaved,
}: {
  botId: number;
  table: TableInfo;
  tables: TableInfo[];
  connection: { database_url: string } | { bot_id: number };
  existing: BotSourceInfo | null;
  keepUrl: boolean;
  url: string;
  onBack: () => void;
  onSaved: (s: BotSourceInfo) => void;
}) {
  const initial = (existing?.column_map ?? table.suggested) as Partial<ColumnMap>;
  const [map, setMap] = useState<Partial<Record<MappedField, string | null>>>(initial);
  const [suggested, setSuggested] = useState<Set<MappedField>>(
    () => new Set(existing ? [] : (Object.keys(table.suggested) as MappedField[])),
  );
  const [filters, setFilters] = useState<SourceFilter[]>(existing?.filters ?? []);
  const groups = useMemo(() => columnGroups(table, tables), [table, tables]);
  const mainOnly = groups.slice(0, 1);

  const spec = useMemo(() => {
    const column_map = Object.fromEntries(Object.entries(map).filter(([, v]) => v)) as Record<string, string>;
    const complete = filters.filter((f) => f.column && (!OPS.find((o) => o.value === f.op)?.needsValue || (f.value ?? "") !== ""));
    return { table: table.name, schema: table.schema, column_map, filters: complete, joins: joinsFor(table, [...Object.values(column_map), ...complete.map((f) => f.column)]) };
  }, [map, filters, table]);
  const debounced = useDebounced(spec, 450);
  const ready = !!debounced.column_map.chat_id;

  const preview = useQuery({
    queryKey: ["source-preview", connection, debounced],
    queryFn: () => api<SourcePreview>("/sources/preview", { method: "POST", json: { ...connection, ...debounced } }),
    enabled: ready,
    retry: false,
    placeholderData: (prev) => prev,
  });

  const save = useMutation({
    mutationFn: () =>
      api<BotSourceInfo>(`/bots/${botId}/source`, {
        method: "PUT",
        json: { ...spec, ...(keepUrl ? {} : { database_url: url }) },
      }),
    onSuccess: onSaved,
  });

  const setField = (k: MappedField, v: string) => {
    setMap((m) => ({ ...m, [k]: v || null }));
    setSuggested((s) => {
      const n = new Set(s);
      n.delete(k);
      return n;
    });
  };

  return (
    <div className="space-y-8">
      <section>
        <SubHead title="Map the columns" aside={<>From <span className="font-medium text-ink">{table.schema ? `${table.schema}.` : ""}{table.name}</span></>} />
        <div className="divide-y divide-line rounded-xl border border-line">
          {FIELDS.map((f) => (
            <div key={f.key} className="grid items-center gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div>
                <label htmlFor={`map-${f.key}`} className="font-medium">
                  {f.label}
                  {f.key === "chat_id" && <span className="text-status-error"> *</span>}
                </label>
                <p className="text-sm text-ink-faint">{f.help}</p>
              </div>
              <div className="flex items-center gap-2">
                <ColumnSelect id={`map-${f.key}`} groups={f.key === "chat_id" ? mainOnly : groups} value={map[f.key] ?? ""} onChange={(v) => setField(f.key, v)} required={f.key === "chat_id"} />
                <span className={cx("w-[70px] shrink-0 text-xs text-accent-deep", !(suggested.has(f.key) && map[f.key]) && "invisible")} title="Picked by matching the column name">
                  suggested
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <SubHead title="Filters" aside="Optional. Only users who match every filter are included." />
        {groups.some((g) => g.cardinality === "many") && (
          <p className="-mt-1 mb-3 text-sm text-ink-faint">
            A filter on a table with many rows per user means “has at least one row where…”.
          </p>
        )}
        <div className="space-y-2">
          {filters.map((f, i) => {
            const op = OPS.find((o) => o.value === f.op)!;
            const update = (p: Partial<SourceFilter>) => setFilters((fs) => fs.map((x, j) => (j === i ? { ...x, ...p } : x)));
            return (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                <ColumnSelect aria-label={`Filter ${i + 1} column`} groups={groups} value={f.column} onChange={(column) => update({ column })} placeholder="Column" />
                <select aria-label={`Filter ${i + 1} condition`} className={selectCls} value={f.op} onChange={(e) => update({ op: e.target.value as FilterOp })}>
                  {OPS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                {op.needsValue ? (
                  <Input aria-label={`Filter ${i + 1} value`} placeholder="Value" value={f.value ?? ""} onChange={(e) => update({ value: e.target.value })} />
                ) : (
                  <span className="hidden sm:block" />
                )}
                <Button variant="ghost" aria-label={`Remove filter ${i + 1}`} onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>
                  <Trash2 size={16} />
                </Button>
              </div>
            );
          })}
          <Button size="sm" variant="ghost" onClick={() => setFilters((fs) => [...fs, { column: "", op: "eq", value: "" }])} disabled={filters.length >= 20}>
            <Plus size={15} /> Add filter
          </Button>
        </div>
      </section>

      <section aria-live="polite">
        <SubHead
          title="Preview"
          aside={preview.isFetching ? "Updating…" : undefined}
        />
        {!ready ? (
          <p className="text-sm text-ink-soft">Choose the Telegram user ID column to see who this bot would reach.</p>
        ) : preview.error ? (
          <Notice>{preview.error.message}</Notice>
        ) : preview.data ? (
          <div className="space-y-3">
            <p className="text-lg">
              <span className="font-semibold">{fmt(preview.data.total)}</span> users will be reachable
              <span className="text-sm text-ink-faint"> (before anyone who has blocked the bot)</span>
            </p>
            {preview.data.warnings.map((w) => (
              <Notice key={w} tone="info">{w}</Notice>
            ))}
            {preview.data.rows.length > 0 && <PreviewTable rows={preview.data.rows} />}
          </div>
        ) : (
          <p className="text-sm text-ink-soft">Loading…</p>
        )}
      </section>

      {save.error && <Notice>{save.error.message}</Notice>}
      <div className="flex justify-between gap-2 border-t border-line pt-5">
        <Button onClick={onBack}>Back</Button>
        <Button variant="primary" onClick={() => save.mutate()} disabled={!spec.column_map.chat_id || save.isPending || !!preview.error}>
          {save.isPending ? "Saving…" : "Save source"}
        </Button>
      </div>
    </div>
  );
}

function SubHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 className="font-semibold">{title}</h3>
      {aside && <span className="text-sm text-ink-soft">{aside}</span>}
    </div>
  );
}

type ColumnGroup = { label: string; prefix: string; cardinality: "main" | "one" | "many"; columns: ColumnInfo[] };

/** The main table's columns, then each linked table's columns as "table.column". */
function columnGroups(table: TableInfo, tables: TableInfo[]): ColumnGroup[] {
  const groups: ColumnGroup[] = [{ label: table.name, prefix: "", cardinality: "main", columns: table.columns }];
  const seen = new Set<string>();
  for (const rel of table.relations) {
    if (seen.has(rel.table)) continue; // one link per table keeps "table.column" unambiguous
    seen.add(rel.table);
    const other = tables.find((t) => t.name === rel.table && t.schema === rel.schema);
    if (!other) continue;
    groups.push({
      label: `${rel.table}: ${rel.cardinality === "one" ? "one per user" : "any of many per user"}`,
      prefix: `${rel.table}.`,
      cardinality: rel.cardinality,
      columns: other.columns,
    });
  }
  return groups;
}

/** The links needed for the "table.column" references in use. */
function joinsFor(table: TableInfo, refs: string[]): SourceJoin[] {
  const names = new Set(refs.filter((r) => r.includes(".")).map((r) => r.split(".")[0]));
  const joins: SourceJoin[] = [];
  for (const name of names) {
    const rel: RelationInfo | undefined = table.relations.find((r) => r.table === name);
    if (rel) joins.push({ table: rel.table, schema: rel.schema, base_column: rel.base_column, related_column: rel.related_column });
  }
  return joins;
}

function ColumnSelect({
  groups,
  value,
  onChange,
  placeholder = "Not mapped",
  required,
  ...rest
}: {
  groups: ColumnGroup[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const options = (g: ColumnGroup) =>
    g.columns.map((c) => (
      <option key={g.prefix + c.name} value={g.prefix + c.name}>
        {c.name} ({c.type})
      </option>
    ));
  return (
    <select {...rest} className={selectCls} value={value} onChange={(e) => onChange(e.target.value)} required={required}>
      <option value="">{placeholder}</option>
      {groups.length === 1
        ? options(groups[0])
        : groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {options(g)}
            </optgroup>
          ))}
    </select>
  );
}

const LABELS: Record<string, string> = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));

function PreviewTable({ rows }: { rows: Record<string, unknown>[] }) {
  const keys = FIELDS.map((f) => f.key).filter((k) => rows.some((r) => k in r));
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full min-w-[480px] text-left text-sm">
        <thead className="border-b border-line bg-canvas text-ink-soft">
          <tr>
            {keys.map((k) => (
              <th key={k} className="px-3 py-2 font-medium">{LABELS[k]}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i}>
              {keys.map((k) => (
                <td key={k} className={cx("px-3 py-2", k === "chat_id" && "font-medium")}>
                  {r[k] == null || r[k] === "" ? <span className="text-ink-faint">—</span> : String(r[k])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
