---
name: Long (>2 min) jobs must run as a Replit workflow
description: Why bash background jobs die mid-run on Replit, and the reliable way to run multi-minute scripts.
---

# Long-running jobs on Replit

A bash background job (`cmd &`, `setsid`, `nohup …`, disown) is KILLED at the
bash-tool-call boundary — it does not survive past the tool invocation that
started it. So any script that runs longer than the bash tool's ~2 min timeout
cannot be backgrounded this way; it just gets reaped and you see a partial/empty
log.

**How to apply:** for multi-minute work (large benchmarks, big seeds, long
builds), register it as a temporary Replit **workflow** (a named long-running
command managed by the platform), let it run, read its log via `refresh_all_logs`
/ the `/tmp/logs/<workflow>_*.log` file, then remove the workflow when done.

**Why:** a real at-scale benchmark in this repo (~2.5 min) only completed when
run as a temporary `engine-bench` workflow; the same command as a bash `&` job was
killed before finishing.
