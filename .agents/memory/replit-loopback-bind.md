---
name: Loopback bind vs Replit waitForPort
description: Binding the dev server to 127.0.0.1 makes the Replit workflow fail DIDNT_OPEN_A_PORT even though the preview proxy can reach it; this repo binds 0.0.0.0 only when REPL_ID is set.
---

The preview proxy CAN reach a server bound to 127.0.0.1:5000 (verified empirically via the dev domain), but the platform's workflow port detection (`waitForPort`) cannot — the workflow fails "didn't open port" and gets killed.

**Why:** Port detection and the preview proxy are separate paths; detection requires a 0.0.0.0 bind (see the debug-workflow-ports-issues skill).

**How to apply:** The Express server stays loopback-only on real user machines and binds 0.0.0.0 only when `process.env.REPL_ID` is set (a Replit container is not the user's LAN). Security parity on Replit comes from the per-launch API token middleware, not the bind address. Never "fix" a Replit-only bind back to plain 0.0.0.0 unconditionally, and don't chase DIDNT_OPEN_A_PORT as a code bug when the log shows the server listening on 127.0.0.1.
