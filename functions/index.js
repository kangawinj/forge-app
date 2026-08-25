const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { buildIcsFeed } = require('./ics');

initializeApp();

// Set once via `firebase functions:secrets:set FEED_SECRET`, never
// committed -- every subscription URL handed out must include
// ?key=<this value>, since project data (who's working on what, and
// when) isn't meant to be guessable/public just because someone finds
// the URL shape. Not scoped per person: everyone already sees
// everyone else's Activities Updates inside the app itself (Task
// Tracking has no per-user data isolation today), so one shared secret
// matches the trust model already in place rather than adding a
// separate one.
const FEED_SECRET = defineSecret('FEED_SECRET');

// Same summary-line composition as muPlanSummaryLine in projects.js
// (What before Where, time/who prefixed). Duplicated rather than
// shared -- app.js/projects.js are browser ES modules (DOM and the
// Firebase client SDK throughout) that can't be require()'d into a
// Cloud Function's plain CommonJS runtime without a bundler this
// project otherwise has none of. Keep this in sync by hand if that
// function's composition ever changes.
function planSummaryLine(mu){
  const parts = [];
  if(mu.time) parts.push(mu.time);
  if(mu.planWho) parts.push(mu.planWho);
  if(mu.plan) parts.push(mu.plan);
  if(mu.planWhere) parts.push(`@ ${mu.planWhere}`);
  return parts.join(' · ');
}

// Keeps the feed from accumulating years of completed history -- 30
// days back is enough to still show anything recently overdue, with no
// cap looking forward (calendar apps handle far-future entries fine).
const LOOKBACK_DAYS = 30;
function cutoffDateStr(now){
  const d = new Date(now);
  d.setDate(d.getDate() - LOOKBACK_DAYS);
  return d.toISOString().slice(0, 10);
}

// GET /calendarFeed?who=<name>&key=<FEED_SECRET> -- an iCalendar feed of
// that person's Activities Update plans (matched against the Who field,
// case-insensitively), for subscribing from iPhone/Mac/Google
// Calendar/Outlook's own "Add Subscription Calendar" -- see
// buildIcsFeed in ics.js for the actual VEVENT construction, and
// computeCalendarEvents in app.js for the in-app Activities Calendar
// this is meant to mirror.
exports.calendarFeed = onRequest({ region: 'asia-southeast1', secrets: [FEED_SECRET] }, async (req, res) => {
  const who = (req.query.who || '').toString().trim();
  const key = (req.query.key || '').toString();
  if(key !== FEED_SECRET.value()){
    res.status(403).send('Forbidden');
    return;
  }
  if(!who){
    res.status(400).send('Missing ?who=<name> -- this feed is per person, matching the Who field on an Activities Update.');
    return;
  }

  const db = getFirestore();
  const snap = await db.collection('projects').get();
  const since = cutoffDateStr(new Date());
  const events = [];
  snap.forEach(doc => {
    const p = doc.data();
    const projectName = p.name || 'Untitled project';
    (p.monthlyUpdates || []).forEach(mu => {
      if(!mu.date || mu.date < since) return;
      if((mu.planWho || '').trim().toLowerCase() !== who.toLowerCase()) return;
      events.push({
        date: mu.date,
        projectName,
        text: planSummaryLine(mu) || mu.actionTaken || 'Untitled task',
        mu
      });
    });
  });

  const ics = buildIcsFeed(events, `Forge — ${who}`);
  res.set('Content-Type', 'text/calendar; charset=utf-8');
  // Matches the REFRESH-INTERVAL hint in the feed itself (see ics.js) --
  // no reason for an app that ignores that hint to re-fetch more often
  // than this either.
  res.set('Cache-Control', 'public, max-age=1800');
  res.send(ics);
});
