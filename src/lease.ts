// Leases: the path globs a task may edit. They replace the honor-system ownership
// table — the orchestrator checks the diff, not the agent's good intentions.
import picomatch from "picomatch";

const GLOB_CHARS = /[*?[\]{}()!]/;

/** Literal directory/file prefix of a glob, e.g. "backend/app/**" → "backend/app/". */
export function staticPrefix(glob: string): string {
  const parts = glob.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (GLOB_CHARS.test(p)) return out.length ? out.join("/") + "/" : "";
    out.push(p);
  }
  return out.join("/"); // no wildcard: an exact path
}

/** Conservative overlap test: two globs may touch the same file if either literal prefix contains the other. */
export function globsOverlap(a: string, b: string): boolean {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  if (pa === "" || pb === "") return true;
  const isDirA = pa.endsWith("/") || pa !== a;
  const isDirB = pb.endsWith("/") || pb !== b;
  if (!isDirA && !isDirB) return pa === pb;
  if (!isDirA) return picomatch(b, { dot: true })(pa) || pa.startsWith(pb);
  if (!isDirB) return picomatch(a, { dot: true })(pb) || pb.startsWith(pa);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

export function leasesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => globsOverlap(x, y)));
}

/** Files outside the lease. `.nightshift/` bookkeeping is never allowed. */
export function leaseViolations(files: string[], lease: string[]): string[] {
  const isMatch = picomatch(lease, { dot: true });
  return files.filter((f) => f.startsWith(".nightshift/") || !isMatch(f));
}
