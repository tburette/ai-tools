import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../src/server.js';

describe('delay-server', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = await createServer({
      final: 'Test final content',
      initial: 'Test initial content',
      delay: 1000,
      port: 0
    });
    const { port } = server.address();
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('returns 200 status code', async () => {
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
  });

  it('returns HTML content type', async () => {
    const response = await fetch(baseUrl);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('contains initial content', async () => {
    const response = await fetch(baseUrl);
    const html = await response.text();
    expect(html).toContain('Test initial content');
  });

  it('does not contain final content in initial HTML', async () => {
    const response = await fetch(baseUrl);
    const html = await response.text();
    expect(html).not.toContain('Test final content');
  });

  it('contains correct delay value', async () => {
    const response = await fetch(baseUrl);
    const html = await response.text();
    expect(html).toContain('1000');
  });
});

describe('/final endpoint', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = await createServer({
      final: 'Secret final content',
      initial: 'Loading...',
      delay: 1000,
      port: 0
    });
    const { port } = server.address();
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('returns final content', async () => {
    const response = await fetch(`${baseUrl}/final`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('Secret final content');
  });

  it('initial page does not contain final content', async () => {
    const response = await fetch(baseUrl);
    const html = await response.text();
    expect(html).not.toContain('Secret final content');
  });
});

describe('delay query parameter', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = await createServer({
      final: 'Final',
      initial: 'Initial',
      delay: 3000,
      port: 0
    });
    const { port } = server.address();
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  it('uses configured delay when no query param', async () => {
    const response = await fetch(baseUrl);
    const html = await response.text();
    expect(html).toContain('3000');
  });

  it('overrides delay with valid query param', async () => {
    const response = await fetch(`${baseUrl}?delay=500`);
    const html = await response.text();
    expect(html).toContain('500');
  });

  it('ignores invalid delay (non-numeric)', async () => {
    const response = await fetch(`${baseUrl}?delay=abc`);
    const html = await response.text();
    expect(html).toContain('3000');
  });

  it('ignores negative delay', async () => {
    const response = await fetch(`${baseUrl}?delay=-100`);
    const html = await response.text();
    expect(html).toContain('3000');
  });

  it('accepts large delay values', async () => {
    const response = await fetch(`${baseUrl}?delay=99999`);
    const html = await response.text();
    expect(html).toContain('99999');
  });
});
