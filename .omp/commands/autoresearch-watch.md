# Autoresearch Watch Command

Run upstream `/autoresearch` unchanged, but require it to implement a durable, provider-neutral semantic-progress watcher in the target project's harness.

## Arguments

- `$ARGUMENTS` — a research goal whose first token is `--watch=<seconds>`. `seconds` is a positive finite number. Everything after that leading option is the goal passed to upstream `/autoresearch`.

Only the first token is parsed as the watch option; preserve all later text verbatim as the research goal. Reject missing, duplicate, malformed, non-finite, zero, or negative `--watch` values before changing the target project. Do not accept `--no-watch` for this command.

## Steps

### 1. Establish the target and upstream behavior

1. Treat the current project as the target project and inspect its harness, existing `/autoresearch` command, state layout, and test conventions.
2. Invoke `/autoresearch` with the goal after removing `--watch=<seconds>`, or follow its documented invocation procedure exactly if direct command composition is unavailable. Do not modify upstream `/autoresearch`, its prompt, its parser, or its state paths.
3. In the same target-project work, implement the watcher infrastructure requested below. Keep it opt-in: ordinary upstream `/autoresearch` behavior must remain byte-for-byte unchanged when no watcher is enabled.

### 2. Implement durable watcher state

1. Store watcher-owned durable state outside every upstream autoresearch state path. Use a project-local harness-owned location with restrictive permissions where appropriate; do not use provider storage as the source of truth.
2. On first use, atomically create one state record containing the remote submission identity, goal identity, watch interval, last semantic-progress token, last token-change time, and enough terminal outcome information to resume or report correctly.
3. On restart, atomically load and validate that state before deciding whether to submit. If it represents a compatible nonterminal run, reattach to it rather than submitting again. If it is terminal, report its terminal result. If it is malformed, incomplete, version-unknown, or incompatible, fail closed without submitting or treating it as success.
4. Serialize all read-modify-write transitions with a single-watcher lock. The lock must prevent two local processes from simultaneously submitting, observing, or replacing the same watcher state. Write replacement state to a temporary file in the same directory, flush it, atomically rename it into place, and ensure crash recovery never interprets a partial update as valid.

### 3. Observe remote work safely

1. Define a closed, structured remote-state model covering every state the implementation can observe: submitted/queued, running, succeeded, failed, cancelled, expired, and unknown. Map transport responses to this model in one provider-neutral boundary.
2. Treat an unknown state, missing required fields, malformed response, impossible transition, or unrecognized terminal result as failure. Never silently coerce it into running or success.
3. Bound observation failures: use a finite attempt/time budget and an explicit failure result after it is exhausted. Do not spin, recurse unboundedly, or hide repeated errors.
4. Do not poll a model, ask a model to judge liveness, or infer progress from output volume, timestamps, token counts, log chatter, or transport activity. Poll only the remote job/status interface needed to observe the structured state and reported semantic token.

### 4. Enforce semantic progress and staleness

1. Semantic progress is only a changed opaque progress token attached to a valid running observation. Record the token and refresh the liveness time only when the token differs from the persisted previous token.
2. A nonterminal job must produce a changed token before the requested watch interval deadline.
3. A repeated token, absent token, blank token, output-only activity, or observation success without a changed token does not refresh liveness.
4. If a nonterminal job has not produced a changed token for the requested watch interval, transition the watcher to a stale failure and report that result.
5. The watcher, not upstream `/autoresearch`, enforces this deadline.
6. Support this optional compatibility output line exactly:

   ```text
   AUTORESEARCH_PROGRESS TOKEN
   ```

   The literal `TOKEN` represents an opaque non-whitespace value after the single space and must be compared only for exact change. This line is a convention for work launched by the watcher; unmodified OMP `/autoresearch` does not parse it, so the harness-side watcher must capture, persist, and enforce staleness itself.

### 5. Validate completion and artifacts

1. Treat success as valid only when the remote job exits with code `0` and the configured primary metric is present, finite, and valid for the target project's existing metric contract.
2. Validate every required artifact before success: it must exist, be readable, be attributable to the observed run, and satisfy the target project's expected format and completeness checks. Missing, malformed, stale, or mismatched artifacts are failures.
3. A nonzero exit, remote failure/cancellation/expiry, stale run, observation-budget exhaustion, invalid metric, or invalid artifact is a failure with a structured reason persisted in state.
4. Report concise final status with the run identity, outcome, last semantic token time where relevant, and validation failure reason where applicable.

### 6. Prove the watcher locally

Add one minimal deterministic fake-provider self-check using the target project's existing test style. It must exercise all of these cases without network access:

1. successful exit with a valid primary metric and valid artifacts;
2. explicit remote failure;
3. repeated progress token leading to stale failure;
4. malformed response and unknown remote state, both failing closed;
5. process restart that reattaches to saved nonterminal state without a second submission.

Run only that self-check and fix the implementation until it passes. Do not run formatters, linters, typechecks, or broader test suites.

## Rules

- Keep the implementation provider-neutral and dependency-free; use the target platform's standard filesystem, locking, clock, and process primitives.
- Do not alter upstream `/autoresearch` or assume it understands watcher arguments or progress lines.
- Do not store watcher state in upstream autoresearch state paths, and do not delete or rewrite upstream state.
- Do not submit a duplicate remote run after a successful reattachment decision.
- Fail closed on malformed, unknown, missing, or inconsistent local and remote state; success requires all stated exit, metric, and artifact checks.
- Do not weaken the watcher to activity-based liveness or model-mediated polling.
- Preserve ordinary upstream `/autoresearch` behavior exactly when this command's watcher infrastructure is not selected.
