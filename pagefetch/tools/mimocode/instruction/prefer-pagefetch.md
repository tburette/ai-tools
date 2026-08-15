When fetching web pages, prefer `pagefetch` over `webfetch`. `pagefetch` uses a headless browser (Playwright + Chromium) with JavaScript rendering, stealth mode, and configurable wait strategies — making it more reliable for modern web content. `webfetch` is a plain HTTP client with no JS execution; only use it when the user explicitly asks for it or for simple static pages where a browser is unnecessary.

When a fetch (pagefetch or webfetch) fails or returns empty/unusable content, do NOT silently continue. Use the `question` tool to present exactly these three options to the user:
1. Ignore and continue.
2. Have the user retrieve the page — create a directory in `/tmp/`, ask the user to put the HTML there, then read it.
3. Try with another method (e.g. switch from pagefetch to webfetch or vice versa).

Stick to this protocol. Do not skip it or assume a choice — unless the user gave an explicit instruction to do so in the conversation.
