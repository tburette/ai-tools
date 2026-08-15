# delay-server

A simple web server that displays initial content and swaps it for final content after a configurable delay. Useful for testing delayed page transitions, loading states, and content-swapping behavior.

## How it works

The server renders an HTML page with initial content (e.g. "Loading..."). Client-side JavaScript fetches the `/final` endpoint, then replaces the visible content after the specified delay. This simulates slow page loads or async content delivery.

## Install

```bash
npm install
```

## Usage

### CLI

```bash
npx delay-server
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `-i, --initial <text>` | Initial content shown | `Loading...` |
| `-f, --final <text>` | Final content after delay | `Final content loaded` |
| `-d, --delay <ms>` | Delay in milliseconds | `3000` |
| `-p, --port <port>` | Server port | `3000` |
| `--initial-file <path>` | Load initial content from file | — |
| `--final-file <path>` | Load final content from file | — |
| `-h, --help` | Show help | — |

### Examples

```bash
# Defaults: "Loading..." → "Final content loaded" after 3s
delay-server

# Custom content and delay
delay-server --initial "Please wait..." --final "Done!" --delay 2000

# Load from HTML files
delay-server --initial-file ./spinner.html --final-file ./result.html

# Run on a different port
delay-server --port 8080
```

### Overriding delay via query string

Append `?delay=<ms>` to the URL to override the server-configured delay per request:

```
http://localhost:3000?delay=500
```

### Programmatic API

```js
import { createServer } from './src/server.js';

const server = await createServer({
  initial: 'Loading...',
  final: 'Done!',
  delay: 2000,
  port: 3000
});

console.log(`Server running at http://localhost:${server.address().port}`);
```

## Development

```bash
npm test          # run tests
npm run test:watch  # run tests in watch mode
```
