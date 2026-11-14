# Relay

**Plan it together. Your team's AI agents build it together, at the same time. Review one pull request when they're done.**

Relay runs a hackathon team's coding agents side by side, at any time of day: in the afternoon while you work, in the evening, or overnight while you sleep. Nobody has to watch. Each teammate's computer (Mac or Windows) runs **their own Claude Code or Codex, on their own subscription**. The agents split up the work, hand finished pieces to each other, ask each other questions, review each other's changes, and merge into a `relay/<run>` branch. Nothing ever waits for a person. When the run finishes you get a report and a single pull request into `main`.

It works for any hackathon, team size (1–8) or tech stack. You describe the event and idea in a guided setup, and an AI planner turns that into contracts and small tasks for each teammate.

## Get started (everyone, Mac or Windows)

You need Node.js 20+, Git (on Windows, Git for Windows, which includes Git Bash) and the GitHub CLI signed in (`gh auth login`). Then install your agent and sign in with your plan:

| Agent | Install | Sign in |
|---|---|---|
| Claude Code (Pro/Max/Team) | `npm install -g @anthropic-ai/claude-code` | run `claude`, type `/login` |
| Codex (ChatGPT plan) | `npm install -g @openai/codex` | `codex login` |

```bash
git clone https://github.com/ethnmz/relay && cd relay && npm install && npm start
```

Your browser opens Relay.
- **Team lead:** click **Start a new team**. That creates a private GitHub repo, then you walk through the setup.
- **Teammates:** click **Join my team** and paste the repo link the lead sends. The setup's Share step writes that message for the lead.
- **Just curious:** click **Watch a practice run**. Four pretend teammates build a project in about two minutes, with no AI usage.

## The setup (in the browser)

1. **Hackathon:** fastest path: drop one markdown brief (your notes, or the downloadable template) and Relay fills in the whole setup: event, challenge, deadline, idea, demo, must-haves, stack, rules, team, and agent rules. Labeled sections are read exactly, and an optional AI pass (one short read on your Claude subscription) fills in the rest from freeform notes. The whole brief is also handed to the planner. You can always type or fix fields by hand.
2. **Team:** name, GitHub username, Mac/Windows/Linux, Claude Code or Codex, and role. Roles become each person's area of work.
3. **Rules:** plain-word choices. Review every change? Can idle computers help others? Agents per computer, usage cap, who owns shared contracts.
4. **Plan:** one click runs the AI planner (on the lead's subscription). It writes shared contracts and a task list per teammate. Read it and edit any task.
5. **Share:** pushes the plan, creates the team's message board (a GitHub issue), invites teammates, and makes a **setup prompt for each teammate**. A teammate pastes their file into Claude Code or Codex on their own computer, and their AI does the whole setup: checks and installs tools (asking first), installs Relay, runs `relay join`, runs the final check, and leaves the computer on `relay start --wait-for-go`, so it starts when you start the run. Each Share of a changed plan begins a new run (its id, like `2026-11-14-1930`, is saved in `relay.yaml`), so every computer agrees on which run it's in without asking. Teammates only type their own logins.
6. **Your computer** (each teammate): pick who you are, see what's missing with copy-paste install commands for your OS, then run the final check (power, sleep, GitHub access, and a live call to your agent through your plan).
7. **Start:** see who's ready. The lead can **Start the run for everyone**, and teammates can turn on *start automatically*.

## Live and Results

- **Live:** a live map of the team. Each teammate's agent sits around the shared run branch, and animated dots show work being merged, finished work unblocking a teammate, questions and answers, and hand-offs when a plan runs out of usage. Below the map is a plain-language "what just happened" feed and the task list.
- **Results:** the report covers what merged, what was set aside and why, and **every decision the agents made on their own**. One button opens the pull request. Merging to `main` is always a person's call.
  - **Submission kit:** your agent reads the finished code (read-only) and drafts *How to run*, a *demo script*, *what works vs. what's mocked*, and a *Devpost write-up*. Each part has a Copy button, and one click adds `SUBMISSION.md` to the pull request.
  - **Retry with a hint:** each set-aside task gets a hint box. Retry queues it as a new task (for example `A3-r2`) that sees why it failed, the kept work, and your hint.
- **Working alongside the agents:** on the Live tab, list the folders you're editing and agents stay out of them. When a run finishes, **Start again** keeps building leftovers and retries on the same run branch.

## Walk away

- **Check from your phone:** one progress note on the GitHub board issue is edited in place every few minutes. It shows merged count, what each teammate's computer is doing, what was set aside, and the deadline cutoff.
- **Alerts only for real problems:** the lead is @mentioned on the board, so the GitHub app on your phone buzzes. That happens when the full check fails twice in a row, a laptop goes silent, every plan hits its limit, a login stops working, the usage cap is reached, or the run finishes. Each kind fires at most once an hour. GitHub doesn't notify you about your own posts, so alerts raised on the lead's computer are relayed by a teammate's computer.
- **Lost login:** if a teammate's Claude Code or Codex login stops working, that computer hands its tasks to the others, pauses, checks again every 30 minutes, and resumes on its own after someone logs back in.
- **Deadline-aware:** the submission deadline from the setup becomes a cutoff (2 hours before by default). After that no new tasks start and work in progress finishes. Tasks are `must` or `nice`. Must-haves are always built first, and only must-haves start near the cutoff or near the usage cap.

## How it stays hands-off and safe

- **Nothing asks a person.** Agent permission checks always answer allow or deny. Tools that would ask a human are disabled, and every command runs non-interactively with a timeout. Agents decide unclear details themselves and write them down for you to review.
- **Each computer is sandboxed to its task.** Agents only write inside their task's own copy of the repo and only the files their task owns. Out-of-scope edits are reverted and sent to the owner. Agents can't push, can't use your GitHub login, and can't read secrets files.
- **Subscriptions only.** API keys are removed from the agents' environment. Dollar figures are *estimates*, not charges. When someone's plan hits its usage limit, that computer hands its work to the others and pauses until the limit resets.
- **No server.** Computers coordinate through git: a task is claimed with a compare-and-swap ref, so two computers can't take the same task. If a computer sleeps or crashes, its tasks move to teammates. The node restarts itself after a crash and keeps the computer awake (caffeinate on Mac, a power request on Windows).
- **Quality gates.** Each task's checks plus a global check, a second agent's review, and a fuller test run every few merges. A failure queues a fix that runs before new work.

## Command line (optional)

`relay` (opens the app) · `start --node ID` · `preflight --node ID` · `status` · `stop [--team]` · `report [--pr]` · `plan` · `validate`. Run `relay help` for details.

## Tests

```bash
npm test
```

That runs 56 tests: permission policy, file ownership, scheduler, claim races, commands that would prompt, 4-computer runs with stand-in agents, Codex, usage-limit and lost-login hand-offs, alerts, the live status note, deadline and must-first scheduling, retries, reserved folders, the submission kit, the setup wizard backend, and the app API. An opt-in live test runs one real Claude task (`RELAY_LIVE=1 npx vitest run test/live.test.ts`) and checks it finishes with zero denied actions.

## Not verified yet

- **Windows on a real Windows PC.** The Windows paths (Git Bash for checks, process-tree kills, keep-awake, launching npm-installed agents) are written but were only run on macOS. Do a practice run and the setup's final check on one Windows machine before the event.
- Codex with a real ChatGPT login (tested with a stand-in `codex` that uses the same flags and output), a real multi-hour run on four computers, the AI planner on a real idea, and a real plan hitting its usage limit.
