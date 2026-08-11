/**
 * Business hours, and the one question the agent has to get right: is a human
 * reachable right now, or is this an after-hours call?
 *
 * No date library. `Intl.DateTimeFormat` with an explicit `timeZone` is the only
 * correct way to ask "what time is it in Kenosha" from a process running in UTC,
 * and it is built in. Doing this with UTC offset arithmetic is wrong twice a year
 * and the failure -- routing a 2am emergency to "we'll call you tomorrow" -- is
 * invisible until a customer complains.
 */

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** Minutes from midnight, local to the site's timezone. */
export interface DayWindow {
  /** "08:00" */
  open: string
  /** "17:00". Must be after `open`; overnight windows are not modelled. */
  close: string
}

/**
 * A missing or null day means CLOSED.
 *
 * Deliberately not "open 24h" -- the safe default for an unconfigured site is to
 * treat the call as after-hours and escalate by the after-hours path, which ends
 * with a human. Defaulting to "open" would have the agent promise a same-day
 * visit that nobody is scheduled to make.
 */
export type WeeklyHours = Partial<Record<Weekday, DayWindow | null>>

export interface LocalNow {
  weekday: Weekday
  /** Minutes from local midnight. */
  minutes: number
  /** 0-23, local. */
  hour: number
  /** "14:32" */
  clock: string
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseClock(value: string): number | null {
  const m = HHMM.exec(value.trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export function formatClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Speakable: "8 AM", "5:30 PM". TTS reads "17:00" as "seventeen hundred". */
export function speakClock(value: string): string {
  const total = parseClock(value)
  if (total === null) return value
  const h24 = Math.floor(total / 60)
  const mins = total % 60
  const suffix = h24 < 12 ? 'AM' : 'PM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return mins === 0 ? `${h12} ${suffix}` : `${h12}:${String(mins).padStart(2, '0')} ${suffix}`
}

/**
 * What time it is at the site.
 *
 * Returns null when the timezone string is not one the runtime knows. Null is
 * propagated rather than defaulted to UTC: a site whose timezone is typo'd must
 * read as "hours unknown", not as "it is currently 3pm in Greenwich".
 */
export function localNow(timezone: string, at: Date = new Date()): LocalNow | null {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at)
  } catch {
    return null
  }

  const get = (t: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === t)?.value ?? ''

  const weekday = get('weekday').slice(0, 3).toLowerCase() as Weekday
  if (!WEEKDAYS.includes(weekday)) return null

  // hour12:false yields "24" for midnight in some ICU versions.
  const hour = Number(get('hour')) % 24
  const minute = Number(get('minute'))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null

  return { weekday, minutes: hour * 60 + minute, hour, clock: formatClock(hour * 60 + minute) }
}

export type OpenState = 'open' | 'closed' | 'unknown'

/**
 * `unknown` is a real answer and must stay distinct from `closed`.
 *
 * No hours configured is not the same fact as "closed right now", and the agent
 * says different things: one promises a callback in stated hours, the other
 * cannot and must not invent them.
 */
export function openStateAt(
  hours: WeeklyHours | null | undefined,
  timezone: string,
  at: Date = new Date(),
): OpenState {
  if (!hours || Object.keys(hours).length === 0) return 'unknown'
  const now = localNow(timezone, at)
  if (!now) return 'unknown'

  const window = hours[now.weekday]
  if (!window) return 'closed'

  const open = parseClock(window.open)
  const close = parseClock(window.close)
  if (open === null || close === null || close <= open) return 'unknown'

  return now.minutes >= open && now.minutes < close ? 'open' : 'closed'
}

/** "Mon–Fri 8 AM–5 PM, Sat 9 AM–1 PM". Spoken by the agent, so no en dashes. */
export function describeHours(hours: WeeklyHours | null | undefined): string | null {
  if (!hours || Object.keys(hours).length === 0) return null

  const labels: Record<Weekday, string> = {
    sun: 'Sunday',
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
  }

  // Group consecutive days sharing an identical window, so the agent says
  // "Monday through Friday" instead of listing five identical clauses.
  const groups: Array<{ from: Weekday; to: Weekday; window: DayWindow }> = []
  for (const day of WEEKDAYS) {
    const w = hours[day]
    if (!w) continue
    const last = groups[groups.length - 1]
    const contiguous =
      last !== undefined &&
      last.window.open === w.open &&
      last.window.close === w.close &&
      WEEKDAYS.indexOf(day) === WEEKDAYS.indexOf(last.to) + 1
    if (contiguous) last.to = day
    else groups.push({ from: day, to: day, window: w })
  }
  if (groups.length === 0) return null

  return groups
    .map((g) => {
      const span =
        g.from === g.to ? labels[g.from] : `${labels[g.from]} through ${labels[g.to]}`
      return `${span} ${speakClock(g.window.open)} to ${speakClock(g.window.close)}`
    })
    .join(', ')
}

/** Mon–Fri 8–5 plus Sat morning. Used as the create-form default. */
export const DEFAULT_HOURS: WeeklyHours = {
  mon: { open: '08:00', close: '17:00' },
  tue: { open: '08:00', close: '17:00' },
  wed: { open: '08:00', close: '17:00' },
  thu: { open: '08:00', close: '17:00' },
  fri: { open: '08:00', close: '17:00' },
  sat: { open: '09:00', close: '13:00' },
  sun: null,
}
