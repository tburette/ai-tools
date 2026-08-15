# pagefetch

A CLI tool that uses a real headless browser (Playwright + Chromium) to fetch webpages and output the rendered HTML. Handles JavaScript-rendered content and includes stealth capabilities to bypass bot detection.

Created because I had issues retrieving some pages with OpenCode's webfetch.

## Install

```sh
npm install
npx playwright install chromium
```

The second command is required — without it the tool will fail silently.

## Uninstall the browser used
To uninstall the browser that was installed use
```sh
npx playwright uninstall
```

## Usage

```sh
pagefetch <url>                    # Print HTML to stdout
pagefetch <url> -o output.html     # Save to file
pagefetch <url> --wait networkidle # Wait for JS rendering
pagefetch <url> --timeout 60000    # Custom timeout (ms)
pagefetch <url> --user-agent "Mozilla/5.0 ..."
```

### Options

| Option | Description | Default |
|---|---|---|
| `<url>` | URL to fetch (required) | — |
| `-o, --output <file>` | Save HTML to file instead of stdout | stdout |
| `-w, --wait <strategy>` | Wait strategy: `load`, `domready`, `networkidle` | `load` |
| `-t, --timeout <ms>` | Timeout in milliseconds | `30000` |
| `-u, --user-agent <ua>` | Custom user agent string | — |

## Use with AI coding agents
See the tools/ directory.
