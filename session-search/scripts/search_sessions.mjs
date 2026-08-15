#!/usr/bin/env node
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
