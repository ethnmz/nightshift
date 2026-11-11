import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "prompts");
const cache = new Map<string, string>();

export function prompt(name: string, vars: Record<string, string | number>): string {
  if (!cache.has(name)) cache.set(name, readFileSync(join(DIR, `${name}.md`), "utf8"));
  return cache.get(name)!.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? String(vars[k]) : `{{${k}}}`));
}

export const bullets = (xs: string[], empty = "(none)") => (xs.length ? xs.map((x) => `- \`${x}\``).join("\n") : empty);
