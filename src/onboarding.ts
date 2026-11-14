// One "megaprompt" per teammate. The teammate pastes it into their own coding agent
// (Claude Code or Codex, on their own computer) and the agent does the whole setup:
// check and install tools, get Relay, join the project, run the final check, and leave
// the computer waiting for the lead's "start". Logins stay with the human.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelayConfig, Task } from "./config.js";
import { paths } from "./config.js";
import { Setup, Member, rolesOf } from "./setup.js";

export const RELAY_REPO = process.env.RELAY_REPO ?? "ethnmz/relay";

export interface PromptInput {
  setup: Setup;
  cfg: RelayConfig;
  tasks: Task[];
  member: Member;
  repo: string; // owner/name of the team's project
  leadName: string;
}

const osLabel = { mac: "macOS", windows: "Windows", linux: "Linux" } as const;

export function teammatePrompt({ setup, cfg, tasks, member: m, repo, leadName }: PromptInput): string {
  const win = m.os === "windows";
  const mac = m.os === "mac";
  const agentName = m.agent === "codex" ? "Codex" : "Claude Code";
  const lanes = rolesOf(m);
  const mine = tasks.filter((t) => lanes.includes(t.lane));
  const event = setup.event.name || cfg.project;
  const team = setup.team
    .map((x) => `| ${x.name}${x.id === m.id ? " (you)" : ""} | ${x.github ? "@" + x.github : "—"} | ${osLabel[x.os]} | ${x.agent === "codex" ? "Codex" : "Claude Code"} | ${rolesOf(x).join(", ")} |`)
    .join("\n");
  // "$HOME/relay" works the same in PowerShell, Git Bash, zsh and bash.
  const nsDir = "$HOME/relay";

  const install = win
    ? {
        node: "winget install OpenJS.NodeJS.LTS",
        git: "winget install Git.Git   (this also installs Git Bash, which Relay needs)",
        gh: "winget install GitHub.cli",
        agent: m.agent === "codex" ? "npm install -g @openai/codex" : "npm install -g @anthropic-ai/claude-code",
      }
    : mac
      ? {
          node: "brew install node   (or the installer from nodejs.org if Homebrew is missing)",
          git: "xcode-select --install",
          gh: "brew install gh",
          agent: m.agent === "codex" ? "npm install -g @openai/codex" : "npm install -g @anthropic-ai/claude-code",
        }
      : {
          node: "install Node.js 20+ with the distro's package manager or nodejs.org",
          git: "sudo apt install git",
          gh: "see https://cli.github.com (then gh auth login)",
          agent: m.agent === "codex" ? "npm install -g @openai/codex" : "npm install -g @anthropic-ai/claude-code",
        };

  const agentLogin =
    m.agent === "codex"
      ? {
          check: "codex login status",
          ok: 'the output mentions "ChatGPT" (a ChatGPT plan login, not an API key)',
          human: "codex login   (choose Sign in with ChatGPT)",
        }
      : {
          check: "claude auth status",
          ok: 'the JSON shows "loggedIn": true and "authMethod": "claude.ai"',
          human: "claude   then type /login and sign in with the Claude account that has the Pro/Max/Team plan",
        };

  return `# Relay setup for ${m.name}

**${m.name}: paste this whole file into ${agentName} on your ${osLabel[m.os]} computer.** Open ${agentName} in any folder (your home folder is fine). It will do the setup with you in about 10 minutes. It will stop and ask you whenever you need to sign in or approve something.

---

## Instructions for the coding agent

You are setting up this computer so **${m.name}** can take part in the team's **Relay** build for **${event}**. Relay runs ${m.name}'s own ${agentName} on their own subscription, side by side with their teammates' computers. Once a run starts nobody has to watch it (the team may be working, in class, or asleep), so everything must be ready and verified now.

### Rules for you
- Work through the steps **in order**. Run each check, show the human the result, and only move on when it passes.
- **Never type, ask for, or store passwords, tokens or API keys.** When a login is needed, stop and ask the human to run the login command themselves in their own terminal, then re-run the check.
- **Ask the human before installing software** or changing global settings, and say exactly what you will run.
- Do not edit files in the team's project, do not commit, and do not push. Only use the Relay commands below.
- This computer runs **${osLabel[m.os]}**.${win ? " Use PowerShell or Git Bash (not cmd.exe), where `$HOME` is the home folder." : ""} The Relay folder will be \`${nsDir}\`.
- If a step fails in a way these instructions don't cover, explain the error to the human in plain words and suggest the smallest fix.

### Who's on the team
| Name | GitHub | Computer | Agent | Role |
|---|---|---|---|---|
${team}

${m.name}'s role: **${lanes.join(", ")}**. The team lead is **${leadName}**. The project repo is **https://github.com/${repo}**.
${mine.length ? `\nTasks in this role (their agent builds these during the run):\n${mine.map((t) => `- ${t.id}: ${t.title}`).join("\n")}\n` : ""}
### Step 1: Check the basic tools
Run each command and check the result:
- \`node --version\` must be **v20 or newer**. If missing or older: ${install.node}
- \`git --version\` must work. If missing: ${install.git}${win ? "\n- Git Bash must exist: check for `C:\\Program Files\\Git\\bin\\bash.exe` (or run `where bash`). It comes with Git for Windows." : ""}
- \`gh --version\` must work. If missing: ${install.gh}

### Step 2: GitHub sign-in (the human does this part)
1. Run \`gh auth status\`. It must show a logged-in account.
2. Run \`gh api user --jq .login\`. It must print **${m.github || "(their GitHub username)"}**.${m.github ? "" : " Ask the human for their GitHub username and tell them to send it to " + leadName + "."}
3. If either fails, ask the human to run \`gh auth login\` themselves (GitHub.com → HTTPS → log in with a web browser), then check again.
4. Check for a pending invitation to the project and to Relay: \`gh api user/repository_invitations --jq '.[] | "\\(.id) \\(.repository.full_name)"'\`. If you see **${repo}** or **${RELAY_REPO}**, show it to the human and, **only if they agree**, accept it with \`gh api -X PATCH user/repository_invitations/<id>\`. If there is no invitation and Step 4 or 5 later fails with "not found", ask the human to message ${leadName} for an invite.

### Step 3: Sign in to ${agentName} with the subscription (the human does this part)
1. If \`${m.agent === "codex" ? "codex --version" : "claude --version"}\` fails, ask before installing: \`${install.agent}\`
2. Run \`${agentLogin.check}\`. It passes when ${agentLogin.ok}.
3. If it fails, ask the human to run \`${agentLogin.human}\` themselves, then check again.
4. Relay uses the **subscription**, not API keys. If \`ANTHROPIC_API_KEY\` or \`OPENAI_API_KEY\` is set in this shell, tell the human. Relay ignores those keys for its agents, so nothing needs deleting.

### Step 4: Get Relay
- If \`${nsDir}\` already exists, run \`git -C "${nsDir}" pull\` there. Otherwise run \`gh repo clone ${RELAY_REPO} "${nsDir}"\`.
- Then, inside that folder, run \`npm install\`. It must finish without errors.
- Check it works: \`node "${nsDir}/bin/relay.mjs" help\` prints the Relay commands.${win ? "\n- Recommended on Windows (ask first): `git config --global core.longpaths true`, so deep folders don't hit Windows path limits." : ""}

### Step 5: Join the team's project
Run:
\`\`\`
node "${nsDir}/bin/relay.mjs" join https://github.com/${repo} --node ${m.id}
\`\`\`
It must end with a line \`PROJECT_DIR=...\`. Remember that folder; the next steps run inside it. It should also say "This computer is ${m.name}".

### Step 6: Run the final check
Inside PROJECT_DIR, run:
\`\`\`
node "${nsDir}/bin/relay.mjs" preflight --node ${m.id}
\`\`\`
It checks power, sleep, GitHub access, and does one real test call to ${agentName}. Every line must be ✔ or ! (a warning), with **no ✖**, and it must end with "Ready for the run." For each ✖, explain it in plain words and help fix it, then run the check again. Common ones:
- **power:** the computer must be plugged in.
- **gh auth:** signed in as the wrong GitHub account; repeat Step 2.
- **${m.agent === "codex" ? "Codex" : "Claude"} login / live check:** repeat Step 3.${win ? "\n- **Git Bash:** install Git for Windows (Step 1)." : ""}

### Step 7: Hand off to ${m.name}
Tell the human to do this themselves, because it must keep running after this ${agentName} session ends:

1. Open a **new terminal window** (${win ? "PowerShell or Windows Terminal" : "Terminal"}).
2. Run:
\`\`\`
cd "<PROJECT_DIR from step 5>"
node "${nsDir}/bin/relay.mjs" start --node ${m.id} --wait-for-go
\`\`\`
3. Leave that window open, the computer **plugged in with the lid open**, and go do something else. It starts on its own when ${leadName} starts the run.${win ? "\n4. Optional: in Windows Settings → System → Power, set \"When I close the lid\" to \"Do nothing\" while plugged in, and pause Windows Update for a day so it doesn't restart during a run." : mac ? "\n4. Optional: keep the lid open (or use an external display). Relay keeps the Mac awake while it runs." : ""}

They can watch progress any time by running \`npm start\` inside \`${nsDir}\`, which opens the Relay app in the browser.

### Finish
Give ${m.name} a short checklist of what passed. Remind them that nothing will ask them anything during a run, and that when it finishes the team reviews one report and one pull request.
`;
}

/** Write one prompt per teammate into the project (committed with the plan). */
export function writeTeammatePrompts(root: string, base: Omit<PromptInput, "member">): { id: string; file: string }[] {
  const dir = join(paths(root).dir, "onboarding");
  mkdirSync(dir, { recursive: true });
  const out: { id: string; file: string }[] = [];
  for (const member of base.setup.team) {
    const file = join(dir, `${member.id}.md`);
    writeFileSync(file, teammatePrompt({ ...base, member }));
    out.push({ id: member.id, file });
  }
  return out;
}

export type { Member };
