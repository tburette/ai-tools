# Possible improvements

## web-inspector

- Profile concurrency: two commands using the same persistent profile at once
  fail deep inside Chromium ("user data directory in use"). Add a pre-launch
  lockfile check with an actionable error

## Spike report review

- Read and evaluate the improvement suggestions in
  [wordpress-inspector-web-inspector-spike-report.md](wordpress-inspector-web-inspector-spike-report.md)
  (2026-08-31, from testing wordpress-inspector + web-inspector during a
  WordPress block development spike). Covers runtime behavior AND SKILL.md
  documentation gaps (18 items total).
