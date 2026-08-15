# Plan: pagefetch CLI Tool

> [!NOTE]
> This document may not reflect the current implementation.
> See the final report for up-to-date state:
> [Final Report](../docs/compose/reports/pagefetch.md)

## Overview

A command-line tool that uses a real browser (Playwright + Chromium) to retrieve webpages and output the rendered HTML to stdout or a file. Unlike curl, this handles JavaScript-rendered content (SPAs, dynamic pages) and includes stealth capabilities to bypass bot detection.

---

## Project Structure

```
/home/tburette/dev/pageretriever/
├── package.json
├── bin/
│   └── pagefetch.js        # CLI entry point
└── src/
    └── fetcher.js          # Browser logic
```

---

## Implementation Steps

### Step 1: Initialize project

Create `package.json`:
```json
{
  "name": "pagefetch",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "pagefetch": "./bin/pagefetch.js"
  },
  "dependencies": {
    "playwright": "^1.44.0",
    "playwright-extra": "^4.3.6",
    "puppeteer-extra-plugin-stealth": "^2.11.2",
    "commander": "^12.0.0"
  }
}
```

### Step 2: Create CLI entry point (`bin/pagefetch.js`)

- Parse arguments with Commander:
  - `<url>` (required) - URL to fetch
  - `-o, --output <file>` - Save to file instead of stdout
  - `-w, --wait <strategy>` - Wait strategy: `load` (default), `domready`, `networkidle`
  - `-t, --timeout <ms>` - Timeout in milliseconds (default: 30000)
  - `-u, --user-agent <ua>` - Custom user agent string
- Call fetcher with options
- Write HTML to stdout or file

### Step 3: Create browser logic (`src/fetcher.js`)

Based on climbot's pattern:
- Singleton browser instance (launch once, reuse)
- Launch headless Chromium with StealthPlugin
- Create context with optional user agent
- Navigate to URL with specified wait strategy
- Extract `document.documentElement.outerHTML`
- Return HTML string
- Close browser on process exit

### Step 4: Install dependencies

```bash
npm install
npx playwright install chromium
```

### Step 5: Make executable and test

```bash
chmod +x bin/pagefetch.js
./bin/pagefetch.js https://example.com
./bin/pagefetch.js https://example.com -o test.html
```

### Step 6: Global install (optional)

```bash
npm install -g .
pagefetch https://example.com
```

---

## CLI Usage

```bash
pagefetch <url>                    # Print HTML to stdout
pagefetch <url> -o output.html     # Save to file
pagefetch <url> --wait networkidle # Wait for JS rendering
pagefetch <url> --timeout 60000    # Custom timeout
pagefetch <url> --user-agent "Mozilla/5.0 ..."
```

---

## Verification

1. `pagefetch https://example.com` — prints HTML to stdout
2. `pagefetch https://example.com -o test.html` — creates file with HTML
3. `pagefetch https://example.com --wait networkidle` — waits for full render
4. `pagefetch https://invalid.url.test` — shows error message
5. `npm install -g . && pagefetch https://example.com` — works globally
