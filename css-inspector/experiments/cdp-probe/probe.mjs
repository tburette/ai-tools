import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePlaywright } from '../../../web-inspector/scripts/lib/playwright.mjs';

const { chromium } = resolvePlaywright();
const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'css-inspector-probe-'));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.goto(new URL('./index.html', import.meta.url).href);
  const cdp = await page.context().newCDPSession(page);
  const headers = new Map();
  cdp.on('CSS.styleSheetAdded', ({ header }) => headers.set(header.styleSheetId, header));
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#probe' });
  const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
  const computed = Object.fromEntries((await cdp.send('CSS.getComputedStyleForNode', { nodeId })).computedStyle.map(({ name, value }) => [name, value]));
  const expected = {
    color: 'rgb(255, 0, 0)',
    'margin-bottom': '7px',
    'margin-top': '22px',
    'letter-spacing': '2px',
    'padding-left': '11px',
    width: '222px',
    'border-top-color': 'rgb(20, 30, 40)',
  };
  for (const [property, value] of Object.entries(expected)) assert.equal(computed[property], value, property);
  assert.ok(matched.inlineStyle.cssProperties.some(p => p.name === 'margin-bottom' && p.value === '123px'));
  assert.ok([...headers.values()].some(h => h.sourceURL.endsWith('/external.css') && !h.isInline));
  assert.ok([...headers.values()].some(h => h.isInline));
  assert.ok(matched.inherited.length > 0);
  assert.ok(matched.pseudoElements.some(p => p.pseudoType === 'before'));
  const sheets = [];
  for (const header of headers.values()) {
    const { text } = await cdp.send('CSS.getStyleSheetText', { styleSheetId: header.styleSheetId });
    sheets.push({ header, text });
  }
  const summary = matched.matchedCSSRules.filter(({ rule }) => rule.origin === 'regular').map(({ rule, matchingSelectors }) => ({
    selector: rule.selectorList.text,
    matchingSelectors,
    specificity: rule.selectorList.selectors.map(s => s.specificity ?? null),
    source: headers.get(rule.styleSheetId)?.sourceURL,
    inlineSheet: headers.get(rule.styleSheetId)?.isInline,
    range: rule.style.range,
    layers: rule.layers,
    declarations: rule.style.cssProperties.filter(p => p.range).map(({ name, value, important, parsedOk }) => ({ name, value, important, parsedOk })),
  }));
  await page.screenshot({ path: path.join(outputDir, 'render.png') });
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  const hovered = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
  const hoveredComputed = Object.fromEntries((await cdp.send('CSS.getComputedStyleForNode', { nodeId })).computedStyle.map(({ name, value }) => [name, value]));
  assert.equal(hoveredComputed.color, 'rgb(0, 128, 0)');
  assert.ok(hovered.matchedCSSRules.some(({ rule }) => rule.selectorList.text === '.probe:hover'));
  await fs.writeFile(path.join(outputDir, 'evidence.json'), JSON.stringify({ browser: browser.version(), sheets, matched, computed, hovered, hoveredColor: hoveredComputed.color }, null, 2));
  console.log(JSON.stringify({ browser: browser.version(), checks: Object.keys(expected).length + 7, outputDir, computed: Object.fromEntries(Object.keys(expected).map(k => [k, computed[k]])), hoveredColor: hoveredComputed.color, inheritedGroups: matched.inherited.length, pseudoTypes: matched.pseudoElements.map(p => p.pseudoType), rules: summary }, null, 2));
} finally {
  await browser.close();
}
