export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function describe(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail) && detail.length) {
    const first = detail[0] as { msg?: string; loc?: unknown[] };
    const field = first.loc?.slice(1).join(".");
    return field ? `${field}: ${first.msg}` : (first.msg ?? "Invalid input");
  }
  return "Something went wrong";
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, describe(body.detail));
  return body as T;
}

// ---- types mirrored from the FastAPI schemas -------------------------------------

export type Admin = { id: number; email: string; name: string };

export type SubscriberCounts = {
  active: number;
  blocked: number;
  unreachable: number;
  total: number;
  /** false until the bot's database is connected */
  connected: boolean;
  /** Set when the bot's database couldn't be read; counts are then the last cached ones. */
  source_error: string | null;
};

export type Bot = {
  id: number;
  telegram_id: number;
  username: string;
  display_name: string;
  is_active: boolean;
  token_valid: boolean;
  /** Telegram short description ("About") */
  about: string;
  /** what people see in an empty chat, before Start */
  telegram_description: string;
  /** null: no profile photo; changes when the photo changes */
  avatar_version: string | null;
  last_checked_at: string | null;
  created_at: string;
  subscribers: SubscriberCounts;
};


export type MessageButton = { text: string; url: string };

export type ParseMode = "Markdown" | "HTML" | "MarkdownV2" | null;

export type MessageContent = {
  text: string;
  parse_mode: ParseMode;
  media_id: number | null;
  buttons: MessageButton[];
  disable_link_preview: boolean;
  silent: boolean;
  protect_content: boolean;
};

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "cancelled";

export type DeliveryStats = {
  pending: number;
  sent: number;
  failed: number;
  blocked: number;
  skipped: number;
  total: number;
};

export type Recipient = { bot_id: number; chat_id: number; label: string };
export type Audience = { mode: "all" | "selected"; recipients: Recipient[] };

export type Campaign = {
  id: number;
  name: string;
  status: CampaignStatus;
  message: MessageContent;
  bot_ids: number[];
  audience: Audience;
  source_campaign_id: number | null;
  /** how many times this message has been sent (list responses) */
  send_count?: number;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  stats: DeliveryStats;
};

export type CampaignBotStats = {
  bot_id: number;
  username: string;
  display_name: string;
  audience: number;
  stats: DeliveryStats;
  error: string | null;
};

export type RelatedSend = {
  id: number;
  name: string;
  status: CampaignStatus;
  created_at: string;
  started_at: string | null;
  audience_mode: "all" | "selected";
  bot_ids: number[];
  stats: DeliveryStats;
};

export type ShareInfo = { token: string; hide_message: boolean };

export type CampaignDetail = Campaign & { bots: CampaignBotStats[]; sends: RelatedSend[]; share: ShareInfo | null };

export type Person = {
  chat_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  reachable: boolean;
};

export type ActivityEntry = {
  id: number;
  actor_email: string | null;
  action: string;
  entity_type: "bot" | "campaign";
  entity_id: number | null;
  details: Record<string, unknown>;
  created_at: string;
};

export type Page<T> = { items: T[]; total: number };

export type Delivery = {
  id: number;
  bot_id: number;
  chat_id: number;
  status: "pending" | "sent" | "failed" | "blocked" | "skipped";
  attempts: number;
  error: string | null;
  sent_at: string | null;
};

export type Media = {
  id: number;
  kind: "photo" | "video" | "document" | "animation";
  filename: string;
  content_type: string;
  size_bytes: number;
};

export type Overview = {
  bots: (SubscriberCounts & {
    id: number;
    username: string;
    display_name: string;
    is_active: boolean;
    token_valid: boolean;
    avatar_version: string | null;
  })[];
  total_bots: number;
  total_active_subscribers: number;
  unique_people: number;
  recent_campaigns: Pick<
    Campaign,
    "id" | "name" | "status" | "scheduled_at" | "started_at" | "finished_at" | "stats"
  >[];
};

export const emptyMessage = (): MessageContent => ({
  text: "",
  parse_mode: "Markdown",
  media_id: null,
  buttons: [],
  disable_link_preview: false,
  silent: false,
  protect_content: false,
});

// ---- subscriber sources --------------------------------------------------------------

export type MappedField =
  | "chat_id"
  | "username"
  | "first_name"
  | "last_name"
  | "language_code"
  | "joined_at"
  | "is_active";

export type ColumnMap = { chat_id: string } & Partial<Record<Exclude<MappedField, "chat_id">, string | null>>;

export type FilterOp = "eq" | "neq" | "is_null" | "not_null" | "is_true" | "is_false";
export type SourceFilter = { column: string; op: FilterOp; value?: string | null };

export type BotSourceInfo = {
  kind: "none" | "database";
  driver: string | null;
  host: string | null;
  database: string | null;
  schema: string | null;
  table: string | null;
  column_map: Partial<ColumnMap>;
  filters: SourceFilter[];
  joins: SourceJoin[];
  status: "healthy" | "error" | "unchecked" | null;
  last_error: string | null;
  last_checked_at: string | null;
  cached_count: number | null;
  cached_count_at: string | null;
};

export type ConnectionInfo = {
  ok: boolean;
  driver: string;
  host: string | null;
  database: string | null;
  server_version: string | null;
};

export type ColumnInfo = { name: string; type: string; nullable: boolean };

/** A table linked to another by a foreign key. "many" = any number of rows per user. */
export type RelationInfo = {
  table: string;
  schema: string | null;
  base_column: string;
  related_column: string;
  cardinality: "one" | "many";
};

export type SourceJoin = { table: string; schema: string | null; base_column: string; related_column: string };

export type TableInfo = {
  schema: string | null;
  name: string;
  kind: "table" | "view";
  row_estimate: number | null;
  columns: ColumnInfo[];
  relations: RelationInfo[];
  suggested: Partial<Record<MappedField, string>>;
};

export type Introspection = { connection: ConnectionInfo; tables: TableInfo[] };

export type SourcePreview = { rows: Record<string, unknown>[]; total: number; warnings: string[] };

// ---- test groups ---------------------------------------------------------------------

export type TestMember = { bot_id: number; chat_id: number; label: string; kind: string };
export type TestGroup = { id: number; name: string; members: TestMember[]; is_default: boolean; updated_at: string };
export type TestSendResult = { bot_id: number; chat_id: number; label: string; delivered: boolean; error: string | null };

// ---- broadcast progress -------------------------------------------------------------

export type Outcome = "delivered" | "blocked" | "unreachable" | "failed";
export type TimelinePoint = { t: string; bot_id: number; outcome: Outcome; count: number };
export type ErrorGroup = { bot_id: number; status: "failed" | "blocked"; error: string; count: number };
export type Progress = {
  bucket_seconds: number;
  start: string | null;
  end: string | null;
  points: TimelinePoint[];
  per_minute: number;
  eta_seconds: number | null;
  elapsed_seconds: number | null;
  errors: ErrorGroup[];
};
export type Estimate = { recipients: number; seconds: number; bots: { bot_id: number; recipients: number }[] };

// ---- public share ---------------------------------------------------------------------

export type PublicBroadcast = {
  name: string;
  status: CampaignStatus;
  audience_mode: "all" | "selected";
  reach: number;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  stats: DeliveryStats;
  bots: { bot_id: number; username: string; display_name: string; audience: number; stats: DeliveryStats }[];
  message: MessageContent | null;
  media: { kind: Media["kind"]; filename: string; size_bytes: number } | null;
  progress: Progress;
};

// ---- analytics -----------------------------------------------------------------------

export type AnalyticsRange = "7d" | "30d" | "90d" | "12m" | "all";
export type AudienceAnalytics = {
  period: { range: AnalyticsRange; unit: "day" | "week" | "month"; start: string; end: string; buckets: string[] };
  bots: number[];
  kpis: {
    people: number;
    subscriptions: number;
    multi_bot_people: number;
    new_people: number | null;
    new_people_previous: number | null;
    blocked: number;
  };
  growth: { points: { t: string; bot_id: number; count: number }[]; before_start: Record<string, number>; missing_joined_at: number[] };
  overlap: { by_bot_count: Record<string, number>; pairs: { a: number; b: number; people: number }[]; per_bot: Record<string, number> };
  languages: { items: { code: string; people: number }[]; unknown: number; missing_language: number[] };
  blocked: { t: string; count: number }[];
  broadcasts: { id: number; name: string; started: string; bucket: string }[];
  errors: Record<string, string>;
};

export type BroadcastPerformance = {
  id: number;
  name: string;
  status: CampaignStatus;
  started: string;
  finished: string | null;
  total: number;
  sent: number;
  blocked: number;
  failed: number;
  delivery_rate: number | null;
  block_rate: number | null;
  seconds: number | null;
};
export type BroadcastAnalytics = { period: AudienceAnalytics["period"]; items: BroadcastPerformance[] };
export type ColumnChoice = { ref: string; table: string; name: string; type: string };
export type Breakdown = {
  bot_id: number;
  column: string;
  total: number;
  items: { value: string; people: number }[];
  other: number;
  empty: number;
  grouped_by_month: boolean;
};
