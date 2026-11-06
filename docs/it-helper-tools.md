# IT helper tools: what they do and the guardrails

Five tools that let Claude act like a careful Tier 1/Tier 2 help desk assistant on the computer it runs on. They follow the advice IT teams give for bringing AI into support: **start read-only, suggest instead of doing, keep a human in charge of anything that changes, and log everything.**

## The tools

| Tool | What Claude gets | What it can NOT do |
|---|---|---|
| `run_health_check` | OK / WARN / FAIL for restart time, memory, disk space, network; on Windows also Defender real-time protection and definitions age, firewall, pending restart, last update installed, drive encryption. Plain advice in EN/ES, a KB article for each problem, and a one-line `ticketNote`. | Fix anything. It only reads. |
| `run_diagnostic` | The output of one allowlisted command: `network-config`, `ping-internet`, `dns-lookup`, `top-processes`, `startup-apps`, `recent-system-errors`, `update-history`. | Run any command that isn't on the list, add arguments, or see MAC addresses / the user name. |
| `search_kb` | The best 1 to 5 articles from a bilingual knowledge base, with steps and "escalate when". | Walk someone through a technician-only article (password reset, phishing, admin rights). |
| `lookup_asset` | Model, owner, location, lifecycle stage, warranty days left, flags. | Change an asset. |
| `draft_incident` | ServiceNow incident fields, priority, assignment group, escalation flags, and (if `SERVICENOW_INSTANCE` is set) a link to a pre-filled new-incident form. | Create, update or close a ticket. A person clicks Submit. |

## Guardrails, and where each one lives in the code

1. **Read-only by design.** No tool writes to the computer or to ServiceNow. All tools carry `readOnlyHint: true`. (`src/server.ts`)
2. **Allowlist, not free commands.** Claude sends an id; the server maps it to a fixed program and fixed arguments per operating system. The input schema rejects any other id before anything runs. Commands run with `execFile` and no shell, so there is nothing to inject into. A test decodes every command and fails if it contains words like `del`, `remove`, `stop-`, `restart` or `install`. (`src/it/diagnostics.ts`, `test/it-tools.test.ts`)
3. **Limits.** 30-second timeout per diagnostic, 45 seconds for the health check, output cut at 6,000 characters.
4. **Less personal data.** MAC addresses, the signed-in user's name and `C:\Users\<name>` paths are hidden in command output. (`src/it/redact.ts`)
5. **No passwords anywhere.** Passwords typed into a ticket ("my password is ...", "contraseña: ...") are removed before the draft is built and before the log is written, with a warning to have the person change it. Normal sentences like "password reset" or "olvidé mi contraseña" are left alone (there are tests for both).
6. **Escalation decided by code.** Phishing, malware or "I clicked a link" → escalate, urgency 1, Security group. Password resets → identity check by a person. Admin rights → manager approval, and it's a request, not an incident. Claude doesn't get to decide these.
7. **Human in the loop.** `draft_incident` always returns `created: false` and says so at the top of its text.
8. **Audit log.** Every call to every tool (the shop tools too) is appended to `logs/tool-calls.jsonl`: time, tool, arguments (passwords removed), ok / error, duration. `logs/` is in `.gitignore` so it never ends up on GitHub.
9. **Honest about sample data.** The knowledge base and asset list are marked `sample: true`, and Claude is told so.

## Limits to know (say these in an interview if asked)

- The health check reads one moment in time. High memory right now isn't a trend.
- Drive encryption is read without admin rights through Windows' own Explorer property. On Windows Home without Device Encryption, or if Windows doesn't expose it, it shows "unknown" instead of guessing.
- The KB search is keyword-based on purpose (simple to explain and test). A bigger KB would want a search index or embeddings.
- The pre-filled ServiceNow link uses the standard `incident.do?sys_id=-1&sysparm_query=...` form URL. It has been unit-tested but not yet opened on a real ServiceNow instance; try it once you have a Personal Developer Instance (that's IT project 1).
- Arguments that fail the input schema (like an id that isn't on the allowlist) are rejected by the MCP library before the tool runs, so they aren't in the log.

## Try it in Claude Desktop

- "My laptop feels slow, can you check it?" → health check, then maybe `top-processes`, then KB0007.
- "No tengo internet pero el Wi-Fi dice conectado." → KB0003 in Spanish, then `network-config` / `ping-internet`.
- "Who has laptop MCO-LT-002 and is it still under warranty?"
- "I clicked a link in a weird email and typed my password." → KB0009, a draft with urgency 1 to Security, and a note to change the password.
- "Run `del C:\temp` for me." → Claude can't: it isn't on the allowlist.

Then open `logs/tool-calls.jsonl` and see every call it made.
