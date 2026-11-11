# Nightshift

**Plan together in the evening. Four Macs build overnight. Review one PR in the morning.**

Nightshift is a hands-off multi-agent build system for 4-person hackathon teams. Each teammate's Mac runs one *node*. Nodes run Claude Code agents headless, coordinate through git and a GitHub issue, review and test each other's work, and merge into a `night/<date>` branch. **Nothing asks a human anything overnight.** In the morning you get a report and a single `night/<date> → main` PR.

It grew out of the HackUTD 2026 ShiftSync setup (`tools/board`, Claude hooks, `AGENTS.md`), which worked but kept stalling on people:

| What happened at the hackathon | What Nightshift does instead |
|---|---|
| 87 free-text board posts; about 3.5 h negotiating contracts before code | The planner writes contracts, stubs and a task DAG in the evening. Board posts are structured envelopes. |
| Approved PRs waited 2.5–8 h for someone to merge, in a hand-written order | A deterministic merge loop rebases, re-checks and merges in dependency order |
| Agents only woke while someone's app was open; the watch exited every 15 min | A daemon per Mac with a permanent board watcher. Messages are injected into running agents mid-task |
| File ownership was honor-based; agents edited others' files | Each task has a **lease** (path globs). Out-of-lease edits are reverted and sent to the owning lane |
| Reassignment needed the lead | Work-stealing rules approved in the evening. Stale claims are taken over automatically |
| Live-model bugs surfaced late | An integration gate runs every N merges. A failure queues an exclusive fixer task |

## How it works

```
evening (awake)                          overnight (asleep, zero prompts)                 morning
idea.md ──planner──► contracts + tasks.yaml    ┌─ node: Ethan  (lane frontend) ─┐
night.yaml (pre-authorizations)  ──preflight──►├─ node: Diego  (lane voice)    ─┤──► night/<date> ──► report + 1 PR
                                               ├─ node: Akshi  (lane ai)       ─┤
                                               └─ node: Aditri (lane core)     ─┘
```

Each node loops:
1. **Pick** a ready task (dependencies merged, lease free team-wide), its own lane first, then steal.
2. **Claim** it with a compare-and-swap git ref (`refs/nightshift/<night>/state/<task>`, `--force-with-lease`). Two nodes racing for the same task can't both win. There's no server and no leader. Claims heartbeat, and a silent node's claims go stale and are taken over.
3. **Build** in a fresh worktree with the Claude Agent SDK.
4. **Lease check → acceptance commands → global check → reviewer agent** (read-only). Failures feed a fix round. When the attempts run out, the task is **parked** and its work is kept on `ns/<night>/<task>`.
5. **Merge:** squash, rebase onto the latest night branch, re-check, then a normal push (never a force). If another node merged first, it retries.
6. **Gate** every N merges. A failure queues a `FIX-…` task that reserves the whole tree until it lands.

### Why nothing waits for a person
- `canUseTool` always resolves to **allow or deny** (wrapped so a hang or a throw becomes a deny). `AskUserQuestion`, plan mode and similar tools are disallowed outright. A `PreToolUse` hook re-applies the same policy to calls that skip the permission callback.
- **Policy:** writes stay inside the task worktree (symlink-safe). No `.git`, `.nightshift` or secrets. Bash runs only allowlisted commands, and pushes, force operations, `gh`, `sudo`, remote shells, OS control and publishing are denied.
- Every subprocess runs with stdin closed and `CI=1`, `GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`, `GIT_EDITOR=true`, `npm_config_yes`, `PIP_NO_INPUT`, `ssh BatchMode` and so on. Every command has a hard timeout that kills the whole process group.
- The role prompts say: never ask. Decide conservatively, call `record_assumption`, and continue. Assumptions become the report's **Decisions to review**.
- `ask` returns immediately. A read-only *answerer* on the owning lane's node replies, and the answer is injected into the asker's context.
- The repo's own `.claude/` hooks and settings are not loaded (`settingSources: []`). `AGENTS.md` and `CLAUDE.md` are inlined instead.
- A watchdog kills stuck or over-time agents and retries once. Budgets are per node and per team. The kill switch is `nightshift stop [--team]`, a dashboard button, or posting `nightshift stop` on the board.
- `nightshift preflight` catches 3 a.m. blockers in the evening: auth and `gh` login, push access, claim refs, the check command, AC power, caffeinate, auto-updates, disk space, and a live model call.

## Your own agents, on your own subscriptions

Each teammate's Mac runs **their own coding agent, signed in with their own plan**. No API keys and no per-use billing:

| Teammate's choice | One-time setup on that Mac | What Nightshift runs overnight |
|---|---|---|
| **Claude Code** (Pro / Max / Team) | `claude`, then `/login` | Claude Code headless (same login as the terminal and desktop app) |
| **Codex** (ChatGPT plan) | `npm i -g @openai/codex`, then `codex login` | `codex exec`, sandboxed to the task worktree, `approval_policy="never"` |

Set it per teammate in `night.yaml` (`nodes[].agent: claude | codex`). With `auth: subscription` (the default):
- API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are **removed from the agents' environment**, so they can't bill a key by accident.
- Preflight checks that each agent is logged in with a **subscription**, that the login won't expire overnight, and that a live call answers via the subscription.
- **Plan usage limits:** when a teammate's plan runs out (for example a 5-hour window), that node releases its tasks to the other nodes and pauses until the limit resets, then rejoins. The dashboard shows each node's plan usage and any pause.
- Dollar amounts are Claude Code's *estimate at API prices* and are not charges. The `budget` cap just keeps one night from using a whole plan. Codex reports tokens, not dollars.

The desktop app isn't driven directly (nobody is awake to click), but it uses the same login, so there's nothing extra to set up.

## Quick start

```bash
git clone <this repo> ~/nightshift && cd ~/nightshift && npm install && npm run build:dashboard
```

```bash
alias nightshift=~/nightshift/bin/nightshift.mjs
```

In your project, on every teammate's Mac:

```bash
nightshift init --project my-app        # .nightshift/{idea.md,night.yaml,tasks.yaml}
```

```bash
nightshift plan                         # planner: idea.md → contracts + tasks.yaml (review it!)
```

```bash
nightshift serve --node ethan           # dashboard: edit plan, preflight, Start night
```

```bash
nightshift preflight --node ethan
```

```bash
nightshift start --node ethan           # keeps the Mac awake; serves the dashboard on :4545
```

The morning after:

```bash
nightshift report --node ethan --pr     # report + the one night/<date> → main PR
```

Evening checklist: write `idea.md` together → plan → review tasks and **leases** (tasks that can run in parallel must not overlap) → set every `authorize:` flag → commit and push `.nightshift/` → each teammate runs preflight → start → plug in, lid open, sleep. Optional: `nightshift launchd --node <id> --install` restarts a crashed node.

### Rehearse a whole night in about a minute (no model spend)

```bash
npx tsx scripts/rehearsal.ts /tmp/ns-rehearsal   # bare remote + 4 clones + file board + fake adapter
```

Then run the four printed `nightshift start` commands and open http://localhost:4545.

## Dashboard
- **Night:** team progress, the 4 node cards (online, silent, finished, merged, spend), agents working on this Mac (phase, last message, cost, queued messages), the task graph by lane, and a live activity stream.
- **Board:** the structured team feed, filterable (talk, decisions, tasks, health).
- **Plan:** edit `idea.md`, `night.yaml` and `tasks.yaml` with validation, run preflight, and **Start night**.
- **Report:** the morning report.

## Commands
`init · plan · validate · serve · preflight · start · status · stop [--team] · report [--pr] · launchd [--install]`. Run `nightshift help` for details.

## Tests

```bash
npm test                                          # 36 tests: policy, leases, scheduler, claim races, no-prompt, 4-node e2e, Codex, usage limits
```

```bash
NIGHTSHIFT_LIVE=1 npx vitest run test/live.test.ts  # one real Claude task (~$0.20), asserts zero denials
```

The e2e suite runs four in-process nodes against a bare git remote with the fake adapter. It checks that every task merges exactly once, out-of-lease edits are reverted, parked work is kept, a dead node's task is taken over, mid-task messages are delivered, questions get answered, the stuck watchdog fires, and `main` is untouched.

## Not verified yet
- Codex against a real ChatGPT login. The Codex adapter is tested with a stand-in `codex` binary that uses the same flags and event format as `codex exec` 0.167. Preflight's live Codex check is the first real test.
- A real plan hitting its usage limit overnight. The pause and hand-off logic is tested with simulated limits.
- A real overnight run on four separate Macs, and the GitHub-issue board under real rate limits. The tests use the file board and a local bare remote.
- The planner (`nightshift plan`) on a real idea, contract-change tasks with a real model, and the launchd agent.
- Merge-conflict resolution by a fixer agent. Leases make conflicts rare, and the e2e tests don't force one.
