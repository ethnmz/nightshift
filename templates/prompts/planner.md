# Plan tonight's build

You are the planner. The team (awake, for now) described the hackathon and the idea in `.nightshift/idea.md`. Read it carefully, including the challenge/track, deadline and rules. Turn it into a plan that {{node_count}} computers of AI coding agents can build overnight **without any human**.

Teammates and their roles (each role is a lane; a task's `lane` must be one of these):
{{nodes}}

Produce, in this repository:

1. **Contracts first** (they remove hours of overnight negotiation): the API shapes, data model and any cross-lane interfaces as docs (for example `docs/API.md`, `docs/DATA_MODEL.md`), plus typed stubs and fixtures so every lane can build against them from minute one. Pick a stack from the idea; if it says nothing, choose something simple and common for the challenge, and record that choice.
2. **`.nightshift/tasks.yaml`** with this shape:

```yaml
check: "<one-shot command that proves the whole project builds and its tests pass>"
gate: { command: "<a fuller check, e.g. tests + build>", every: 3 }
contracts: [docs/API.md, docs/DATA_MODEL.md]
tasks:
  - id: T1
    title: Short title
    lane: <one of the lanes above>
    brief: |
      Self-contained instructions: someone with no chat history can do it.
    lease: ["path/globs/**"]      # the only files this task may change
    depends_on: []
    contracts: [docs/API.md]
    acceptance: ["<one-shot command that proves this task works>"]
    priority: must          # must = needed for the demo / the brief's must-haves; nice = only if time allows
```

Rules for the plan:
- Small tasks (30–60 minutes of agent work each). Front-load every lane so all {{node_count}} computers have work in the first hour.
- **Tasks that can run at the same time must not have overlapping leases.**
- Early tasks: project skeleton and test setup that others depend on. Last task: an end-to-end demo check.
- Commands must be one-shot and non-interactive (no servers left running, no watchers, no prompts). They run in bash on Mac and Windows (Git Bash), so avoid OS-specific commands.
- Stay inside the scope in idea.md. Mark every task `priority: must` or `priority: nice`: must-haves and anything the demo needs are `must`; nice-to-haves are `nice`. Nightshift builds every `must` task before any `nice` one, and near the deadline or the usage cap it only builds `must` tasks.

Do not ask questions; record assumptions in `.nightshift/assumptions.md`. Write the files and finish with a one-paragraph summary.
