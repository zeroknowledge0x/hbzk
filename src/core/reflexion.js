// Reflexion scratchpad.
//
// Tier 1 of the playbook ladder: after a failed attempt the agent writes one short verbal
// lesson and carries it into the next attempt. Nothing here persists past the run — a lesson
// only becomes permanent through the verified playbook.

export const MAX_ITERATIONS = 4;

export function createScratch(patch = {}) {
  return { task: null, attempts: 0, lessons: [], ...patch };
}

export function openTask(scratch, task) {
  const t = String(task || '');
  if (scratch.task === t) return scratch;
  return { ...createScratch(), task: t };
}

export function noteFailure(scratch, { step = '', error = '', at = Date.now() } = {}) {
  const lesson = `"${String(step || 'step').slice(0, 40)}" failed: ${String(error || 'unknown').slice(0, 60)}`;
  return {
    ...scratch,
    attempts: scratch.attempts + 1,
    lessons: [...scratch.lessons, { lesson, at }].slice(-5),
  };
}

export function noteSuccess(scratch) {
  return { ...createScratch(), task: scratch.task };
}

// The lesson text that goes back into the prompt on the retry, or '' when there is room left
// and nothing learned yet.
export function retryContext(scratch) {
  if (!scratch.lessons.length) return '';
  const last = scratch.lessons[scratch.lessons.length - 1].lesson;
  return scratch.attempts >= MAX_ITERATIONS ? `GIVE UP on this one, it keeps failing: ${last}` : `Last attempt: ${last}`;
}

export function exhausted(scratch) {
  return scratch.attempts >= MAX_ITERATIONS;
}

export function scratchLine(scratch) {
  if (!scratch.task) return 'REFLEXION idle';
  return `REFLEXION ${scratch.task.slice(0, 40)} · attempts ${scratch.attempts}/${MAX_ITERATIONS}${scratch.lessons.length ? ` · ${scratch.lessons[scratch.lessons.length - 1].lesson.slice(0, 80)}` : ''}`;
}
