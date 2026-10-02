import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const label = 'ai.serp-scout.hht-engine-semrush-sync'
const launchAgents = join(homedir(), 'Library/LaunchAgents')
const configDir = join(homedir(), '.config/serp-scout')
const plist = join(launchAgents, `${label}.plist`)
const cursorDb = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')
const pnpm = execFileSync('which', ['pnpm'], { encoding: 'utf8' }).trim()
const repo = resolve('.')
mkdirSync(launchAgents, { recursive: true })
mkdirSync(configDir, { recursive: true })
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${pnpm}</string>
    <string>engine</string>
    <string>sync:semrush</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>RunAtLoad</key><true/>
  <key>WatchPaths</key><array><string>${xml(cursorDb)}</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>${xml(join(configDir, 'semrush-sync.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(configDir, 'semrush-sync-error.log'))}</string>
</dict>
</plist>
`)
try {
  execFileSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' })
} catch {
  // It was not loaded.
}
execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist])
console.log(`Installed ${label}; it runs at login, every 15 minutes, and when Cursor's token store changes.`)

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
