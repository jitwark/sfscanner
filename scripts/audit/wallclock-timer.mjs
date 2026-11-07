import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const STATE_FILE = resolve('pipeline/.work/wallclock-timer-state.json');
const TARGET_HOUR = 6;
const TARGET_MINUTE = 30;

function getNow() {
  return new Date();
}

function formatTime(d) {
  return d.toTimeString().split(' ')[0];
}

function loadState() {
  if (existsSync(STATE_FILE)) {
    try {
      return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    } catch {
      // fallback
    }
  }
  return {
    startTime: getNow().toISOString(),
    intervalsCompleted: 0,
    target: '06:30:00',
    status: 'ACTIVE',
  };
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function run() {
  const state = loadState();
  const now = getNow();
  
  // Calculate target date (today at 06:30 AM)
  const targetDate = new Date(now);
  targetDate.setHours(TARGET_HOUR, TARGET_MINUTE, 0, 0);
  if (now > targetDate) {
    // If it's already past 06:30 AM, the deadline has passed
    console.log(`[WALLCLOCK STOP] Target 06:30 AM has arrived or passed! Current time: ${formatTime(now)}`);
    state.status = 'STOP_REACHED';
    saveState(state);
    process.exit(0);
  }

  const msRemaining = targetDate.getTime() - now.getTime();
  const intervalMs = Math.min(30 * 60 * 1000, msRemaining);
  const minutesToWait = Math.round(intervalMs / 60000);

  console.log(`[WALLCLOCK TIMER] Started at ${formatTime(now)}. Sleeping for ${minutesToWait} minutes until next ping.`);
  console.log(`[WALLCLOCK TIMER] Target stop deadline: 06:30 AM (approx ${(msRemaining / 3600000).toFixed(2)} hours remaining).`);

  await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));

  const wakeTime = getNow();
  state.intervalsCompleted += 1;
  const remainingAfterWake = targetDate.getTime() - wakeTime.getTime();

  if (remainingAfterWake <= 60000) {
    state.status = 'STOP_REACHED';
    saveState(state);
    console.log(`================================================================`);
    console.log(`[WALLCLOCK STOP] 06:30 AM DEADLINE REACHED at ${formatTime(wakeTime)}!`);
    console.log(`PAUSE ALL IMPLEMENTATION WORK IMMEDIATELY.`);
    console.log(`================================================================`);
  } else {
    saveState(state);
    console.log(`================================================================`);
    console.log(`[WALLCLOCK PING] 30-Minute Interval #${state.intervalsCompleted} Fired.`);
    console.log(`Current Time: ${formatTime(wakeTime)}`);
    console.log(`Time Remaining until 06:30 AM: ${(remainingAfterWake / 3600000).toFixed(2)} hours (${Math.round(remainingAfterWake / 60000)} mins).`);
    console.log(`Status: ACTIVE. Safe to continue implementation.`);
    console.log(`================================================================`);
  }
}

run().catch((err) => {
  console.error('[WALLCLOCK ERROR]', err);
  process.exit(1);
});
