> **SHIPPED 2026-09-27 — this file is the original proposal, kept for the
> reasoning. It is not an open task.** `src/revert.ts` landed in `5cbe923`;
> GitHub issue #2 is closed; `docs/BACKLOG.md` P0-2 reads **DONE 2026-09-27**
> with the verified `git apply --check -R` rc=0 acceptance run. The P0-1
> block described below no longer applies. For current state read
> `docs/BACKLOG.md`, not this file.

# `midflight revert` — the inverse of the report (P0-2)

Once before-images are real ([P0-1](01-read-claude-file-history-before-images.md)),
the report stops being read-only and gains its obvious inverse: given a step
index, print the patch that step applied, ready to `git apply -R`.

**Blocked on P0-1 by design.** Reverting a diff you reconstructed from a guess
is a way to lose work, so this ships after the reconstruction is provable, not
before. Do not start it against the current inline-`old_string` path.

**Acceptance**

```
midflight revert <report> --step <n> --out patch.diff
git apply --check -R patch.diff    # must exit 0 against the tree that step ran in
```

and the command must refuse — loudly, non-zero — when the step has no
before-image, rather than emitting an empty patch that `git apply` accepts as a
no-op.

Deliberately not in scope: writing to the working tree, or a server. A single
patch file on stdout keeps the zero-network, zero-dependency claim true.

Source: `docs/BACKLOG.md` P0-2, `docs/KNOWN-GAPS.md` §5.
