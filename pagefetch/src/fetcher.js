import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

export async function fetchPage(url, options = {}) {
  const { wait = 'load', timeout = 30000, userAgent } = options;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(
      userAgent ? { userAgent } : {}
    );
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: wait, timeout });
      return await page.evaluate(() => document.documentElement.outerHTML);
    } finally {
      await page.close();
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
