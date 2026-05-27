import { useNavigate } from 'react-router-dom'
import { useState, useEffect, useRef, useCallback } from 'react'
import { ref, onValue, off } from 'firebase/database'
import { db } from '../firebase/config'
import { SCHEDULES } from '../data/schedules'
import { useRoster } from '../hooks/useRoster'
import { scheduleStr, writeStudentOut, writeStudentIn, writeAutoReset } from '../firebase/writes'
import { fmt, fmt12, todayStr } from '../utils/schedule'
import type { ScheduleDay, StartType, Period } from '../types'
import { useWindowSize } from '../hooks/useWindowSize'

const ADMIN_PIN = import.meta.env.VITE_ADMIN_PIN ?? '0244'

const C = {
  bg: '#f8fafc', white: '#ffffff', ink: '#0f172a', slate: '#475569',
  cloud: '#f1f5f9', border: '#e2e8f0',
  green: '#10b981', greenBg: 'rgba(16,185,129,0.1)',
  red: '#ef4444', redBg: 'rgba(239,68,68,0.08)', redBorder: 'rgba(239,68,68,0.3)',
  primary: '#667eea',
  muted: '#94a3b8',
}

function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 }}>
      {children}
    </div>
  )
}

function WelcomeBar() {
  const [w, setW] = useState(100)
  useEffect(() => { const id = setTimeout(() => setW(0), 50); return () => clearTimeout(id) }, [])
  return (
    <div style={{ height: 4, borderRadius: 2, background: '#e2e8f0', overflow: 'hidden' }}>
      <div style={{ height: '100%', borderRadius: 2, background: C.green, width: `${w}%`, transition: 'width 3.3s linear' }} />
    </div>
  )
}


export default function Scanner() {
  const [day, setDay] = useState<ScheduleDay>(() =>
    (localStorage.getItem('hp_day') as ScheduleDay) ?? 'red')
  const [start, setStart] = useState<StartType>(() =>
    (localStorage.getItem('hp_start') as StartType) ?? 'regular')
  const [periodName, setPeriodName] = useState<string>(() =>
    localStorage.getItem('hp_period') ?? SCHEDULES.red.regular[0].name)
  const [screen, setScreen] = useState<'main'|'settings'|'firstRun'|'pickStart'|'swipe'|'welcome'>(() =>
    localStorage.getItem('hp_day') ? 'main' : 'firstRun')
  const [pickDay, setPickDay] = useState<ScheduleDay>('red')
  const [pickStart, setPickStart] = useState<StartType>('regular')
  const [pickPeriod, setPickPeriod] = useState<string>('')
  const navigate = useNavigate()
  const [errorPopup, setErrorPopup] = useState<{ type: 'maxOut' | 'notActive' } | null>(null)
  const [pinTarget, setPinTarget] = useState<'home' | 'confirm' | null>(null)
  const [pinDigits, setPinDigits] = useState(['','','',''])
  const [pinError, setPinError] = useState(false)
  const [pickMaxOut, setPickMaxOut] = useState<number>(() => parseInt(localStorage.getItem('hp_maxOut') ?? '5'))
  const [swipeName, setSwipeName] = useState('')
  const [swipeAction, setSwipeAction] = useState<'out'|'in'>('out')
  const [swipeProgress, setSwipeProgress] = useState(0)
  const [welcomeName, setWelcomeName] = useState('')
  const [welcomeTime, setWelcomeTime] = useState('')
  const [maxOut, setMaxOut] = useState<number>(() => {
    const saved = localStorage.getItem('hp_maxOut')
    return saved ? parseInt(saved) : 5
  })
  const [outSet, setOutSet] = useState<Set<string>>(new Set())
  const [outTimes, setOutTimes] = useState<Record<string, number>>({})
  const [tick, setTick] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)
  const dragStartX = useRef(0)

  // Ref holds all data needed by commit — avoids stale closures entirely
  const swipeRef = useRef<{
    name: string; action: 'out'|'in'; period: Period|null;
    day: ScheduleDay; start: StartType; outTimes: Record<string, number>
  }>({ name: '', action: 'out', period: null, day: 'red', start: 'regular', outTimes: {} })

  const { isIPadLandscape, isLargerThanIPad } = useWindowSize()
  const { roster } = useRoster()
  const allPeriods = SCHEDULES[day][start]
  const periods = allPeriods.filter(p => {
    const num = p.name.match(/\d+/)?.[0] ?? ''
    return roster[`${day}_${num}`]?.name?.trim()
  })
  const period: Period | null = periods.find(p => p.name === periodName) ?? periods[0] ?? null

  // Get student list from Firebase roster — fall back to schedules.ts only if Firebase
  // has NO entry for this period at all (i.e. editor has never been used)
  const rosterKey_ = period ? `${day}_${period.name.match(/\d+/)?.[0] ?? '1'}` : null
  const rosterEntry = rosterKey_ !== null && rosterKey_ in roster ? roster[rosterKey_] : undefined
  const firebaseHasRoster = Object.keys(roster).length > 0
  const periodStudents: string[] = firebaseHasRoster
    ? (rosterEntry?.students ?? [])           // Firebase has been set up — use it (even if empty)
    : (period?.students ?? [])                 // Firebase empty — fall back to schedules.ts

  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 1000); return () => clearInterval(id) }, [])

  // Reset period when day/start changes
  useEffect(() => {
    setErrorPopup(null)  // clear any error when schedule changes
    const valid = SCHEDULES[day][start].find(p => p.name === periodName)
    if (!valid) {
      const first = SCHEDULES[day][start][0]?.name ?? ''
      setPeriodName(first)
      localStorage.setItem('hp_period', first)
    }
  }, [day, start, periodName])

  // Real-time listener — syncs scanner with dashboard and auto-resets at period end
  // Uses a ref so the callback always sees current period/day/start without re-subscribing
  const periodRef = useRef(period)
  const dayRef = useRef(day)
  const startRef = useRef(start)
  periodRef.current = period
  dayRef.current = day
  startRef.current = start

  useEffect(() => {
    const studentsRef = ref(db, 'students')

    const handleSnapshot = async (snap: import('firebase/database').DataSnapshot) => {
      const p = periodRef.current
      const d = dayRef.current
      const s = startRef.current
      if (!p) return

      const sched = scheduleStr(d, s)
      const all = (snap.val() ?? {}) as Record<string, {
        status: string; name: string; period: string; schedule: string;
        outTimestamp: number|null; timestamp: number
      }>

      const now = new Date()
      const t = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0')
      const periodOver = t >= p.endTime
      const resetTime = Date.now()
      const today = todayStr()

      const newOut = new Set<string>()
      const newTimes: Record<string, number> = {}

      for (const [key, student] of Object.entries(all)) {
        if (student.period !== p.name || student.schedule !== sched) continue
        if (student.status === 'out') {
          if (periodOver) {
            await writeAutoReset({ name: student.name, period: student.period, schedule: student.schedule, studentKey: key, outStart: student.outTimestamp ?? student.timestamp, resetTime, date: today })
          } else {
            newOut.add(student.name)
            newTimes[student.name] = student.outTimestamp ?? student.timestamp
          }
        }
      }

      setOutSet(newOut)
      setOutTimes(newTimes)
    }

    onValue(studentsRef, handleSnapshot)
    return () => off(studentsRef, 'value', handleSnapshot)
  }, [])  // Empty deps — subscribes once, reads from refs

  const applySchedule = (d: ScheduleDay, s: StartType) => {
    setDay(d); setStart(s)
    localStorage.setItem('hp_day', d)
    localStorage.setItem('hp_start', s)
    const first = SCHEDULES[d][s][0]?.name ?? ''
    setPeriodName(first)
    localStorage.setItem('hp_period', first)
    setScreen('main')
  }

  const openSwipe = (name: string) => {
    const isOut = outSet.has(name)
    // Check period exists and is currently active
    if (!period) { setErrorPopup({ type: 'notActive' }); return }
    const now = new Date()
    const t = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0')
    const active = t >= period.startTime && t < period.endTime
    if (!active) { setErrorPopup({ type: 'notActive' }); return }
    // Check capacity only when checking OUT (not checking back in)
    if (!isOut && outSet.size >= maxOut) { setErrorPopup({ type: 'maxOut' }); return }
    // Store everything in ref right now, before any state changes
    swipeRef.current = { name, action: isOut ? 'in' : 'out', period, day, start, outTimes }
    setSwipeName(name)
    setSwipeAction(isOut ? 'in' : 'out')
    setSwipeProgress(0)
    setScreen('swipe')
  }

  const commitSwipe = useCallback(async () => {
    // Read from ref — guaranteed fresh, no stale closure possible
    const { name, action, period: p, day: d, start: s, outTimes: ot } = swipeRef.current
    if (!p || !name) return
    isDragging.current = false

    const now = Date.now()
    const today = new Date().toISOString().split('T')[0]

    if (action === 'out') {
      await writeStudentOut({ day: d, start: s, name, period: p.name, outTime: now, date: today })
      setOutSet(prev => new Set([...prev, name]))
      setOutTimes(prev => ({ ...prev, [name]: now }))
      setSwipeProgress(0)
      setScreen('main')
    } else {
      const outStart = ot[name] ?? now
      const duration = now - outStart
      await writeStudentIn({ day: d, start: s, name, period: p.name, outStart, inTime: now, date: today })
      setOutSet(prev => { const n = new Set(prev); n.delete(name); return n })
      setOutTimes(prev => { const n = { ...prev }; delete n[name]; return n })
      setWelcomeName(name)
      setWelcomeTime(fmt(duration))
      setSwipeProgress(0)
      setScreen('welcome')
      setTimeout(() => setScreen('main'), 3500)
    }
  }, [])

  // Pointer events — work on both mouse and touch, no separate handlers needed
  const onPointerDown = (e: React.PointerEvent) => {
    isDragging.current = true;
    dragStartX.current = e.clientX;
    (e.target as HTMLElement).setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current || !trackRef.current) return
    const maxX = trackRef.current.offsetWidth - 60
    const x = Math.max(0, Math.min(e.clientX - dragStartX.current, maxX))
    const pct = x / maxX
    setSwipeProgress(pct)
    if (pct >= 0.95) commitSwipe()
    e.preventDefault()
  }

  const onPointerUp = () => {
    if (!isDragging.current) return
    isDragging.current = false
    setSwipeProgress(p => p < 0.95 ? 0 : p)
  }

  void tick
  const isCheckingOut = swipeAction === 'out'
  const accent = isCheckingOut ? C.red : C.green
  const accentBg = isCheckingOut ? C.redBg : C.greenBg
  const thumbSize = isIPadLandscape ? 48 : 44
  const thumbLeft = swipeProgress === 0 ? '4px' : `calc(4px + ${swipeProgress} * (100% - ${thumbSize + 8}px))`

  // Local clock — updates every second via tick
  const clockTime = (() => {
    const now = new Date()
    const h = now.getHours() % 12 || 12
    const m = now.getMinutes().toString().padStart(2, '0')
    const ampm = now.getHours() >= 12 ? 'PM' : 'AM'
    return { hm: `${h}:${m}`, ampm }
  })()

  // Period countdown — only when period is active
  const periodCountdown = (() => {
    if (!period) return null
    const now = new Date()
    const t = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0')
    if (t < period.startTime || t >= period.endTime) return null
    const [eh, em] = period.endTime.split(':').map(Number)
    const endMs = (eh * 60 + em) * 60 * 1000
    const nowMs = (now.getHours() * 60 + now.getMinutes()) * 60 * 1000 + now.getSeconds() * 1000
    const remaining = endMs - nowMs
    if (remaining <= 0) return null
    const totalMins = Math.floor(remaining / 60000)
    const h = Math.floor(totalMins / 60)
    const m = totalMins % 60
    const s = Math.floor((remaining % 60000) / 1000)
    return h > 0
      ? `${h}h ${m}m`
      : m > 0
        ? `${m}:${String(s).padStart(2,'0')}`
        : `0:${String(s).padStart(2,'0')}`
  })()

  return (
    <div style={{ minHeight: '100vh', height: '100vh', background: C.bg, display: 'flex', flexDirection: 'column', fontFamily: "'IBM Plex Sans', sans-serif", overflow: 'hidden' }}>

      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <div style={{ background: C.white, borderBottom: `1px solid ${C.border}`, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>

        {/* Left: class name as title, period label + times below */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {period ? (
            <>
              <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: '2.15rem', color: C.ink, margin: 0, lineHeight: 1.1 }}>
                {rosterEntry?.name || 'Unnamed Class'}
              </h1>
              <span style={{ fontSize: 17, fontWeight: 600, color: C.muted, lineHeight: 1.3 }}>
                {period.name.replace(/([A-Za-z]+)(\d+)/, '$1 $2')} &nbsp;·&nbsp; {fmt12(period.startTime)} – {fmt12(period.endTime)}
              </span>
            </>
          ) : (
            <>
              <h1 style={{ fontFamily: "'Fraunces', serif", fontSize: '2.15rem', color: C.ink, margin: 0 }}>Hall Pass</h1>
              <span style={{ fontSize: 17, color: C.muted }}>No period selected</span>
            </>
          )}
        </div>

        {/* Center clock — shown on all layouts except iPad landscape */}
        {!isIPadLandscape && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '2.88rem', fontWeight: 600, color: C.ink }}>{clockTime.hm}</span>
            <span style={{ fontSize: 19, fontWeight: 600, color: C.muted }}>{clockTime.ampm}</span>
          </div>
        )}

        {/* Right: settings only — counter is hidden below grid */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => { setPickDay(day); setPickStart(start); setPickPeriod(periodName || SCHEDULES[day][start][0]?.name || ''); setPickMaxOut(maxOut); setScreen('settings') }}
            style={{ background: C.cloud, border: `1px solid ${C.border}`, borderRadius: 8, padding: '6px 12px', fontSize: 16, color: C.slate, display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            Schedule
          </button>
        </div>
      </div>

      {/* ── Main content ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Left: student grid */}
        <div style={{ flex: 1, overflowY: 'auto', padding: isIPadLandscape ? '16px 20px' : '12px 14px' }}>
          {!period ? (
            <p style={{ textAlign: 'center', padding: '2rem', color: C.slate, fontSize: 14 }}>No period selected. Tap Schedule.</p>
          ) : (
            <>
              {/* Capacity dots — top of grid near where checked-out students appear */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                {Array.from({length: maxOut}, (_, i) => (
                  <span key={i} style={{ width: isIPadLandscape ? 10 : 8, height: isIPadLandscape ? 10 : 8, borderRadius: '50%', background: i < outSet.size ? C.red : C.border, display: 'inline-block', transition: 'background 0.2s' }} />
                ))}
                {outSet.size > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 600, color: C.red, marginLeft: 2 }}>{outSet.size}/{maxOut}</span>
                )}
              </div>

              {/* Students Out */}
              {outSet.size > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.red, textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: 8 }}>Students Out</div>
                  <div style={{ display: 'grid', gridTemplateColumns: isIPadLandscape ? 'repeat(5, 1fr)' : isLargerThanIPad ? 'repeat(6, 1fr)' : 'repeat(3, 1fr)', gap: isIPadLandscape ? 10 : isLargerThanIPad ? 10 : 8 }}>
                    {periodStudents.filter(n => outSet.has(n)).map(name => {
                      const elapsed = Date.now() - (outTimes[name] ?? Date.now())
                      return (
                        <button key={name} onClick={() => openSwipe(name)}
                          style={{ border: `1.5px solid ${C.redBorder}`, background: C.redBg, borderRadius: 10, padding: isLargerThanIPad ? '20px 10px' : isIPadLandscape ? '12px 8px' : '10px 6px', textAlign: 'center', cursor: 'pointer' }}
                          onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.94)')}
                          onMouseUp={e => (e.currentTarget.style.transform = '')}
                          onMouseLeave={e => (e.currentTarget.style.transform = '')}
                        >
                          <div style={{ fontSize: isLargerThanIPad ? 16 : isIPadLandscape ? 15 : 12, fontWeight: 600, color: '#b91c1c', marginBottom: 4 }}>{name}</div>
                          <div style={{ fontSize: isLargerThanIPad ? 15 : isIPadLandscape ? 14 : 12, fontWeight: 700, color: C.red, fontVariantNumeric: 'tabular-nums' }}>{fmt(elapsed)}</div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* In Class */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: 8 }}>Tap your name</div>
                <div style={{ display: 'grid', gridTemplateColumns: isIPadLandscape ? 'repeat(5, 1fr)' : isLargerThanIPad ? 'repeat(6, 1fr)' : 'repeat(3, 1fr)', gap: isIPadLandscape ? 10 : isLargerThanIPad ? 10 : 8 }}>
                  {periodStudents.filter(n => !outSet.has(n)).map(name => (
                    <button key={name} onClick={() => openSwipe(name)}
                      style={{ border: `1px solid ${C.border}`, background: C.white, borderRadius: 10, padding: isLargerThanIPad ? '20px 10px' : isIPadLandscape ? '12px 8px' : '10px 6px', textAlign: 'center', cursor: 'pointer' }}
                      onMouseDown={e => (e.currentTarget.style.transform = 'scale(0.94)')}
                      onMouseUp={e => (e.currentTarget.style.transform = '')}
                      onMouseLeave={e => (e.currentTarget.style.transform = '')}
                    >
                      <div style={{ fontSize: isLargerThanIPad ? 16 : isIPadLandscape ? 15 : 12, fontWeight: 600, color: C.ink }}>{name}</div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

        </div>

        {/* Right: big clock panel — iPad landscape only */}
        {isIPadLandscape && !isLargerThanIPad && (
          <div style={{ width: 200, background: C.ink, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', paddingTop: 16, gap: 4, flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,0.08)' }}>
            {/* Current time */}
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '4.5rem', fontWeight: 700, color: '#fff', letterSpacing: '-3px', lineHeight: 1 }}>
              {clockTime.hm}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'rgba(255,255,255,0.5)' }}>
              {clockTime.ampm}
            </div>
            {/* Countdown — only when period is active */}
            {periodCountdown && (
              <div style={{ marginTop: 12, textAlign: 'center', padding: '0 16px' }}>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 6 }}>Time remaining</div>
                <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: '1.75rem', fontWeight: 700, color: 'rgba(255,255,255,0.85)', letterSpacing: '-1px' }}>
                  {periodCountdown}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Swipe overlay */}
      {screen === 'swipe' && (
        <Overlay>
          <div style={{ background: C.white, borderRadius: 20, padding: isIPadLandscape ? '32px 32px 28px' : '28px 24px 24px', width: isIPadLandscape ? 420 : 300, textAlign: 'center' }}>
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: accentBg, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
              <svg width="26" height="26" fill="none" stroke={accent} viewBox="0 0 24 24">
                {isCheckingOut
                  ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
                }
              </svg>
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 4 }}>{isCheckingOut ? 'Checking out' : 'Checking back in'}</div>
            <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "'Fraunces', serif", color: C.ink, marginBottom: 24 }}>{swipeName}</div>

            {/* Swipe track — pointer events handle both mouse and touch */}
            <div ref={trackRef} style={{ position: 'relative', height: isIPadLandscape ? 64 : 56, background: C.cloud, borderRadius: isIPadLandscape ? 32 : 28, border: `1px solid ${C.border}`, marginBottom: 16, touchAction: 'none' }}>
              <div style={{ position: 'absolute', inset: 0, background: accentBg, width: `${swipeProgress * 100}%`, borderRadius: 28, pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                <span style={{ fontSize: 13, color: C.slate, opacity: swipeProgress > 0.15 ? 0 : 1, transition: 'opacity 0.15s' }}>Swipe to confirm →</span>
              </div>
              <div
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                style={{ position: 'absolute', top: '50%', transform: 'translateY(-50%)', left: thumbLeft, width: isIPadLandscape ? 48 : 44, height: isIPadLandscape ? 48 : 44, borderRadius: '50%', background: accent, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab', touchAction: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.2)', transition: swipeProgress === 0 ? 'left 0.25s' : 'none' }}
              >
                <svg width="22" height="22" fill="none" stroke="white" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" /></svg>
              </div>
            </div>

            <button onClick={() => { isDragging.current = false; setSwipeProgress(0); setScreen('main') }} style={{ width: '100%', padding: 10, border: `1px solid ${C.border}`, borderRadius: 8, background: 'transparent', color: C.slate, fontSize: 14 }}>
              Cancel
            </button>
          </div>
        </Overlay>
      )}

      {/* Welcome back */}
      {screen === 'welcome' && (
        <Overlay>
          <div onClick={() => setScreen('main')} style={{ background: C.white, borderRadius: 20, padding: isIPadLandscape ? '40px 36px' : '28px 24px', width: isIPadLandscape ? 360 : 280, textAlign: 'center', cursor: 'pointer' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: C.greenBg, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
              <svg width="28" height="28" fill="none" stroke={C.green} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
            </div>
            <div style={{ fontSize: isIPadLandscape ? 24 : 18, fontWeight: 700, fontFamily: "'Fraunces', serif", color: C.ink, marginBottom: 4 }}>Welcome back!</div>
            <div style={{ fontSize: 14, color: C.slate, marginBottom: 12 }}>{welcomeName}</div>
            <div style={{ fontSize: 12, color: C.slate, marginBottom: 4 }}>Trip time</div>
            <div style={{ fontSize: isIPadLandscape ? 56 : 42, fontWeight: 700, fontFamily: "'Fraunces', serif", color: C.ink, marginBottom: 20, fontVariantNumeric: 'tabular-nums' }}>{welcomeTime}</div>
            <WelcomeBar />
          </div>
        </Overlay>
      )}

      {/* Settings */}
      {screen === 'settings' && (
        <Overlay>
          <div style={{ background: C.white, borderRadius: 16, padding: '24px', width: isIPadLandscape ? 420 : 340, maxHeight: '65vh', overflowY: 'auto' }}>


            <div style={{ fontSize: 11, fontWeight: 700, color: C.slate, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 8 }}>Day</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {(['red','black'] as ScheduleDay[]).map(d => (
                <button key={d} onClick={() => setPickDay(d)} style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: pickDay === d ? `2px solid ${d === 'red' ? C.red : C.ink}` : `1px solid ${C.border}`, background: pickDay === d ? (d === 'red' ? C.redBg : '#f1f5f9') : C.white, color: pickDay === d ? (d === 'red' ? '#b91c1c' : C.ink) : C.slate, fontWeight: pickDay === d ? 700 : 400, fontSize: 15 }}>{d === 'red' ? 'Red Day' : 'Black Day'}</button>
              ))}
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: C.slate, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 8 }}>Start</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              {(['regular','late'] as StartType[]).map(s => (
                <button key={s} onClick={() => setPickStart(s)} style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: pickStart === s ? `2px solid ${C.green}` : `1px solid ${C.border}`, background: pickStart === s ? C.greenBg : C.white, color: pickStart === s ? '#065f46' : C.slate, fontWeight: pickStart === s ? 700 : 400, fontSize: 15 }}>{s === 'regular' ? 'Regular' : 'Late Start'}</button>
              ))}
            </div>

            <div style={{ fontSize: 11, fontWeight: 700, color: C.slate, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 8 }}>Period</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 24 }}>
              {SCHEDULES[pickDay][pickStart].filter(p => {
                const num = p.name.match(/\d+/)?.[0] ?? ''
                const rKey = `${pickDay}_${num}`
                return roster[rKey]?.name?.trim()
              }).map(p => {
                const pNum = p.name.match(/\d+/)?.[0] ?? ''
                const pDay = pickDay === 'red' ? 'Red' : 'Black'
                const periodLabel = `${pDay} ${pNum}`
                const rKey = `${pickDay}_${pNum}`
                const className = roster[rKey]?.name || p.name.replace(/^[^-]+-/, '')
                return (
                  <button key={p.name} onClick={() => setPickPeriod(p.name)}
                    style={{ padding: '10px 14px', borderRadius: 8, border: pickPeriod === p.name ? `2px solid ${C.primary}` : `1px solid ${C.border}`, background: pickPeriod === p.name ? 'rgba(102,126,234,0.08)' : C.white, color: pickPeriod === p.name ? C.primary : C.ink, fontSize: 14, fontWeight: pickPeriod === p.name ? 700 : 400, textAlign: 'left', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>{className}</span>
                    <span style={{ color: pickPeriod === p.name ? C.primary : C.muted, fontWeight: 400, fontSize: 12 }}>{periodLabel}</span>
                  </button>
                )
              })}
            </div>

            <button onClick={() => {
              // No PIN — period/day/start changes are free
              setDay(pickDay); setStart(pickStart); setPeriodName(pickPeriod)
              localStorage.setItem('hp_day', pickDay); localStorage.setItem('hp_start', pickStart); localStorage.setItem('hp_period', pickPeriod)
              setScreen('main')
            }} style={{ width: '100%', padding: 12, borderRadius: 10, border: 'none', background: C.ink, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', marginBottom: 10 }}>
              Confirm
            </button>
            <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
              <button onClick={() => setScreen('main')} style={{ flex: 1, padding: 9, borderRadius: 8, border: `1px solid ${C.border}`, background: C.cloud, color: C.slate, fontSize: 14 }}>Cancel</button>
              <button onClick={() => { setPinTarget('home'); setPinDigits(['','','','']); setPinError(false) }} style={{ flex: 1, padding: 9, borderRadius: 8, background: C.ink, color: '#fff', fontSize: 14, fontWeight: 600, border: 'none', cursor: 'pointer' }}>Home</button>
            </div>

            {/* Max Students — below the fold, scroll to reveal */}
            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 20, marginTop: 24 }}>
              <div style={{ fontSize: 10, color: C.muted, textAlign: 'center', marginBottom: 16 }}>
                Admin settings
              </div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: 8 }}>Max Students Out</div>
              <select
                value={pickMaxOut}
                onChange={e => setPickMaxOut(parseInt(e.target.value))}
                style={{ width: '100%', padding: '10px 14px', borderRadius: 8, border: `1px solid ${C.border}`, fontSize: 15, color: C.ink, fontFamily: 'inherit', background: C.white, cursor: 'pointer', appearance: 'none', backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23475569' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center' }}
              >
                {[2,3,4,5,6,7,8].map(n => (
                  <option key={n} value={n}>{n} students</option>
                ))}
              </select>
              <button onClick={() => {
                if (pickMaxOut !== maxOut) {
                  setPinTarget('confirm'); setPinDigits(['','','','']); setPinError(false)
                }
              }} disabled={pickMaxOut === maxOut}
                style={{ width: '100%', marginTop: 10, padding: '9px 0', borderRadius: 8, border: 'none', background: pickMaxOut !== maxOut ? '#667eea' : C.cloud, color: pickMaxOut !== maxOut ? '#fff' : C.muted, fontSize: 14, fontWeight: 600, cursor: pickMaxOut !== maxOut ? 'pointer' : 'default' }}>
                {pickMaxOut === maxOut ? 'No change' : 'Apply change (PIN required)'}
              </button>
            </div>
          </div>
        </Overlay>
      )}

      {/* ── Error popups ────────────────────────────────────────────────────── */}
      {errorPopup?.type === 'maxOut' && (
        <Overlay>
          <div style={{ background: C.white, borderRadius: 16, padding: '28px 24px', width: isIPadLandscape ? 380 : 320, textAlign: 'center' }}>
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: C.redBg, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <svg width="26" height="26" fill="none" stroke={C.red} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
            </div>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.3rem', color: C.ink, margin: '0 0 10px' }}>Class is at capacity</h2>
            <p style={{ fontSize: 14, color: C.slate, margin: '0 0 24px', lineHeight: 1.6 }}>
              The maximum number of students is already out. Please wait for someone to return before leaving.
            </p>
            <button onClick={() => setErrorPopup(null)}
              style={{ width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', background: C.ink, color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
              OK
            </button>
          </div>
        </Overlay>
      )}

      {errorPopup?.type === 'notActive' && (
        <Overlay>
          <div style={{ background: C.white, borderRadius: 16, padding: '28px 24px', width: isIPadLandscape ? 380 : 320, textAlign: 'center' }}>
            <div style={{ width: 52, height: 52, borderRadius: '50%', background: 'rgba(245,158,11,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <svg width="26" height="26" fill="none" stroke="#f59e0b" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            </div>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.3rem', color: C.ink, margin: '0 0 10px' }}>No active period</h2>
            <p style={{ fontSize: 14, color: C.slate, margin: '0 0 24px', lineHeight: 1.6 }}>
              The current period is not active. Check the schedule settings to make sure the right period is selected.
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => setErrorPopup(null)}
                style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: `1px solid ${C.border}`, background: C.cloud, color: C.slate, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Dismiss
              </button>
              <button onClick={() => { setErrorPopup(null); setPickDay(day); setPickStart(start); setPickPeriod(periodName || SCHEDULES[day][start][0]?.name || ''); setScreen('settings') }}
                style={{ flex: 1, padding: '12px 0', borderRadius: 10, border: 'none', background: C.ink, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Change Schedule
              </button>
            </div>
          </div>
        </Overlay>
      )}

      {/* PIN modal — for home nav and maxOut changes */}
      {pinTarget !== null && (
        <Overlay>
          <div style={{ background: C.white, borderRadius: 16, padding: '28px 24px', width: 300, textAlign: 'center' }}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.4rem', color: C.ink, marginBottom: 8 }}>Enter PIN</h2>
            <p style={{ fontSize: 13, color: C.slate, marginBottom: 20 }}>
              {pinTarget === 'home' ? 'PIN required to return home' : 'PIN required to change student limit'}
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 16 }}>
              {pinDigits.map((d, i) => (
                <input key={i} id={`pin-${i}`} type="password" inputMode="numeric" maxLength={1} value={d}
                  autoFocus={i === 0}
                  onChange={e => {
                    const val = e.target.value.slice(-1).replace(/[^0-9]/g, '')
                    const next = [...pinDigits]; next[i] = val; setPinDigits(next); setPinError(false)
                    if (val && i < 3) document.getElementById(`pin-${i+1}`)?.focus()
                    if (val && i === 3) {
                      const full = [...pinDigits.slice(0,3), val].join('')
                      if (full === ADMIN_PIN) {
                        setPinTarget(null)
                        if (pinTarget === 'home') {
                          setScreen('main'); navigate('/')
                        } else {
                          setMaxOut(pickMaxOut)
                          localStorage.setItem('hp_maxOut', String(pickMaxOut))
                          setScreen('main')
                        }
                      } else {
                        setPinError(true); setPinDigits(['','','',''])
                        setTimeout(() => document.getElementById('pin-0')?.focus(), 50)
                      }
                    }
                  }}
                  onKeyDown={e => { if (e.key === 'Backspace' && !pinDigits[i] && i > 0) document.getElementById(`pin-${i-1}`)?.focus() }}
                  style={{ width: 52, height: 60, fontSize: '1.5rem', textAlign: 'center', border: `2px solid ${pinError ? C.red : C.border}`, borderRadius: 10, fontFamily: 'monospace', outline: 'none', color: C.ink, background: pinError ? C.redBg : C.white }}
                />
              ))}
            </div>
            {pinError && <p style={{ color: C.red, fontSize: 13, marginBottom: 12 }}>Incorrect PIN</p>}
            <button onClick={() => { setPinTarget(null); setPinDigits(['','','','']); setPinError(false) }}
              style={{ width: '100%', padding: 9, borderRadius: 8, border: `1px solid ${C.border}`, background: C.cloud, color: C.slate, fontSize: 14, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </Overlay>
      )}

      {/* First run — pick day */}
      {screen === 'firstRun' && (
        <Overlay>
          <div style={{ background: C.white, borderRadius: 16, padding: '28px 24px', width: 300, textAlign: 'center' }}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.5rem', color: C.ink, marginBottom: 8 }}>Select Day</h2>
            <p style={{ fontSize: 13, color: C.slate, marginBottom: 24 }}>Which schedule is active today?</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(['red','black'] as ScheduleDay[]).map(d => (
                <button key={d} onClick={() => { setPickDay(d); setScreen('pickStart') }} style={{ padding: 12, borderRadius: 10, border: `1.5px solid ${d === 'red' ? C.red : C.ink}`, background: d === 'red' ? C.redBg : C.cloud, color: d === 'red' ? '#b91c1c' : C.ink, fontSize: 15, fontWeight: 600 }}>{d === 'red' ? 'Red Day' : 'Black Day'}</button>
              ))}
            </div>
          </div>
        </Overlay>
      )}

      {/* First run — pick start */}
      {screen === 'pickStart' && (
        <Overlay>
          <div style={{ background: C.white, borderRadius: 16, padding: '28px 24px', width: 300, textAlign: 'center' }}>
            <h2 style={{ fontFamily: "'Fraunces', serif", fontSize: '1.5rem', color: C.ink, marginBottom: 8 }}>Start Time</h2>
            <p style={{ fontSize: 13, color: C.slate, marginBottom: 24 }}>{pickDay === 'red' ? 'Red' : 'Black'} Day</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
              {(['regular','late'] as StartType[]).map(s => (
                <button key={s} onClick={() => applySchedule(pickDay, s)} style={{ padding: 12, borderRadius: 10, border: `1.5px solid ${C.green}`, background: C.greenBg, color: '#065f46', fontSize: 15, fontWeight: 600 }}>{s === 'regular' ? 'Regular Start' : 'Late Start'}</button>
              ))}
            </div>
            <button onClick={() => setScreen('firstRun')} style={{ padding: 9, border: `1px solid ${C.border}`, borderRadius: 8, background: C.cloud, color: C.slate, fontSize: 14, width: '100%' }}>← Back</button>
          </div>
        </Overlay>
      )}
    </div>
  )
}
