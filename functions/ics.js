// Pure, dependency-free iCalendar (RFC 5545) building for the per-person
// Activities Calendar feed -- kept separate from index.js so this can be
// unit tested without firebase-admin or firebase-functions in the loop
// at all (see ics.test.js).

// Escapes a text value per RFC 5545 3.3.11 -- backslash, semicolon,
// comma, and newline all need escaping. Long-line folding (75 octets)
// is skipped: every field this feed actually writes (a project name +
// a short Plan line) is realistically short enough in practice that no
// calendar app this was tested against had trouble with an unfolded
// line, and folding wrong is a worse bug than not folding at all.
function escapeIcsText(s){
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function pad2(n){ return String(n).padStart(2, '0'); }

// mu.date/mu.time are entered in Bangkok local time (Asia/Bangkok,
// UTC+7, no DST) -- converted to a real UTC Date here (not string math)
// so DTEND arithmetic below can't get midnight rollover wrong the way
// manually carrying hours/minutes as strings would.
function bangkokLocalToUtcDate(dateStr, timeStr){
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '09:00').split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, 0) - 7 * 60 * 60 * 1000);
}
function formatIcsUtc(date){
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(date.getUTCDate())}T${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}Z`;
}
function icsDateOnly(dateStr){
  return dateStr.replace(/-/g, '');
}
// The day after dateStr, same YYYYMMDD shape -- an all-day VEVENT's
// DTEND is exclusive per RFC 5545, so a one-day event spanning just
// `date` itself needs DTEND set to the following day, not date itself.
function icsDateOnlyNextDay(dateStr){
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}${pad2(next.getUTCMonth() + 1)}${pad2(next.getUTCDate())}`;
}

const EVENT_DURATION_MS = 30 * 60 * 1000;

// One VEVENT per plan entry. Timed (a 30-minute block starting there) if
// mu.time is set, otherwise an all-day event on mu.date -- matches how
// the field is actually used elsewhere in the app (time is optional).
function planEventIcs(ev, nowStamp){
  const uid = `${ev.mu.id}@forge-food-dev.web.app`;
  const summary = escapeIcsText(`${ev.projectName} - ${ev.text}`);
  const description = escapeIcsText(ev.mu.plan || ev.text || '');
  let dtLines;
  if(ev.mu.time){
    const start = bangkokLocalToUtcDate(ev.date, ev.mu.time);
    const end = new Date(start.getTime() + EVENT_DURATION_MS);
    dtLines = `DTSTART:${formatIcsUtc(start)}\r\nDTEND:${formatIcsUtc(end)}`;
  }else{
    dtLines = `DTSTART;VALUE=DATE:${icsDateOnly(ev.date)}\r\nDTEND;VALUE=DATE:${icsDateOnlyNextDay(ev.date)}`;
  }
  return [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${nowStamp}`,
    dtLines,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    'END:VEVENT'
  ].join('\r\n');
}

// events: array of {date, mu, projectName, text} -- the same shape
// computeCalendarEvents() already builds in app.js, so the feed and the
// in-app calendar can never drift into showing different fields for the
// same entry.
function buildIcsFeed(events, calendarName, now){
  const nowStamp = formatIcsUtc(now || new Date());
  const veventsText = events.map(ev => planEventIcs(ev, nowStamp)).join('\r\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Forge//Activities Calendar//EN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT4H'
  ];
  if(veventsText) lines.push(veventsText);
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

module.exports = {
  escapeIcsText, bangkokLocalToUtcDate, formatIcsUtc, icsDateOnly, icsDateOnlyNextDay,
  planEventIcs, buildIcsFeed
};
