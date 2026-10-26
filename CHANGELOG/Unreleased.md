## Unreleased

### Fixes

- **Embedded agent run timeout**: Keep the execution deadline on the monotonic clock during approval pauses so a wall-clock jump (NTP step, DST transition, manual date change) cannot prematurely abort a run or hold its lane indefinitely. The `ExecutionDeadline` now carries a `monotonicDeadlineMs` alongside its wall-clock `deadlineAtMs`; the remaining budget computed on approval resume uses `performance.now()` instead of `Date.now()`. Plugin-approval human-input-wait deadlines are likewise switched to the monotonic clock.

  Ref: BUG-234-cron-stream-approval-deadline-wall-clock

- Control UI: keep automation editor actions flush with the scroll area's bottom, including on narrow screens and when editing job scratch. (#172176) Thanks @brandon-julio-t!
