#!/usr/bin/env node
import { readFileSync, readdirSync, existsSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = homedir()
const OPENCODE_ROOT = join(HOME, '.local/share/opencode')
const CODEX_ROOT = join(HOME, '.codex')

function fail(message) {
  console.error(`error: ${message}`)
  process.exit(1)
}

const args = process.argv.slice(2)

const USAGE = `Usage: node extract_session.mjs <session-id> [options]

Print the full conversation of a past opencode or codex session by its id.

The tool is auto-detected from the id shape ("ses_..." for opencode, a UUID for
codex); both stores are tried for ambiguous shapes, or force with --tool.

Options:
  -h, --help             show this help and exit
  --tool=opencode|codex  force which session store to read
  --no-reasoning         omit reasoning blocks
  --no-tools             omit tool calls and outputs
  --max-output=<n>       truncate long tool/reasoning blocks to <n> chars (default: full)
  --json                 emit a structured JSON transcript (session, stats, ordered items)

Exit code 0 on success, 1 when the session id is not found or arguments are invalid.`

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${USAGE}\n`)
  process.exit(0)
}

const id = args.find((a) => !a.startsWith('--'))
if (!id) {
  process.stderr.write(`${USAGE}\n`)
  process.exit(1)
}

const tool = (args.find((a) => a.startsWith('--tool=')) || '').slice(7) || null
const asJson = args.includes('--json')
const wantReasoning = !args.includes('--no-reasoning')
const wantTools = !args.includes('--no-tools')
const maxOutputArg = args.find((a) => a.startsWith('--max-output='))
const maxOutput = maxOutputArg ? Number(maxOutputArg.slice(13)) : null

function isOpenCodeId(id) {
  return id.startsWith('ses_')
}

function isUuid(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function fmtTime(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function truncate(text, label) {
  if (text == null) return ''
  const s = typeof text === 'string' ? text : JSON.stringify(text, null, 2)
  if (maxOutput != null && s.length > maxOutput) {
    return `${s.slice(0, maxOutput)}\n…[${label} truncated from ${s.length} to ${maxOutput} chars]`
  }
  return s
}

// ---------------------------------------------------------------- opencode

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

function extractOpenCode(id) {
  const dbs = findOpenCodeDbs()
  const meta = dbs.length
    ? `SQLite database${dbs.length > 1 ? 's' : ''} ${dbs.join(', ')}; tables session, message, part`
    : `no database found under ${OPENCODE_ROOT} (expected opencode.db)`
  const report = { tool: 'opencode', found: false, meta, session: null, items: [], stats: {} }

  for (const dbPath of dbs) {
    let db
    try {
      db = new DatabaseSync(dbPath, { readOnly: true })
    } catch (e) {
      console.error(`warning: cannot open ${dbPath}: ${e.message}`)
      continue
    }
    try {
      const s = db.prepare('SELECT * FROM session WHERE id = ?').get(id)
      if (!s) continue
      report.found = true
      let model = ''
      try {
        const m = JSON.parse(s.model || '{}')
        model = `${m.providerID || ''}/${m.id || ''}`.replace(/^\//, '')
      } catch {}
      report.session = {
        slug: s.slug,
        title: s.title,
        directory: s.directory,
        agent: s.agent,
        model,
        started: fmtTime(s.time_created),
      }

      const messages = db.prepare(
        'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id'
      ).all(id)
      const parts = db.prepare(
        'SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, message_id, id'
      ).all(id)

      const byMessage = new Map()
      for (const p of parts) {
        if (!byMessage.has(p.message_id)) byMessage.set(p.message_id, [])
        byMessage.get(p.message_id).push(p)
      }

      let nUser = 0
      let nAssistant = 0
      let nReasoning = 0
      let nTools = 0
      let nSteps = 0
      const unknown = new Set()

      for (const m of messages) {
        let role = ''
        let summary = ''
        try {
          const d = JSON.parse(m.data)
          role = d.role || ''
          summary = d.summary || ''
        } catch {}

        const messageParts = byMessage.get(m.id) || []
        if (role === 'user') {
          const texts = messageParts
            .filter((p) => {
              let t = ''
              try { t = JSON.parse(p.data).type } catch {}
              return t === 'text'
            })
            .map((p) => {
              try { return JSON.parse(p.data).text || '' } catch { return '' }
            })
          if (texts.length) {
            nUser++
            const text = texts.join('\n')
            report.items.push({ kind: 'user', time: fmtTime(m.time_created), text })
          }
          continue
        }

        if (role !== 'assistant') continue
        nAssistant++
        for (const p of messageParts) {
          let d
          try { d = JSON.parse(p.data) } catch { continue }
          const type = d.type
          if (type === 'text') {
            if (d.text) report.items.push({ kind: 'assistant', time: fmtTime(p.time_created), text: d.text })
          } else if (type === 'reasoning' && d.text) {
            if (wantReasoning) {
              nReasoning++
              report.items.push({ kind: 'reasoning', time: fmtTime(p.time_created), text: d.text })
            }
          } else if (type === 'tool') {
            nTools++
            if (wantTools) {
              report.items.push({
                kind: 'tool',
                time: fmtTime(p.time_created),
                name: d.tool || 'unknown',
                callID: d.callID || '',
                input: d.state && d.state.input != null ? d.state.input : undefined,
                output: d.state && d.state.output != null ? d.state.output : undefined,
              })
            }
          } else if (type === 'step-start' || type === 'step-finish') {
            nSteps++
          } else {
            unknown.add(type)
          }
        }
      }
      report.stats = {
        messages: messages.length,
        user: nUser,
        assistant: nAssistant,
        reasoning: nReasoning,
        tool: nTools,
        steps: nSteps,
        unknownParts: [...unknown],
      }
    } finally {
      db.close()
    }
    if (report.found) break
  }
  return report
}

// ------------------------------------------------------------------ codex

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

function findCodexFiles(id) {
  const files = listCodexRollouts()
  const hits = []
  for (const f of files) {
    let firstLine = ''
    try {
      const content = readFileSync(f, 'utf8')
      firstLine = content.slice(0, content.indexOf('\n') > -1 ? content.indexOf('\n') : content.length)
    } catch (e) {
      console.error(`warning: cannot read ${f}: ${e.message}`)
      continue
    }
    let fileId = ''
    try {
      const meta = JSON.parse(firstLine)
      if (meta.payload) fileId = meta.payload.session_id || meta.payload.id || ''
    } catch {}
    if (!fileId) {
      const m = f.match(/rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/)
      if (m) fileId = m[1]
    }
    if (fileId === id) hits.push(f)
  }
  hits.sort()
  return hits
}

function extractCodex(id) {
  const files = findCodexFiles(id)
  const threadNames = codexThreadNames()
  const meta = files.length
    ? `rows from ${files.length} rollout file${files.length > 1 ? 's' : ''} under ${CODEX_ROOT}/sessions and ${CODEX_ROOT}/archived_sessions (matched by session_id in the first line); events decoded as response_item records`
    : `no rollout file with session_id ${id} under ${CODEX_ROOT}`
  const report = { tool: 'codex', found: files.length > 0, meta, session: null, items: [], stats: {} }

  if (files.length === 0) return report

  const seen = new Set()
  let metaLine = null
  for (const f of files) {
    for (const raw of readFileSync(f, 'utf8').split('\n')) {
      if (!raw.trim() || seen.has(raw)) continue
      seen.add(raw)
      let rec
      try {
        rec = JSON.parse(raw)
      } catch {
        continue
      }
      if (rec.type === 'session_meta' && !metaLine) metaLine = rec
    }
  }

  const metaPayload = (metaLine && metaLine.payload) || {}
  const tc = []
  report.session = {
    directory: metaPayload.cwd || '',
    thread: threadNames.get(id) || '',
    source: metaPayload.source || '',
    originator: metaPayload.originator || '',
    cliVersion: metaPayload.cli_version || '',
    provider: metaPayload.model_provider || '',
    started: fmtTime(metaPayload.timestamp),
  }

  let nUser = 0
  let nAssistant = 0
  let nReasoning = 0
  let nTools = 0
  let nEncryptedReasoning = 0
  let nCut = 0
  let nMessages = 0
  let nItems = 0
  const toolOutputs = new Map()

  for (const f of files) {
    for (const raw of readFileSync(f, 'utf8').split('\n')) {
      let rec
      try {
        rec = JSON.parse(raw)
      } catch {
        continue
      }
      if (rec.type === 'turn_context' && rec.payload) tc.push(rec.payload)
      if (rec.type !== 'response_item') continue
      nItems++
      const p = rec.payload
      if (!p) continue
      const time = fmtTime(rec.timestamp)
      switch (p.type) {
        case 'message': {
          const role = p.role
          if (role === 'developer' || role === 'system') break
          const content = p.content || []
          if (role === 'user') {
            nUser++
            const text = renderUserContent(content)
            if (text) report.items.push({ kind: 'user', time, text })
          } else if (role === 'assistant') {
            nMessages++
            const text = content
              .filter((c) => c.type === 'output_text' && c.text)
              .map((c) => c.text)
              .join('\n\n')
            report.items.push({ kind: 'assistant', phase: p.phase, time, text: text.trim() })
            if (text.trim()) nAssistant++
          }
          break
        }
        case 'reasoning': {
          nReasoning++
          if (!wantReasoning) break
          const summaries = (p.summary || [])
            .filter((s) => s.type === 'summary_text' && s.text)
            .map((s) => s.text)
          if (summaries.length) {
            report.items.push({ kind: 'reasoning', time, text: summaries.join('\n') })
          } else if (p.encrypted_content) {
            nEncryptedReasoning++
            report.items.push({
              kind: 'reasoning',
              time,
              text: '…[reasoning content is E2E-encrypted in this rollout; only a summary is stored, and none was recorded]',
            })
          }
          break
        }
        case 'function_call':
        case 'custom_tool_call': {
          const input = p.input != null ? p.input : p.arguments || ''
          let inputText
          if (typeof input === 'string') inputText = input
          else {
            try {
              inputText = typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input)
            } catch {
              inputText = String(input)
            }
          }
          nTools++
          if (wantTools) {
            const item = {
              kind: 'tool',
              time,
              name: p.name || (p.type === 'function_call' ? 'function' : 'unknown'),
              callID: p.call_id || p.callID || '',
              input: inputText,
            }
            report.items.push(item)
            if (p.call_id) toolOutputs.set(p.call_id, item)
          }
          break
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          const out = normalizeToolOutput(p.output)
          if (!out) break
          if (wantTools) {
            const item = p.call_id && toolOutputs.get(p.call_id)
            if (item) {
              if (item.output) item.output += `\n\n${out}`
              else item.output = out
            } else {
              nTools++
              report.items.push({
                kind: 'tool',
                time,
                name: 'unknown',
                callID: p.call_id || '',
                output: out,
              })
            }
          }
          break
        }
        default:
          nCut++
      }
    }
  }

  report.session.model = (() => {
    for (const p of [...tc].reverse()) if (p.model) return p.model
    return ''
  })()
  report.session.effort = (() => {
    for (const p of [...tc].reverse()) if (p.effort) return p.effort
    return ''
  })()

  report.stats = {
    responseItems: nItems,
    assistantMessages: nMessages,
    assistant: nAssistant,
    user: nUser,
    reasoning: nReasoning,
    encryptedReasoning: nEncryptedReasoning,
    tool: nTools,
    skippedKinds: nCut,
  }
  return report
}

function normalizeToolOutput(output) {
  if (!output) return ''
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .filter((c) => c.type === 'input_text' && c.text)
      .map((c) => c.text)
      .join('\n\n')
  }
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

function renderUserContent(content) {
  const parts = []
  for (const c of content) {
    if (c.type === 'input_file') {
      parts.push(`[attachment: ${c.filename || c.file_id || 'file'}]`)
      continue
    }
    if (c.type !== 'input_text' && c.type !== 'text') continue
    const t = (c.text || '').replace(/^\n+/, '')
    if (t.startsWith('<recommended_plugins>') || t.startsWith('<environment_context>')) continue
    if (t.startsWith('<turn_aborted>')) {
      parts.push('[the user aborted the previous turn while it was running]')
      continue
    }
    parts.push(t)
  }
  return parts.join('\n\n').trim()
}

function writeAll(text) {
  const buf = Buffer.from(text, 'utf8')
  let off = 0
  while (off < buf.length) {
    off += writeSync(1, buf, off, buf.length - off, null)
  }
}

// -------------------------------------------------------------- orchestrate

const wanted = []
if (tool) {
  if (tool !== 'opencode' && tool !== 'codex') fail(`unknown tool "${tool}"; use --tool=opencode or --tool=codex`)
  wanted.push(tool)
} else if (isOpenCodeId(id)) {
  wanted.push('opencode')
} else if (isUuid(id)) {
  wanted.push('codex')
} else {
  wanted.push('opencode', 'codex')
}

const reports = []
for (const t of wanted) {
  const r = t === 'opencode' ? extractOpenCode(id) : extractCodex(id)
  reports.push(r)
  if (r.found) break
}

const found = reports.find((r) => r.found)

if (!found) {
  console.error(`error: no session with id ${id} was found`)
  for (const r of reports) console.error(`  [${r.tool}] ${r.meta}`)
  process.exit(1)
}

if (asJson) {
  writeAll(JSON.stringify({
    sessionId: id,
    tool: found.tool,
    method: found.meta,
    session: found.session,
    stats: found.stats,
    items: found.items,
  }, null, 2) + '\n')
  process.exit(0)
}

// render transcript
const out = []
out.push(`# Session ${id}`)
out.push(`Tool:        ${found.tool}`)
for (const [label, value] of [
  ['Directory', found.session.directory],
  ['Slug', found.session.slug],
  ['Title', found.session.title],
  ['Thread', found.session.thread],
  ['Started', found.session.started ? `${found.session.started} (UTC)` : ''],
  ['Model', found.session.model],
  ['Effort', found.session.effort],
  ['Agent', found.session.agent],
  ['Provider', found.session.provider],
  ['Source', found.session.source],
  ['Originator', found.session.originator],
  ['CLI', found.session.cliVersion],
]) {
  if (value) out.push(`${label.padEnd(10)} ${value}`)
}
const stats = found.stats
const statParts = []
if (stats.user != null) statParts.push(`${stats.user} user`)
if (stats.assistant != null) statParts.push(`${stats.assistant} assistant`)
if (stats.reasoning != null) statParts.push(`${stats.reasoning} reasoning`)
if (stats.tool != null) statParts.push(`${stats.tool} tool`)
if (statParts.length) out.push(`${'Stats'.padEnd(10)} ${statParts.join(', ')}`)
out.push('')
out.push(`Method: ${found.meta}`)
out.push('')

for (const it of found.items) {
  switch (it.kind) {
    case 'user':
      out.push(`## user — ${it.time}`)
      if (it.text) out.push('', it.text.trim())
      out.push('')
      break
    case 'assistant': {
      const phase = it.phase ? ` (${it.phase})` : ''
      out.push(`## assistant${phase} — ${it.time}`)
      if (it.text) out.push('', it.text.trim())
      out.push('')
      break
    }
    case 'reasoning':
      out.push(`### reasoning — ${it.time}`)
      out.push('', truncate(it.text, 'reasoning'))
      out.push('')
      break
    case 'tool': {
      const header = [`### tool ${it.name}`]
      if (it.callID) header.push(` (${it.callID})`)
      header.push(` — ${it.time}`)
      out.push(header.join(''))
      if (it.input) {
        out.push('', 'input:')
        out.push('```')
        out.push(truncate(it.input, 'input'))
        out.push('```')
      }
      if (it.output) {
        out.push('', 'output:')
        out.push('```')
        out.push(truncate(it.output, 'output'))
        out.push('```')
      }
      out.push('')
      break
    }
  }
}

if (found.items.length === 0) out.push('(no conversation items in this session)')

writeAll(out.join('\n'))