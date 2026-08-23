# Possible improvements

## web-inspector

- Profile concurrency: two commands using the same persistent profile at once
  fail deep inside Chromium ("user data directory in use"). Add a pre-launch
  lockfile check with an actionable error
