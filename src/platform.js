// OS-specific bits (Windows fixes live here).
const { spawn } = require('child_process');

// The unelevated Windows sandbox cannot launch the Microsoft Store pwsh alias (CreateProcessAsUserW: access
// denied), so Codex children get a PATH without WindowsApps and fall back to Windows PowerShell.
function codexEnv() {
  if (process.platform !== 'win32') return process.env;
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  if (key) env[key] = env[key].split(';').filter((p) => !/\\WindowsApps\\?$/i.test(p)).join(';');
  return env;
}

// Kill a CLI child and everything it spawned (Windows: taskkill /T /F; elsewhere SIGTERM).
function killTree(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
}

module.exports = { codexEnv, killTree };
