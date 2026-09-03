# Desktop release auto-lock smoke check

The normal Electron unit tests use an in-process `powerMonitor` event emitter.
That proves policy behavior, but it cannot prove that a packaged Electron
runtime receives the native operating-system events. Before a desktop release,
run the native smoke check on every supported release target:

| Target | Release-like package | Native session |
| --- | --- | --- |
| Windows x64 | `release/win-unpacked/` from the portable release build | An interactive Windows desktop |
| macOS x64 | `release/mac/KYUTXO.app` from the signed zip/dmg build | A logged-in macOS x64 desktop |
| macOS arm64 | `release/mac-arm64/KYUTXO.app` from the signed zip/dmg build | A logged-in macOS arm64 desktop |
| Linux x64 | `release/linux-unpacked/` from the AppImage build | A logged-in Linux desktop session |
| Linux arm64 | `release/linux-arm64-unpacked/` from the AppImage build | A logged-in Linux desktop session |

The reusable GitHub `desktop-package-matrix` workflow builds the same five
platform/architecture targets and verifies their packaged native module. The
native power check is intentionally run on an interactive release machine:
locking a Windows/macOS session can suspend or hide the automation runner, so
it is not an unattended pull-request step.

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