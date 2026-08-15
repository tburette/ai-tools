import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  it('returns default values when no args provided', () => {
    const result = parseArgs([]);
    expect(result.final).toBe('Final content loaded');
    expect(result.initial).toBe('Loading...');
    expect(result.delay).toBe(3000);
    expect(result.port).toBe(3000);
  });

  it('parses --final flag', () => {
    const result = parseArgs(['--final', 'Hello World']);
    expect(result.final).toBe('Hello World');
  });

  it('parses --initial flag', () => {
    const result = parseArgs(['--initial', 'Please wait']);
    expect(result.initial).toBe('Please wait');
  });

  it('parses --delay flag', () => {
    const result = parseArgs(['--delay', '5000']);
    expect(result.delay).toBe(5000);
  });

  it('parses --port flag', () => {
    const result = parseArgs(['--port', '8080']);
    expect(result.port).toBe(8080);
  });

  it('parses --final-file flag', () => {
    const result = parseArgs(['--final-file', './content.html']);
    expect(result.finalFile).toBe('./content.html');
  });

  it('parses --initial-file flag', () => {
    const result = parseArgs(['--initial-file', './loading.html']);
    expect(result.initialFile).toBe('./loading.html');
  });

  it('sets help flag when --help is provided', () => {
    const result = parseArgs(['--help']);
    expect(result.help).toBe(true);
  });

  it('sets help flag when -h is provided', () => {
    const result = parseArgs(['-h']);
    expect(result.help).toBe(true);
  });
});
