// A safety halt means the controller could not prove a round settled and stopped, on purpose.
// The marker file it leaves behind is what keeps the Windows launcher from just restarting the
// process: an unattended box must stop visibly, not loop through the same broken hand all night.
import fs from 'node:fs';
import path from 'node:path';

export function safetyHaltPath(cwd = process.cwd()) {
  return path.join(cwd, 'data', 'safety-halt.json');
}

export function readSafetyHalt(cwd = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(safetyHaltPath(cwd), 'utf8'));
    if (!raw || !raw.reason) return null;
    return { reason: String(raw.reason), at: raw.at || null };
  } catch {
    return null;
  }
}

export function writeSafetyHalt(reason, cwd = process.cwd()) {
  const file = safetyHaltPath(cwd);
  const at = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ reason: String(reason), at }, null, 2));
  } catch {
    return null;
  }
  return { reason: String(reason), at };
}

export function clearSafetyHalt(cwd = process.cwd()) {
  try { fs.rmSync(safetyHaltPath(cwd), { force: true }); } catch { /* nothing to clear */ }
  return !readSafetyHalt(cwd);
}
