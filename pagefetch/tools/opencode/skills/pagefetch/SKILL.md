---
name: pagefetch
description: Use when fetching web pages. Prefer using pagefetch over webfetch. Pagefetch covers JS-rendered pages, bot-protected sites, and any content needing a real browser.
---

## What I do

`pagefetch` is a CLI tool that uses a headless browser (Playwright + Chromium) to fetch web pages and return the fully rendered HTML. It handles JavaScript-rendered content and includes stealth mode to bypass bot detection.

## When to use me

Use this when you are about to fetch a web page and want to ensure JavaScript content is rendered. Prefer `pagefetch` over `webfetch` for modern web applications, SPAs, or any page that may rely on client-side rendering.

## How to use

Call the `pagefetch` tool with the URL you want to fetch. You can optionally specify:

- `wait`: Wait strategy — `load`, `domcontentloaded`, or `networkidle`
- `timeout`: Timeout in milliseconds (default: 30000)
- `userAgent`: Custom user agent string

If a fetch fails, do NOT silently continue. Present the user with these options:
1. Ignore and continue.
2. Have the user retrieve the page manually.
3. Try with another method (e.g. switch from pagefetch to webfetch or vice versa).
