# Research isolation and immutable history

The two original research isolation guards used `bae82dc11ed06714271cba2652400c66a4126d64` and `ff25aaed9a9e2a47a00a1447efee3fef16df7926`. Reproducing them against the fixed original main gives 27 modified, 106 added and 2 deleted protected paths for each: the historical comparison still fails. No SHA was replaced and these results are not converted into a PASS.

`migration/isolation/*.json` retains each exact original protected-path list and historical identity. `scripts/isolation_guard.py` preserves membership, content and executable mode; symlinks are rejected. Its pure comparator has independent synthetic mutation tests for both complete path lists, including every protected entry. Research output outside those original scopes can change; production changes cannot.

For a private research change, an operator-reviewed external base manifest and exact digest are required, under the private profile. The candidate cannot generate or silently replace its trusted base. The reviewed manifest includes policy identity, approved source identity and the original historical SHA. No public job authorizes research or production. Public CI tests only the comparator on synthetic temporary trees. Installing this new per-change checker in private production is a separate review; the existing immutable baseline comparisons remain independently required and currently blocked.

This separates an impossible public-history lookup from a reusable security predicate without claiming historical equivalence. Private model/protocol/first-origin hashes, archived ledgers and append-only rules remain authoritative and unchanged. A safe per-change comparison does not by itself approve a new frozen baseline or public distribution of data.
