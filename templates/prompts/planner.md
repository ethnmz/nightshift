# Plan tonight's build

You are the planner. The team (awake, for now) wrote the idea in `.nightshift/idea.md`. Turn it into a plan that {{node_count}} nodes of AI agents can build overnight **without any human**.

Teammates and their lanes:
{{nodes}}

Produce, in this repository:

1. **Contracts first** (this is what removes hours of overnight negotiation): API shapes, data model, and any cross-lane interfaces as docs (e.g. `docs/API.md`, `docs/DATA_MODEL.md`), plus typed stubs and fixtures so every lane can build against them from minute one.
2. **`.nightshift/tasks.yaml`**: a DAG of small tasks (30–60 min of agent work each). Schema per task:
   - `id` (T1, T2, …), `title`, `lane` (one of the lanes above), `brief` (self-contained: someone with no chat history can do it),
   - `lease`: path globs the task may edit. **Tasks that can run at the same time must not have overlapping leases.**
   - `depends_on`, `contracts` (files to read), `acceptance`: one-shot shell commands that prove it works (tests, build). No servers, no watchers.
3. Put scaffolding (project skeleton, test setup) in early tasks that others depend on. Front-load each lane so all {{node_count}} nodes have work immediately. End with an integration/demo task.

Rules: do not ask questions; record assumptions in `.nightshift/assumptions.md`. Write the files and finish with a one-paragraph summary.
