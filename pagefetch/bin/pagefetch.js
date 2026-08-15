#!/usr/bin/env node

import { Command } from 'commander';
import { writeFileSync } from 'fs';
import { fetchPage } from '../src/fetcher.js';

const program = new Command();

program
  .name('pagefetch')
  .description(`Fetch a webpage using a real headless browser (Playwright + Chromium) and output the rendered HTML.

Supports JavaScript-rendered pages and includes stealth mode to avoid bot detection.
The output is the full rendered HTML of the page.`)
  .version('1.0.0')
  .argument('[url]', 'URL to fetch')
  .option('-o, --output <file>', 'Save HTML to a file instead of printing to stdout')
  .option('-w, --wait <strategy>', 'Wait strategy: load, domcontentloaded, networkidle (default: load)')
  .addHelpText('after', `
<strategy> values:
  load             Wait for the page load event. Fires when all resources
                   (images, scripts, stylesheets) finish loading.
  domcontentloaded Wait for the DOM to be fully parsed, without waiting for
                   stylesheets, images, and subframes. Faster than load, but
                   JavaScript that runs after DOM parse may not have executed.
  networkidle      Wait until there are no network connections for at least
                   500ms. Useful for SPAs that fetch data on load.`)
  .option('-t, --timeout <ms>', 'Time allocated to retreve the page (fetching the HTML and waiting for the strategy to finish)', '30000')
  .option('-u, --user-agent <ua>', 'Custom user agent string to send with the request')
  .addHelpText('after', `
Examples:
  $ pagefetch https://example.com
  $ pagefetch https://example.com -o page.html
  $ pagefetch https://example.com -w networkidle -t 60000
  $ pagefetch https://example.com -u "Mozilla/5.0 (X11; Linux x86_64)"`);

program.parse();

const url = program.args[0];
if (!url) {
  console.error('error: URL is required. Usage: pagefetch <url> [options]\nRun pagefetch --help for full usage.');
  process.exit(1);
}

const opts = program.opts();

try {
  const html = await fetchPage(url, {
    wait: opts.wait,
    timeout: parseInt(opts.timeout, 10),
    userAgent: opts.userAgent
  });
  if (opts.output) {
    writeFileSync(opts.output, html);
  } else {
    process.stdout.write(html);
  }
} catch (err) {
  console.error(`Error fetching ${url}: ${err.message}`);
  process.exit(1);
}
