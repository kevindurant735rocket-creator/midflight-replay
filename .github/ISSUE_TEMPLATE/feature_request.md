---
name: Feature request
about: Suggest something
title: ""
labels: enhancement
---

**The problem, not the solution:** what can't you do today?

**Who hits it:** only you? your team? reviewers of AI PRs?

**Does it need a network call?** midflight ships zero-network. If your idea does, say
so and say why the constraint should bend — argue it here, with a measurement, before
you write the code.

**Evidence:** if you've measured something about real session logs that motivates this
(how many `patch` fields exist, how often a loop repeats, etc.), include the numbers.
We add adapters and detectors based on measured data, not intuition.
