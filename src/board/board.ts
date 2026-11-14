// Two interchangeable boards:
//  - GitHubIssueBoard: comments on one issue through `gh api` (ported from hackutd2026 tools/board:
//    incremental `since=` polling with an id cursor, so a quiet poll costs one API call).
//  - FileBoard: a shared JSONL file, for tests and for 4-nodes-on-one-Mac rehearsals.
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "../exec.js";
import { BoardMessage, Envelope, formatPost, parseEnvelope } from "./envelope.js";

export interface Board {
  post(human: string, env: Envelope): Promise<void>;
  /** Messages not returned before by this instance (cursor persisted when a path is given). */
  fetchNew(): Promise<BoardMessage[]>;
  /** Everything on the board (used once at startup to rebuild state, and by the report). */
  fetchAll(): Promise<BoardMessage[]>;
  describe(): string;
  /** The run's live progress note, edited in place (one per run). */
  upsertStatus(runId: string, markdown: string): Promise<void>;
  /** When the progress note was last written, or null if there is none yet. */
  statusUpdatedAt(runId: string): Promise<number | null>;
}

export const statusMarker = (runId: string) => `<!-- relay-status run=${runId} -->`;

function readCursor(path?: string): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8").trim() || undefined;
}
function writeCursor(path: string | undefined, v: string) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, v);
}

export class FileBoard implements Board {
  private seen = 0;
  constructor(private file: string, private cursorPath?: string) {
    const c = readCursor(cursorPath);
    if (c) this.seen = Number(c) || 0;
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, "");
  }
  describe() {
    return `file ${this.file}`;
  }
  private statusFile(runId: string) {
    return join(dirname(this.file), `status-${runId}.md`);
  }
  async upsertStatus(runId: string, markdown: string) {
    writeFileSync(this.statusFile(runId), `${statusMarker(runId)}\n${markdown}`);
  }
  async statusUpdatedAt(runId: string) {
    const f = this.statusFile(runId);
    return existsSync(f) ? statSync(f).mtimeMs : null;
  }
  async post(human: string, env: Envelope) {
    const text = formatPost(human, env);
    // One short line per append; O_APPEND keeps concurrent writers from interleaving.
    appendFileSync(this.file, JSON.stringify({ author: "file", createdAt: new Date().toISOString(), text }) + "\n");
  }
  private readAll(): BoardMessage[] {
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    return lines.map((l, i) => {
      const o = JSON.parse(l);
      return { id: String(i + 1), author: o.author, createdAt: o.createdAt, text: o.text, env: parseEnvelope(o.text) };
    });
  }
  async fetchAll() {
    return this.readAll();
  }
  async fetchNew() {
    const all = this.readAll();
    const fresh = all.slice(this.seen);
    this.seen = all.length;
    writeCursor(this.cursorPath, String(this.seen));
    return fresh;
  }
}

export class GitHubIssueBoard implements Board {
  private cursor: { id: number; ts: string } | undefined;
  constructor(private repo: string, private issue: number, private cursorPath?: string) {
    const c = readCursor(cursorPath);
    if (c) {
      const [id, ts] = c.split(" ");
      if (id && ts) this.cursor = { id: Number(id), ts };
    }
  }
  describe() {
    return `github ${this.repo}#${this.issue}`;
  }
  private async findStatus(runId: string): Promise<BoardMessage | undefined> {
    const all = await this.fetchAll();
    return all.filter((m) => m.text.startsWith(statusMarker(runId))).pop();
  }
  async upsertStatus(runId: string, markdown: string) {
    const body = `${statusMarker(runId)}\n${markdown}`;
    const cache = this.cursorPath ? `${this.cursorPath}-status-${runId}` : undefined;
    let id = cache && existsSync(cache) ? readFileSync(cache, "utf8").trim() : "";
    if (!id) id = (await this.findStatus(runId))?.id ?? "";
    if (id) {
      const r = await run("gh", ["api", "-X", "PATCH", `repos/${this.repo}/issues/comments/${id}`, "--input", "-"], { input: JSON.stringify({ body }), timeoutMs: 30_000 });
      if (r.code === 0) return;
      id = ""; // deleted or not ours any more: create a new one
    }
    const r = await run("gh", ["api", "-X", "POST", this.endpoint(), "--input", "-", "--jq", ".id"], { input: JSON.stringify({ body }), timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error("status post failed");
    if (cache) writeCursor(cache, r.stdout.trim());
  }
  async statusUpdatedAt(runId: string) {
    const m = await this.findStatus(runId);
    return m ? Date.parse(m.updatedAt ?? m.createdAt) : null;
  }
  private endpoint(q = "") {
    return `repos/${this.repo}/issues/${this.issue}/comments${q}`;
  }
  async post(_human: string, env: Envelope) {
    const body = formatPost(_human, env);
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await run("gh", ["api", "-X", "POST", this.endpoint(), "--input", "-"], {
        input: JSON.stringify({ body }),
        timeoutMs: 30_000,
      });
      if (r.code === 0) return;
      await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt)); // network blip or secondary rate limit
    }
    throw new Error("board post failed after retries");
  }
  private async fetch(q: string): Promise<BoardMessage[]> {
    const jq = '.[] | {id, user: .user.login, created_at, updated_at, body} | tojson';
    const r = await run("gh", ["api", "--paginate", this.endpoint(q), "--jq", jq], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`board fetch: ${r.stderr.trim().slice(0, 300)}`);
    return r.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((o) => ({ id: String(o.id), author: o.user, createdAt: o.created_at, updatedAt: o.updated_at, text: o.body ?? "", env: parseEnvelope(o.body ?? "") }))
      .sort((a, b) => Number(a.id) - Number(b.id));
  }
  async fetchAll() {
    return this.fetch("?per_page=100");
  }
  async fetchNew() {
    if (!this.cursor) {
      // First run in this checkout: start from "now", like the old board's last-10 context.
      const all = await this.fetchAll();
      const last = all[all.length - 1];
      if (last) this.save(Number(last.id), last.createdAt);
      return all.slice(-10);
    }
    const rows = await this.fetch(`?per_page=100&since=${encodeURIComponent(this.cursor.ts)}`);
    const fresh = rows.filter((m) => Number(m.id) > this.cursor!.id);
    const last = fresh[fresh.length - 1];
    if (last) this.save(Number(last.id), last.createdAt);
    return fresh;
  }
  private save(id: number, ts: string) {
    this.cursor = { id, ts };
    writeCursor(this.cursorPath, `${id} ${ts}`);
  }
}
