When fetching web pages, use `pagefetch` instead of `webfetch`. `pagefetch` renders JavaScript and bypasses bot detection. Only use `webfetch` for simple static pages or when explicitly asked.

If a fetch fails, do NOT silently continue. Present the user with these options:
1. Ignore and continue.
2. Have the user retrieve the page manually.
3. Try with another method (e.g. switch from pagefetch to webfetch or vice versa).
