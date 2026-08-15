#!/usr/bin/env node
// TODO: reject whitespace-only search terms: the empty-string guard below uses
//   `!searchTerm`, which "   " passes. A whitespace-only term matches ~236 sessions
//   ("nearly everything"). Fix: `if (!searchTerm || !searchTerm.trim())`.
// TODO: cosmetic: when the codex store is missing, the Method line prints
//   "scanned 0 JSONL session logs ...", which is less clear than the opencode
//   side's "no database found ...". Give the codex line a matching "no sessions
//   found under ..." wording when no rollout files exist.
// TODO: non-ASCII case-insensitivity is inconsistent across backends. The codex
//   side lowercases the whole file (content.toLowerCase()), so it is case-
//   insensitive for any Unicode. SQLite LIKE is case-insensitive for ASCII only,
//   so on the opencode side "É" and "é" can return different sets. Possible
//   fixes: (1) normalize both sides to lowercase via strtolower (still ASCII-only
//   in SQLite) or better use the SQLite ICU extension / COLLATE NOCASE-ICU;
//   (2) lowercase the search term in JS and query the DB with LIKE on a
//   lower(data) expression (needs a scan, no index, slow for big DBs);
//   (3) also lowercase in JS and additionally probe the codex side the same way
//   (already done). For full Unicode case folding, the robust option is to
//   extract text and compare in JS (like the codex side) rather than SQL LIKE.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = homedir()

const OPENCODE_ROOT = join(HOME, '.local/share/opencode')
const CODEX_ROOT = join(HOME, '.codex')

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

const searchTerm = process.argv[2]
if (!searchTerm) fail('usage: node search_sessions.mjs "<string to search>"')

function likeEscape(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function findOpenCodeDbs() {
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name === 'opencode.db') found.push(p)
    }
  }
  walk(OPENCODE_ROOT)
  return found
}

function searchOpenCode(escapedNeedle) {
  const dbs = findOpenCodeDbs()
  const method = dbs.length
    ? `SQLite database${dbs.length > 1 ? 's' : ''} ${dbs.join(', ')}\n` +
      `            searched tables: part, message (conversation content)\n` +
      `            joined table: session (id, slug, directory, date)`
    : `no database found under ${OPENCODE_ROOT} (expected opencode.db)`
  const results = []
  for (const dbPath of dbs) {
    let db
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
    } catch (e) {
      console.error(`warning: cannot open ${dbPath}: ${e.message}`)
      continue
    }
    try {
      const sql = `
        SELECT DISTINCT s.id, s.slug, s.directory, s.time_created
        FROM session s
        WHERE s.id IN (
          SELECT session_id FROM part WHERE data LIKE '%' || ? || '%' ESCAPE '\\'
          UNION
          SELECT session_id FROM message WHERE data LIKE '%' || ? || '%' ESCAPE '\\'
        )
        ORDER BY s.time_created`
      const rows = db.prepare(sql).all(escapedNeedle, escapedNeedle)
      for (const r of rows) {
        results.push({
          tool: 'opencode',
          id: r.id,
          slug: r.slug,
          dir: r.directory || '',
          date: new Date(r.time_created).toISOString().slice(0, 16).replace('T', ' '),
        })
      }
    } finally {
      db.close()
    }
  }
  return { method, results }
}

function listCodexRollouts() {
  const files = []
  for (const base of [join(CODEX_ROOT, 'sessions'), join(CODEX_ROOT, 'archived_sessions')]) {
    if (!existsSync(base)) continue
    const walk = (dir) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.jsonl')) files.push(p)
      }
    }
    walk(base)
  }
  return files
}

function codexThreadNames() {
  const map = new Map()
  const idx = join(CODEX_ROOT, 'session_index.jsonl')
  if (!existsSync(idx)) return map
  for (const line of readFileSync(idx, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const o = JSON.parse(line)
      if (o.id) map.set(o.id, o.thread_name || '')
    } catch {}
  }
  return map
}

function searchCodex(searchTerm) {
  const files = listCodexRollouts()
  const threadNames = codexThreadNames()
  const method = `scanned ${files.length} JSONL session log${files.length === 1 ? '' : 's'} under ${CODEX_ROOT}/sessions and ${CODEX_ROOT}/archived_sessions\n` +
    `            searched full file contents; for matches, session id + cwd read from the first line (session_meta)`
  const hay = searchTerm.toLowerCase()
  const seen = new Set()
  const results = []
  for (const f of files) {
    let content
    try {
      content = readFileSync(f, 'utf8')
    } catch (e) {
      console.error(`warning: cannot read ${f}: ${e.message}`)
      continue
    }
    if (!content.toLowerCase().includes(hay)) continue
    const firstLine = content.slice(0, content.indexOf('\n') > -1 ? content.indexOf('\n') : content.length)
    let id = ''
    let dir = ''
    let date = ''
    try {
      const meta = JSON.parse(firstLine)
      if (meta.payload) {
        id = meta.payload.session_id || meta.payload.id || ''
        dir = meta.payload.cwd || ''
        date = (meta.payload.timestamp || '').slice(0, 16).replace('T', ' ')
      }
    } catch {}
    if (!id) {
      const m = f.match(/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/)
      if (m) id = m[1]
    }
    if (seen.has(id)) continue
    seen.add(id)
    results.push({
      tool: 'codex',
      id,
      slug: threadNames.get(id) || '',
      dir,
      date,
    })
  }
  return { method, results }
}

const escaped = likeEscape(searchTerm)
const opencode = searchOpenCode(escaped)
const codex = searchCodex(searchTerm)

const all = [...opencode.results, ...codex.results]
  .sort((a, b) => (a.date || '').localeCompare(b.date || ''))

const out = []
out.push(`String: "${searchTerm}"`)
out.push('')
out.push('Method:')
out.push(`  opencode  ${opencode.method}`)
out.push(`  codex     ${codex.method}`)
out.push('')

if (all.length === 0) {
  out.push('No session contains this string. Try a shorter substring or check spelling.')
} else if (all.length === 1) {
  const r = all[0]
  const cmd = r.tool === 'opencode' ? 'opencode --session' : 'codex resume'
  out.push(`1 match:`)
  out.push('')
  out.push(`  ${r.dir ? `cd ${r.dir} && ` : ''}${cmd} ${r.id}`)
  out.push('')
  out.push(`  [${r.tool}] ${r.id}${r.slug ? `  ${r.slug}` : ''}${r.date ? `  ${r.date}` : ''}${r.dir ? `  ${r.dir}` : ''}`)
} else {
  out.push(`${all.length} matches:`)
  out.push('')
  all.forEach((r, i) => {
    out.push(`  [${i + 1}] [${r.tool}] ${r.id}${r.slug ? `  ${r.slug}` : ''}${r.date ? `  ${r.date}` : ''}${r.dir ? `  ${r.dir}` : ''}`)
  })
  out.push('')
  out.push('To resume one, run from the directory listed next to it:')
  out.push('  opencode --session <session-id>')
  out.push('  codex resume <session-id>')
}
out.push('')
process.stdout.write(out.join('\n'))
