# Continuous delivery

## Order of work

1. Put code onto a task branch as soon as each coherent change starts; do not leave
   finished work uncommitted.
2. Open a draft PR once tests begin; promote the draft to ready only after comparing it
   with user scenarios and finding no contradictions.
3. Merge only after all required checks are green and a completed E2E covering the change
   exists. Manual human approval is not required.
4. After merge, deploy immediately and stop only when the deploy is verified. Do not
   merge a PR without a deploy plan or path.

## Standing rules

- Do not delete prior work, tasks, commits, PRs, records, or memories without explicit
  user confirmation.
- Keep docs and configuration changes limited to the requested task; do not add
  unrelated complexity.
