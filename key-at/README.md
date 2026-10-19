# key-at

`key-at` sends a key event through `ydotool` after a delay or at the next
occurrence of a local clock time.

## Requirements

- Linux, Bash, GNU `date`, `awk`, `sleep`, and `ydotool` available in `PATH`.
- The `ydotoold` daemon must be running and accessible to the current user.

## Use

```text
key-at <when> [keycode:state ...]
```

Examples from the repository root:

```bash
./key-at/bin/key-at 0.4                       # press Enter in 0.4 seconds
./key-at/bin/key-at 14:30                     # press Enter at 14:30 today or tomorrow
./key-at/bin/key-at 14:30:00 105:1 105:0      # send the Left key at 14:30
./key-at/bin/key-at "@$(( $(date +%s) + 3600 ))" # press Enter in one hour by epoch
KEY_AT_DRY_RUN=1 ./key-at/bin/key-at 5         # print the planned action
```

`<when>` may be a number of seconds (`N` or `+N`, including fractions), a
local time (`HH:MM[:SS]`), or a Unix timestamp (`@EPOCH`). A clock time already
reached today is scheduled for tomorrow. An epoch timestamp must be in the
future. Extra key arguments replace the default Enter press (`28:1 28:0`).

The key event goes to whichever application has keyboard focus when the timer
fires. The command stays in the foreground and writes no log; keep its terminal
session open. Use `KEY_AT_DRY_RUN=1` to preview the delay and key sequence
without sending it.

## Install

From the repository root, copy the executable into a directory on your `PATH`:

```bash
install -m 0755 key-at/bin/key-at ~/bin/key-at
```

## Validate

```bash
bash -n key-at/bin/key-at
KEY_AT_DRY_RUN=1 ./key-at/bin/key-at 0.4
```
