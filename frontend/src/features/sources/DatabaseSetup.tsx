import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Plus, Search, Trash2 } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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

type FieldGroup = "Profile" | "Activity" | "Reach";
const FIELDS: { key: MappedField; label: string; help: string; group?: FieldGroup }[] = [
  { key: "chat_id", label: "Telegram user ID", help: "The numeric ID messages are sent to. Required." },
  { key: "username", label: "Username", help: "The @handle, shown in previews and reports.", group: "Profile" },
  { key: "first_name", label: "First name", help: "Shown in previews.", group: "Profile" },
  { key: "last_name", label: "Last name", help: "Shown in previews.", group: "Profile" },
  { key: "title", label: "Group or channel name", help: "Shown for groups and channels, which have no first name.", group: "Profile" },
  { key: "language_code", label: "Language", help: "Two-letter code such as en or ne.", group: "Profile" },
  { key: "is_premium", label: "Premium", help: "True for Telegram Premium users.", group: "Profile" },
  { key: "joined_at", label: "Joined at", help: "When the user first started the bot.", group: "Activity" },
  { key: "last_active_at", label: "Last active", help: "When they last used the bot. A failed send is forgotten once they're back.", group: "Activity" },
  { key: "is_active", label: "Can receive", help: "Rows where this is false or 0 are left out.", group: "Reach" },
  { key: "status", label: "Bot's status", help: "Telegram's member status: member, kicked (blocked), left... Unreachable rows are left out.", group: "Reach" },
  { key: "unreachable_reason", label: "Unreachable reason", help: "Set when the chat can't be messaged, e.g. deactivated. Rows with a value are left out.", group: "Reach" },
  { key: "chat_type", label: "Chat type", help: "private, group, supergroup or channel.", group: "Reach" },
  { key: "member_count", label: "Member count", help: "How many people are in a group or channel.", group: "Reach" },
  { key: "status_changed_at", label: "Status changed at", help: "When the bot's status last changed, e.g. when someone blocked it.", group: "Reach" },
  { key: "unreachable_at", label: "Unreachable since", help: "When the chat became unreachable, e.g. the account was deleted.", group: "Reach" },
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
  start = "connect",
  onCancel,
  onSaved,
}: {
  botId: number;
  existing: BotSourceInfo | null;
  /** "map": edit the saved source straight away, using its saved connection */
  start?: "connect" | "map";
  onCancel: () => void;
  onSaved: (s: BotSourceInfo) => void;
}) {
  const [step, setStep] = useState<Step>("connect");
  const [url, setUrl] = useState("");
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [table, setTable] = useState<TableInfo | null>(null);
  const [chatColumn, setChatColumn] = useState<string>(existing?.column_map.chat_id ?? "");

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

  // Editing a saved source: read its tables through the saved connection, then open the mapping.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (start === "map" && existing && !autoStarted.current) {
      autoStarted.current = true;
      introspect.mutate();
    }
  }, [start, existing, introspect]);

  if (start === "map" && step === "connect" && !introspect.error) {
    return <p className="text-sm text-ink-soft" role="status">Reading the bot's database…</p>;
  }

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
              {introspect.isPending ? "Reading tables…" : "Continue"}
            </Button>
          </div>
        </div>
      )}
      {step === "table" && tables && (
        <TablePicker
          tables={tables}
          selected={table}
          selectedColumn={chatColumn}
          onBack={() => setStep("connect")}
          onPick={(t, col) => {
            setTable(t);
            setChatColumn(col);
            setStep("map");
          }}
        />
      )}
      {step === "map" && table && connection && (
        <Mapping
          key={`${table.schema}.${table.name}.${chatColumn}`}
          botId={botId}
          table={table}
          chatColumn={chatColumn}
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
    ["table", "Telegram user IDs"],
    ["map", "Details"],
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
  selectedColumn,
  onPick,
  onBack,
}: {
  tables: TableInfo[];
  selected: TableInfo | null;
  selectedColumn: string;
  onPick: (t: TableInfo, chatColumn: string) => void;
  onBack: () => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<TableInfo | null>(selected);
  const [column, setColumn] = useState(selectedColumn || selected?.suggested.chat_id || "");
  const term = q.trim().toLowerCase();
  // Tables that look like they hold Telegram IDs come first.
  const shown = tables
    .filter((t) => `${t.schema ?? ""}.${t.name}`.toLowerCase().includes(term))
    .sort((a, b) => Number(!a.suggested.chat_id) - Number(!b.suggested.chat_id));
  const same = (a: TableInfo | null, b: TableInfo) => a?.name === b.name && a?.schema === b.schema;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-semibold">Where are the Telegram user IDs?</h3>
        <p className="mt-1 max-w-[64ch] text-sm text-ink-soft">
          Pick the table with one row per user, then the column holding their numeric Telegram ID.
          Other details like names or language can come from linked tables in the next step.
        </p>
      </div>
      <div className="relative max-w-sm">
        <Search size={16} className="pointer-events-none absolute top-3 left-3 text-ink-faint" />
        <Input autoFocus placeholder={`Search ${tables.length} tables and views`} className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tables" />
      </div>
      <div className="max-h-[440px] divide-y divide-line overflow-y-auto rounded-xl border border-line">
        {shown.length === 0 && <p className="px-4 py-6 text-sm text-ink-soft">No tables match “{q}”.</p>}
        {shown.map((t) => {
          const isOpen = same(open, t);
          return (
            <div key={`${t.schema}.${t.name}`} className={cx(isOpen && "bg-accent-wash/40")}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => {
                  setOpen(t);
                  setColumn(same(selected, t) && selectedColumn ? selectedColumn : (t.suggested.chat_id ?? ""));
                }}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 text-left hover:bg-canvas"
              >
                <span className="min-w-0">
                  <span className="block truncate">
                    {t.schema && <span className="text-ink-faint">{t.schema}.</span>}
                    <span className="font-medium">{t.name}</span>
                    {t.kind === "view" && <span className="ml-2 rounded bg-line px-1.5 py-0.5 text-xs text-ink-soft">view</span>}
                  </span>
                  <span className="block truncate text-sm text-ink-faint">
                    {t.suggested.chat_id ? `Telegram IDs likely in ${t.suggested.chat_id}` : `${t.columns.length} columns`}
                  </span>
                </span>
                <span className="text-right text-sm text-ink-soft">
                  {t.row_estimate != null ? `${t.schema ? "about " : ""}${fmt(t.row_estimate)} rows` : ""}
                </span>
              </button>
              {isOpen && (
                <div className="flex flex-wrap items-end gap-3 px-4 pb-4">
                  <div className="min-w-[240px] flex-1">
                    <label htmlFor="chat-col" className="mb-1.5 block text-sm font-medium">
                      Telegram user ID column
                    </label>
                    <select id="chat-col" className={selectCls} value={column} onChange={(e) => setColumn(e.target.value)}>
                      <option value="">Choose a column</option>
                      {t.columns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name} ({c.type})
                        </option>
                      ))}
                    </select>
                  </div>
                  <Button variant="primary" disabled={!column} onClick={() => onPick(t, column)}>
                    Use {t.name}
                  </Button>
                </div>
              )}
            </div>
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
  chatColumn,
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
  chatColumn: string;
  tables: TableInfo[];
  connection: { database_url: string } | { bot_id: number };
  existing: BotSourceInfo | null;
  keepUrl: boolean;
  url: string;
  onBack: () => void;
  onSaved: (s: BotSourceInfo) => void;
}) {
  // Keep what was saved; suggest the fields it leaves empty (e.g. ones Orbit added since),
  // never reusing a column the saved mapping already uses.
  const saved = (existing?.column_map ?? {}) as Partial<ColumnMap>;
  const used = new Set(Object.values(saved).filter(Boolean));
  const fresh = (Object.keys(table.suggested) as MappedField[]).filter(
    (k) => !saved[k] && !used.has(table.suggested[k] ?? null),
  );
  const initial = {
    ...Object.fromEntries(fresh.map((k) => [k, table.suggested[k]])),
    ...saved,
    chat_id: chatColumn,
  };
  const [map, setMap] = useState<Partial<Record<MappedField, string | null>>>(initial);
  const [suggested, setSuggested] = useState<Set<MappedField>>(() => new Set(fresh));
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
        <p className="mb-6 flex flex-wrap items-center gap-x-2 rounded-lg bg-canvas px-4 py-3 text-sm ring-1 ring-line">
          <span className="text-ink-soft">Users from</span>
          <span className="font-medium">{table.schema ? `${table.schema}.` : ""}{table.name}</span>
          <span className="text-ink-soft">· Telegram ID in</span>
          <span className="font-medium">{chatColumn}</span>
          <button type="button" onClick={onBack} className="ml-auto text-accent-deep underline-offset-4 hover:underline">
            Change
          </button>
        </p>
        <SubHead
          title="Details"
          aside={table.relations.length ? "Optional. Columns can come from this table or tables linked to it." : "Optional."}
        />
        <div className="divide-y divide-line rounded-xl border border-line">
          {FIELDS.filter((f) => f.key !== "chat_id").map((f, i, all) => (
            <Fragment key={f.key}>
            {f.group !== all[i - 1]?.group && (
              <p className="bg-canvas px-4 py-2 text-sm font-medium text-ink-soft">{f.group}</p>
            )}
            <div className="grid items-center gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
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
            </Fragment>
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
