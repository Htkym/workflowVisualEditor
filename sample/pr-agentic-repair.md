---
name: Agentic PR Repair
description: Repairs actionable Copilot review comments and CI failures until the PR is merge-ready
run-name: "Agentic PR Repair · PR #${{ github.event.pull_request.number || github.event.client_payload.pr_number || github.event.inputs.pr_number || 'unknown' }}"

# CI は Build and test job と Documentation review の完了後、この workflow の
# workflow_dispatch を直接起動する。PR Repair自身は workflow_run trigger を持たない。
on:
  pull_request_review:
    types: [submitted]
    max-stack: -1
  repository_dispatch:
    types: [agentic-repair-reevaluate]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to re-evaluate
        required: true
        type: string
      expected_head_sha:
        description: Expected pull request head SHA
        required: true
        type: string
  bots:
    - copilot
    - copilot-pull-request-reviewer
    - github-copilot
    - github-actions
  roles: [admin, maintainer, write]
  permissions:
    # Central workflow_dispatch validation reads the PR to verify its provenance.
    pull-requests: read

permissions:
  actions: read
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write

engine:
  id: copilot
  max-continuations: 2

model: gpt-5.6-luna

network:
  allowed:
    - defaults
    - github

checkout:
  fetch: ["refs/pulls/open/*"]
  fetch-depth: 0

pre-agent-steps:
  - name: Stage trusted bounded repair worker
    uses: actions/github-script@v9
    with:
      script: |
        const fs = require('node:fs');
        const path = require('node:path');
        const root = path.join(process.env.RUNNER_TEMP, 'gh-aw');
        fs.mkdirSync(root, { recursive: true });
        const statusPath = path.join(root, 'repair-workers-status.json');
        const sequential = reason => {
          core.warning(`Parallel repair disabled: ${reason}. Continue sequential repair.`);
          fs.writeFileSync(statusPath, JSON.stringify({ decision: 'sequential', reason }), { flag: 'wx' });
        };
        // Repository metadata, never event/PR base refs or workflow_sha, selects the trust root.
        const { data: repository } = await github.rest.repos.get(context.repo);
        if (repository.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
            typeof repository.default_branch !== 'string' || !repository.default_branch) {
          throw new Error('Invalid trusted repository metadata');
        }
        const { data: branch } = await github.rest.repos.getBranch({
          ...context.repo, branch: repository.default_branch,
        });
        if (branch.name !== repository.default_branch || !/^[a-f0-9]{40}$/.test(branch.commit?.sha)) {
          throw new Error('Invalid trusted default branch identity');
        }
        if (branch.protected !== true) {
          sequential('repository default branch is not protected');
          return;
        }
        const trustedSha = branch.commit.sha;
        let file;
        try {
          ({ data: file } = await github.rest.repos.getContent({
            ...context.repo, path: '.github/workflows/scripts/repair-workers.cjs', ref: trustedSha,
          }));
        } catch (error) {
          if (error.status !== 404) throw error;
          sequential(`trusted helper absent at default branch SHA ${trustedSha}`);
          return;
        }
        if (file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string') {
          throw new Error('Invalid trusted helper content');
        }
        const source = Buffer.from(file.content, 'base64').toString('utf8');
        if (!source.startsWith("'use strict';\n// repair-workers-protocol: 1\n") &&
            !source.startsWith("'use strict';\r\n// repair-workers-protocol: 1\r\n")) {
          sequential(`trusted helper protocol mismatch at default branch SHA ${trustedSha}; expected 1`);
          return;
        }
        fs.writeFileSync(path.join(root, 'repair-workers.cjs'), source, { flag: 'wx' });
        fs.writeFileSync(statusPath, JSON.stringify({
          decision: 'available', trustedSha, protocol: 1,
        }), { flag: 'wx' });
  - name: Checkout validated pull request head
    uses: actions/checkout@v7
    with:
      ref: ${{ needs.trigger_context.outputs.head_ref }}
      fetch-depth: 0
      persist-credentials: false
  - name: Verify validated pull request head
    env:
      EXPECTED_HEAD_SHA: ${{ needs.trigger_context.outputs.expected_head_sha }}
    run: |
      actual_head_sha="$(git rev-parse HEAD)"
      if [ "$actual_head_sha" != "$EXPECTED_HEAD_SHA" ]; then
        echo "::error::Checked out head $actual_head_sha does not match expected head $EXPECTED_HEAD_SHA."
        exit 1
      fi

post-steps:
  - name: Preserve bounded worker evidence
    if: always()
    uses: actions/upload-artifact@v7
    with:
      name: repair-worker-evidence-${{ github.run_attempt }}
      path: |
        ${{ runner.temp }}/gh-aw/repair-workers-status.json
        /tmp/gh-aw/repair-workers/*/input.json
        /tmp/gh-aw/repair-workers/*/result.json
        /tmp/gh-aw/repair-workers/failure.json
        /tmp/gh-aw/repair-workers/receipt.json
        /tmp/gh-aw/repair-workers/final.patch
      if-no-files-found: ignore
      retention-days: 7

concurrency:
  group: agentic-pr-repair-${{ github.event.pull_request.number || github.event.client_payload.pr_number || github.event.inputs.pr_number || github.run_id }}
  job-discriminator: ${{ github.repository }}-${{ github.event.pull_request.number || github.event.client_payload.pr_number || github.event.inputs.pr_number || github.run_id }}
  cancel-in-progress: false

tools:
  cli-proxy: true
  edit:
  bash:
    - "*"
  github:
    mode: gh-proxy
    toolsets: [pull_requests, repos, actions, issues]

jobs:
  trigger_context:
    name: Capture trusted trigger context
    runs-on: ubuntu-latest
    permissions:
      checks: write
      issues: write
      # PR conversation comments (issues API) require pull-requests: write; read returns 403.
      pull-requests: write
    outputs:
      valid: ${{ steps.context.outputs.valid }}
      trigger_kind: ${{ steps.context.outputs.trigger_kind }}
      event_action: ${{ steps.context.outputs.event_action }}
      target_pr_number: ${{ steps.context.outputs.target_pr_number }}
      expected_head_sha: ${{ steps.context.outputs.expected_head_sha }}
      head_ref: ${{ steps.context.outputs.head_ref }}
      status_check_run_id: ${{ steps.context.outputs.status_check_run_id }}
      status_comment_id: ${{ steps.context.outputs.status_comment_id }}
      review_author: ${{ steps.context.outputs.review_author }}
    steps:
      - name: Validate and capture event fields
        id: context
        uses: actions/github-script@v9
        with:
          script: |
            const payload = context.payload;
            const repository = `${context.repo.owner}/${context.repo.repo}`;
            const allowedReviewAuthors = new Set([
              'copilot-pull-request-reviewer[bot]',
              'github-copilot[bot]',
            ]);
            const isAllowedReviewTrigger = user =>
              user?.type === 'Bot' &&
              (allowedReviewAuthors.has(user.login) ||
                (user.login === 'Copilot' && user.id === 175728472));
            const parsePositiveInteger = value => {
              if (typeof value === 'number') {
                return Number.isSafeInteger(value) && value > 0 ? value : null;
              }
              if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
                return null;
              }
              const number = Number(value);
              return Number.isSafeInteger(number) ? number : null;
            };
            const isCommitSha = value => /^[0-9a-f]{40}$/.test(String(value ?? ''));

            let valid = true;
            let eventAction = '';
            let targetPrNumber = '';
            let expectedHeadSha = '';
            let headRef = '';
            let statusCheckRunId = '';
            let statusCommentId = '';
            let reviewAuthor = '';

            switch (context.eventName) {
              case 'pull_request_review':
                eventAction = payload.action;
                targetPrNumber = payload.pull_request?.number;
                expectedHeadSha = payload.review?.commit_id;
                reviewAuthor = payload.review?.user?.login;
                valid =
                  eventAction === 'submitted' &&
                  parsePositiveInteger(targetPrNumber) !== null &&
                  isCommitSha(expectedHeadSha) &&
                  isAllowedReviewTrigger(payload.review?.user);
                break;

              case 'repository_dispatch': {
                const clientPayload = payload.client_payload ?? {};
                eventAction = payload.action;
                targetPrNumber = clientPayload.pr_number;
                expectedHeadSha = clientPayload.head_sha;
                valid =
                  eventAction === 'agentic-repair-reevaluate' &&
                  clientPayload.repository === repository &&
                  parsePositiveInteger(targetPrNumber) !== null &&
                  isCommitSha(expectedHeadSha);
                break;
              }

              case 'workflow_dispatch':
                targetPrNumber = payload.inputs?.pr_number;
                expectedHeadSha = payload.inputs?.expected_head_sha;
                valid =
                  parsePositiveInteger(targetPrNumber) !== null &&
                  isCommitSha(expectedHeadSha);
                break;

              default:
                valid = false;
                break;
            }

            const canonicalPrNumber = valid ? parsePositiveInteger(targetPrNumber) : null;
            if (valid) {
              const { data: pull } = await github.rest.pulls.get({
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: canonicalPrNumber,
              });
              valid =
                pull.state === 'open' &&
                pull.head.repo?.full_name === repository &&
                pull.head.sha === expectedHeadSha;
              if (valid) {
                headRef = pull.head.ref;
              }
            }

            if (valid) {
              const runUrl =
                `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}` +
                `/actions/runs/${context.runId}`;
              const { data: checkRun } = await github.rest.checks.create({
                owner: context.repo.owner,
                repo: context.repo.repo,
                name: 'Agentic PR Repair Status',
                head_sha: expectedHeadSha,
                status: 'in_progress',
                started_at: new Date().toISOString(),
                details_url: runUrl,
                external_id: `agentic-pr-repair:${context.runId}`,
                output: {
                  title: 'Agentic PR Repairを実行中',
                  summary: `PR #${canonicalPrNumber} のレビューとCI状態を確認しています。`,
                },
              });
              statusCheckRunId = checkRun.id;

              const marker =
                `<!-- agentic-pr-repair-status ` +
                `${JSON.stringify({
                  check_run_id: statusCheckRunId,
                  run_id: Number(context.runId),
                  head_sha: expectedHeadSha,
                })} -->`;
              const body = [
                marker,
                '## Agentic PR Repair Status',
                '',
                '🟡 **実行中 — レビューとCI状態を確認しています**',
                '',
                '| 項目 | 内容 |',
                '| --- | --- |',
                `| Head SHA | \`${expectedHeadSha.slice(0, 12)}\` |`,
                `| Workflow | [実行ログ](${runUrl}) |`,
                `| 最終更新 | ${new Date().toISOString()} |`,
                '',
                '> このコメントはAgentic PR Repairが自動更新します。',
              ].join('\n');
              try {
                const comments = await github.paginate(github.rest.issues.listComments, {
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  issue_number: canonicalPrNumber,
                  per_page: 100,
                });
                const statusComment = comments
                  .filter(
                    comment =>
                      comment.user?.login === 'github-actions[bot]' &&
                      comment.user?.type === 'Bot' &&
                      comment.body?.includes('<!-- agentic-pr-repair-status '),
                  )
                  .at(-1);

                if (statusComment) {
                  const { data: currentComment } = await github.rest.issues.getComment({
                    ...context.repo, comment_id: statusComment.id,
                  });
                  const currentMarker = currentComment.body?.match(
                    /^<!-- agentic-pr-repair-status (\{[^\r\n]*\}) -->/,
                  );
                  const statusOwner = currentMarker ? JSON.parse(currentMarker[1]) : null;
                  if (
                    currentComment.user?.login !== 'github-actions[bot]' ||
                    currentComment.user?.type !== 'Bot' ||
                    !Number.isSafeInteger(statusOwner?.run_id) || statusOwner.run_id <= 0 ||
                    !Number.isSafeInteger(statusOwner?.check_run_id) || statusOwner.check_run_id <= 0 ||
                    !isCommitSha(statusOwner?.head_sha)
                  ) {
                    throw new Error('The existing PR status marker has invalid ownership.');
                  }
                  statusCommentId = statusComment.id;
                  if (statusOwner.run_id > Number(context.runId)) {
                    core.notice('Preserving the newer PR status while continuing this run.');
                  } else {
                    await github.rest.issues.updateComment({
                      owner: context.repo.owner,
                      repo: context.repo.repo,
                      comment_id: statusComment.id,
                      body,
                    });
                  }
                } else {
                  const { data: createdComment } = await github.rest.issues.createComment({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: canonicalPrNumber,
                    body,
                  });
                  statusCommentId = createdComment.id;
                }
              } catch (error) {
                const title = 'AWステータスの初期化に失敗しました';
                const summary =
                  '固定コメントを更新できませんでした。Workflowログを確認してください。';
                try {
                  await github.rest.checks.update({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    check_run_id: statusCheckRunId,
                    status: 'completed',
                    conclusion: 'failure',
                    completed_at: new Date().toISOString(),
                    details_url: runUrl,
                    output: { title, summary },
                  });
                } catch (cleanupError) {
                  core.warning(
                    `Failed to finalize status check ${statusCheckRunId}: ${cleanupError.message}`,
                  );
                }
                core.setFailed(`Failed to synchronize the PR status comment: ${error.message}`);
                return;
              }
            }

            core.setOutput('valid', String(valid));
            core.setOutput('trigger_kind', valid ? context.eventName : '');
            core.setOutput('event_action', valid ? eventAction : '');
            core.setOutput('target_pr_number', valid ? String(canonicalPrNumber) : '');
            core.setOutput('expected_head_sha', valid ? expectedHeadSha : '');
            core.setOutput('head_ref', valid ? headRef : '');
            core.setOutput('status_check_run_id', valid ? String(statusCheckRunId) : '');
            core.setOutput('status_comment_id', valid ? String(statusCommentId) : '');
            core.setOutput('review_author', valid ? reviewAuthor : '');

            if (!valid) {
              core.warning(`Ignoring invalid ${context.eventName} trigger context.`);
            }

  triage:
    name: Triage review threads and required checks
    # pre_activation を明示的に依存へ含めることで、gh-aw が triage outputs を
    # Agent prompt の runtime placeholders として生成する。
    needs: [pre_activation, trigger_context]
    if: needs.trigger_context.outputs.valid == 'true'
    runs-on: ubuntu-latest
    permissions:
      checks: read
      contents: read
      pull-requests: read
      statuses: read
    outputs:
      decision: ${{ steps.triage.outputs.decision }}
      required_checks: ${{ steps.triage.outputs.required_checks }}
      failed_checks: ${{ steps.triage.outputs.failed_checks }}
      attention_checks: ${{ steps.triage.outputs.attention_checks }}
      pending_checks: ${{ steps.triage.outputs.pending_checks }}
      failed_checks_json: ${{ steps.triage.outputs.failed_checks_json }}
      observed_threads_json: ${{ steps.triage.outputs.observed_threads_json }}
      unresolved_thread_count: ${{ steps.triage.outputs.unresolved_thread_count }}
      untrusted_thread_author: ${{ steps.triage.outputs.untrusted_thread_author }}
      stale_reason: ${{ steps.triage.outputs.stale_reason }}
      # pre_activation の role/bot 判定を、agent / triage_finalizer が直接
      # pre_activation へ依存せずに参照できるよう、triage 経由でパススルーする
      # （agent / triage_finalizer から pre_activation へ直接 needs を張ると、
      # gh-aw の activation auto-injection と衝突し job dependency cycle になるため）。
      activated: ${{ needs.pre_activation.outputs.activated }}
    steps:
      - name: Evaluate unresolved review threads and required checks
        id: triage
        uses: actions/github-script@v9
        env:
          TARGET_PR_NUMBER: ${{ needs.trigger_context.outputs.target_pr_number }}
          EXPECTED_HEAD_SHA: ${{ needs.trigger_context.outputs.expected_head_sha }}
        with:
          script: |
            // Required check 名の正準定義。prompt と finalizer は required_checks output を参照する。
            const REQUIRED_CHECKS = [
              'Build and test',
              'Documentation consistency',
            ];
            const ALLOWED_REVIEW_AUTHORS = new Set([
              'copilot-pull-request-reviewer[bot]',
              'github-copilot[bot]',
            ]);
            const isAllowedReviewAuthor = author =>
              ALLOWED_REVIEW_AUTHORS.has(author?.login) ||
              (
                author?.__typename === 'Bot' &&
                author.id === 'BOT_kgDOCnlnWA'
              );
            // failure 系として扱う check conclusion。neutral・skipped は人手判断が必要な
            // attention として扱う（skipped は上流check失敗に伴う派生状態で終端的に
            // 変化しないため、pending にすると waiting のまま停止し Agent が起動されない）。
            const FAILURE_CONCLUSIONS = new Set([
              'failure',
              'cancelled',
              'timed_out',
              'action_required',
              'startup_failure',
              'stale',
            ]);

            const repository = `${context.repo.owner}/${context.repo.repo}`;
            const prNumber = Number(process.env.TARGET_PR_NUMBER);
            const expectedHeadSha = String(process.env.EXPECTED_HEAD_SHA ?? '');
            const emit = (decision, extra = {}) => {
              core.setOutput('decision', decision);
              core.setOutput('required_checks', REQUIRED_CHECKS.join(','));
              core.setOutput('failed_checks', (extra.failed ?? []).join(','));
              core.setOutput('attention_checks', (extra.attention ?? []).join(','));
              core.setOutput('pending_checks', (extra.pending ?? []).join(','));
              core.setOutput('failed_checks_json', JSON.stringify(extra.failedDetails ?? []));
              // This output is the immutable, trusted review baseline for this run/PR/head.
              // It intentionally contains every unresolved thread and every comment ID, not
              // merely the subset the Agent later elects to handle.
              core.setOutput('observed_threads_json', JSON.stringify(extra.observedThreads ?? []));
              core.setOutput('unresolved_thread_count', String(extra.unresolvedCount ?? 0));
              core.setOutput(
                'untrusted_thread_author',
                extra.untrustedAuthor === true ? 'true' : 'false',
              );
              core.setOutput('stale_reason', extra.staleReason ?? '');
              core.notice(`Agentic PR Repair triage decision: ${decision}`);
            };

            if (
              !Number.isSafeInteger(prNumber) ||
              prNumber <= 0 ||
              !/^[0-9a-f]{40}$/.test(expectedHeadSha)
            ) {
              core.setFailed('Triage received an invalid pull request number or head SHA.');
              return;
            }

            // 判断の直前に same-repository / open / current head SHA を再検証する。
            const { data: pull } = await github.rest.pulls.get({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: prNumber,
            });
            if (
              pull.state !== 'open' ||
              pull.head.repo?.full_name !== repository ||
              pull.head.sha !== expectedHeadSha
            ) {
              // stale の理由を区別し、finalizer が誤解を招くメッセージを出さないようにする。
              const staleReason =
                pull.state !== 'open'
                  ? 'closed'
                  : pull.head.repo?.full_name !== repository
                    ? 'fork'
                    : 'head_sha_mismatch';
              emit('stale', { staleReason });
              return;
            }

            async function listThreadComments(threadId, initialConnection) {
              const comments = [...initialConnection.nodes];
              let after = initialConnection.pageInfo.hasNextPage
                ? initialConnection.pageInfo.endCursor
                : null;
              while (after) {
                const result = await github.graphql(
                  `query($threadId: ID!, $after: String) {
                    node(id: $threadId) {
                      ... on PullRequestReviewThread {
                        comments(first: 100, after: $after) {
                          nodes {
                            id
                            author {
                              login
                              __typename
                              ... on Bot { id }
                            }
                          }
                          pageInfo { hasNextPage endCursor }
                        }
                      }
                    }
                  }`,
                  { threadId, after },
                );
                const connection = result.node?.comments;
                if (!connection) {
                  throw new Error('Missing triage comment connection.');
                }
                comments.push(...connection.nodes);
                after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
                if (connection.pageInfo.hasNextPage && !after) throw new Error('Missing triage comment cursor.');
              }
              return comments;
            }

            const unresolvedThreads = [];
            let threadCursor = null;
            do {
              const result = await github.graphql(
                `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
                  repository(owner: $owner, name: $repo) {
                    pullRequest(number: $pr) {
                      reviewThreads(first: 50, after: $after) {
                        nodes {
                          id
                          isResolved
                          comments(first: 100) {
                            nodes {
                              id
                              author {
                                login
                                __typename
                                ... on Bot { id }
                              }
                            }
                            pageInfo { hasNextPage endCursor }
                          }
                        }
                        pageInfo { hasNextPage endCursor }
                      }
                    }
                  }
                }`,
                {
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  pr: prNumber,
                  after: threadCursor,
                },
              );
              const connection = result.repository.pullRequest.reviewThreads;
              for (const thread of connection.nodes) {
                if (thread.isResolved) {
                  continue;
                }
                unresolvedThreads.push({
                  id: thread.id,
                  comments: await listThreadComments(thread.id, thread.comments),
                });
              }
              threadCursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
              if (connection.pageInfo.hasNextPage && !threadCursor) throw new Error('Missing triage thread cursor.');
            } while (threadCursor);

            // allowlist 外 author の最終的な blocked-human-review 判定は Agent 側で行う。
            const untrustedAuthor = unresolvedThreads.some(thread =>
              thread.comments.some(
                comment => !isAllowedReviewAuthor(comment.author),
              ),
            );

            const checkRuns = await github.paginate(github.rest.checks.listForRef, {
              owner: context.repo.owner,
              repo: context.repo.repo,
              ref: expectedHeadSha,
              filter: 'latest',
              per_page: 100,
            });
            // check run と commit status context を同一の時系列へ統合する。
            const commitStatuses = await github.paginate(
              github.rest.repos.listCommitStatusesForRef,
              {
                owner: context.repo.owner,
                repo: context.repo.repo,
                ref: expectedHeadSha,
                per_page: 100,
              },
            );
            const timestampOf = result =>
              Date.parse(
                result.completed_at ?? result.started_at ??
                result.updated_at ?? result.created_at ?? '',
              ) || 0;
            const latestCheckByName = new Map();
            const recordLatest = (kind, name, value) => {
              const candidate = { kind, value, timestamp: timestampOf(value) };
              const current = latestCheckByName.get(name);
              if (
                !current ||
                candidate.timestamp > current.timestamp ||
                (candidate.timestamp === current.timestamp && (
                  (candidate.kind === 'check_run' && current.kind !== 'check_run') ||
                  (candidate.kind === current.kind &&
                    Number(candidate.value.id) > Number(current.value.id))
                ))
              ) {
                latestCheckByName.set(name, candidate);
              }
            };
            for (const run of checkRuns) recordLatest('check_run', run.name, run);
            for (const status of commitStatuses) recordLatest('commit_status', status.context, status);

            const failed = [];
            const attention = [];
            const pending = [];
            const failedDetails = [];
            for (const name of REQUIRED_CHECKS) {
              const latest = latestCheckByName.get(name);
              if (!latest) {
                // current head SHA 上に未作成の required check は waiting 扱い。
                pending.push(name);
                continue;
              }

              if (latest.kind === 'check_run') {
                const checkRun = latest.value;
                if (checkRun.status !== 'completed') {
                  pending.push(name);
                  continue;
                }
                if (checkRun.conclusion === 'success') {
                  continue;
                }
                if (FAILURE_CONCLUSIONS.has(checkRun.conclusion)) {
                  const workflowRunId = Number(
                    /\/actions\/runs\/(\d+)/.exec(checkRun.details_url ?? '')?.[1] ?? 0,
                  );
                  failed.push(name);
                  failedDetails.push({
                    name,
                    conclusion: checkRun.conclusion,
                    check_run_id: checkRun.id,
                    workflow_run_id: Number.isSafeInteger(workflowRunId) && workflowRunId > 0
                      ? workflowRunId
                      : null,
                  });
                  continue;
                }
                // skipped は success へ自然遷移しない終端状態のため pending にせず、
                // attention として Agent の判断に委ねる（waiting のまま停止させない）。
                attention.push(name);
                continue;
              }

              const status = latest.value;
              if (status.state === 'pending') {
                pending.push(name);
                continue;
              }
              if (status.state === 'success') continue;
              failed.push(name);
              failedDetails.push({
                name,
                conclusion: status.state,
                check_run_id: null,
                workflow_run_id: null,
              });
            }

            let mergeability = pull;
            for (let retry = 0; mergeability.mergeable === null && retry < 2; retry++) {
              ({ data: mergeability } = await github.rest.pulls.get({
                ...context.repo, pull_number: prNumber,
              }));
              if (mergeability.head.sha !== expectedHeadSha) {
                emit('stale', { staleReason: 'head_sha_mismatch' });
                return;
              }
            }
            let decision;
            if (!untrustedAuthor && mergeability.mergeable === false) {
              decision = 'blocked-base-conflict';
            } else if (!untrustedAuthor && mergeability.mergeable === null) {
              decision = 'waiting';
            } else if (
              unresolvedThreads.length > 0 ||
              untrustedAuthor ||
              failed.length > 0 ||
              attention.length > 0
            ) {
              decision = 'agent';
            } else if (pending.length > 0) {
              decision = 'waiting';
            } else {
              decision = 'success';
            }

            core.info(
              `unresolved threads: ${unresolvedThreads.length}, failed: [${failed.join(', ')}], ` +
              `attention: [${attention.join(', ')}], pending: [${pending.join(', ')}]`,
            );
            emit(decision, {
              failed,
              attention,
              pending,
              failedDetails,
              unresolvedCount: unresolvedThreads.length,
              untrustedAuthor,
              observedThreads: unresolvedThreads.map(thread => ({
                thread_id: thread.id,
                comment_ids: thread.comments.map(comment => comment.id),
              })),
            });
      - name: Preserve trusted review baseline
        if: steps.triage.outputs.decision == 'agent'
        uses: actions/github-script@v9
        env:
          TRUSTED_OBSERVED_THREADS_JSON: ${{ steps.triage.outputs.observed_threads_json }}
          FAILED_CHECKS: ${{ steps.triage.outputs.failed_checks }}
          ATTENTION_CHECKS: ${{ steps.triage.outputs.attention_checks }}
        with:
          script: |
            require('fs').writeFileSync(
              `${process.env.RUNNER_TEMP}/repair-trusted-observed-threads.json`,
              process.env.TRUSTED_OBSERVED_THREADS_JSON,
            );
            require('fs').writeFileSync(
              `${process.env.RUNNER_TEMP}/repair-trusted-checks.json`,
              JSON.stringify({
                failed: process.env.FAILED_CHECKS.split(',').filter(Boolean),
                attention: process.env.ATTENTION_CHECKS.split(',').filter(Boolean),
              }),
            );
      - name: Upload trusted review baseline
        if: steps.triage.outputs.decision == 'agent'
        uses: actions/upload-artifact@v7
        with:
          name: repair-trusted-review-baseline-${{ github.run_attempt }}
          path: |
            ${{ runner.temp }}/repair-trusted-observed-threads.json
            ${{ runner.temp }}/repair-trusted-checks.json
          if-no-files-found: error

  triage_finalizer:
    name: Finalize deterministic triage outcome
    needs: [trigger_context, triage, agent]
    # Agent を起動しない run でも Status Check と固定コメントを in_progress のまま残さない。
    # pre_activation が非アクティブ（role/bot 判定で無効化、triage 経由でパススルー）な
    # run は、Status Check/固定コメント更新や通知処理を一切行わずスキップする。
    if: >-
      always() &&
      needs.trigger_context.outputs.valid == 'true' &&
      needs.triage.outputs.activated == 'true' &&
      needs.agent.result == 'skipped'
    runs-on: ubuntu-latest
    permissions:
      checks: write
      issues: write
      statuses: read
      # PR conversation comments (issues API) require pull-requests: write; read returns 403.
      pull-requests: write
    steps:
      - name: Complete PR status without the agent
        uses: actions/github-script@v9
        env:
          TRIAGE_RESULT: ${{ needs.triage.result }}
          TRIAGE_DECISION: ${{ needs.triage.outputs.decision }}
          PENDING_CHECKS: ${{ needs.triage.outputs.pending_checks }}
          REQUIRED_CHECKS: ${{ needs.triage.outputs.required_checks }}
          STALE_REASON: ${{ needs.triage.outputs.stale_reason }}
          STATUS_CHECK_RUN_ID: ${{ needs.trigger_context.outputs.status_check_run_id }}
          STATUS_COMMENT_ID: ${{ needs.trigger_context.outputs.status_comment_id }}
          TARGET_PR_NUMBER: ${{ needs.trigger_context.outputs.target_pr_number }}
          EXPECTED_HEAD_SHA: ${{ needs.trigger_context.outputs.expected_head_sha }}
        with:
          script: |
            const checkRunId = Number(process.env.STATUS_CHECK_RUN_ID);
            const commentId = Number(process.env.STATUS_COMMENT_ID);
            const prNumber = Number(process.env.TARGET_PR_NUMBER);
            const headSha = String(process.env.EXPECTED_HEAD_SHA ?? '');
            if (
              !Number.isSafeInteger(checkRunId) || checkRunId <= 0 ||
              !Number.isSafeInteger(commentId) || commentId <= 0 ||
              !Number.isSafeInteger(prNumber) || prNumber <= 0 ||
              !/^[0-9a-f]{40}$/.test(headSha)
            ) {
              core.setFailed('Agentic PR Repair status identifiers are invalid.');
              return;
            }

            const triageResult = process.env.TRIAGE_RESULT ?? '';
            const decision = process.env.TRIAGE_DECISION ?? '';
            const pendingChecks = (process.env.PENDING_CHECKS ?? '')
              .split(',')
              .map(name => name.trim())
              .filter(name => name.length > 0);
            const runUrl =
              `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}` +
              `/actions/runs/${context.runId}`;

            const repository = `${context.repo.owner}/${context.repo.repo}`;
            const allowedAuthors = new Set([
              'copilot-pull-request-reviewer[bot]',
              'github-copilot[bot]',
            ]);
            const isAllowedAuthor = author =>
              author?.__typename === 'Bot' &&
              (allowedAuthors.has(author.login) || author.id === 'BOT_kgDOCnlnWA');
            const requiredChecks = String(process.env.REQUIRED_CHECKS ?? '')
              .split(',')
              .map(name => name.trim())
              .filter(Boolean);
            if (requiredChecks.length === 0) {
              throw new Error('Fresh success validation received no required check names.');
            }

            async function evaluateFreshSuccess() {
              const isStale = pull =>
                pull.state !== 'open'
                  ? 'closed'
                  : pull.head.repo?.full_name !== repository
                    ? 'fork'
                    : pull.head.sha !== headSha
                      ? 'head_sha_mismatch'
                      : '';
              const { data: initialPr } = await github.rest.pulls.get({
                ...context.repo, pull_number: prNumber,
              });
              const initialStaleReason = isStale(initialPr);
              if (initialStaleReason) return { kind: 'stale', reason: initialStaleReason };

              const reviewAuthors = [];
              let threadCursor = null;
              do {
                const result = await github.graphql(
                  `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
                    repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
                      reviewThreads(first: 100, after: $after) {
                        nodes {
                          id
                          isResolved
                          comments(first: 100) {
                            nodes { author { login __typename ... on Bot { id } } }
                            pageInfo { hasNextPage endCursor }
                          }
                        }
                        pageInfo { hasNextPage endCursor }
                      }
                    } }
                  }`,
                  { ...context.repo, pr: prNumber, after: threadCursor },
                );
                const connection = result.repository?.pullRequest?.reviewThreads;
                if (!connection) throw new Error('Missing fresh review thread connection.');
                for (const thread of connection.nodes.filter(thread => !thread.isResolved)) {
                  if (!thread.id) throw new Error('Fresh unresolved review thread has no ID.');
                  const comments = [...thread.comments.nodes];
                  let commentCursor = thread.comments.pageInfo.hasNextPage
                    ? thread.comments.pageInfo.endCursor
                    : null;
                  while (commentCursor) {
                    const result = await github.graphql(
                      `query($threadId: ID!, $after: String) {
                        node(id: $threadId) { ... on PullRequestReviewThread {
                          comments(first: 100, after: $after) {
                            nodes { author { login __typename ... on Bot { id } } }
                            pageInfo { hasNextPage endCursor }
                          }
                        } }
                      }`,
                      { threadId: thread.id, after: commentCursor },
                    );
                    const commentsPage = result.node?.comments;
                    if (!commentsPage) throw new Error('Missing fresh review comment connection.');
                    comments.push(...commentsPage.nodes);
                    commentCursor = commentsPage.pageInfo.hasNextPage
                      ? commentsPage.pageInfo.endCursor
                      : null;
                    if (commentsPage.pageInfo.hasNextPage && !commentCursor) {
                      throw new Error('Missing fresh review comment cursor.');
                    }
                  }
                  if (comments.length === 0) throw new Error('Fresh review thread has no comments.');
                  reviewAuthors.push(...comments.map(comment => comment.author));
                }
                threadCursor = connection.pageInfo.hasNextPage
                  ? connection.pageInfo.endCursor
                  : null;
                if (connection.pageInfo.hasNextPage && !threadCursor) {
                  throw new Error('Missing fresh review thread cursor.');
                }
              } while (threadCursor);

              const checkRuns = await github.paginate(github.rest.checks.listForRef, {
                ...context.repo, ref: headSha, filter: 'latest', per_page: 100,
              });
              const statuses = await github.paginate(
                github.rest.repos.listCommitStatusesForRef,
                { ...context.repo, ref: headSha, per_page: 100 },
              );
              const latestByName = new Map();
              const timestampOf = result =>
                Date.parse(
                  result.completed_at ?? result.started_at ??
                  result.updated_at ?? result.created_at ?? '',
                ) || 0;
              const recordLatest = (kind, name, value) => {
                const candidate = { kind, value, timestamp: timestampOf(value) };
                const current = latestByName.get(name);
                if (
                  !current ||
                  candidate.timestamp > current.timestamp ||
                  (candidate.timestamp === current.timestamp && (
                    (candidate.kind === 'check_run' && current.kind !== 'check_run') ||
                    (candidate.kind === current.kind &&
                      Number(candidate.value.id) > Number(current.value.id))
                  ))
                ) {
                  latestByName.set(name, candidate);
                }
              };
              for (const run of checkRuns) recordLatest('check_run', run.name, run);
              for (const status of statuses) {
                recordLatest('commit_status', status.context, status);
              }

              const unsatisfiedChecks = [];
              for (const name of requiredChecks) {
                const latest = latestByName.get(name);
                if (
                  !latest ||
                  (latest.kind === 'check_run'
                    ? latest.value.status !== 'completed' || latest.value.conclusion !== 'success'
                    : latest.value.state !== 'success')
                ) {
                  unsatisfiedChecks.push(name);
                }
              }

              const { data: currentPr } = await github.rest.pulls.get({
                ...context.repo, pull_number: prNumber,
              });
              const staleReason = isStale(currentPr);
              if (staleReason) return { kind: 'stale', reason: staleReason };
              if (reviewAuthors.some(author => !isAllowedAuthor(author))) {
                return { kind: 'blocked-human-review' };
              }
              if (currentPr.mergeable === false) return { kind: 'blocked-base-conflict' };
              if (currentPr.mergeable !== true) return { kind: 'waiting', checks: [] };
              if (reviewAuthors.length > 0) return { kind: 'waiting', checks: [] };
              if (unsatisfiedChecks.length > 0) {
                return { kind: 'waiting', checks: unsatisfiedChecks };
              }
              return { kind: 'success' };
            }

            let conclusion = 'failure';
            let icon = '🔴';
            let title = 'AWの実行に失敗しました';
            let summary =
              '決定的トリアージが完了しませんでした。Workflowログを確認し、原因を解消してから再実行してください。';
            let notifySuccess = false;
            let notificationOutcome = null;
            let failureMessage =
              'Deterministic triage did not produce a supported terminal decision.';

            if (triageResult === 'success' && decision === 'success') {
              const fresh = await evaluateFreshSuccess();
              failureMessage = '';
              if (fresh.kind === 'success') {
                conclusion = 'success';
                icon = '🟢';
                title = 'AW完了 — マージ可能です';
                summary = 'レビュー指摘とRequired Checkがすべて解消されました。';
                notifySuccess = true;
                notificationOutcome = 'success';
              } else if (fresh.kind === 'blocked-human-review') {
                conclusion = 'action_required';
                icon = '🟠';
                title = '人間によるレビュー対応が必要です';
                summary =
                  'Copilot以外の投稿を含む未解決レビューがあります。内容を確認して解決し、最新のHeadで再評価してください。';
                notifySuccess = true;
                notificationOutcome = 'blocked-human-review';
              } else if (fresh.kind === 'blocked-base-conflict') {
                conclusion = 'action_required';
                icon = '🟠';
                title = 'baseとの競合 — 手動解消が必要です';
                summary =
                  'baseとの競合を手動で解消してpushしてください。synchronizeイベントで最新Headを再評価します。自動merge/rebaseは行いません。';
                notifySuccess = true;
                notificationOutcome = 'blocked-base-conflict';
              } else if (fresh.kind === 'stale') {
                conclusion = 'neutral';
                icon = '⚪';
                title = fresh.reason === 'closed'
                  ? 'PRがクローズされました'
                  : fresh.reason === 'fork'
                    ? 'PRのHead参照リポジトリが一致しません'
                    : 'PR Headが更新されました';
                summary = fresh.reason === 'closed'
                  ? '評価対象のPRがクローズまたはマージされたため、変更を加えずに終了しました。'
                  : fresh.reason === 'fork'
                    ? '評価対象のPRのHeadリポジトリが同一リポジトリではないため、変更を加えずに終了しました。'
                    : '評価対象のHead SHAが最新ではないため、success通知を停止しました。最新のイベントで再評価します。';
              } else {
                conclusion = 'neutral';
                icon = '🟡';
                title = 'CIまたはレビュー待ちです';
                summary = fresh.checks?.length
                  ? `Required Checkの最新状態が変わりました。次のCIまたはレビューイベントで再評価します: ${fresh.checks.join(', ')}`
                  : 'レビュー、CI、またはmergeabilityの状態が変わりました。次のイベントで再評価します。';
              }
            } else if (triageResult === 'success' && decision === 'waiting') {
              conclusion = 'neutral';
              icon = '🟡';
              title = 'CIまたはレビュー待ちです';
              summary = pendingChecks.length > 0
                ? `次のRequired Checkの完了を待っています: ${pendingChecks.join(', ')}`
                : '次のCIまたはCopilot Reviewイベントで自動的に再評価します。';
              failureMessage = '';
            } else if (triageResult === 'success' && decision === 'blocked-base-conflict') {
              conclusion = 'action_required';
              icon = '🟠';
              title = 'baseとの競合 — 手動解消が必要です';
              summary = 'baseとの競合を手動で解消してpushしてください。synchronizeイベントで最新Headを再評価します。自動merge/rebaseは行いません。';
              notifySuccess = true;
              notificationOutcome = 'blocked-base-conflict';
              failureMessage = '';
            } else if (triageResult === 'success' && decision === 'stale') {
              conclusion = 'neutral';
              icon = '⚪';
              // stale の実際の理由（closed / fork / head SHA不一致）によって
              // 誤解を招かないタイトル・サマリーを出し分ける。
              const staleReason = process.env.STALE_REASON ?? '';
              if (staleReason === 'closed') {
                title = 'PRがクローズされました';
                summary =
                  '評価対象のPRがクローズまたはマージされたため、変更を加えずに終了しました。';
              } else if (staleReason === 'fork') {
                title = 'PRのHead参照リポジトリが一致しません';
                summary =
                  '評価対象のPRのHeadリポジトリが同一リポジトリではないため、変更を加えずに終了しました。';
              } else {
                title = 'PR Headが更新されました';
                summary =
                  '評価対象のHead SHAが最新ではないため、変更を加えずに終了しました。最新のイベントで再評価します。';
              }
              failureMessage = '';
            } else if (triageResult === 'success' && decision === 'agent') {
              summary =
                '修復対象を検出しましたがAgentを起動できませんでした。Workflowの制限・認証・利用量を確認して再実行してください。';
              failureMessage =
                'The agent was required by deterministic triage but was skipped before execution.';
            }

            let attempt = null;
            if (notifySuccess && notificationOutcome === 'blocked-base-conflict') {
              let after = null;
              let human = false;
              do {
                const result = await github.graphql(
                  `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
                    repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
                      reviewThreads(first: 100, after: $after) {
                        nodes { id isResolved } pageInfo { hasNextPage endCursor }
                      }
                    } }
                  }`, { ...context.repo, pr: prNumber, after },
                );
                const connection = result.repository.pullRequest.reviewThreads;
                for (const thread of connection.nodes.filter(thread => !thread.isResolved)) {
                  let cursor = null;
                  do {
                    const result = await github.graphql(
                      `query($threadId: ID!, $after: String) { node(id: $threadId) {
                        ... on PullRequestReviewThread { comments(first: 100, after: $after) {
                          nodes { author { login __typename ... on Bot { id } } }
                          pageInfo { hasNextPage endCursor }
                        } }
                      } }`, { threadId: thread.id, after: cursor },
                    );
                    const comments = result.node.comments;
                    human ||= comments.nodes.some(({ author }) => !(author?.__typename === 'Bot' && (
                      ['copilot-pull-request-reviewer[bot]', 'github-copilot[bot]'].includes(author.login) ||
                      (['Copilot', 'copilot-pull-request-reviewer', 'github-copilot'].includes(author.login) &&
                        author.id === 'BOT_kgDOCnlnWA')
                    )));
                    cursor = comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : null;
                    if (comments.pageInfo.hasNextPage && !cursor) throw new Error('Missing conflict comment cursor.');
                  } while (cursor);
                }
                after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
                if (connection.pageInfo.hasNextPage && !after) throw new Error('Missing conflict thread cursor.');
              } while (after);
              const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: prNumber });
              if (human) {
                notifySuccess = false;
                notificationOutcome = null;
                conclusion = 'action_required';
                icon = '🟠';
                title = '人間によるレビュー対応が必要です';
                summary =
                  'Copilot以外の投稿を含む未解決レビューがあります。内容を確認して解決し、最新のHeadで再評価してください。';
                notificationOutcome = 'blocked-human-review';
              } else if (current.state !== 'open' || current.head.sha !== headSha ||
                current.head.repo?.full_name !== repository || current.mergeable !== false
              ) {
                notifySuccess = false;
                notificationOutcome = null;
                conclusion = 'neutral';
                title = 'PR状態更新 — 競合通知を停止しました';
                summary = 'レビューまたはHead/競合状態が変わりました。最新のPR状態を確認してください。';
              }
            }
            if (notifySuccess) {
              try {
                const outcome = notificationOutcome;
                const deliveryKey =
                  `${context.repo.owner}/${context.repo.repo}/${prNumber}/${headSha}/${outcome}`;
                const notificationMarker =
                  `<!-- agentic-pr-repair-notification ${deliveryKey} -->`;
                const markerAuthorLogin = 'github-actions[bot]';
                const comments = await github.paginate(github.rest.issues.listComments, {
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  issue_number: prNumber,
                  per_page: 100,
                });
                let markerAttempt = 0;
                for (const comment of comments) {
                  if (
                    comment.user?.login !== markerAuthorLogin ||
                    comment.user?.type !== 'Bot' ||
                    !comment.body?.startsWith('<!-- agentic-pr-repair-state ')
                  ) continue;
                  const match = comment.body.match(
                    /^<!-- agentic-pr-repair-state (\{[^\r\n]*\}) -->/
                  );
                  if (!match) continue;
                  try {
                    const marker = JSON.parse(match[1]);
                    if (
                      marker.workflow === 'agentic-pr-repair' &&
                      Number.isInteger(marker.attempt)
                    ) {
                      markerAttempt = Math.max(markerAttempt, marker.attempt);
                    }
                  } catch {
                    // Ignore malformed comments instead of trusting them as state.
                  }
                }
                attempt = markerAttempt;

                if (comments.some(comment =>
                  comment.user?.login === markerAuthorLogin &&
                  comment.user?.type === 'Bot' &&
                  comment.body?.includes(notificationMarker)
                )) {
                  core.info(`Notification already recorded for ${deliveryKey}.`);
                } else {
                  await github.rest.issues.createComment({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: prNumber,
                    body: [
                      notificationMarker,
                      '## Agentic PR Repair 通知',
                      '',
                      `${outcome === 'success' ? '🟢' : '🟠'} **${outcome}**`,
                      '',
                      summary,
                      '',
                      `- Head SHA: \`${headSha}\``,
                      `- Repair attempts: ${attempt}/5`,
                      `- Workflow: [実行ログ](${runUrl})`,
                    ].join('\n'),
                  });
                }
              } catch {
                failureMessage = 'PR notification comment failed. See workflow logs for details.';
                conclusion = 'failure';
                icon = '🔴';
                title = 'AWの実行に失敗しました';
                summary = 'PRへの通知コメント投稿に失敗しました。Workflowログを確認してください。';
              }
            }

            const marker =
              `<!-- agentic-pr-repair-status ` +
              `${JSON.stringify({
                check_run_id: checkRunId,
                run_id: Number(context.runId),
                head_sha: headSha,
              })} -->`;
            const body = [
              marker,
              '## Agentic PR Repair Status',
              '',
              `${icon} **${title}**`,
              '',
              summary,
              '',
              '| 項目 | 内容 |',
              '| --- | --- |',
              `| Head SHA | \`${headSha.slice(0, 12)}\` |`,
              ...(attempt === null ? [] : [`| Repair attempt | ${attempt}/5 |`]),
              `| Workflow | [実行ログ](${runUrl}) |`,
              `| 最終更新 | ${new Date().toISOString()} |`,
              '',
              '> このコメントはAgentic PR Repairが自動更新します。',
            ].join('\n');

            await github.rest.checks.update({
              owner: context.repo.owner,
              repo: context.repo.repo,
              check_run_id: checkRunId,
              status: 'completed',
              conclusion,
              completed_at: new Date().toISOString(),
              details_url: runUrl,
              output: { title, summary },
            });
            if (failureMessage) {
              core.setFailed(failureMessage);
            }
            const { data: currentComment } = await github.rest.issues.getComment({
              ...context.repo, comment_id: commentId,
            });
            const currentMarker = currentComment.body?.match(
              /^<!-- agentic-pr-repair-status (\{[^\r\n]*\}) -->/,
            );
            const statusOwner = currentMarker ? JSON.parse(currentMarker[1]) : null;
            const { data: currentPr } = await github.rest.pulls.get({
              ...context.repo, pull_number: prNumber,
            });
            if (
              currentComment.user?.login !== 'github-actions[bot]' ||
              currentComment.user?.type !== 'Bot' ||
              statusOwner?.run_id !== Number(context.runId) ||
              statusOwner?.head_sha !== headSha ||
              currentPr.head.sha !== headSha
            ) {
              core.notice('Completed this run check without overwriting a newer PR status.');
              return;
            }
            await github.rest.issues.updateComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              comment_id: commentId,
              body,
            });

  agent:
    needs: [trigger_context, triage]
    # unresolved thread か failure 系 check がある場合だけ AI 推論を起動する。
    # pre_activation の role/bot 判定（triage 経由でパススルー）を明示チェックし、
    # 非アクティブ時は agent を確実にスキップする。
    if: >-
      needs.triage.outputs.activated == 'true' &&
      needs.trigger_context.outputs.valid == 'true' &&
      needs.triage.outputs.decision == 'agent'

  safe_outputs:
    needs: [repair_guard, detection]
    if: >-
      needs.repair_guard.outputs.guard_result == 'allowed' &&
      needs.detection.result == 'success' &&
      needs.detection.outputs.detection_success == 'true' &&
      needs.detection.outputs.detection_conclusion == 'success'

  conclusion:
    permissions:
      actions: read
      checks: write
      issues: write
      # PR conversation comments (issues API) require pull-requests: write; read returns 403.
      pull-requests: write
    pre-steps:
      - name: Download agent output for PR status
        id: download-agent-output-for-status
        continue-on-error: true
        uses: actions/download-artifact@v8
        with:
          name: agent
          path: ${{ runner.temp }}/gh-aw-status
      - name: Download actual mutation outcome
        continue-on-error: true
        uses: actions/download-artifact@v8
        with:
          name: repair-mutation-outcome
          path: ${{ runner.temp }}/gh-aw-mutation-status
      - name: Update Agentic PR Repair status
        if: always()
        uses: actions/github-script@v9
        env:
          AGENT_OUTPUT_PATH: ${{ runner.temp }}/gh-aw-status/agent_output.json
          AGENT_RESULT: ${{ needs.agent.result }}
          DETECTION_RESULT: ${{ needs.detection.result }}
          DETECTION_SUCCESS: ${{ needs.detection.outputs.detection_success }}
          DETECTION_CONCLUSION: ${{ needs.detection.outputs.detection_conclusion }}
          REPAIR_GUARD_RESULT: ${{ needs.repair_guard.result }}
          GUARD_OUTCOME: ${{ needs.repair_guard.outputs.outcome }}
          GUARD_DECISION: ${{ needs.repair_guard.outputs.guard_result }}
          GUARD_ATTEMPT: ${{ needs.repair_guard.outputs.attempt }}
          SAFE_OUTPUTS_RESULT: ${{ needs.safe_outputs.result }}
          FINALIZE_REPAIR_RESULT: ${{ needs.finalize_repair.result }}
          MUTATION_OUTCOME_PATH: ${{ runner.temp }}/gh-aw-mutation-status/repair-outcome.txt
          MUTATION_DETAILS_PATH: ${{ runner.temp }}/gh-aw-mutation-status/repair-details.json
          PUSH_COMMIT_SHA: ${{ needs.safe_outputs.outputs.push_commit_sha }}
          NOTIFY_PR_COMMENT_RESULT: ${{ needs.notify_pr_comment.result }}
          RESUME_EVALUATION_RESULT: ${{ needs.resume_evaluation.result }}
          STATUS_CHECK_RUN_ID: ${{ needs.trigger_context.outputs.status_check_run_id }}
          STATUS_COMMENT_ID: ${{ needs.trigger_context.outputs.status_comment_id }}
          TARGET_PR_NUMBER: ${{ needs.trigger_context.outputs.target_pr_number }}
          EXPECTED_HEAD_SHA: ${{ needs.trigger_context.outputs.expected_head_sha }}
        with:
          script: |
            const fs = require('fs');
            // Agent を起動しない run の終端ステータスは triage_finalizer が所有する。
            if (process.env.AGENT_RESULT === 'skipped') {
              core.notice(
                'Deterministic triage owns the terminal PR status for this run; skipping the agent status update.',
              );
              return;
            }
            const checkRunId = Number(process.env.STATUS_CHECK_RUN_ID);
            const commentId = Number(process.env.STATUS_COMMENT_ID);
            const prNumber = Number(process.env.TARGET_PR_NUMBER);
            const headSha = process.env.EXPECTED_HEAD_SHA;
            if (
              !Number.isSafeInteger(checkRunId) ||
              !Number.isSafeInteger(commentId) ||
              !Number.isSafeInteger(prNumber) ||
              !/^[0-9a-f]{40}$/.test(headSha)
            ) {
              core.setFailed('Agentic PR Repair status identifiers are invalid.');
              return;
            }

            let output = { items: [], errors: [] };
            if (fs.existsSync(process.env.AGENT_OUTPUT_PATH)) {
              output = JSON.parse(fs.readFileSync(process.env.AGENT_OUTPUT_PATH, 'utf8'));
            }
            const items = Array.isArray(output.items) ? output.items : [];
            const notification = items.find(item => item.type === 'notify_pr_comment');
            const finalizer = items.find(item => item.type === 'finalize_repair');
            const noop = items.find(item => item.type === 'noop');
            const detectionClean =
              process.env.DETECTION_RESULT === 'success' &&
              process.env.DETECTION_SUCCESS === 'true' &&
              process.env.DETECTION_CONCLUSION === 'success';
            const outcome = !detectionClean
              ? 'workflow-error'
              : process.env.GUARD_DECISION !== 'allowed'
                ? process.env.GUARD_OUTCOME
                : fs.existsSync(process.env.MUTATION_OUTCOME_PATH)
                  ? fs.readFileSync(process.env.MUTATION_OUTCOME_PATH, 'utf8').trim()
                  : '';
            const knownOutcomes = new Set([
              'success', 'repair-pushed', 'review-resolved', 'waiting', 'stale',
              'blocked-human-review', 'blocked-non-code', 'limit-reached', 'workflow-error',
            ]);
            const failedResults = new Set(['failure', 'cancelled', 'timed_out']);
            const dependencyResults = [
              process.env.AGENT_RESULT,
              process.env.DETECTION_RESULT,
              process.env.REPAIR_GUARD_RESULT,
              process.env.SAFE_OUTPUTS_RESULT,
              process.env.FINALIZE_REPAIR_RESULT,
              process.env.NOTIFY_PR_COMMENT_RESULT,
              process.env.RESUME_EVALUATION_RESULT,
            ];

            let conclusion = 'neutral';
            let icon = '⚪';
            let title = '処理完了 — 変更はありません';
            let summary = '現在のPR状態に対する処理を完了しました。';

            if (
              dependencyResults.some(result => failedResults.has(result)) ||
              (Array.isArray(output.errors) && output.errors.length > 0) ||
              outcome === 'workflow-error' ||
              (!knownOutcomes.has(outcome) && (notification || finalizer))
            ) {
              conclusion = 'failure';
              icon = '🔴';
              title = 'AWの実行に失敗しました';
              summary = !detectionClean
                ? 'Threat Detectionの安全判定を確認できないため変更を拒否しました。検出ログを確認してください。'
                : 'Workflowログを確認し、失敗したJobの原因を解消してください。';
            } else if (outcome === 'success') {
              conclusion = 'success';
              icon = '🟢';
              title = 'AW完了 — マージ可能です';
              summary = 'レビュー指摘とRequired Checkがすべて解消されました。';
            } else if (
              ['blocked-human-review', 'blocked-non-code', 'limit-reached']
                .includes(outcome)
            ) {
              conclusion = 'action_required';
              icon = '🟠';
              title = '人間による対応が必要です';
              summary =
                outcome === 'limit-reached'
                  ? '自動修復の上限に達しました。残りの問題を手動で確認してください。'
                  : '自動処理を継続できません。固定ステータスコメントとWorkflowログを確認してください。';
            } else if (outcome === 'repair-pushed') {
              title = '修正処理完了 — 再評価待ちです';
              summary = '修正push後のCopilot ReviewとCI完了を待っています。';
            } else if (outcome === 'stale') {
              title = 'Head更新 — この実行の変更処理を停止しました';
              summary = 'PRのHeadが変更されました。新しいHeadのレビューとCIイベントで再評価します。';
            } else if (
              ['waiting', 'review-resolved'].includes(outcome) ||
              /waiting|待機|待ち|pending/i.test(noop?.message ?? '')
            ) {
              title = 'CIまたはレビュー待ちです';
              summary = '次のCIまたはCopilot Reviewイベントで自動的に再評価します。';
            }
            if (
              conclusion !== 'failure' && finalizer &&
              ['repair-pushed', 'review-resolved'].includes(outcome)
            ) {
              const details = JSON.parse(fs.readFileSync(process.env.MUTATION_DETAILS_PATH, 'utf8'));
              if (
                details.outcome !== outcome ||
                !Number.isSafeInteger(details.handled) || details.handled < 0 ||
                !Number.isSafeInteger(details.remaining) || details.remaining < 0 ||
                !Array.isArray(details.baseline_checks) ||
                typeof details.blocked_reason !== 'string'
              ) throw new Error('Invalid verified partial repair details.');
              summary += ` 対応済みレビュー: ${details.handled}、未解決: ${details.remaining}。`;
              if (details.baseline_checks.length > 0) {
                summary += ` 修正前Headの未成功CI（新Headで再確認が必要）: ${details.baseline_checks.join(', ')}。`;
              }
              if (details.blocked_reason) {
                conclusion = 'action_required';
                icon = '🟠';
                title = '部分対応完了 — 人間による対応が必要です';
                summary += ` 残作業: ${details.blocked_reason}`;
              }
            }

            const attemptCandidate = process.env.GUARD_DECISION !== 'allowed' || finalizer
              ? process.env.GUARD_ATTEMPT
              : notification?.attempt;
            const attempt =
              attemptCandidate !== undefined && attemptCandidate !== '' &&
              Number.isSafeInteger(Number(attemptCandidate)) &&
              Number(attemptCandidate) >= 0 &&
              Number(attemptCandidate) <= 5
                ? Number(attemptCandidate)
                : null;
            const runUrl =
              `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}` +
              `/actions/runs/${context.runId}`;
            const marker =
              `<!-- agentic-pr-repair-status ` +
              `${JSON.stringify({
                check_run_id: checkRunId,
                run_id: Number(context.runId),
                head_sha: headSha,
              })} -->`;
            const body = [
              marker,
              '## Agentic PR Repair Status',
              '',
              `${icon} **${title}**`,
              '',
              summary,
              '',
              '| 項目 | 内容 |',
              '| --- | --- |',
              `| Head SHA | \`${headSha.slice(0, 12)}\` |`,
              ...(attempt === null ? [] : [`| Repair attempt | ${attempt}/5 |`]),
              `| Workflow | [実行ログ](${runUrl}) |`,
              `| 最終更新 | ${new Date().toISOString()} |`,
              '',
              '> このコメントはAgentic PR Repairが自動更新します。',
            ].join('\n');

            await github.rest.checks.update({
              owner: context.repo.owner,
              repo: context.repo.repo,
              check_run_id: checkRunId,
              status: 'completed',
              conclusion,
              completed_at: new Date().toISOString(),
              details_url: runUrl,
              output: { title, summary },
            });
            const { data: currentComment } = await github.rest.issues.getComment({
              ...context.repo, comment_id: commentId,
            });
            const currentMarker = currentComment.body?.match(
              /^<!-- agentic-pr-repair-status (\{[^\r\n]*\}) -->/,
            );
            const statusOwner = currentMarker ? JSON.parse(currentMarker[1]) : null;
            const { data: currentPr } = await github.rest.pulls.get({
              ...context.repo, pull_number: prNumber,
            });
            if (
              currentComment.user?.login !== 'github-actions[bot]' ||
              currentComment.user?.type !== 'Bot' ||
              statusOwner?.run_id !== Number(context.runId) ||
              statusOwner?.head_sha !== headSha ||
              ![headSha, process.env.PUSH_COMMIT_SHA].includes(currentPr.head.sha)
            ) {
              core.notice('Completed this run check without overwriting a newer PR status.');
              return;
            }
            await github.rest.issues.updateComment({
              owner: context.repo.owner,
              repo: context.repo.repo,
              comment_id: commentId,
              body,
            });

      - name: Record run-attempt timings
        if: always()
        uses: actions/github-script@v9
        with:
          script: |
            const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
            const { data: run } = await github.rest.actions.getWorkflowRun({
              ...context.repo, run_id: context.runId,
            });
            const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt, {
              ...context.repo, run_id: context.runId, attempt_number: attempt, per_page: 100,
            });
            const seconds = (start, end) => {
              const value = (Date.parse(end) - Date.parse(start)) / 1000;
              return Number.isFinite(value) && value >= 0 ? String(value) : 'unavailable';
            };
            await core.summary.addHeading(`Repair timing — attempt ${attempt}`)
              .addRaw(`Initial workflow queue seconds: ${attempt === 1 ? seconds(run.created_at, run.run_started_at) : 'unavailable (rerun)'}\n\n`)
              .addTable([
                ['Job', 'Execution seconds', 'Job conclusion (not repair outcome)'],
                ...jobs.map(job => [
                  job.name, seconds(job.started_at, job.completed_at), job.conclusion ?? job.status,
                ]),
              ])
              .addRaw('\nDependency wait, environment approval and runner allocation are not separately exposed by these timestamps. Do not attribute them to concurrency without further evidence.\n')
              .write();

  resume_evaluation:
    name: Reserve one fresh evaluation after drift
    needs: [agent, trigger_context, triage, repair_guard, safe_outputs, finalize_repair, detection]
    if: >-
      always() &&
      needs.trigger_context.outputs.valid == 'true' &&
      needs.triage.outputs.activated == 'true' &&
      needs.repair_guard.result == 'success' &&
      (needs.safe_outputs.result == 'success' || needs.safe_outputs.result == 'skipped') &&
      (needs.finalize_repair.result == 'success' || needs.finalize_repair.result == 'skipped') &&
      needs.detection.result == 'success' &&
      needs.detection.outputs.detection_success == 'true' &&
      needs.detection.outputs.detection_conclusion == 'success' &&
      github.event.action != 'agentic-repair-reevaluate'
    runs-on: ubuntu-latest
    permissions:
      actions: read
      checks: read
      contents: read
      pull-requests: read
      statuses: read
    steps:
      - name: Download drift outcome
        continue-on-error: true
        uses: actions/download-artifact@v8
        with:
          name: repair-mutation-outcome
          path: ${{ runner.temp }}/repair-resume
      - name: Check fresh reevaluation input
        id: resume
        uses: actions/github-script@v9
        env:
          GUARD_OUTCOME: ${{ needs.repair_guard.outputs.outcome }}
          TARGET_PR_NUMBER: ${{ needs.trigger_context.outputs.target_pr_number }}
          REQUIRED_CHECKS: ${{ needs.triage.outputs.required_checks }}
        with:
          script: |
            const fs = require('fs');
            const file = `${process.env.RUNNER_TEMP}/repair-resume/repair-outcome.txt`;
            const guardOutcome = process.env.GUARD_OUTCOME;
            if (!['stale', 'waiting', 'reserved', 'validated'].includes(guardOutcome)) return;
            const outcome = ['stale', 'waiting'].includes(guardOutcome) ? guardOutcome :
              fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : guardOutcome;
            if (!['stale', 'waiting'].includes(outcome)) return;
            const prNumber = Number(process.env.TARGET_PR_NUMBER);
            if (!Number.isSafeInteger(prNumber) || prNumber <= 0) throw new Error('Invalid resume PR.');
            const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: prNumber });
            if (pull.state !== 'open' || pull.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}`) return;
            if (!/^[0-9a-f]{40}$/.test(pull.head.sha)) throw new Error('Invalid resume head.');
            const allowed = author => author?.__typename === 'Bot' && (
              ['copilot-pull-request-reviewer[bot]', 'github-copilot[bot]'].includes(author.login) ||
              (['Copilot', 'copilot-pull-request-reviewer', 'github-copilot'].includes(author.login) &&
                author.id === 'BOT_kgDOCnlnWA')
            );
            const threads = [];
            let after = null;
            do {
              const result = await github.graphql(
                `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
                  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) {
                    reviewThreads(first: 100, after: $after) {
                      nodes { id isResolved }
                      pageInfo { hasNextPage endCursor }
                    }
                  } }
                }`, { ...context.repo, pr: prNumber, after },
              );
              const connection = result.repository.pullRequest.reviewThreads;
              for (const thread of connection.nodes.filter(thread => !thread.isResolved)) {
                const ids = [];
                let cursor = null;
                do {
                  const result = await github.graphql(
                    `query($threadId: ID!, $after: String) {
                      node(id: $threadId) { ... on PullRequestReviewThread {
                        comments(first: 100, after: $after) {
                          nodes { id author { login __typename ... on Bot { id } } }
                          pageInfo { hasNextPage endCursor }
                        }
                      } }
                    }`, { threadId: thread.id, after: cursor },
                  );
                  const comments = result.node.comments;
                  if (comments.nodes.some(comment => !allowed(comment.author))) return;
                  ids.push(...comments.nodes.map(comment => comment.id));
                  cursor = comments.pageInfo.hasNextPage ? comments.pageInfo.endCursor : null;
                  if (comments.pageInfo.hasNextPage && !cursor) throw new Error('Missing comment cursor.');
                } while (cursor);
                threads.push({ id: thread.id, comments: ids.sort() });
              }
              after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
              if (connection.pageInfo.hasNextPage && !after) throw new Error('Missing thread cursor.');
            } while (after);
            const checks = await github.paginate(github.rest.checks.listForRef, {
              ...context.repo, ref: pull.head.sha, per_page: 100,
            });
            const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
              ...context.repo, ref: pull.head.sha, per_page: 100,
            });
            const required = new Set(process.env.REQUIRED_CHECKS.split(',').filter(Boolean));
            if (required.size === 0) throw new Error('Missing required checks for reevaluation.');
            const key = require('crypto').createHash('sha256').update(JSON.stringify({
              pr: prNumber, head: pull.head.sha, mergeable: pull.mergeable,
              threads: threads.sort((a, b) => a.id.localeCompare(b.id)),
              checks: checks.filter(c => required.has(c.name)).map(c => [c.id, c.name, c.status, c.conclusion]).sort(),
              statuses: statuses.filter(s => required.has(s.context)).map(s => [s.id, s.context, s.state]).sort(),
            })).digest('hex');
            const name = `repair-reevaluation-${key}`;
            const { data: artifacts } = await github.rest.actions.listArtifactsForRepo({
              ...context.repo, name, per_page: 100,
            });
            if (artifacts.total_count > 0) {
              core.notice('This fresh input already has a reevaluation reservation.');
              return;
            }
            const { data: latest } = await github.rest.pulls.get({ ...context.repo, pull_number: prNumber });
            if (latest.head.sha !== pull.head.sha || latest.state !== 'open') return;
            fs.writeFileSync(`${process.env.RUNNER_TEMP}/repair-resume.json`, JSON.stringify({
              repository: `${context.repo.owner}/${context.repo.repo}`,
              pr_number: prNumber, head_sha: pull.head.sha, evaluation_key: key,
            }));
            core.setOutput('artifact_name', name);
      - name: Reserve fresh input before dispatch
        if: steps.resume.outputs.artifact_name != ''
        uses: actions/upload-artifact@v7
        with:
          name: ${{ steps.resume.outputs.artifact_name }}
          path: ${{ runner.temp }}/repair-resume.json
          retention-days: 90
          if-no-files-found: error
      - name: Dispatch one fresh evaluation
        if: steps.resume.outputs.artifact_name != ''
        uses: actions/github-script@v9
        with:
          github-token: ${{ secrets.AGENTIC_WORKFLOW_TOKEN }}
          script: |
            const payload = JSON.parse(require('fs').readFileSync(
              `${process.env.RUNNER_TEMP}/repair-resume.json`, 'utf8',
            ));
            await github.rest.repos.createDispatchEvent({
              ...context.repo, event_type: 'agentic-repair-reevaluate', client_payload: payload,
            });

  repair_guard:
    needs: [agent, detection, triage]
    if: always() && needs.agent.result == 'success'
    runs-on: ubuntu-latest
    outputs:
      target_pr: ${{ steps.guard.outputs.target_pr }}
      guard_result: ${{ steps.guard.outputs.guard_result }}
      outcome: ${{ steps.guard.outputs.outcome }}
      attempt: ${{ steps.guard.outputs.attempt }}
    permissions:
      contents: read
      issues: write
      # PR conversation comments (issues API) require pull-requests: write; read returns 403.
      pull-requests: write
    steps:
      - name: Download agent output
        uses: actions/download-artifact@v8
        with:
          name: agent
          path: ${{ runner.temp }}/gh-aw
      - name: Enforce repair attempt limit
        id: guard
        uses: actions/github-script@v9
        env:
          AGENT_OUTPUT_PATH: ${{ runner.temp }}/gh-aw/agent_output.json
          DETECTION_RESULT: ${{ needs.detection.result }}
          DETECTION_SUCCESS: ${{ needs.detection.outputs.detection_success }}
          DETECTION_CONCLUSION: ${{ needs.detection.outputs.detection_conclusion }}
          TRUSTED_OBSERVED_THREADS_JSON: ${{ needs.triage.outputs.observed_threads_json }}
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          script: |
            const fs = require('fs');
            core.setOutput('outcome', 'workflow-error');
            const skip = (message, outcome = 'stale') => {
              core.setOutput('target_pr', '0');
              core.setOutput('guard_result', 'skip');
              core.setOutput('outcome', outcome);
              core.warning(message);
            };
            const deny = message => {
              core.setOutput('target_pr', '0');
              core.setOutput('guard_result', 'deny');
              core.setFailed(message);
            };
            if (
              process.env.DETECTION_RESULT !== 'success' ||
              process.env.DETECTION_SUCCESS !== 'true' ||
              process.env.DETECTION_CONCLUSION !== 'success'
            ) {
              deny('Threat Detection did not return a clean successful verdict; all repair mutations are denied.');
              return;
            }
            const output = JSON.parse(fs.readFileSync(process.env.AGENT_OUTPUT_PATH, 'utf8'));
            let trustedObservedThreads;
            try {
              trustedObservedThreads = JSON.parse(process.env.TRUSTED_OBSERVED_THREADS_JSON ?? '');
            } catch {
              deny('Triage did not provide a complete trusted observed thread snapshot.');
              return;
            }
            if (!Array.isArray(output.items)) {
              deny('Agent output must contain an items array.');
              return;
            }
            const isAllowedReviewTrigger = user =>
              user?.type === 'Bot' &&
              ([
                'copilot-pull-request-reviewer[bot]',
                'github-copilot[bot]',
              ].includes(user.login) ||
                (user.login === 'Copilot' && user.id === 175728472));
            let eventPrNumber;
            let eventExpectedHeadSha;
            switch (context.eventName) {
              case 'pull_request':
                eventPrNumber = context.payload.pull_request?.number;
                eventExpectedHeadSha = context.payload.pull_request?.head?.sha;
                break;
              case 'pull_request_review':
                if (!isAllowedReviewTrigger(context.payload.review?.user)) {
                  skip('The triggering review was not submitted by an allowed Copilot reviewer.');
                  return;
                }
                eventPrNumber = context.payload.pull_request?.number;
                eventExpectedHeadSha = context.payload.review?.commit_id;
                break;
              case 'repository_dispatch':
                eventPrNumber = context.payload.client_payload?.pr_number;
                eventExpectedHeadSha = context.payload.client_payload?.head_sha;
                break;
              case 'workflow_dispatch':
                eventPrNumber = context.payload.inputs?.pr_number;
                eventExpectedHeadSha = context.payload.inputs?.expected_head_sha;
                break;
              default:
                skip(`Unsupported trigger: ${context.eventName}.`);
                return;
            }
            if (!Number.isInteger(Number(eventPrNumber)) || !eventExpectedHeadSha) {
              skip('The trigger does not identify a valid pull request and head SHA.');
              return;
            }
            core.setOutput('target_pr', String(eventPrNumber));

            const { data: eventPr } = await github.rest.pulls.get({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: Number(eventPrNumber),
            });
            if (
              eventPr.state !== 'open' ||
              eventPr.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
              eventPr.head.sha !== String(eventExpectedHeadSha)
            ) {
              skip('The event-derived pull request is stale or is not an open same-repository PR.');
              return;
            }

            const pushes = output.items.filter(item => item.type === 'push_to_pull_request_branch');
            if (pushes.length !== 1) {
              if (pushes.length > 1) {
                deny(`Expected at most one repair push, but found ${pushes.length}.`);
                return;
              }
            }
            const finalizers = output.items.filter(item => item.type === 'finalize_repair');
            const notifications = output.items.filter(item => item.type === 'notify_pr_comment');
            if (finalizers.length > 0 && eventPr.mergeable === false) {
              skip('The base branch now conflicts; manual resolution is required.', 'waiting');
              return;
            }
            if (finalizers.length > 0 && eventPr.mergeable === null) {
              skip('Mergeability is not yet known.', 'waiting');
              return;
            }
            if (finalizers.length > 1 || notifications.length > 1) {
              deny('At most one finalizer and one terminal notification are allowed.');
              return;
            }
            if (finalizers.length > 0 && notifications.length > 0) {
              deny('A repair finalizer and terminal notification cannot run in the same pass.');
              return;
            }
            for (const finalizer of finalizers) {
              if (
                finalizer.blocked_reason !== undefined &&
                (typeof finalizer.blocked_reason !== 'string' ||
                  finalizer.blocked_reason.length > 2000 ||
                  finalizer.blocked_reason.includes('<!--') ||
                  (finalizer.blocked_reason !== '' && !/[ぁ-んァ-ヶ一-龠]/.test(finalizer.blocked_reason)))
              ) {
                deny('Invalid partial repair blocked reason.');
                return;
              }
              if (
                !Number.isSafeInteger(finalizer.pr_number) || finalizer.pr_number <= 0 ||
                finalizer.pr_number !== Number(eventPrNumber) ||
                !/^[0-9a-f]{40}$/.test(finalizer.expected_head_sha) ||
                finalizer.expected_head_sha !== eventExpectedHeadSha ||
                typeof finalizer.push_expected !== 'boolean' ||
                !Number.isSafeInteger(finalizer.attempt) ||
                finalizer.attempt < (finalizer.push_expected ? 1 : 0) || finalizer.attempt > 5 ||
                typeof finalizer.thread_actions_json !== 'string' ||
                typeof finalizer.observed_threads_json !== 'string' ||
                (finalizer.summary_comment !== undefined && typeof finalizer.summary_comment !== 'string')
              ) {
                deny('Invalid finalizer target, attempt, boolean, or string fields.');
                return;
              }
              let actions;
              let observedThreads;
              try {
                actions = JSON.parse(finalizer.thread_actions_json);
                observedThreads = JSON.parse(finalizer.observed_threads_json);
              } catch {
                deny('Invalid finalizer thread_actions_json or observed_threads_json: expected complete JSON arrays.');
                return;
              }
              const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
              const isValidThreadSet = value =>
                Array.isArray(value) &&
                value.every(action =>
                  action && validId(action.thread_id) &&
                  Array.isArray(action.comment_ids) && action.comment_ids.length > 0 &&
                  action.comment_ids.every(validId) &&
                  new Set(action.comment_ids).size === action.comment_ids.length
                ) &&
                new Set(value.map(action => action.thread_id)).size === value.length;
              if (
                !isValidThreadSet(actions) ||
                !isValidThreadSet(observedThreads) ||
                !isValidThreadSet(trustedObservedThreads) ||
                finalizer.observed_threads_json !== process.env.TRUSTED_OBSERVED_THREADS_JSON ||
                actions.some(action => {
                  const observed = observedThreads.find(item => item.thread_id === action.thread_id);
                  return !observed ||
                    observed.comment_ids.length !== action.comment_ids.length ||
                    action.comment_ids.some(id => !observed.comment_ids.includes(id));
                }) ||
                (actions.length > 0
                  ? !(finalizer.summary_comment ?? '').trim() ||
                    (finalizer.summary_comment ?? '').length > 10000 || (finalizer.summary_comment ?? '').includes('<!--')
                  : (finalizer.summary_comment ?? '').trim().length > 0)
              ) {
                deny('Invalid finalizer thread IDs, comment IDs, or review summary.');
                return;
              }
            }
            const terminalOutcomes = new Set([
              'success',
              'blocked-human-review',
              'blocked-non-code',
              'limit-reached',
              'workflow-error',
            ]);
            for (const notification of notifications) {
              if (
                Number(notification.pr_number) !== Number(eventPrNumber) ||
                String(notification.head_sha) !== String(eventExpectedHeadSha) ||
                !terminalOutcomes.has(notification.outcome) ||
                !Number.isSafeInteger(notification.attempt) ||
                notification.attempt < 0 || notification.attempt > 5 ||
                typeof notification.reason !== 'string' || !notification.reason.trim()
              ) {
                deny('A terminal notification does not match the event-derived target.');
                return;
              }
            }

            if (pushes.length > 0 && (finalizers.length !== 1 || finalizers[0].push_expected !== true)) {
              deny('A repair push requires exactly one push-aware finalizer.');
              return;
            }
            if (pushes.length === 0 && finalizers.some(item => item.push_expected)) {
              deny('A push-aware finalizer was emitted without a repair push.');
              return;
            }

            // Validate every referenced thread, including resolved ones, and the complete
            // unresolved snapshot before reserving an attempt or allowing any safe output.
            const observedIdsByThread = new Map(
              finalizers.flatMap(item => JSON.parse(item.observed_threads_json))
                .map(item => [item.thread_id, new Set(item.comment_ids)]),
            );
            const repository = `${context.repo.owner}/${context.repo.repo}`;
            const isAllowedAuthor = author =>
              author?.__typename === 'Bot' &&
              (['copilot-pull-request-reviewer[bot]', 'github-copilot[bot]'].includes(author.login) ||
                (['Copilot', 'copilot-pull-request-reviewer', 'github-copilot'].includes(author.login) &&
                  author.id === 'BOT_kgDOCnlnWA'));
            async function validateSnapshot() {
              let after = null;
              const ids = new Set(observedIdsByThread.keys());
              const unresolvedIds = new Set();
              do {
                const result = await github.graphql(
                  `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
                    repository(owner: $owner, name: $repo) {
                      pullRequest(number: $pr) {
                        reviewThreads(first: 100, after: $after) {
                          nodes { id isResolved }
                          pageInfo { hasNextPage endCursor }
                        }
                      }
                    }
                  }`,
                  { ...context.repo, pr: Number(eventPrNumber), after },
                );
                const connection = result.repository.pullRequest.reviewThreads;
                for (const thread of connection.nodes.filter(thread => !thread.isResolved)) {
                  ids.add(thread.id);
                  unresolvedIds.add(thread.id);
                }
                after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
                if (connection.pageInfo.hasNextPage && !after) throw new Error('Missing review thread cursor.');
              } while (after);
              let drift = false;
              let untrusted = false;
              for (const threadId of ids) {
                after = null;
                const comments = [];
                do {
                  const result = await github.graphql(
                    `query($threadId: ID!, $after: String) {
                      node(id: $threadId) {
                        ... on PullRequestReviewThread {
                          id
                          pullRequest { number repository { nameWithOwner } }
                          comments(first: 100, after: $after) {
                            nodes { id author { login __typename ... on Bot { id } } }
                            pageInfo { hasNextPage endCursor }
                          }
                        }
                      }
                    }`,
                    { threadId, after },
                  );
                  const thread = result.node;
                  if (
                    !thread || thread.id !== threadId ||
                    thread.pullRequest.number !== Number(eventPrNumber) ||
                    thread.pullRequest.repository.nameWithOwner !== repository
                  ) throw new Error(`Unsafe review thread ${threadId}: missing or outside the target repository/PR.`);
                  comments.push(...thread.comments.nodes);
                  after = thread.comments.pageInfo.hasNextPage ? thread.comments.pageInfo.endCursor : null;
                  if (thread.comments.pageInfo.hasNextPage && !after) throw new Error('Missing review comment cursor.');
                } while (after);
                if (!comments.length) throw new Error(`Review thread ${threadId} has no comments.`);
                untrusted ||= comments.some(comment => !isAllowedAuthor(comment.author));
                const expected = observedIdsByThread.get(threadId);
                const actual = new Set(comments.map(comment => comment.id));
                drift ||= finalizers.length > 0 && (
                  !expected || expected.size !== actual.size ||
                  [...expected].some(id => !actual.has(id))
                );
              }
              if (untrusted) {
                skip('A review thread contains an author outside the Bot allowlist.', 'blocked-human-review');
                return false;
              }
              if (drift || (notifications.some(item => item.outcome === 'success') && unresolvedIds.size > 0)) {
                skip('The reviewed Bot snapshot changed; await the next review/CI event for reevaluation.', 'waiting');
                return false;
              }
              const { data: latestPr } = await github.rest.pulls.get({
                ...context.repo, pull_number: Number(eventPrNumber),
              });
              if (
                latestPr.state !== 'open' || latestPr.head.repo?.full_name !== repository ||
                latestPr.head.sha !== eventExpectedHeadSha
              ) {
                skip('The PR head changed before mutation.');
                return false;
              }
              if (finalizers.length > 0 && latestPr.mergeable !== true) {
                skip('Base conflict or unknown mergeability before mutation.', 'waiting');
                return false;
              }
              return true;
            }
            if (!await validateSnapshot()) return;

            if (finalizers.length === 0) {
              core.setOutput('guard_result', 'allowed');
              core.setOutput('outcome', 'no-action');
              return;
            }

            const item = finalizers[0];
            const prNumber = Number(item.pr_number);
            const expectedHeadSha = String(item.expected_head_sha);
            const requestedAttempt = item.attempt;
            if (
              prNumber !== Number(eventPrNumber) ||
              expectedHeadSha !== String(eventExpectedHeadSha)
            ) {
              deny('Agent repair output does not match the event-derived target.');
              return;
            }
            const pr = eventPr;

            // GITHUB_TOKEN is an installation token and cannot call the user-scoped GET /user API.
            const markerAuthorLogin = 'github-actions[bot]';
            const comments = await github.paginate(github.rest.issues.listComments, {
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: prNumber,
              per_page: 100,
            });
            let markerAttempt = 0;
            for (const comment of comments) {
              if (
                comment.user?.login !== markerAuthorLogin ||
                comment.user?.type !== 'Bot' ||
                !comment.body?.startsWith('<!-- agentic-pr-repair-state ')
              ) {
                continue;
              }
              const match = comment.body.match(
                /^<!-- agentic-pr-repair-state (\{[^\r\n]*\}) -->/
              );
              if (!match) {
                continue;
              }
              try {
                const marker = JSON.parse(match[1]);
                if (marker.workflow === 'agentic-pr-repair') {
                  if (!Number.isSafeInteger(marker.attempt) || marker.attempt < 0 || marker.attempt > 5) {
                    deny('The trusted repair attempt must be an integer from 0 through 5.');
                    return;
                  }
                  markerAttempt = Math.max(markerAttempt, marker.attempt);
                }
              } catch {
                // Ignore malformed comments instead of trusting them as state.
              }
            }

            const completedAttempts = markerAttempt;
            core.setOutput('attempt', completedAttempts);

            if (pushes.length === 0) {
              if (!await validateSnapshot()) return;
              core.setOutput('guard_result', 'allowed');
              core.setOutput('outcome', 'validated');
              return;
            }

            if (completedAttempts >= 5) {
              if (!await validateSnapshot()) return;
              const outcome = 'limit-reached';
              const deliveryKey =
                `${context.repo.owner}/${context.repo.repo}/${prNumber}/${pr.head.sha}/${outcome}`;
              const notificationMarker =
                `<!-- agentic-pr-repair-notification ${deliveryKey} -->`;
              if (!comments.some(comment =>
                comment.user?.login === markerAuthorLogin &&
                comment.user?.type === 'Bot' &&
                comment.body?.includes(notificationMarker)
              )) {
                const runUrl =
                  `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
                await github.rest.issues.createComment({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  issue_number: prNumber,
                  body: [
                    notificationMarker,
                    '## Agentic PR Repair 通知',
                    '',
                    `🟠 **${outcome}**`,
                    '',
                    '自動修復の試行上限（5回）に達しました。残りの指摘を手動で確認し修正してください。',
                    '',
                    `- Head SHA: \`${pr.head.sha}\``,
                    '- Repair attempts: 5/5',
                    `- Workflow: [実行ログ](${runUrl})`,
                  ].join('\n'),
                });
              }
              skip('The five-pass repair limit has already been reached.', 'limit-reached');
              return;
            }

            if (requestedAttempt !== completedAttempts + 1) {
              skip(
                `Repair attempt ${requestedAttempt} does not follow completed attempt ${completedAttempts}.`,
                'waiting',
              );
              return;
            }

            if (!await validateSnapshot()) return;
            const reservation = {
              workflow: 'agentic-pr-repair',
              attempt: requestedAttempt,
              head_sha: pr.head.sha,
              outcome: 'repair-reserved',
            };
            const reservationBody =
              [
                `<!-- agentic-pr-repair-state ${JSON.stringify(reservation)} -->`,
                `> 🤖 Agentic PR Repair: repair-reserved（attempt ${requestedAttempt}/5）`,
              ].join('\n');
            const existingMarker = comments
              .filter(comment =>
                comment.user?.login === markerAuthorLogin &&
                comment.user?.type === 'Bot' &&
                comment.body?.startsWith('<!-- agentic-pr-repair-state ')
              )
              .at(-1);
            if (existingMarker) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                comment_id: existingMarker.id,
                body: reservationBody,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner,
                repo: context.repo.repo,
                issue_number: prNumber,
                body: reservationBody,
              });
            }

            core.setOutput('guard_result', 'allowed');
            core.setOutput('outcome', 'reserved');
            core.setOutput('attempt', requestedAttempt);

safe-outputs:
  needs: [repair_guard]
  github-token: ${{ secrets.AGENTIC_WORKFLOW_TOKEN }}
  concurrency-group: agentic-pr-repair-safe-outputs-${{ github.repository }}-${{ github.event.pull_request.number || github.event.client_payload.pr_number || github.event.inputs.pr_number || github.run_id }}
  # 通常の補助Issueは一切生成しない。Threat Detectionの診断Issueだけを安全上の例外として残す。
  report-failed-jobs: false
  report-failure-as-issue: false
  missing-tool:
    create-issue: false
  report-incomplete:
    create-issue: false
  push-to-pull-request-branch:
    allowed-files:
      - "README.md"
      - "docs/**/*.md"
      - "src/blog/**/*.cs"
      - "src/blog/**/*.razor"
      - "src/blog/**/*.css"
      - "src/blog/**/*.js"
      - "src/blog/**/*.ts"
    staged: ${{ needs.repair_guard.outputs.guard_result != 'allowed' || needs.detection.result != 'success' || needs.detection.outputs.detection_success != 'true' || needs.detection.outputs.detection_conclusion != 'success' }}
    target: ${{ needs.repair_guard.outputs.target_pr }}
    max: 1
    if-no-changes: ignore
    fallback-as-pull-request: false
    check-branch-protection: false
    protected-files: allowed
  noop:
    report-as-issue: false
  jobs:
    finalize-repair:
      description: Verify a repair push, post one normal PR review summary, resolve Bot-only threads, and record repair state
      # gh-aw v0.86.2 only allows generated jobs in custom safe-job needs.
      # safe_outputs directly enforces repair_guard; its success is required here.
      needs: safe_outputs
      if: >-
        needs.safe_outputs.result == 'success' &&
        needs.detection.result == 'success' &&
        needs.detection.outputs.detection_success == 'true' &&
        needs.detection.outputs.detection_conclusion == 'success'
      runs-on: ubuntu-latest
      permissions:
        contents: read
        pull-requests: write
        issues: write
      inputs:
        pr_number:
          description: Pull request number
          required: true
          type: number
        expected_head_sha:
          description: Head SHA before the repair push
          required: true
          type: string
        attempt:
          description: Reserved repair attempt number, unchanged when no push is needed
          required: true
          type: number
        push_expected:
          description: Whether this pass requested a repair push
          required: true
          type: boolean
        thread_actions_json:
          description: 'JSON array with thread_id and comment_ids fields; for CI-only repairs with no handled review threads, pass "[]" and summary_comment ""'
          required: true
          type: string
        observed_threads_json:
          description: 'The complete immutable triage snapshot supplied as trusted_observed_threads_json: every Bot-only unresolved thread and all comment_ids. Pass it unchanged; it is distinct from the handled thread_actions_json subset.'
          required: true
          type: string
        summary_comment:
          description: 'Review findings only, not a CI repair report. Must be "" when thread_actions_json is "[]", including after a CI-only repair push; otherwise one nonempty normal PR review summary'
          required: false
          default: ""
          type: string
        blocked_reason:
          description: 'Japanese actionable reason for known blocked findings left after handling the independent subset; empty when none. This is an Agent classification, not proof that current-head CI failed.'
          type: string
      steps:
        - name: Download trusted review baseline
          uses: actions/download-artifact@v8
          with:
            name: repair-trusted-review-baseline-${{ github.run_attempt }}
            path: ${{ runner.temp }}
        - name: Finalize repair
          id: finalize
          uses: actions/github-script@v9
          env:
            AGENTIC_WORKFLOW_TOKEN: ${{ secrets.AGENTIC_WORKFLOW_TOKEN }}
            PUSH_COMMIT_SHA: ${{ needs.safe_outputs.outputs.push_commit_sha }}
          with:
            github-token: ${{ secrets.GITHUB_TOKEN }}
            script: |
              const fs = require('fs');
              const output = JSON.parse(fs.readFileSync(process.env.GH_AW_AGENT_OUTPUT, 'utf8'));
              const items = output.items.filter(item => item.type === 'finalize_repair');
              const setOutcome = outcome => {
                core.setOutput('outcome', outcome);
                fs.writeFileSync(`${process.env.RUNNER_TEMP}/repair-outcome.txt`, outcome);
              };
              setOutcome('workflow-error');
              const stop = (outcome, message) => {
                setOutcome(outcome);
                core.warning(message);
                return null;
              };
              if (items.length !== 1) throw new Error('Expected exactly one finalizer.');
              const writeGithub = getOctokit(process.env.AGENTIC_WORKFLOW_TOKEN);
              const allowedAuthors = new Set([
                'copilot-pull-request-reviewer[bot]',
                'github-copilot[bot]',
              ]);
              const isAllowedReviewTrigger = user =>
                user?.type === 'Bot' &&
                (allowedAuthors.has(user.login) ||
                  (user.login === 'Copilot' && user.id === 175728472));
              const isAllowedReviewAuthor = author =>
                author?.__typename === 'Bot' &&
                (allowedAuthors.has(author.login) ||
                  (['Copilot', 'copilot-pull-request-reviewer', 'github-copilot'].includes(author.login) &&
                    author.id === 'BOT_kgDOCnlnWA'));

              async function getThread(threadId) {
                let after = null;
                let thread = null;
                const comments = [];
                do {
                  const result = await github.graphql(
                    `query($threadId: ID!, $after: String) {
                      node(id: $threadId) {
                        ... on PullRequestReviewThread {
                          id
                          isResolved
                          pullRequest { number repository { nameWithOwner } }
                          comments(first: 100, after: $after) {
                            nodes {
                              id
                              body
                              author {
                                login
                                __typename
                                ... on Bot { id }
                              }
                            }
                            pageInfo { hasNextPage endCursor }
                          }
                        }
                      }
                    }`,
                    { threadId, after }
                  );
                  if (!result.node) {
                    return null;
                  }
                  thread = result.node;
                  comments.push(...thread.comments.nodes);
                  after = thread.comments.pageInfo.hasNextPage
                    ? thread.comments.pageInfo.endCursor
                    : null;
                  if (thread.comments.pageInfo.hasNextPage && !after) throw new Error('Missing review comment cursor.');
                } while (after);

                return {
                  id: thread.id,
                  isResolved: thread.isResolved,
                  pullRequestNumber: thread.pullRequest.number,
                  repository: thread.pullRequest.repository.nameWithOwner,
                  comments,
                };
              }

              for (const item of items) {
                const blockedReason = item.blocked_reason ?? '';
                if (
                  typeof blockedReason !== 'string' || blockedReason.length > 2000 ||
                  blockedReason.includes('<!--') ||
                  (blockedReason !== '' && !/[ぁ-んァ-ヶ一-龠]/.test(blockedReason))
                ) throw new Error('Invalid partial repair blocked reason.');
                const baselineChecks = JSON.parse(fs.readFileSync(
                  `${process.env.RUNNER_TEMP}/repair-trusted-checks.json`, 'utf8',
                ));
                if (
                  !Array.isArray(baselineChecks.failed) || !Array.isArray(baselineChecks.attention) ||
                  [...baselineChecks.failed, ...baselineChecks.attention].some(name => typeof name !== 'string' || !name)
                ) throw new Error('Invalid trusted check baseline.');
                const prNumber = item.pr_number;
                const expectedHeadSha = item.expected_head_sha;
                let attempt = item.attempt;
                const pushExpected = item.push_expected;
                const pushedCommitSha = process.env.PUSH_COMMIT_SHA;
                if (
                  !Number.isSafeInteger(prNumber) || prNumber <= 0 ||
                  !Number.isSafeInteger(attempt) || attempt < (pushExpected ? 1 : 0) || attempt > 5 ||
                  typeof pushExpected !== 'boolean' ||
                  typeof expectedHeadSha !== 'string' || !/^[0-9a-f]{40}$/.test(expectedHeadSha) ||
                  typeof item.thread_actions_json !== 'string' ||
                  typeof item.observed_threads_json !== 'string' ||
                  (item.summary_comment !== undefined && typeof item.summary_comment !== 'string')
                ) {
                  core.setFailed('Invalid finalizer target, attempt, boolean, or string fields.');
                  return;
                }
                let actions;
                let observedThreads;
                try {
                  actions = JSON.parse(item.thread_actions_json);
                  observedThreads = JSON.parse(item.observed_threads_json);
                  const trustedObservedThreadsJson = fs.readFileSync(
                    `${process.env.RUNNER_TEMP}/repair-trusted-observed-threads.json`, 'utf8',
                  );
                  const trustedObservedThreads = JSON.parse(trustedObservedThreadsJson);
                  if (!Array.isArray(trustedObservedThreads) ||
                    item.observed_threads_json !== trustedObservedThreadsJson) {
                    core.setFailed('Agent observed_threads_json does not match the immutable trusted triage snapshot.');
                    return;
                  }
                } catch {
                  core.setFailed('Invalid finalizer thread_actions_json, observed_threads_json, or trusted triage snapshot: expected complete JSON arrays.');
                  return;
                }
                const summaryComment = (item.summary_comment ?? '').trim();
                const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
                const isValidThreadSet = value =>
                  Array.isArray(value) &&
                  value.every(action =>
                    action && validId(action.thread_id) &&
                    Array.isArray(action.comment_ids) && action.comment_ids.length > 0 &&
                    action.comment_ids.every(validId) &&
                    new Set(action.comment_ids).size === action.comment_ids.length
                  ) &&
                  new Set(value.map(action => action.thread_id)).size === value.length;
                if (
                  !isValidThreadSet(actions) ||
                  !isValidThreadSet(observedThreads) ||
                  actions.some(action => {
                    const observed = observedThreads.find(item => item.thread_id === action.thread_id);
                    return !observed ||
                      observed.comment_ids.length !== action.comment_ids.length ||
                      action.comment_ids.some(id => !observed.comment_ids.includes(id));
                  }) ||
                  (actions.length > 0 &&
                    (
                      summaryComment.length === 0 ||
                      (item.summary_comment ?? '').length > 10000 ||
                      summaryComment.includes('<!--')
                    )) ||
                  (actions.length === 0 && summaryComment.length > 0)
                ) {
                  core.setFailed('Invalid review summary or thread actions.');
                  return;
                }

                let eventPrNumber;
                let eventExpectedHeadSha;
                switch (context.eventName) {
                  case 'pull_request':
                    eventPrNumber = context.payload.pull_request?.number;
                    eventExpectedHeadSha = context.payload.pull_request?.head?.sha;
                    break;
                  case 'pull_request_review':
                    if (!isAllowedReviewTrigger(context.payload.review?.user)) {
                      stop('blocked-human-review', 'The triggering reviewer is outside the Bot allowlist.');
                      return;
                    }
                    eventPrNumber = context.payload.pull_request?.number;
                    eventExpectedHeadSha = context.payload.review?.commit_id;
                    break;
                  case 'repository_dispatch':
                    eventPrNumber = context.payload.client_payload?.pr_number;
                    eventExpectedHeadSha = context.payload.client_payload?.head_sha;
                    break;
                  case 'workflow_dispatch':
                    eventPrNumber = context.payload.inputs?.pr_number;
                    eventExpectedHeadSha = context.payload.inputs?.expected_head_sha;
                    break;
                  default:
                    stop('stale', `Unsupported trigger: ${context.eventName}.`);
                    return;
                }
                if (
                  prNumber !== Number(eventPrNumber) ||
                  expectedHeadSha !== String(eventExpectedHeadSha)
                ) {
                  core.setFailed('The finalizer does not match the event-derived target.');
                  return;
                }

                const { data: pr } = await github.rest.pulls.get({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  pull_number: prNumber,
                });
                if (pr.state !== 'open' || pr.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}`) {
                  stop('stale', 'The target PR is not an open same-repository pull request.');
                  return;
                }
                if (pushExpected) {
                  if (!pushedCommitSha) {
                    core.setFailed('The requested repair push did not produce a commit SHA.');
                    return;
                  }
                  if (pr.head.sha !== pushedCommitSha) {
                    stop('stale', 'The pull request head no longer matches the guarded repair push.');
                    return;
                  }
                  const { data: pushedCommit } = await github.rest.repos.getCommit({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    ref: pushedCommitSha,
                  });
                  if (
                    pushedCommit.parents.length !== 1 ||
                    pushedCommit.parents[0].sha !== expectedHeadSha ||
                    !pushedCommit.commit.message
                      .split(/\r?\n/)
                      .some(line => line === `Agentic-Repair-Attempt: ${attempt}/5`)
                  ) {
                    core.setFailed('The repair commit parent or attempt trailer is invalid.');
                    return;
                  }
                }
                if (!pushExpected && pr.head.sha !== expectedHeadSha) {
                  stop('stale', 'The pull request head changed before review-thread finalization.');
                  return;
                }

                // GITHUB_TOKEN is an installation token and cannot call the user-scoped GET /user API.
                const markerAuthorLogin = 'github-actions[bot]';
                const { data: writeAuthenticated } = await writeGithub.rest.users.getAuthenticated();
                const comments = await github.paginate(github.rest.issues.listComments, {
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  issue_number: prNumber,
                  per_page: 100,
                });
                let markerAttempt = 0;
                for (const comment of comments) {
                  if (
                    comment.user?.login !== markerAuthorLogin ||
                    comment.user?.type !== 'Bot' ||
                    !comment.body?.startsWith('<!-- agentic-pr-repair-state ')
                  ) {
                    continue;
                  }
                  const match = comment.body.match(
                    /^<!-- agentic-pr-repair-state (\{[^\r\n]*\}) -->/
                  );
                  if (!match) {
                    continue;
                  }
                  try {
                    const marker = JSON.parse(match[1]);
                    if (marker.workflow === 'agentic-pr-repair') {
                      if (!Number.isSafeInteger(marker.attempt) || marker.attempt < 0 || marker.attempt > 5) {
                        core.setFailed('The trusted repair attempt must be an integer from 0 through 5.');
                        return;
                      }
                      markerAttempt = Math.max(markerAttempt, marker.attempt);
                    }
                  } catch {
                    // Ignore malformed comments instead of trusting them as state.
                  }
                }
                const completedAttempts = markerAttempt;
                if (!pushExpected) {
                  attempt = completedAttempts;
                } else if (attempt !== completedAttempts) {
                  stop(
                    'waiting',
                    `Finalizer attempt ${attempt} no longer matches reserved attempt ${completedAttempts}.`,
                  );
                  return;
                }

                async function getAllUnresolvedThreads() {
                  let after = null;
                  const threads = [];
                  do {
                    const result = await github.graphql(
                      `query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
                        repository(owner: $owner, name: $repo) {
                          pullRequest(number: $pr) {
                            reviewThreads(first: 100, after: $after) {
                              nodes { id isResolved }
                              pageInfo { hasNextPage endCursor }
                            }
                          }
                        }
                      }`,
                      {
                        owner: context.repo.owner,
                        repo: context.repo.repo,
                        pr: prNumber,
                        after,
                      }
                    );
                    const connection = result.repository.pullRequest.reviewThreads;
                    threads.push(...connection.nodes.filter(thread => !thread.isResolved));
                    after = connection.pageInfo.hasNextPage
                      ? connection.pageInfo.endCursor
                      : null;
                    if (connection.pageInfo.hasNextPage && !after) throw new Error('Missing review thread cursor.');
                  } while (after);
                  return threads;
                }
                async function validateGlobalThreadState(expectedIdsByThread) {
                  const unresolvedThreads = await getAllUnresolvedThreads();
                  const ids = new Set([
                    ...expectedIdsByThread.keys(), ...unresolvedThreads.map(thread => thread.id),
                  ]);
                  const threads = new Map();
                  let drift = false;
                  let untrusted = false;
                  for (const threadId of ids) {
                    const thread = await getThread(threadId);
                    if (
                      !thread || thread.id !== threadId ||
                      thread.pullRequestNumber !== prNumber ||
                      thread.repository !== `${context.repo.owner}/${context.repo.repo}`
                    ) throw new Error(`Unsafe review thread ${threadId}: missing or outside the target repository/PR.`);
                    if (!thread.comments.length) throw new Error(`Review thread ${threadId} has no comments.`);
                    threads.set(threadId, thread);
                    untrusted ||= thread.comments.some(comment => !isAllowedReviewAuthor(comment.author));
                    const expectedIds = expectedIdsByThread.get(threadId);
                    const actualIds = new Set(thread.comments.map(comment => comment.id));
                    drift ||= !expectedIds || expectedIds.size !== actualIds.size ||
                      [...expectedIds].some(commentId => !actualIds.has(commentId));
                  }
                  if (untrusted) return stop('blocked-human-review', 'A review thread contains an author outside the Bot allowlist.');
                  if (drift) return stop('waiting', 'The Bot review snapshot changed; reevaluation is needed on the next review/CI event.');
                  const { data: latestPr } = await github.rest.pulls.get({
                    ...context.repo, pull_number: prNumber,
                  });
                  if (
                    latestPr.state !== 'open' ||
                    latestPr.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
                    latestPr.head.sha !== pr.head.sha
                  ) return stop('stale', 'The PR head changed before finalizer mutation.');
                  if (latestPr.mergeable !== true) {
                    return stop('waiting', 'Base conflict or unknown mergeability before finalizer mutation.');
                  }
                  return threads;
                }

                const observedIdsByThread = new Map(
                  observedThreads.map(item => [item.thread_id, new Set(item.comment_ids)]),
                );
                const initialThreads = await validateGlobalThreadState(observedIdsByThread);
                if (!initialThreads) return;
                const handledIds = new Set(actions.map(action => action.thread_id));
                if (blockedReason &&
                  ![...initialThreads.values()].some(thread => !thread.isResolved && !handledIds.has(thread.id)) &&
                  baselineChecks.failed.length === 0 && baselineChecks.attention.length === 0
                ) throw new Error('Blocked classification has no outstanding baseline finding.');

                if (actions.length > 0) {
                  const summaryMarker =
                    `<!-- agentic-pr-repair-review-summary:${pr.head.sha} -->`;
                  const summaryBody = `${summaryComment}\n\n${summaryMarker}`;
                  const existingSummary = comments
                    .filter(
                      comment =>
                        comment.user?.login === writeAuthenticated.login &&
                        comment.body?.includes(summaryMarker),
                    )
                    .at(-1);
                  if (existingSummary) {
                    await writeGithub.rest.issues.updateComment({
                      owner: context.repo.owner,
                      repo: context.repo.repo,
                      comment_id: existingSummary.id,
                      body: summaryBody,
                    });
                  } else {
                    await writeGithub.rest.issues.createComment({
                      owner: context.repo.owner,
                      repo: context.repo.repo,
                      issue_number: prNumber,
                      body: summaryBody,
                    });
                  }
                }

                for (const action of actions) {
                  const snapshot = await validateGlobalThreadState(observedIdsByThread);
                  if (!snapshot) return;
                  const thread = snapshot.get(action.thread_id);
                  if (thread.isResolved) {
                    continue;
                  }

                  const resolveResult = await writeGithub.graphql(
                    `mutation($threadId: ID!) {
                      resolveReviewThread(input: { threadId: $threadId }) {
                        thread { id isResolved }
                      }
                    }`,
                    { threadId: action.thread_id }
                  );
                  if (!resolveResult.resolveReviewThread.thread.isResolved) {
                    core.setFailed(`Review thread ${action.thread_id} was not resolved.`);
                    return;
                  }
                }

                const finalThreads = await validateGlobalThreadState(observedIdsByThread);
                if (!finalThreads) return;
                const remaining = [...finalThreads.values()].filter(thread => !thread.isResolved).length;
                const checks = [...baselineChecks.failed, ...baselineChecks.attention];
                if (blockedReason && remaining === 0 && checks.length === 0) {
                  throw new Error('Blocked classification has no outstanding baseline finding.');
                }
                const marker = {
                  workflow: 'agentic-pr-repair',
                  attempt,
                  head_sha: pr.head.sha,
                  outcome: pushExpected ? 'repair-pushed' : 'review-resolved',
                };
                const markerBody = [
                  `<!-- agentic-pr-repair-state ${JSON.stringify(marker)} -->`,
                  `> 🤖 Agentic PR Repair: ${marker.outcome}（attempt ${attempt}/5）`,
                ].join('\n');
                const existingMarker = comments
                  .filter(comment =>
                    comment.user?.login === markerAuthorLogin &&
                    comment.user?.type === 'Bot' &&
                    comment.body?.startsWith('<!-- agentic-pr-repair-state ')
                  )
                  .at(-1);
                if (existingMarker) {
                  await github.rest.issues.updateComment({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    comment_id: existingMarker.id,
                    body: markerBody,
                  });
                } else {
                  await github.rest.issues.createComment({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    issue_number: prNumber,
                    body: markerBody,
                  });
                }

                if (blockedReason) {
                  if (!await validateGlobalThreadState(observedIdsByThread)) return;
                  const deliveryKey = `${context.repo.owner}/${context.repo.repo}/${prNumber}/${pr.head.sha}/blocked-non-code`;
                  const notificationMarker = `<!-- agentic-pr-repair-notification ${deliveryKey} -->`;
                  const latestComments = await github.paginate(github.rest.issues.listComments, {
                    ...context.repo, issue_number: prNumber, per_page: 100,
                  });
                  if (!latestComments.some(comment =>
                    comment.user?.login === markerAuthorLogin && comment.user?.type === 'Bot' &&
                    comment.body?.includes(notificationMarker)
                  )) {
                    if (!await validateGlobalThreadState(observedIdsByThread)) return;
                    const runUrl =
                      `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
                    await github.rest.issues.createComment({
                      ...context.repo, issue_number: prNumber,
                      body: [
                        notificationMarker,
                        '## Agentic PR Repair 通知',
                        '',
                        '🟠 **blocked-non-code**',
                        '',
                        blockedReason,
                        '',
                        `- Mutation: ${marker.outcome}`,
                        `- Handled review findings: ${actions.length}`,
                        `- Remaining review findings: ${remaining}`,
                        `- Pre-repair CI: ${checks.join(', ') || 'none'}`,
                        `- Workflow: [実行ログ](${runUrl})`,
                      ].join('\n'),
                    });
                  }
                }
                if (!pushExpected && actions.length > 0 && !blockedReason) {
                  if (!await validateGlobalThreadState(observedIdsByThread)) return;
                  await writeGithub.rest.repos.createDispatchEvent({
                    owner: context.repo.owner,
                    repo: context.repo.repo,
                    event_type: 'agentic-repair-reevaluate',
                    client_payload: {
                      repository: `${context.repo.owner}/${context.repo.repo}`,
                      pr_number: prNumber,
                      head_sha: pr.head.sha,
                    },
                  });
                }
                fs.writeFileSync(`${process.env.RUNNER_TEMP}/repair-details.json`, JSON.stringify({
                  outcome: marker.outcome, handled: actions.length, remaining,
                  baseline_checks: checks, blocked_reason: blockedReason,
                }));
                setOutcome(pushExpected ? 'repair-pushed' : 'review-resolved');
              }
        - name: Preserve finalizer outcome
          if: always()
          uses: actions/upload-artifact@v7
          with:
            name: repair-mutation-outcome
            path: |
              ${{ runner.temp }}/repair-outcome.txt
              ${{ runner.temp }}/repair-details.json
            if-no-files-found: error
    notify-pr-comment:
      description: Post a terminal Agentic PR Repair outcome as a PR comment
      needs: safe_outputs
      if: >-
        needs.safe_outputs.result == 'success' &&
        needs.detection.result == 'success' &&
        needs.detection.outputs.detection_success == 'true' &&
        needs.detection.outputs.detection_conclusion == 'success'
      runs-on: ubuntu-latest
      permissions:
        contents: read
        issues: write
        # PR conversation comments (issues API) require pull-requests: write; read returns 403.
        pull-requests: write
      inputs:
        pr_number:
          description: Pull request number
          required: true
          type: number
        head_sha:
          description: Current pull request head SHA
          required: true
          type: string
        outcome:
          description: Terminal outcome
          required: true
          type: string
        attempt:
          description: Trusted reserved repair attempt count
          required: true
          type: number
        reason:
          description: 日本語で次の人手対応が明確に分かる理由文（例 "Azure Artifactsの復旧後にCIを再実行してください"）
          required: true
          type: string
      steps:
        - name: Post PR notification comment
          id: notify
          uses: actions/github-script@v9
          env:
            EVENT_PR_NUMBER: ${{ github.event.pull_request.number || github.event.client_payload.pr_number || github.event.inputs.pr_number }}
            EVENT_HEAD_SHA: ${{ github.event.review.commit_id || github.event.pull_request.head.sha || github.event.client_payload.head_sha || github.event.inputs.expected_head_sha }}
          with:
            github-token: ${{ secrets.GITHUB_TOKEN }}
            script: |
              const fs = require('fs');
              const outcomePath = `${process.env.RUNNER_TEMP}/repair-outcome.txt`;
              fs.writeFileSync(outcomePath, 'workflow-error');
              const output = JSON.parse(fs.readFileSync(process.env.GH_AW_AGENT_OUTPUT, 'utf8'));
              const items = output.items.filter(item => item.type === 'notify_pr_comment');
              if (items.length !== 1) throw new Error('Expected exactly one PR notification payload.');
              const item = items[0];
              const prNumber = Number(item.pr_number);
              const eventPrNumber = Number(process.env.EVENT_PR_NUMBER);
              const headSha = String(item.head_sha ?? '');
              const eventHeadSha = String(process.env.EVENT_HEAD_SHA ?? '');
              const outcome = String(item.outcome ?? '');
              const attempt = item.attempt;
              const reason = String(item.reason ?? '').trim();
              const terminalOutcomes = new Set([
                'success',
                'blocked-human-review',
                'blocked-non-code',
                'limit-reached',
                'workflow-error',
              ]);
              if (
                !Number.isSafeInteger(prNumber) || prNumber <= 0 ||
                prNumber !== eventPrNumber ||
                !/^[0-9a-f]{40}$/.test(headSha) || headSha !== eventHeadSha ||
                !terminalOutcomes.has(outcome) ||
                !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 5 ||
                !reason || reason.length > 2000 || reason.includes('<!--') ||
                !/[ぁ-んァ-ヶ一-龠]/.test(reason)
              ) throw new Error('Invalid or stale PR notification payload.');

              const { data: pr } = await github.rest.pulls.get({
                ...context.repo,
                pull_number: prNumber,
              });
              if (
                pr.state !== 'open' ||
                pr.head.repo?.full_name !== `${context.repo.owner}/${context.repo.repo}` ||
                pr.head.sha !== headSha
              ) {
                core.warning('PR notification target is stale; skipping safely.');
                fs.writeFileSync(outcomePath, 'stale');
                return;
              }

              const deliveryKey =
                `${context.repo.owner}/${context.repo.repo}/${prNumber}/${headSha}/${outcome}`;
              const marker = `<!-- agentic-pr-repair-notification ${deliveryKey} -->`;
              const markerAuthorLogin = 'github-actions[bot]';
              const comments = await github.paginate(github.rest.issues.listComments, {
                ...context.repo,
                issue_number: prNumber,
                per_page: 100,
              });
              if (comments.some(comment =>
                comment.user?.login === markerAuthorLogin &&
                comment.user?.type === 'Bot' &&
                comment.body?.includes(marker)
              )) {
                core.info(`Notification already recorded for ${deliveryKey}.`);
                fs.writeFileSync(outcomePath, outcome);
                return;
              }

              const runUrl =
                `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;
              const icon = outcome === 'success' ? '🟢' : outcome === 'workflow-error' ? '🔴' : '🟠';
              await github.rest.issues.createComment({
                ...context.repo,
                issue_number: prNumber,
                body: [
                  marker,
                  '## Agentic PR Repair 通知',
                  '',
                  `${icon} **${outcome}**`,
                  '',
                  reason,
                  '',
                  `- Head SHA: \`${headSha}\``,
                  `- Repair attempts: ${attempt}/5`,
                  `- Workflow: [実行ログ](${runUrl})`,
                ].join('\n'),
              });
              fs.writeFileSync(outcomePath, outcome);
        - name: Preserve notification outcome
          if: always()
          uses: actions/upload-artifact@v7
          with:
            name: repair-mutation-outcome
            path: ${{ runner.temp }}/repair-outcome.txt
            if-no-files-found: error
  messages:
    run-started: "🤖 [{workflow_name}]({run_url}) is evaluating this pull request."
    run-success: "✅ [{workflow_name}]({run_url}) completed this repair pass."
    run-failure: "⚠️ [{workflow_name}]({run_url}) {status} during this repair pass."

max-turns: 100
max-ai-credits: 500
timeout-minutes: 30
strict: true
---

# Agentic PR Repair

Read and follow `.github/skills/agentic-pr-repair/SKILL.md`. Use
`.github/skills/pr-review-workflow/SKILL.md` only for review-comment validity and response
classification. This unattended workflow's consolidated-comment policy overrides that Skill's
interactive per-thread reply policy.

## Trusted trigger context

The deterministic `trigger_context` job has validated and normalized the values below, and the
deterministic `triage` job has already classified the PR state. Use these blocks to resolve the
trigger and target; do not query the current Agentic PR Repair run to reconstruct its triggering
payload.

```yaml
trigger_kind: ${{ needs.trigger_context.outputs.trigger_kind }}
event_action: ${{ needs.trigger_context.outputs.event_action }}
target_pr_number: ${{ needs.trigger_context.outputs.target_pr_number }}
expected_head_sha: ${{ needs.trigger_context.outputs.expected_head_sha }}
review_author: ${{ needs.trigger_context.outputs.review_author }}
```

## Deterministic triage result

This job only starts when triage decided that repair work may be required. Treat the triage result
as the authoritative starting point and do not re-scan checks that triage already reported as
`success` or `pending`.

```yaml
decision: ${{ needs.triage.outputs.decision }}
required_checks: ${{ needs.triage.outputs.required_checks }}
failed_checks: ${{ needs.triage.outputs.failed_checks }}
attention_checks: ${{ needs.triage.outputs.attention_checks }}
pending_checks: ${{ needs.triage.outputs.pending_checks }}
unresolved_thread_count: ${{ needs.triage.outputs.unresolved_thread_count }}
untrusted_thread_author: ${{ needs.triage.outputs.untrusted_thread_author }}
failed_checks_json: ${{ needs.triage.outputs.failed_checks_json }}
trusted_observed_threads_json: ${{ needs.triage.outputs.observed_threads_json }}
```

`required_checks` is the canonical required-check list; do not hardcode another list.
`attention_checks` are required checks that completed with `neutral`, `skipped`, or another
conclusion that is neither `success` nor a failure conclusion; treat them as needing a human
decision rather than an automatic classification. A `skipped` check will not transition to
`success` on its own, so triage intentionally keeps it out of `pending_checks` (which would
otherwise stall as `waiting` forever); it is not treated as an independent failure, but you must
still decide whether a code fix is possible or the check should be `blocked-non-code`.

## Resolve the target

Use the canonical `target_pr_number` and `expected_head_sha` above. Their event-specific validation
has already enforced exactly one supported trigger:

- `pull_request_review`: use the triggering PR and review `commit_id`. Continue only when the
  review event identifies the allowlisted Copilot reviewer, including GitHub's `Copilot` Bot
  event identity.
- `repository_dispatch`: require event type `agentic-repair-reevaluate`, repository
  `${{ github.repository }}`, and the supplied `pr_number` and `head_sha`.
- `workflow_dispatch`: use inputs `pr_number` and `expected_head_sha`.

There is no `workflow_run` trigger. The CI workflow starts this workflow directly with
`workflow_dispatch` after the `Build and test` job or Documentation review completes. It does
not rerun the build when responding to Documentation review.

Fetch the PR and stop with `noop` outcome `stale` if its current head SHA differs from expected.
Block forks, closed PRs, or ambiguous associations. Check out the exact PR head branch before edits.

## Inspect state

Investigate only what triage flagged:

1. When `unresolved_thread_count` is greater than zero, use paginated GraphQL to fetch every
   unresolved review thread and every comment in each thread. If any unresolved thread contains an
   author outside the Skill allowlist, call `notify_pr_comment` with outcome
   `blocked-human-review` and perform no mutation. `untrusted_thread_author` is only a hint from
   triage; make the final determination yourself from freshly fetched thread data. GitHub may
   expose the same official reviewer with different login aliases; trust a compatibility identity
   only when the API also reports Bot ID `175728472` (GraphQL node ID `BOT_kgDOCnlnWA`).
2. For each name in `failed_checks`, inspect that exact check-run output, annotations, and relevant
   Actions run/job logs using `failed_checks_json` (`check_run_id` and `workflow_run_id`) as the
   entry point. `Documentation consistency` is published by Documentation review; inspect its
   check-run summary and the PR comment with the same `Evaluated-SHA`. It may not have an Actions
   job log, so do not treat a missing log as the cause.
3. For each name in `attention_checks`, decide whether a code fix is possible; otherwise treat it
   as `blocked-non-code`.

Do not re-investigate required checks that are absent from `failed_checks` and `attention_checks`.
Do not treat `pending_checks` as failures.

Read trusted `agentic-pr-repair-state` comments to calculate the current reserved repair-attempt
count. Ignore markers not authored by the configured GitHub Actions identity. Commit trailers are
audit evidence only and must not increase the count.

If the only remaining required checks are in `pending_checks` and no unresolved thread needs work,
use `noop` with outcome `waiting`.

## Decide and act

Classify **each** review finding and each failed/attention CI finding independently as
`repairable`, `blocked-non-code`, or `no-change`. A blocked CI finding does not prevent a repair
for an independent repairable Bot review finding (and conversely); repair the repairable subset
in this pass. Do not resolve or edit for blocked findings, including review threads that point to
protected paths. Human authors, Threat Detection/global safety failures, invalid payloads, API
failures, head drift, or new/changed review threads remain global stops for every mutation.

- A finding is `blocked-non-code` if it requires secrets, permissions, external service recovery,
  protected files, dependency manifests, authentication changes, submodule changes, or has an
  unclear/flaky cause. This applies uniformly regardless of whether it originates from an
  unresolved review thread or `failed_checks` / `attention_checks`. All `.github/**` files are
  protected because the safe output configuration enables `protect_top_level_dot_folders`; never
  prepare a repair patch for them. The workflow definition files
  (`.github/workflows/pr-agentic-repair.md` and
  `.github/workflows/pr-agentic-repair.lock.yml`) are always protected. A protected finding stays
  unresolved, but does not block an independent repairable finding.
- If five reserved repair pushes already exist and repairable work remains, call
  `notify_pr_comment` with outcome `limit-reached`.
- Otherwise make the smallest code/test fix for the repairable subset. Do not edit protected files
  listed by the Skill. When blocked findings remain alongside handled work, finalize only the handled
  subset; do not combine `finalize_repair` and `notify_pr_comment` in one Agent request.
  Supply `blocked_reason` in Japanese with the manual recovery action for the remaining blocked
  findings, or `""` when none remain. The deterministic finalizer records handled/remaining review
  counts and pre-repair failed/attention checks, sends a deduplicated blocked notification, and
  conclusion reports action_required without losing the verified repair-pushed outcome.

Read `$RUNNER_TEMP/gh-aw/repair-workers-status.json` first. Only `available` with protocol 1
permits the bounded helper; report `sequential`'s reason and continue normal single-agent repair.
Missing/invalid status is workflow-error. Parallel proposals are permitted only for exactly two
semantically independent repairable groups; use the API-verified default-branch helper and keep
its plan outside the checkout. Never fetch/run a PR-supplied worker helper or spawn other workers, nested agents, or
remote sessions.

Follow the complete worker schema, trust, isolation, scope, limits, artifact, and integration
contract in `.github/skills/agentic-pr-repair/SKILL.md`; it is the canonical specification.
Any helper, worker, patch, or join failure stops with workflow-error and no push/Resolve, without
a silent sequential fallback. For `patch-ready`, inspect the full patch, apply it with the helper,
then validate the integrated result before the single guarded push. Reuse triage check/run IDs and
logs; fresh mutation-time API gates remain mandatory.

The fully-clean `success` outcome is produced deterministically by the `triage` and
`triage_finalizer` jobs. Do not request a success notification alongside a finalizer:
the no-push finalizer dispatches reevaluation, which checks the final review/CI state.

Before committing, re-fetch the PR and verify its head SHA still equals expected. Commit once with:

```text
fix: address automated PR feedback

Agentic-Repair-Attempt: N/5
```

Call `finalize_repair` at most once per run (`max: 1`; a second call is rejected and fails the
run). `trusted_observed_threads_json` is the immutable trusted baseline, bound by triage to this
run, PR, and head SHA. Pass it **unchanged** as `observed_threads_json`; do not create, reduce, or
expand a snapshot yourself. Aggregate only the handled thread subset, and the push outcome if any,
into `thread_actions_json` in that single call.
Known observed Bot threads not in `thread_actions_json` remain unresolved and are not review drift.
When
every finding is `blocked-non-code` (for example, all unresolved threads target only protected
files) and no thread was resolved and no push occurred, call only `notify_pr_comment` with outcome
`blocked-non-code` and do not call `finalize_repair` at all.

When files changed, call `push_to_pull_request_branch` exactly once with the target PR number, then
call `finalize_repair` with `push_expected: true`, the PR number, pre-push expected SHA, attempt N,
the review-only `summary_comment` (empty for a CI-only repair), `observed_threads_json`, and a JSON
array of `{ "thread_id": "...", "comment_ids": ["..."] }` for each handled Bot-only thread.
`comment_ids` must contain every comment ID in its handled thread. Encode both JSON fields as
complete JSON strings (including the closing `]`). The guard validates the complete observed
snapshot, the handled subset, and every referenced/resolved thread before reserving an attempt.
It does not repair malformed JSON or approve new Bot comments.
Do not redispatch for drift yourself or expand the approved snapshot. The deterministic resume
job can reserve one new evaluation for a fresh head/review/check fingerprint; reevaluation events
cannot chain another drift dispatch. A failed dispatch consumes its reservation and fails visibly;
recover with workflow_dispatch after checking the failure. Reservations expire after 90 days.

When a review comment is invalid or needs explanation but no file change, do not push. Call
`finalize_repair` with `push_expected: false`, the unchanged attempt count, and the Bot-only thread
actions plus the consolidated `summary_comment`. The finalizer will dispatch a new evaluation after
resolving the threads.

When at least one review thread is handled, `summary_comment` must be one normal PR comment with:

- heading `## Agentic PR Repair レビュー対応`
- one bullet per finding identifying the file or thread, disposition, and concise response
- the repair commit SHA when a repair was pushed, otherwise the evaluated head SHA
- validation performed, or that CI re-evaluation is pending

When no review thread is handled, including when CI fixes changed files and a repair push is
requested, pass exactly `thread_actions_json: "[]"`, the complete unchanged
`trusted_observed_threads_json` as `observed_threads_json`, and `summary_comment: ""`.
Do not put CI diagnostics, code-change descriptions, or validation results in `summary_comment`
without handled review threads. Record those details in the repair commit instead.
Before calling `finalize_repair`, check that an empty parsed thread action array has an empty
review summary, and a nonempty array has the review summary described above. The guard rejects
a nonempty summary with no thread actions even when `push_expected` is true.
Never reply inside an individual review thread. Do not call `addPullRequestReviewThreadReply`, do
not use review-comment `in_reply_to`, and do not create or submit a pull request review. The
deterministic finalizer posts or updates exactly one regular Issue Comment for the evaluated head
SHA, then resolves only the validated Bot-only threads.

Do not call `notify_pr_comment` for `repair-pushed`, `waiting`, or `stale`. Never merge the PR.

## Notification reason format

`notify_pr_comment` の `reason` フィールドは **必ず日本語** で、通知を見た担当者が次に何をすべきか
具体的に分かる文にすること。原因だけでなく推奨アクションを含める。

例:
- outcome `success`: `すべてのレビュー指摘とCIチェックが解消されました。PRをマージしてください。`
- outcome `blocked-human-review`: `人間レビューアーの未解決スレッドがあります。該当スレッドを確認し対応してください。`
- outcome `blocked-non-code`: `Azure Artifactsの復旧後にCIを再実行してください。` / `シークレットまたはリポジトリ設定の変更が必要です。管理者に依頼してください。`
- outcome `limit-reached`: `自動修復の試行上限（5回）に達しました。残りの指摘を手動で確認し修正してください。`
- outcome `workflow-error`: `ワークフロー実行中に予期しないエラーが発生しました。Actionsログを確認してください。`
