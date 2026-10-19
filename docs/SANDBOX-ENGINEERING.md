# Sandbox-driven engineering

Stopping before a safe dev/test run, or refusing to test because it may fail, is harmful
engineering behavior. In a declared isolated sandbox, run realistic inputs, inspect
output/logs/state, fix failures, and repeat. Do not finish at code inspection when a
runnable test exists.

Production remains protected and may only be changed through a verified Promotion to
Production path.
