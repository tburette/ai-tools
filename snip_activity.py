#!/usr/bin/env python3
"""Reduce size of codex logs (created with /export) by removing shell-command output

    remove shell result inside "## Activity" blocks.

    ./snip_activity.py transcript.md            # to stdout
    ./snip_activity.py -i transcript.md         # in place
    ./snip_activity.py -B -i transcript.md      # replace the command by a bare "$"

Before:
    ## Activity

        $ git diff --check
         M INSTALL_README.md
        ✓ • 0ms

    ## Activity

After:
    ## Activity

        $ git diff --check
        [SNIPPED result]

    ## Activity

A block starts at an indented "$" line and ends at the next "#"/"##" section or the
next "$" line. Blocks that already contain a "[SNIPPED...]" marker are left as is,
so the script can be re-run over a partially processed transcript.
"""

from __future__ import annotations

import argparse
import re
import shutil
import sys

HEADER_RE = re.compile(r"^#{1,2}\s+\S")       # section start, ends a block
PROMPT_RE = re.compile(r"^(\s*)\$(?=\s|$)")  # command line, starts a block
MARKED_RE = re.compile(r"\[SNIPPED")          # already processed
MARKER_LINE_RE = re.compile(r"^(\s*)\[SNIPPED[^\]]*\]\s*$")
MARKER = "[SNIPPED result]"


def snip(text: str, marker: str = MARKER, keep_command: bool = True,
         unify: bool = False) -> tuple[str, int, int]:
    lines = text.splitlines()
    out: list[str] = []
    n, i = len(lines), 0
    snipped = already = 0

    while i < n:
        if not HEADER_RE.match(lines[i]):
            out.append(lines[i])
            i += 1
            continue

        out.append(lines[i])  # section header
        i += 1
        while i < n and not lines[i].strip():  # blank lines after the header
            out.append(lines[i])
            i += 1

        while i < n and PROMPT_RE.match(lines[i]):
            block = [lines[i]]
            i += 1
            while i < n and not HEADER_RE.match(lines[i]) and not PROMPT_RE.match(lines[i]):
                block.append(lines[i])
                i += 1
            trailing: list[str] = []
            while block and not block[-1].strip():  # keep the blank(s) before the next section
                trailing.insert(0, block.pop())

            if any(MARKED_RE.search(line) for line in block):
                if unify:
                    block = [MARKER_LINE_RE.sub(rf"\g<1>{marker}", l) if MARKER_LINE_RE.match(l) else l
                             for l in block]
                out.extend(block)
                out.extend(trailing)
                already += 1
                continue

            m = PROMPT_RE.match(block[0])
            indent, cmd = m.group(1), block[0][m.end():].strip()
            out.append(f"{indent}$ {cmd}".rstrip() if keep_command else f"{indent}$")
            if any(line.strip() for line in block[1:]):
                out.append(f"{indent}{marker}")
            out.extend(trailing)
            snipped += 1

    return "\n".join(out) + "\n", snipped, already


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file", nargs="?", help="transcript file (default: stdin)")
    ap.add_argument("-i", "--in-place", action="store_true", help="rewrite the file")
    ap.add_argument("-B", "--bare", action="store_true",
                    help="replace the command text by a bare '$' (default: keep it)")
    ap.add_argument("-m", "--marker", default=MARKER, help=f"replacement line (default: {MARKER!r})")
    ap.add_argument("-u", "--unify", action="store_true",
                    help="also rewrite existing '[SNIPPED ...]' marker lines to --marker")
    ap.add_argument("-b", "--backup", action="store_true", help="with -i, keep a .bak copy")
    ap.add_argument("-v", "--verbose", action="store_true", help="report counts on stderr")
    args = ap.parse_args()

    if args.file:
        with open(args.file, encoding="utf-8") as fh:
            text = fh.read()
    else:
        text = sys.stdin.read()

    result, snipped, already = snip(text, args.marker, not args.bare, args.unify)

    if args.file and args.in_place:
        if args.backup:
            shutil.copyfile(args.file, args.file + ".bak")
        with open(args.file, "w", encoding="utf-8") as fh:
            fh.write(result)
    else:
        sys.stdout.write(result)

    if args.verbose:
        print(f"snipped {snipped} block(s), {already} already snipped", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
