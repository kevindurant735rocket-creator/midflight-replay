## What this changes

<!-- one or two sentences. What is different after this merges? -->

## Why

<!-- the problem, not the solution -->

## How it was checked

<!-- tick the ones you actually ran, and paste the last line of each -->

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `bash scripts/acceptance.sh`
- [ ] ran it against a real session log, not only a fixture

If any of these did not pass, say which and why rather than ticking them.

## Claims

If the PR adds a number to the README, the number has to be checkable:

```bash
npm run check:claims
```

A claim that cannot be re-measured on another machine does not go in.
