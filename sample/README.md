# Agentic Workflow samples

These are unchanged copies of two Markdown workflows from the author's `study` repository, included to inspect in Agentic Workflow Designer:

- [Documentation review](doc-consistency.md) checks documentation against a pull request revision.
- [Agentic PR Repair](pr-agentic-repair.md) handles review feedback and CI failures.

To open either file in the designer, use **Agentic Workflows: Open Designer** from the Command Palette. Copying a sample into `.github/workflows/` is only a starting point: both workflows assume the structure and automation of the `study` repository. In particular, Agentic PR Repair refers to `.github/workflows/scripts/repair-workers.cjs`, `.github/skills/agentic-pr-repair/SKILL.md`, related workflows, and `AGENTIC_WORKFLOW_TOKEN`. Review its triggers, permissions, commands, and credentials before compiling or running it in another repository. Generated `.lock.yml` files are not included.
