---
name: Long jobs need a workflow, not a background bash job
description: Why >2min jobs (benchmarks, seeds, imports) must run as a Replit workflow and how to capture their output reliably
---

# Long-running jobs must run as a Replit workflow

A job that needs more than ~2 minutes of wall-clock CANNOT be run from the bash tool:
the bash tool caps a single call at 120000ms, and **backgrounded processes (`cmd &`,
`setsid`, `nohup`, `disown`) are killed at the bash-tool-call boundary** — when the
launching bash call returns, the detached child dies shortly after. Observed: a
detached bench died at the exact second its launcher's `sleep 25` ended, with tiny
RSS and no OOM/segfault/JS-exception trace (i.e. an external kill, not a crash).

**How to apply:** run the long job as a temporary workflow via the `workflows` skill
(`configureWorkflow({name, command, outputType:"console", autoStart:true})`).
Workflows are the one process class Replit keeps alive across agent turns (same as
`Start application`). Poll its output across turns, then `removeWorkflow` when done.
Have the command write results to a file you can `cat` between turns (e.g.
`> /tmp/x.log 2>&1`) so the data survives even if you stop watching.

# Streamed output survives a kill only if flushed per-line to a file

`npx ... | tee` / any **pipe** to stdout is block-buffered (~64KB); on SIGKILL the
buffer is lost, leaving a 0-byte log and no trace of where the job died. Two fixes,
both used together:
- Run the binary **directly** (`./node_modules/.bin/tsx x.ts`), not through `npx`
  (npx adds a buffering pipe layer).
- In the script, write each progress line with `process.stdout.write(line+"\n")` and
  redirect straight to a file (`> log 2>&1`). Writes to a regular file are synchronous
  on Linux, so a later kill still leaves a complete trail. Add a heartbeat (rows/rate/
  RSS every few seconds) so a frozen log instantly distinguishes "slow" from "dead".
