import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import {
  savePeriod, saveFullRoster, watchRoster,
  parseRosterCSV, parseExcelTSV, deduplicateNames,
} from '../firebase/roster'
import type { RosterData, DayKey, PeriodNum, RosterPeriod, ExcelParseResult } from '../firebase/roster'
import { PERIOD_TIMES, fmt12 } from '../data/periods'


const EDITOR_PIN = import.meta.env.VITE_EDITOR_PIN ?? '0000'

const C = {
  bg: '#f8fafc', white: '#fff', ink: '#0f172a', slate: '#475569',
  muted: '#94a3b8', cloud: '#f1f5f9', border: '#e2e8f0',
  green: '#10b981', greenBg: 'rgba(16,185,129,0.08)',
  red: '#ef4444', redBg: 'rgba(239,68,68,0.06)',
  primary: '#667eea', primaryBg: 'rgba(102,126,234,0.08)',
  amber: '#f59e0b', amberBg: 'rgba(245,158,11,0.08)',
  purple: '#8b5cf6',
}

type Screen = 'pin' | 'main' | 'period'
interface ActivePeriod { day: DayKey; period: PeriodNum }

// ─── PIN ──────────────────────────────────────────────────────────────────────

function PinEntry({ onSuccess }: { onSuccess: () => void }) {
  const [digits, setDigits] = useState(['', '', '', ''])
  const [error, setError] = useState(false)
  const refs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)]

  const verify = (d: string[]) => {
    if (d.join('') === EDITOR_PIN) { onSuccess() }
    else { setError(true); setDigits(['', '', '', '']); setTimeout(() => refs[0].current?.focus(), 50) }
  }

  const handleChange = (i: number, val: string) => {
    if (!/^\d?$/.test(val)) return
    const next = [...digits]; next[i] = val; setDigits(next); setError(false)
    if (val && i < 3) refs[i + 1].current?.focus()
    if (val && i === 3) verify([...digits.slice(0, 3), val])
  }

  const handleKeyDown = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs[i - 1].current?.focus()
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <div style={{ background: C.white, borderRadius: 16, padding: '2.5rem 2rem', width: 320, textAlign: 'center', border: `1px solid ${C.border}` }}>
        <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.75rem', color: C.ink, margin: '0 0 6px' }}>Roster Editor</h1>
        <p style={{ fontSize: 13, color: C.slate, margin: '0 0 28px' }}>Enter PIN to continue</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 16 }}>
          {digits.map((d, i) => (
            <input key={i} ref={refs[i]} type="password" inputMode="numeric" maxLength={1} value={d}
              onChange={e => handleChange(i, e.target.value)}
              onKeyDown={e => handleKeyDown(i, e)}
              autoFocus={i === 0}
              style={{ width: 56, height: 64, fontSize: '1.75rem', textAlign: 'center', border: `2px solid ${error ? C.red : C.border}`, borderRadius: 10, fontFamily: 'monospace', outline: 'none', color: C.ink, background: error ? C.redBg : C.white }}
            />
          ))}
        </div>
        {error && <p style={{ color: C.red, fontSize: 13, margin: '0 0 12px' }}>Incorrect PIN</p>}
        <Link to="/" style={{ fontSize: 13, color: C.muted, textDecoration: 'none' }}>← Back to home</Link>
      </div>
    </div>
  )
}

// ─── Excel upload preview ─────────────────────────────────────────────────────

function ExcelUpload({ onConfirm }: { onConfirm: (data: RosterData) => void }) {
  const [result, setResult] = useState<ExcelParseResult | null>(null)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Use SheetJS-style reading — but we're in browser, so use FileReader + manual TSV parse
    // The Excel extract-text output is TSV, we replicate that in browser via reading as arraybuffer
    // For browser: read as text (xlsx files need SheetJS) — use a simpler approach:
    // Read file and parse using our TSV parser on the raw text extracted client-side

    const reader = new FileReader()
    reader.onload = ev => {
      // Try to parse as TSV text first (if exported as TSV/CSV from PowerSchool)
      const text = ev.target?.result as string
      // Check if it looks like TSV
      if (text.includes('\t')) {
        setResult(parseExcelTSV(text))
      } else {
        // Might be CSV format — try to convert
        const tsvLike = text.replace(/,/g, '\t')
        setResult(parseExcelTSV(tsvLike))
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const handleExcelFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Use SheetJS for actual .xlsx files
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
    script.onload = () => {
      const reader = new FileReader()
      reader.onload = ev => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const XLSX = (window as any).XLSX
          const data = new Uint8Array(ev.target?.result as ArrayBuffer)
          const wb = XLSX.read(data, { type: 'array' })
          const ws = wb.Sheets[wb.SheetNames[0]]
          const tsv = XLSX.utils.sheet_to_csv(ws, { FS: '\t' })
          setResult(parseExcelTSV(tsv))
        } catch {
          setResult({ roster: {}, warnings: ['Could not read Excel file. Try saving as CSV from Excel first.'], summary: [] })
        }
      }
      reader.readAsArrayBuffer(file)
    }
    document.head.appendChild(script)
    e.target.value = ''
  }

  const confirm = async () => {
    if (!result) return
    setSaving(true)
    await onConfirm(result.roster)
    setSaving(false)
    setResult(null)
  }

  const dayLabel = (key: string) => {
    const [day, num] = key.split('_')
    return `${day === 'red' ? 'Red' : 'Black'} Day · Period ${num}`
  }

  return (
    <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: '1.5rem', marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.25rem', color: C.ink, margin: '0 0 4px' }}>Full Year Upload</h2>
          <p style={{ fontSize: 13, color: C.slate, margin: 0 }}>Upload your PowerSchool roster Excel to populate all periods at once</p>
        </div>
      </div>

      {!result ? (
        <div>
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={e => {
            const file = e.target.files?.[0]
            if (!file) return
            if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
              handleExcelFile(e)
            } else {
              handleFile(e)
            }
          }} style={{ display: 'none' }} />

          <button onClick={() => fileRef.current?.click()}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderRadius: 10, border: `2px dashed ${C.border}`, background: C.bg, color: C.slate, fontSize: 14, fontWeight: 600, cursor: 'pointer', width: '100%', justifyContent: 'center' }}>
            <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            Upload Excel or CSV roster
          </button>
          <p style={{ fontSize: 11, color: C.muted, textAlign: 'center', marginTop: 8 }}>
            PowerSchool export with Name + Course columns · .xlsx, .xls, or .csv
          </p>
        </div>
      ) : (
        <div>
          {/* Warnings */}
          {result.warnings.length > 0 && (
            <div style={{ background: C.amberBg, border: `1px solid rgba(245,158,11,0.3)`, borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
              {result.warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 12, color: '#92400e', marginBottom: i < result.warnings.length - 1 ? 4 : 0 }}>⚠ {w}</div>
              ))}
            </div>
          )}

          {/* Preview */}
          {result.summary.length === 0 ? (
            <div style={{ background: C.redBg, borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
              <div style={{ fontSize: 13, color: C.red, fontWeight: 600 }}>No periods found in file</div>
              <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>Make sure the file has Name and Course columns</div>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8, marginBottom: 16 }}>
              {result.summary.sort((a, b) => a.key.localeCompare(b.key)).map(s => (
                <div key={s.key} style={{ background: C.bg, borderRadius: 8, padding: '10px 12px', border: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 3 }}>{dayLabel(s.key)}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.ink, marginBottom: 2 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: C.slate }}>{s.count} students</div>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => setResult(null)}
              style={{ padding: '8px 16px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.cloud, color: C.slate, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              Cancel
            </button>
            {result.summary.length > 0 && (
              <button onClick={confirm} disabled={saving}
                style={{ padding: '8px 24px', borderRadius: 8, border: 'none', background: C.ink, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Saving…' : `Confirm — populate ${result.summary.length} periods`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Period card ──────────────────────────────────────────────────────────────

function PeriodCard({ day, period, data, onClick }: {
  day: DayKey; period: PeriodNum; data?: RosterPeriod; onClick: () => void
}) {
  const times = PERIOD_TIMES.find(p => p.period === period)!
  const hasClass = !!(data?.name?.trim())
  const count = data?.students?.length ?? 0

  return (
    <button onClick={onClick} style={{ background: C.white, borderRadius: 12, border: `1.5px solid ${hasClass ? (day === 'red' ? 'rgba(239,68,68,0.3)' : 'rgba(15,23,42,0.2)') : C.border}`, padding: '14px 16px', textAlign: 'left', cursor: 'pointer', width: '100%', transition: 'box-shadow 0.15s' }}
      onMouseEnter={e => (e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)')}
      onMouseLeave={e => (e.currentTarget.style.boxShadow = 'none')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: day === 'red' ? C.red : C.muted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 3 }}>
            {day === 'red' ? 'Red' : 'Black'} · Period {period}
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: hasClass ? C.ink : C.muted }}>
            {hasClass ? data!.name : 'Not scheduled'}
          </div>
        </div>
        {hasClass && (
          <span style={{ fontSize: 12, fontWeight: 600, color: C.slate, background: C.cloud, borderRadius: 100, padding: '2px 10px' }}>
            {count}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: C.muted }}>
        Regular {fmt12(times.regular.start)}–{fmt12(times.regular.end)} · Late {fmt12(times.late.start)}–{fmt12(times.late.end)}
      </div>
    </button>
  )
}

// ─── Period editor ────────────────────────────────────────────────────────────

function PeriodEditor({ day, period, data, onBack, onSave }: {
  day: DayKey; period: PeriodNum; data?: RosterPeriod
  onBack: () => void; onSave: (d: RosterPeriod) => Promise<void>
}) {
  const [className, setClassName] = useState(data?.name ?? '')
  const [students, setStudents] = useState<string[]>(data?.students ?? [])
  const [newName, setNewName] = useState('')
  const [csvPreview, setCsvPreview] = useState<{ names: string[]; warnings: string[] } | null>(null)
  const [saving, setSaving] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const times = PERIOD_TIMES.find(p => p.period === period)!

  const addStudent = () => {
    const trimmed = newName.trim()
    if (!trimmed) return
    const parts = trimmed.split(' ')
    const first = parts[0]
    const existingFirst = students.find(s => s.split(' ')[0].toLowerCase() === first.toLowerCase())
    if (existingFirst && parts.length < 2) {
      alert(`There's already a "${first}" — include a last initial, e.g. "${first} B"`)
      return
    }
    setStudents(prev => [...new Set([...prev, trimmed])].sort())
    setNewName('')
  }

  const removeStudent = (name: string) => setStudents(prev => prev.filter(s => s !== name))

  const handleCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      const parsed = parseRosterCSV(text)
      const warnings: string[] = []
      // Check for duplicates against existing
      const allEntries = [...students, ...parsed].map(n => {
        const p = n.split(' '); return { first: p[0], lastInitial: p[1] ?? '' }
      })
      const counts: Record<string, number> = {}
      allEntries.forEach(e => { counts[e.first] = (counts[e.first] ?? 0) + 1 })
      Object.entries(counts).forEach(([name, c]) => {
        if (c > 1) warnings.push(`"${name}" appears ${c}× — last initials added`)
      })
      setCsvPreview({ names: parsed, warnings })
    }
    reader.readAsText(file); e.target.value = ''
  }

  const confirmCSV = (replace: boolean) => {
    if (!csvPreview) return
    const base = replace ? [] : students
    const allEntries = [...base, ...csvPreview.names].map(n => {
      const p = n.split(' '); return { first: p[0], lastInitial: p[1] ?? '' }
    })
    setStudents([...new Set(deduplicateNames(allEntries))].sort())
    setCsvPreview(null)
  }

  const handleSave = async () => {
    setSaving(true)
    await onSave({ name: className.trim(), students })
    setSaving(false)
    onBack()
  }

  const accentColor = day === 'red' ? C.red : C.ink

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1.5rem' }}>
        <button onClick={onBack} style={{ width: 36, height: 36, borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: C.slate }}>
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: accentColor, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            {day === 'red' ? 'Red' : 'Black'} · Period {period}
          </div>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.5rem', color: C.ink, margin: 0 }}>{className || 'Unnamed Class'}</h2>
        </div>
      </div>

      {/* Class name */}
      <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: '1.25rem', marginBottom: '1rem' }}>
        <label style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px', display: 'block', marginBottom: 8 }}>Class Name</label>
        <input type="text" value={className} onChange={e => setClassName(e.target.value)}
          placeholder="e.g. Algebra I, Geometry, Pre-Algebra..."
          style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 15, color: C.ink, fontFamily: 'inherit', outline: 'none' }} />
        <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>
          Regular {fmt12(times.regular.start)}–{fmt12(times.regular.end)} · Late {fmt12(times.late.start)}–{fmt12(times.late.end)}
        </div>
      </div>

      {/* Roster */}
      <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, padding: '1.25rem', marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px' }}>
            Students ({students.length})
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input ref={fileRef} type="file" accept=".csv" onChange={handleCSV} style={{ display: 'none' }} />
            <button onClick={() => fileRef.current?.click()}
              style={{ padding: '5px 12px', borderRadius: 7, border: `1px solid ${C.border}`, background: C.cloud, color: C.slate, fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
              <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
              Upload CSV
            </button>
          </div>
        </div>

        {/* CSV preview */}
        {csvPreview && (
          <div style={{ background: C.primaryBg, border: `1px solid rgba(102,126,234,0.25)`, borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.primary, marginBottom: 6 }}>{csvPreview.names.length} students found</div>
            {csvPreview.warnings.map((w, i) => <div key={i} style={{ fontSize: 12, color: C.amber, marginBottom: 4 }}>⚠ {w}</div>)}
            <div style={{ fontSize: 12, color: C.slate, marginBottom: 10 }}>{csvPreview.names.join(', ')}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => confirmCSV(false)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: C.primary, color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Merge with existing</button>
              <button onClick={() => confirmCSV(true)} style={{ padding: '5px 14px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.white, color: C.slate, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Replace all</button>
              <button onClick={() => setCsvPreview(null)} style={{ padding: '5px 14px', borderRadius: 6, border: 'none', background: 'transparent', color: C.muted, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        )}

        {/* Add manually */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input type="text" value={newName} onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addStudent()}
            placeholder="First name  (or  First L  for duplicates)"
            style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 14, color: C.ink, fontFamily: 'inherit', outline: 'none' }} />
          <button onClick={addStudent} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: C.ink, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Add</button>
        </div>

        {/* Student grid */}
        {students.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1.5rem', color: C.muted, fontSize: 14 }}>No students yet</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 6 }}>
            {students.map(name => (
              <div key={name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderRadius: 7, border: `1px solid ${C.border}`, background: C.cloud, fontSize: 13, fontWeight: 500, color: C.ink }}>
                <span>{name}</span>
                <button onClick={() => removeStudent(name)} style={{ width: 18, height: 18, borderRadius: '50%', border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button onClick={() => { if (confirm('Clear this period?')) { onSave({ name: '', students: [] }).then(onBack) } }}
          style={{ padding: '10px 16px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.white, color: C.red, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          Clear
        </button>
        <div style={{ flex: 1 }} />
        <button onClick={onBack} style={{ padding: '10px 20px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.cloud, color: C.slate, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
        <button onClick={handleSave} disabled={saving} style={{ padding: '10px 28px', borderRadius: 8, border: 'none', background: C.ink, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.7 : 1 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ─── Main Editor ──────────────────────────────────────────────────────────────

export default function Editor() {
  const [screen, setScreen] = useState<Screen>('pin')
  const [roster, setRoster] = useState<RosterData>({})
  const [active, setActive] = useState<ActivePeriod | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (screen !== 'main' && screen !== 'period') return
    return watchRoster(setRoster)
  }, [screen])

  const handleFullSave = useCallback(async (data: RosterData) => {
    await saveFullRoster(data)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }, [])

  const handlePeriodSave = useCallback(async (day: DayKey, period: PeriodNum, data: RosterPeriod) => {
    await savePeriod(day, period, data)
  }, [])

  if (screen === 'pin') return <PinEntry onSuccess={() => setScreen('main')} />

  if (screen === 'period' && active) {
    const key = `${active.day}_${active.period}`
    return (
      <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'IBM Plex Sans', sans-serif" }}>
        <PeriodEditor
          day={active.day} period={active.period} data={roster[key]}
          onBack={() => { setActive(null); setScreen('main') }}
          onSave={async (data) => handlePeriodSave(active.day, active.period, data)}
        />
      </div>
    )
  }

  const days: DayKey[] = ['red', 'black']
  const periods: PeriodNum[] = [1, 2, 3, 4]

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '1.5rem' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
          <div>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: '2rem', color: C.ink, margin: '0 0 4px' }}>Roster Editor</h1>
            <p style={{ fontSize: 13, color: C.muted, margin: 0 }}>Upload your PowerSchool export or edit periods individually</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {saved && <span style={{ fontSize: 13, color: C.green, fontWeight: 600 }}>✓ Saved</span>}
            <Link to="/" style={{ width: 34, height: 34, borderRadius: 8, background: C.cloud, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', color: C.slate }}>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
            </Link>
          </div>
        </div>

        {/* Excel upload — primary workflow */}
        <ExcelUpload onConfirm={handleFullSave} />

        {/* Individual period cards */}
        <div style={{ marginBottom: 8 }}>
          <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.25rem', color: C.ink, margin: '0 0 4px' }}>Individual Periods</h2>
          <p style={{ fontSize: 13, color: C.muted, margin: '0 0 16px' }}>Edit a single period — add/remove students or update a class name mid-year</p>
        </div>

        {days.map(day => (
          <div key={day} style={{ marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: day === 'red' ? C.red : C.ink }} />
              <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.1rem', color: C.ink, margin: 0 }}>{day === 'red' ? 'Red Day' : 'Black Day'}</h3>
              <div style={{ flex: 1, height: 1, background: C.border }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem' }}>
              {periods.map(p => (
                <PeriodCard key={p} day={day} period={p} data={roster[`${day}_${p}`]}
                  onClick={() => { setActive({ day, period: p }); setScreen('period') }} />
              ))}
            </div>
          </div>
        ))}

        <p style={{ fontSize: 11, color: C.muted, textAlign: 'center' }}>
          Periods with no class name are hidden on the scanner and dashboard
        </p>
      </div>
    </div>
  )
}
