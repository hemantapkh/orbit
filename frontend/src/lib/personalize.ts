/** Mirrors backend messages.py: {first_name}, {last_name}, {full_name}, {username}, with "|fallback". */
export const FIELDS = [
  { key: "first_name", label: "First name", sample: "Ana" },
  { key: "last_name", label: "Last name", sample: "Rai" },
  { key: "full_name", label: "Full name", sample: "Ana Rai" },
  { key: "username", label: "Username", sample: "ana_rai" },
] as const;
export type Field = (typeof FIELDS)[number]["key"];

const PLACEHOLDER = /\{(first_name|last_name|full_name|username)(?:\|([^{}\n]{0,60}))?\}/g;

export type Use = { field: Field; fallback: string | null };

export function placeholdersIn(text: string): Use[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => ({ field: m[1] as Field, fallback: m[2] ?? null }));
}

/** Fill with sample values, for the preview. */
export function withSamples(text: string): string {
  return text.replace(PLACEHOLDER, (_, f: Field) => FIELDS.find((x) => x.key === f)!.sample);
}
