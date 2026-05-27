import { Link } from 'react-router-dom'
import { useState, useMemo, useEffect, useRef } from 'react'
import { Chart, registerables } from 'chart.js'
import { useAllLogs } from '../hooks/useLogs'
import { useRoster } from '../hooks/useRoster'
import { fmtDuration } from '../utils/schedule'
import { SCHEDULES } from '../data/schedules'
import type { ScheduleDay } from '../types'

Chart.register(...registerables)

type TimeRange = '7days' | '14days' | '30days' | 'custom'

const C = {
  bg: '#f8fafc', white: '#fff', ink: '#0f172a', slate: '#475569',
  muted: '#94a3b8', cloud: '#f1f5f9', border: '#e2e8f0',
  green: '#10b981', greenBg: 'rgba(16,185,129,0.08)',
  red: '#ef4444', redBg: 'rgba(239,68,68,0.06)', redBorder: 'rgba(239,68,68,0.2)',
  amber: '#f59e0b', amberBg: 'rgba(245,158,11,0.08)',
  primary: '#667eea', primaryBg: 'rgba(102,126,234,0.08)',
}

function getRange(tr: TimeRange, cs: string, ce: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const end = today.toISOString().split('T')[0]
  if (tr === 'custom' && cs && ce) return { start: cs, end: ce }
  const days = parseInt(tr.replace('days', ''))
  const s = new Date(today); s.setDate(today.getDate() - days)
  return { start: s.toISOString().split('T')[0], end }
}

function fmtTime(ts: number | null) {
  if (!ts) return '—'
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmtDate(d: string) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ─── Small shared components ──────────────────────────────────────────────────

function StatCard({ label, value, color, sub }: { label: string; value: string | number; color?: string; sub?: string }) {
  return (
    <div style={{ background: C.white, borderRadius: 10, padding: '0.875rem 1rem', border: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: '1.6rem', fontWeight: 700, color: color ?? C.ink, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function Seg({ opts, val, onSet }: { opts: [string, string][]; val: string; onSet: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 3, background: C.cloud, padding: 3, borderRadius: 8 }}>
      {opts.map(([v, l]) => (
        <button key={v} onClick={() => onSet(v)}
          style={{ padding: '4px 12px', borderRadius: 6, border: 'none', fontWeight: 600, fontSize: 12, cursor: 'pointer', background: val === v ? C.white : 'transparent', color: val === v ? C.ink : C.slate, boxShadow: val === v ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>
          {l}
        </button>
      ))}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Analytics() {
  const { logs, loading } = useAllLogs()
  const { roster } = useRoster()

  const [schedDay, setSchedDay] = useState<ScheduleDay>('red')
  const [periodKey, setPeriodKey] = useState('red_1')  // e.g. "red_1", "black_3"
  const [timeRange, setTimeRange] = useState<TimeRange>('14days')
  const [customStart, setCustomStart] = useState('')
  const [customEnd, setCustomEnd] = useState(new Date().toISOString().split('T')[0])
  const [expandedStudent, setExpandedStudent] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<'duration' | 'trips' | 'over10'>('duration')

  const trendRef = useRef<HTMLCanvasElement>(null)
  const dowRef   = useRef<HTMLCanvasElement>(null)
  const trendChart = useRef<Chart | null>(null)
  const dowChart   = useRef<Chart | null>(null)

  const range = getRange(timeRange, customStart, customEnd)

  // Build period options from Firebase roster + schedules
  const periodOptions = useMemo(() => {
    const periods = SCHEDULES[schedDay].regular.filter(p => {
      const num = p.name.match(/\d+/)?.[0] ?? ''
      return roster[`${schedDay}_${num}`]?.name?.trim()
    })
    return periods.map(p => {
      const num = p.name.match(/\d+/)?.[0] ?? '1'
      const key = `${schedDay}_${num}`
      const className = roster[key]?.name || p.name.replace(/([A-Za-z]+)(\d+)/, '$1 $2')
      const dayLabel = schedDay === 'red' ? 'Red' : 'Black'
      return { key, label: className, sub: `${dayLabel} ${num}`, periodName: p.name }
    })
  }, [schedDay, roster])

  // The period name used in logs (e.g. "Red1-Algebra")
  const activePeriodName = useMemo(() => {
    const opt = periodOptions.find(o => o.key === periodKey)
    if (opt) return opt.periodName
    return periodOptions[0]?.periodName ?? ''
  }, [periodOptions, periodKey])

  // Reset period when day changes
  useEffect(() => {
    const first = SCHEDULES[schedDay].regular[0]
    const num = first?.name.match(/\d+/)?.[0] ?? '1'
    setPeriodKey(`${schedDay}_${num}`)
    setExpandedStudent(null)
  }, [schedDay])

  // All completed trips in selected period + range
  const filtered = useMemo(() => logs.filter(l => {
    if (l.scheduleDay !== schedDay) return false
    if (l.date < range.start || l.date > range.end) return false
    if (!['in', 'auto-reset', 'manual-in'].includes(l.action)) return false
    if (!l.duration || l.duration <= 0) return false
    // Match period: compare full period name OR just the number
    const periodNum = activePeriodName.match(/\d+/)?.[0] ?? ''
    const logPeriodNum = l.periodName.match(/\d+/)?.[0] ?? ''
    const sameDay = l.periodName.toLowerCase().startsWith(schedDay === 'red' ? 'red' : 'black')
    return sameDay && logPeriodNum === periodNum
  }), [logs, schedDay, activePeriodName, range])

  // Per-student stats
  const studentStats = useMemo(() => {
    const m: Record<string, { trips: number; duration: number; over10: number; autoReset: number }> = {}
    filtered.forEach(l => {
      if (!m[l.studentName]) m[l.studentName] = { trips: 0, duration: 0, over10: 0, autoReset: 0 }
      m[l.studentName].trips++
      m[l.studentName].duration += l.duration
      if (l.duration > 600_000) m[l.studentName].over10++
      if (l.action === 'auto-reset') m[l.studentName].autoReset++
    })
    const sorted = Object.entries(m).sort((a, b) => {
      if (sortBy === 'trips') return b[1].trips - a[1].trips
      if (sortBy === 'over10') return b[1].over10 - a[1].over10
      return b[1].duration - a[1].duration
    })
    return sorted
  }, [filtered, sortBy])

  // Flagged students — 2+ trips over 10 min
  const flagged = useMemo(() =>
    studentStats.filter(([, st]) => st.over10 >= 2)
  , [studentStats])

  // Summary stats
  const totalDuration = filtered.reduce((s, l) => s + l.duration, 0)
  const avgDuration = filtered.length > 0 ? totalDuration / filtered.length : 0
  const over10Count = filtered.filter(l => l.duration > 600_000).length
  const uniqueStudents = new Set(filtered.map(l => l.studentName)).size
  // Total class time lost = sum of all trip durations
  const classTimeLost = fmtDuration(totalDuration)

  // Trend chart
  useEffect(() => {
    if (!trendRef.current) return
    const dayMap: Record<string, number> = {}
    const end = new Date(range.end + 'T00:00:00')
    const startD = new Date(range.start + 'T00:00:00')
    const days = Math.round((end.getTime() - startD.getTime()) / 86400000) + 1
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(end); d.setDate(end.getDate() - i)
      dayMap[d.toISOString().split('T')[0]] = 0
    }
    filtered.forEach(l => { if (l.date in dayMap) dayMap[l.date]++ })
    if (trendChart.current) trendChart.current.destroy()
    trendChart.current = new Chart(trendRef.current, {
      type: 'line',
      data: {
        labels: Object.keys(dayMap).map(fmtDate),
        datasets: [{ label: 'Trips', data: Object.values(dayMap), borderColor: C.primary, backgroundColor: 'rgba(102,126,234,0.08)', borderWidth: 2.5, fill: true, tension: 0.4, pointRadius: 3 }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    })
  }, [filtered, range])

  // Day-of-week chart
  useEffect(() => {
    if (!dowRef.current) return
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const counts = [0, 0, 0, 0, 0, 0, 0]
    filtered.forEach(l => {
      const dow = new Date(l.date + 'T00:00:00').getDay()
      counts[dow]++
    })
    if (dowChart.current) dowChart.current.destroy()
    dowChart.current = new Chart(dowRef.current, {
      type: 'bar',
      data: {
        labels: days,
        datasets: [{ data: counts, backgroundColor: counts.map(c => c === Math.max(...counts) ? C.primary : 'rgba(102,126,234,0.25)'), borderRadius: 4 }],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
    })
  }, [filtered])

  useEffect(() => () => { trendChart.current?.destroy(); dowChart.current?.destroy() }, [])

  // Per-student trip log
  const studentTrips = useMemo(() => {
    if (!expandedStudent) return []
    return filtered.filter(l => l.studentName === expandedStudent).sort((a, b) => b.timestamp - a.timestamp)
  }, [filtered, expandedStudent])

  const exportStudentCSV = (name: string) => {
    const trips = filtered.filter(l => l.studentName === name).sort((a, b) => b.timestamp - a.timestamp)
    const rows = [
      ['Date', 'Duration (min)', 'Out Time', 'In Time', 'Action'],
      ...trips.map(l => [l.date, (l.duration / 60000).toFixed(1), fmtTime(l.outTime), fmtTime(l.inTime), l.action]),
    ]
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' }))
    a.download = `${name}_hallpass.csv`
    a.click()
  }

  const exportAllCSV = () => {
    const rows = [
      ['Student', 'Date', 'Duration (min)', 'Out Time', 'In Time', 'Action'],
      ...filtered.sort((a, b) => b.timestamp - a.timestamp).map(l => [
        l.studentName, l.date, (l.duration / 60000).toFixed(1), fmtTime(l.outTime), fmtTime(l.inTime), l.action,
      ]),
    ]
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' }))
    a.download = `hallpass_${schedDay}_${periodKey}_${range.start}_${range.end}.csv`
    a.click()
  }

  const activePeriodLabel = periodOptions.find(o => o.key === periodKey)

  return (
    <div style={{ minHeight: '100vh', background: C.bg, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '1.25rem 1.5rem' }}>

        {/* ── Header ──────────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.8rem', color: C.ink, margin: 0 }}>Analytics</h1>
            {activePeriodLabel && (
              <span style={{ fontSize: 15, fontWeight: 700, color: C.ink }}>{activePeriodLabel.label}
                <span style={{ fontSize: 11, fontWeight: 500, color: C.muted, marginLeft: 8 }}>{activePeriodLabel.sub}</span>
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/dashboard" style={{ width: 34, height: 34, borderRadius: 8, background: C.cloud, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', color: C.slate }}>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7" /></svg>
            </Link>
            <Link to="/" style={{ width: 34, height: 34, borderRadius: 8, background: C.cloud, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none', color: C.slate }}>
              <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
            </Link>
          </div>
        </div>

        {/* ── Filters ─────────────────────────────────────────────────────────── */}
        <div style={{ background: C.white, borderRadius: 12, padding: '0.875rem 1.25rem', border: `1px solid ${C.border}`, marginBottom: '1.25rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>Schedule</div>
            <Seg opts={[['red','Red'],['black','Black']]} val={schedDay} onSet={v => setSchedDay(v as ScheduleDay)} />
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>Period</div>
            <div style={{ display: 'flex', gap: 3, background: C.cloud, padding: 3, borderRadius: 8 }}>
              {periodOptions.map(o => (
                <button key={o.key} onClick={() => { setPeriodKey(o.key); setExpandedStudent(null) }}
                  style={{ padding: '4px 12px', borderRadius: 6, border: 'none', fontWeight: 600, fontSize: 12, cursor: 'pointer', background: periodKey === o.key ? C.white : 'transparent', color: periodKey === o.key ? C.ink : C.slate, boxShadow: periodKey === o.key ? '0 1px 3px rgba(0,0,0,0.1)' : 'none', whiteSpace: 'nowrap' }}>
                  {o.label} <span style={{ fontWeight: 400, color: C.muted, fontSize: 11 }}>{o.sub}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>Range</div>
            <Seg opts={[['7days','7d'],['14days','14d'],['30days','30d'],['custom','Custom']]} val={timeRange} onSet={v => setTimeRange(v as TimeRange)} />
          </div>
          {timeRange === 'custom' && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 6 }}>Dates</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)} style={{ padding: '4px 8px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontFamily: 'inherit' }} />
                <span style={{ color: C.muted, fontSize: 12 }}>→</span>
                <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)} style={{ padding: '4px 8px', border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, fontFamily: 'inherit' }} />
              </div>
            </div>
          )}
          <button onClick={exportAllCSV} style={{ marginLeft: 'auto', padding: '6px 14px', borderRadius: 8, border: `1px solid ${C.border}`, background: C.cloud, color: C.slate, fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Export All CSV
          </button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '4rem', color: C.muted }}>Loading data…</div>
        ) : (
          <>
            {/* ── Flagged students ─────────────────────────────────────────────── */}
            {flagged.length > 0 && (
              <div style={{ background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 12, padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.red, animation: 'pulse 1.5s ease-in-out infinite' }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.red, textTransform: 'uppercase', letterSpacing: '0.6px' }}>Needs attention — 2+ trips over 10 minutes</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {flagged.map(([name, st]) => (
                    <button key={name} onClick={() => setExpandedStudent(name === expandedStudent ? null : name)}
                      style={{ padding: '6px 14px', borderRadius: 100, border: `1px solid ${C.redBorder}`, background: expandedStudent === name ? C.red : C.white, color: expandedStudent === name ? '#fff' : C.red, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                      {name} · {st.over10} trips over 10 min
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── Stats row ────────────────────────────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
              <StatCard label="Students with trips" value={uniqueStudents} />
              <StatCard label="Total trips" value={filtered.length} />
              <StatCard label="Avg duration" value={filtered.length > 0 ? fmtDuration(avgDuration) : '—'} />
              <StatCard label="Trips over 10 min" value={over10Count} color={over10Count > 0 ? C.red : undefined} />
              <StatCard label="Class time lost" value={classTimeLost} color={C.amber} sub="across all students" />
              <StatCard label="Flagged students" value={flagged.length} color={flagged.length > 0 ? C.red : undefined} sub="2+ long trips" />
            </div>

            {/* ── Charts ──────────────────────────────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1rem', marginBottom: '1.25rem' }}>
              <div style={{ background: C.white, borderRadius: 12, padding: '1.25rem', border: `1px solid ${C.border}` }}>
                <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: '1rem', color: C.ink, margin: '0 0 12px' }}>Daily trips</h3>
                <div style={{ height: 200 }}><canvas ref={trendRef} /></div>
              </div>
              <div style={{ background: C.white, borderRadius: 12, padding: '1.25rem', border: `1px solid ${C.border}` }}>
                <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: '1rem', color: C.ink, margin: '0 0 12px' }}>Busiest day of week</h3>
                <div style={{ height: 200 }}><canvas ref={dowRef} /></div>
              </div>
            </div>

            {/* ── Student table ────────────────────────────────────────────────── */}
            <div style={{ background: C.white, borderRadius: 12, border: `1px solid ${C.border}`, overflow: 'hidden' }}>
              <div style={{ padding: '1rem 1.25rem', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ fontFamily: "'Fraunces', serif", fontSize: '1rem', color: C.ink, margin: 0 }}>All students</h3>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: C.muted }}>Sort by</span>
                  <Seg opts={[['duration','Time out'],['trips','Trips'],['over10','> 10 min']]} val={sortBy} onSet={v => setSortBy(v as typeof sortBy)} />
                </div>
              </div>

              {studentStats.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: C.muted }}>No trips in this range</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: C.bg }}>
                      {['Student', 'Trips', 'Total time', 'Avg', '> 10 min', 'Auto-reset', ''].map(h => (
                        <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px', padding: '8px 12px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {studentStats.map(([name, st]) => {
                      const isExpanded = expandedStudent === name
                      const isFlagged = st.over10 >= 2
                      return (
                        <>
                          <tr key={name}
                            onClick={() => setExpandedStudent(isExpanded ? null : name)}
                            style={{ borderBottom: `1px solid ${C.border}`, cursor: 'pointer', background: isExpanded ? C.primaryBg : isFlagged ? C.redBg : C.white }}>
                            <td style={{ padding: '10px 12px', fontSize: 14, fontWeight: 600, color: C.ink }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                {isFlagged && <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.red, display: 'inline-block', flexShrink: 0 }} />}
                                {name}
                              </div>
                            </td>
                            <td style={{ padding: '10px 12px', fontSize: 13, color: C.ink }}>{st.trips}</td>
                            <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 600, color: C.ink }}>{fmtDuration(st.duration)}</td>
                            <td style={{ padding: '10px 12px', fontSize: 13, color: C.slate }}>{fmtDuration(st.trips > 0 ? st.duration / st.trips : 0)}</td>
                            <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: st.over10 > 0 ? 700 : 400, color: st.over10 > 0 ? C.red : C.muted }}>{st.over10 || '—'}</td>
                            <td style={{ padding: '10px 12px', fontSize: 13, color: st.autoReset > 0 ? C.amber : C.muted }}>{st.autoReset || '—'}</td>
                            <td style={{ padding: '10px 12px', fontSize: 12, color: C.muted, textAlign: 'right' }}>
                              {isExpanded ? '▲' : '▼'}
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr key={`${name}-detail`} style={{ background: C.primaryBg }}>
                              <td colSpan={7} style={{ padding: '0 12px 16px' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0 8px' }}>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: C.primary, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Trip history</span>
                                  <button onClick={e => { e.stopPropagation(); exportStudentCSV(name) }}
                                    style={{ padding: '4px 12px', borderRadius: 6, border: 'none', background: C.primary, color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                                    Export CSV
                                  </button>
                                </div>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr>
                                      {['Date', 'Duration', 'Out', 'In', 'Note'].map(h => (
                                        <th key={h} style={{ textAlign: 'left', fontSize: 10, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.5px', padding: '4px 8px', borderBottom: `1px solid ${C.border}` }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {studentTrips.slice(0, 15).map((l, i) => (
                                      <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                                        <td style={{ padding: '6px 8px', fontSize: 12, color: C.ink }}>{fmtDate(l.date)}</td>
                                        <td style={{ padding: '6px 8px', fontSize: 13, fontWeight: 600, color: l.duration > 600_000 ? C.red : l.duration > 300_000 ? C.amber : C.green }}>{fmtDuration(l.duration)}</td>
                                        <td style={{ padding: '6px 8px', fontSize: 12, color: C.slate }}>{fmtTime(l.outTime)}</td>
                                        <td style={{ padding: '6px 8px', fontSize: 12, color: C.slate }}>{fmtTime(l.inTime)}</td>
                                        <td style={{ padding: '6px 8px', fontSize: 11, color: C.muted }}>
                                          {l.action === 'auto-reset' ? 'Auto-reset at period end' : l.action === 'manual-in' ? 'Teacher marked in' : ''}
                                        </td>
                                      </tr>
                                    ))}
                                    {studentTrips.length > 15 && (
                                      <tr><td colSpan={5} style={{ padding: '6px 8px', fontSize: 11, color: C.muted, textAlign: 'center' }}>+ {studentTrips.length - 15} more trips — export CSV for full history</td></tr>
                                    )}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
      <style>{`@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }`}</style>
    </div>
  )
}
