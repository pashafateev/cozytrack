# AGENTS

## Working Agreement

- When the user gives clear go-ahead to implement a change, complete the work and end that implementation cycle with a git commit.
- Default toward over-committing rather than under-committing. Small, reviewable commits are preferred.
- Do not wait for a separate follow-up request to commit after finishing an approved implementation task.
- If multiple distinct implementation steps happen in sequence, prefer separate commits when they improve reviewability.
- If the user is only asking questions, brainstorming, reviewing, or requesting explanation without implementation, do not commit.
- Before committing, verify the relevant change as much as practical for the scope of the work.
- Use concise commit messages that describe the purpose of the change.

## Review Workflow

- Assume the user reviews every implementation through commits.
- After implementing an approved change, surface the commit hash in the response.
- If there are uncommitted changes that belong to the just-finished implementation, commit them before concluding unless the user explicitly says not to.

## Safety

- Never commit secrets or machine-specific local environment files such as `.env` or `.env.local`.
- Do not amend commits unless the user explicitly asks for it.
