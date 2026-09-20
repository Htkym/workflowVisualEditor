# Compatibility

Form suggestions cover common `gh aw` values. They do not restrict custom or imported values. Editing does not query repository labels or provider model lists.

The extension accepts the installed `gh aw` when its version command succeeds. It compiles in the original repository with that CLI, its existing configuration, and Git context. New CLI versions may change generated output; inspect the `.lock.yml` after compiling.

| Area | Supported forms |
|---|---|
| Metadata | `name`, `description`: ordinary scalar strings |
| Triggers | `workflow_dispatch`, `issues.types`, `pull_request.types`, `schedule[].cron`; add/remove event sections |
| Engine | Scalar ID or mapping with `id` and optional `model` |
| Tools | GitHub enablement, `toolsets`, `read-only`; bash string list; edit boolean/null/empty mapping |
| Permissions | Explicit scopes and values, including restricted `id-token`, `models`, `copilot-requests`, and `all` values; removal never adds permissions |
| Safe outputs | `add-comment`: max/target; `create-issue`: max/title-prefix/labels; `add-labels`: max/allowed; `create-pull-request`: max/title-prefix/draft |
| Limits | `network.allowed` string list; positive integer `timeout-minutes` |
| Imports | Array and `imports.aw` forms, string entries, `path`/`uses` objects; transitive local references; Markdown runtime import references; remote references displayed without fetching |
| Custom jobs | Add/remove `jobs.<id>`; edit scalar `name`, `runs-on`, `if`, and explicit `needs` arrays; edit `on.needs` for jobs that must finish before the agent |
| Generated job settings | Add `jobs.<built-in>.if`, additive `needs`, additive permission scopes, and `timeout-minutes` on `agent`/`detection`; remove individual added settings without deleting the generated job |
| Steps | Add run/uses steps to custom `steps`, `pre-steps`, `setup-steps`, top-level `steps` and `post-steps`; add `pre-steps` and supported `setup-steps`/`steps` to generated jobs; edit scalar name/run/uses/if/shell/working-directory; reorder/remove ordinary sequences |
| Instructions | Preserve Markdown as source; `##` sections outside fenced code and HTML comments become editable, reorderable steps; introductory content stays first |
| Generated graph | Parse current `.lock.yml` jobs/needs and ordered steps before any saved snapshot; label a file that differs from the extension record unverified; no live run status |

The official compiler decides whether a combination is valid. For example, a permission value can exist in the schema but still be rejected under strict mode. The editor does not silently escalate permissions or supply missing scopes.

Edits target the selected Markdown or YAML range and preserve surrounding text. Basic settings retain ordinary scalar quote style. Complex aliases, anchors, merges, and moves involving comments require source editing.

Omitted `needs` can acquire compiler dependencies; explicit `needs: []` means independent execution. The designer edits declared dependencies. Open the generated YAML to inspect the compiler's resolved jobs and step order.

Generated job `needs` augment existing dependencies, `if` combines with the compiler condition, and `permissions` merge with compiler permissions. `setup-steps` are refused for `activation` and `pre_activation`; ordinary `steps` on built-in jobs are offered only for those two jobs. The designer links `safe_outputs` to its feature settings.

Compilation can update the target `.lock.yml`, `.gitattributes`, `.github/aw/actions-lock.json`, and auxiliary files for advanced configurations. Review repository changes after compiling.

Windows desktop and local file workspaces are supported. WSL, SSH, containers, Codespaces, virtual workspaces, and browser VS Code are outside the supported target.
