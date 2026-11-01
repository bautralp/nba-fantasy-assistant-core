# One-way source transfer design

Nothing in this export performs synchronization, dispatches a workflow or writes a Git ref. Architecture B keeps the current private repository operational: do not archive or rename it while it owns refresh, Pages and research. The public repository will not receive credentials or a writer workflow. The existing private PR #44 can stay in its current review/base context.

1. A trusted reviewer identifies an immutable public commit and public manifest digest. The file-level transfer inventory is reviewed, with no arbitrary script or artifact execution during import. No public workflow artifact is treated as trusted code.
2. Transfer only approved shared source files. Public demo/network adapters and workflow/package-profile overlays are not copied over the private live-provider adapters. `migration/source-transfer-contract.json` defines the exclusions; directory-wide rsync/mirror is not permitted. Dependency changes receive their own lock/notice and compatibility review.
3. Inside the ordinary private review process, record public source SHA, transfer digest, private base SHA, resulting private commit/release SHA, schema/API compatibility and full private test evidence. Verify approved files' hashes after integration. A green public synthetic job is not full private validation.
4. Keep a single private daily refresh/research/publish owner. Exact source-SHA publication, stale-head rejection, Pages target and frozen append-only controls remain on the private side. The two existing historical isolation mismatches still need an explicit private semantic review.
5. Rollback stops source imports and uses the last verified private source/dependency/adapter mapping and existing Pages release process. Never rewrite saved origins or force-push research history. Previously public code copies cannot be recalled.

No private-to-public automated source, dataset, cache, artifact, log or report path is proposed. If a private fix should become public later, it needs a separate minimal sanitized patch review. Actual GitHub settings, bot bypass and credential scope remain user checks, outside this local preparation.
