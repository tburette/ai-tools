# run-at

`run-at` runs a command at the next occurrence of a local clock time.

## Supported environment

- Linux with Bash and GNU `date`, `sleep`, and `readlink`.
- For the computer to stay awake while waiting, automatic suspend must be
  disabled for the active power source. On GNOME, see **Settings → Power →
  Automatic Suspend**. The display can still blank or lock independently.
- Run it from a normal host terminal. Restricted agent sandboxes may not
  survive logout or expose the host's power settings.

The command runs with the scheduling shell's working directory, environment,
and `PATH`.

## Install

From the repository root, copy the standalone executable into a directory on
your `PATH`:

```bash
install -m 0755 run-at/bin/run-at ~/bin/run-at
```

To use it without installing:

```bash
./run-at/bin/run-at 01:44:00 codex exec "hi"
```

## Usage

```text
run-at HH:MM[:SS] command [argument ...]
```

The time uses the machine's local timezone. If it has passed today, the next
occurrence is tomorrow. For example:

```bash
run-at 01:44:00 codex exec "hi"
run-at 02:15 bash -lc 'codex exec "hi"'
```

Arguments go directly to the command; `run-at` does not evaluate them as shell
text. Use a shell explicitly when the scheduled work needs shell syntax. The
command's stdout and stderr stay in the terminal, and `run-at` returns its exit
status.

## Behavior and limits

The timer stays in the foreground, so keep the terminal session alive. Logging
out, closing the terminal, or killing the process cancels the run. The
computer must be awake when `run-at` starts. It cannot wake a suspended or
powered-off computer.

For an overnight run, plug the computer in. The active power profile must not
suspend it while idle. If the machine is unplugged, its battery suspend policy
can delay or interrupt the scheduled run.

The command runs as the current user with that user's permissions and
environment. Schedule only commands you trust. No separate log is created;
redirect output in the command if you need a saved record.

## Validation

For a short manual check, schedule a harmless command about one minute ahead:

```bash
run-at "$(date --date='+1 minute' '+%H:%M:%S')" bash -c 'date; echo run-at-ok'
```
