# Desktop release auto-lock smoke check

The normal Electron unit tests use an in-process `powerMonitor` event emitter.
That proves policy behavior, but it cannot prove that a packaged Electron
runtime receives the native operating-system events. Before a desktop release,
run the native smoke check on every supported release target:

| Target | Release-like package | Native session |
| --- | --- | --- |
| Windows x64 | `release/win-unpacked/` from `electron-builder --dir` | An interactive Windows desktop |
| macOS x64 | `release/mac/KYUTXO.app` from `electron-builder --dir` | A logged-in macOS x64 desktop |
| macOS arm64 | `release/mac-arm64/KYUTXO.app` from `electron-builder --dir` | A logged-in macOS arm64 desktop |
| Linux x64 | `release/linux-unpacked/` from `electron-builder --dir` | A logged-in Linux desktop session |
| Linux arm64 | `release/linux-arm64-unpacked/` from `electron-builder --dir` | A logged-in Linux desktop session |

The reusable GitHub `desktop-package-matrix` workflow builds the same five
platform/architecture targets and verifies their packaged native module. It
remains the safe pull-request matrix. The release workflow adds a separate
release-only `native-power-smoke` matrix on dedicated interactive runners. It
runs for version tags and explicit `workflow_dispatch` requests with
`publish_release` enabled. Each job builds its own target with
`electron-builder --dir`, runs this check, and must pass before the separate
publisher job can create the GitHub Release.

The five smoke jobs use these exact self-hosted labels:

| Target | Required runner labels |
| --- | --- |
| Windows x64 | `self-hosted`, `desktop-release-win-x64` |
| macOS x64 | `self-hosted`, `desktop-release-darwin-x64` |
| macOS arm64 | `self-hosted`, `desktop-release-darwin-arm64` |
| Linux x64 | `self-hosted`, `desktop-release-linux-x64` |
| Linux arm64 | `self-hosted`, `desktop-release-linux-arm64` |

The labels identify five separate machines (or five separately registered
interactive runner installations), not virtual architecture claims. Keep each
runner dedicated to one target so `process.platform` and `process.arch` are the
same values that the workflow passes to the check. The runner must stay in a
logged-in graphical desktop session while the job runs. Do not run these jobs
as a service account without a desktop session, through Xvfb, or on the normal
hosted runners.

## Scheduled readiness warning

The `Check desktop release runner readiness` workflow runs every Monday and can
also be started manually. Its five matrix jobs use the same dedicated labels as
the release gate, so an offline or incorrectly labeled runner remains visibly
queued instead of giving false assurance that the target is ready. The weekly
lead time lets maintainers restore it before release day (GitHub's job timeout
starts only after a runner accepts the job). Each runner reports its actual Node
OS/architecture and verifies that Bash is executable. Linux runners
additionally require `DISPLAY` or
`WAYLAND_DISPLAY`, the session D-Bus address, and an active, local graphical
session reported by `loginctl`.

This readiness workflow is intentionally non-destructive: it does not build or
launch KYUTXO and never invokes the native screen-lock or suspend commands.
Accepted jobs that fail a prerequisite emit a `Release desktop is not ready`
workflow warning and write the reason to the job summary. Maintainers should
inspect any failed or still-queued scheduled run, restore the named runner's
logged-in desktop session, and rerun the workflow manually until all five jobs
report **Ready**.

The separate `Monitor desktop release runner readiness` workflow runs on a
GitHub-hosted Ubuntu runner every five minutes. If one of those matrix jobs has
remained queued for more than **15 minutes**, it opens one deduplicated issue
whose title names the unavailable label, for example
`desktop-release-darwin-arm64`. Repository maintainers should subscribe to
**Issues** notifications so this alert route reaches them without anyone
watching the Actions page. The monitor run also fails visibly when it creates a
new alert.

The monitor has only `actions: read`, `contents: read`, and `issues: write`
permissions. It reads workflow runs and jobs and creates, comments on, or closes
its own alert issues. It does not call runner-management APIs and cannot
control, lock, suspend, relabel, register, or remove a runner.

An independent `Watch desktop release runner monitor heartbeat` workflow runs
on GitHub-hosted Ubuntu at minutes 7, 22, 37, and 52 of every hour. It opens a
deduplicated issue if `Monitor desktop release runner readiness` has not
completed for **30 minutes**. The issue names that monitor and links its latest
run (or its Actions page when no run exists). Subscribe to **Issues**
notifications for this dead-man route as well.

The watchdog has the same narrow `actions: read`, `contents: read`, and
`issues: write` permissions. It does not inspect, select, or mutate self-hosted
runners. Its owner is the repository maintainers responsible for desktop
releases. To recover, use the issue's link to inspect scheduling or permission
failures, re-enable or repair the monitor, and manually dispatch `Monitor
desktop release runner readiness`. The watchdog closes its issue only after it
observes a monitor completion newer than the alert; a failed monitor run still
counts as a heartbeat and must be investigated through that run's own failure.

### Manual live API contract check

Before a release, or after changing either readiness workflow, manually run
`Check release runner monitor live API contract`. The hosted controller creates
disposable runs of `Desktop release runner monitor contract fixture` and reads
them back through the same GitHub Actions run/job APIs used by the monitor. It
must report four passes:

- the controlled `readiness-linux-x64` matrix job is returned as `queued` and
  resolves to the exact `desktop-release-linux-x64` release-runner label;
- cancelling that disposable run is returned as a completed `cancelled` job;
- a hosted follow-up fixture is returned as completed `failure`; and
- a hosted follow-up fixture is returned as completed `success`.

The queued fixture uses the reserved
`release-runner-monitor-contract-no-runner` label, never a release desktop
label. The controller cancels it as soon as the queued payload is observed and
also attempts cancellation during failure cleanup. The check is manual-only,
has no `issues: write` permission, never invokes the alerting monitor, and uses
no runner-management API. It therefore cannot control or relabel a runner, open
an alert issue, or leave a recurring source of alert noise. If a controller run
is manually cancelled at the same moment as its cleanup, cancel any remaining
contract fixture run from the Actions page; the fixture cannot be mistaken for
the production readiness workflow by the scheduled monitor.

To recover, start the named Actions runner from its logged-in interactive
desktop session, confirm its exact release label is still registered, and
manually rerun `Check desktop release runner readiness`. The hosted monitor
keeps the issue open if the old job is merely cancelled, expires, or if a newer
probe fails. Only after that exact label successfully completes a readiness job
newer than the alert does the monitor add a recovery comment and close the issue
automatically. If the runner is healthy but the issue remains open, run the
monitor manually after the successful readiness rerun has completed.

## Interactive runner setup

Register each machine as a repository self-hosted runner with the labels
above, and launch the GitHub Actions runner from the logged-in desktop user's
session. A startup task, user-level LaunchAgent, or desktop autostart entry is
preferred over a system service that has no access to the active session. The
runner account needs permission to launch the packaged app and invoke the
platform's lock and suspend commands.

No login password, runner registration token, signing credential, or recovery
key belongs in this repository. Configure runner registration and any
machine-local permissions in GitHub and the operating system. The smoke check
creates a temporary home directory and uses its own disposable test password;
it does not use a user's vault or credentials.

### Windows x64

Use a logged-in Windows x64 desktop account and register the runner with
`desktop-release-win-x64`. Start the runner from that user's Startup folder or
Task Scheduler with **Run only when the user is logged on**. Permit the account
to lock the workstation and wake after sleep; disable hibernation and automatic
sign-out so the desktop session remains available for the next job. Install
Git for Windows and ensure the Actions runner can use its `bash.exe`; the
cross-platform workflow step intentionally uses `shell: bash` for fail-closed
streaming logs. The default commands are:

```text
rundll32.exe user32.dll,LockWorkStation
rundll32.exe powrprof.dll,SetSuspendState 0,1,0
```

### macOS x64 and arm64

Use one logged-in desktop runner per architecture, labeled
`desktop-release-darwin-x64` or `desktop-release-darwin-arm64`. Start the runner
as the logged-in user with a user-level LaunchAgent, not a system LaunchDaemon.
Allow the account to sleep and wake the Mac, and leave automatic logout
disabled. The default commands are:

```text
/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession -suspend
/usr/bin/pmset sleepnow
```

The x64 runner must execute an x64 Node/Electron toolchain and the arm64 runner
must execute an arm64 toolchain. Do not use Rosetta to make one runner claim
coverage for the other architecture.

### Linux x64 and arm64

Use one logged-in graphical runner per architecture, labeled
`desktop-release-linux-x64` or `desktop-release-linux-arm64`. Start the runner
from the desktop user's systemd user service or desktop autostart. The job
must inherit the active session's `DISPLAY` and
`DBUS_SESSION_BUS_ADDRESS`; verify that `loginctl` reports the runner user's
session as active. Do not use Xvfb or a headless SSH session. Grant the runner
user the local polkit permission needed for suspend, and keep the session
locked only when the check itself requests it. The default commands are:

```text
loginctl lock-session
systemctl suspend
```

If a managed desktop uses different commands, set the machine-local
`KYUTXO_SCREEN_LOCK_COMMAND` and `KYUTXO_SUSPEND_COMMAND` environment
variables to JSON argv arrays. The workflow never uses shell command strings:

```text
KYUTXO_SCREEN_LOCK_COMMAND=["loginctl","lock-session","my-session"]
KYUTXO_SUSPEND_COMMAND=["systemctl","suspend"]
```

Keep those overrides in the runner environment, not in workflow files or
source control.

## Automatic release evidence

The release-only matrix writes one log per target to
`native-power-smoke-<platform>-<arch>.log`, including the target, runner,
commit, timestamps, package build output, and every `PASS`/`FAIL` result. Each
log is uploaded with `if: always()` and retained as a workflow artifact even
when the check fails. The job also validates that the completed log contains
exactly five `PASS` summary lines and no `FAIL` summary before it can succeed.
After all five jobs and the Windows package build pass, the publisher job
downloads the logs and
checks that every target-specific file is present and still contains exactly
five `PASS` lines and no `FAIL` lines. Only then does it attach the evidence to
the GitHub Release alongside the release executable. A failed or unavailable
supported-target runner, missing artifact, or incomplete log prevents
publishing.

Pull requests never run this matrix and never invoke a screen lock or suspend.
They continue to use the hosted, non-destructive `desktop-package-matrix`
workflow.

## Run

Build the target with the regular release command, then from the checked-out
repository run the check using the matching unpacked package:

```sh
KYUTXO_NATIVE_POWER_SMOKE=1 \
KYUTXO_PACKAGED_SKIP_BUILD=1 \
node scripts/check-packaged-vault-lock-native.mjs \
  --platform linux --arch x64 \
  --unpacked-dir release/linux-unpacked
```

Use `darwin`/`x64` with `release/mac`, `darwin`/`arm64` with
`release/mac-arm64`, and `win`/`x64` with the Windows runner. The check refuses
to run when the target does not match the host OS and architecture; this
prevents a package for one target from being mistaken for coverage of another.
On Linux, run inside the active graphical login session with `DISPLAY` already
set. A headless Xvfb session is not accepted because locking a real desktop
session would not prove that an Electron window isolated in Xvfb received the
same session event.

The check creates a fresh disposable vault for each policy case and sets the
idle timeout to zero. It then:

1. Locks the desktop session and waits for Electron's native `lock-screen`
   event.
2. Suspends and resumes the operating system and waits for native `suspend`
   and `resume` events.
3. Confirms the enabled policy emits exactly `lock-screen`, `suspend`, and
   `resume` vault-lock signals.
4. Repeats the native actions with screen-lock disabled, suspend disabled, and
   resume disabled, confirming those signals are absent while the other
   enabled signal remains.

Unlock the desktop when prompted by the OS. A successful run prints one
`PASS` line for each policy/action pair and exits zero. A command that exits
without Electron logging the corresponding native event fails; so does an
extra, missing, or incorrectly enabled vault-lock signal.

## Alternate desktop/session commands

The defaults are:

- Windows: `rundll32.exe user32.dll,LockWorkStation` and
  `rundll32.exe powrprof.dll,SetSuspendState 0,1,0`
- macOS: `CGSession -suspend` and `pmset sleepnow`
- Linux: `loginctl lock-session` and `systemctl suspend`

If a managed release machine uses different session commands, override one
with a JSON argv array rather than a shell string:

```sh
KYUTXO_SCREEN_LOCK_COMMAND='["loginctl","lock-session","my-session"]' \
KYUTXO_SUSPEND_COMMAND='["systemctl","suspend"]' \
KYUTXO_NATIVE_POWER_SMOKE=1 \
node scripts/check-packaged-vault-lock-native.mjs --platform linux --arch x64 \
  --unpacked-dir release/linux-unpacked
```

Keep the output with the release verification record, including the target
OS/architecture, package version, date, and the check's PASS/FAIL summary.
