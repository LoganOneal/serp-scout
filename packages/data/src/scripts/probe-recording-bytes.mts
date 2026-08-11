import 'dotenv/config'
import { recordingExists, recordingSize, recordingStore } from '../voice/recordings.js'

const path = process.argv[2] ?? '1/2026-08/call_f941b48eb2755c7fb7221d3500a.wav'

console.log('LIVE_CALLS', process.env['LIVE_CALLS_ENABLED'])
console.log('BLOB set?', Boolean(process.env['BLOB_READ_WRITE_TOKEN']?.trim()))
console.log('VERCEL?', process.env['VERCEL'])

try {
  const store = recordingStore()
  console.log('store.kind', store.kind)
  const size = await recordingSize(path)
  console.log('size', size)
  const exists = await recordingExists(path)
  console.log('exists', exists)
  const opened = await store.open(path)
  console.log(
    'open',
    opened
      ? { length: opened.length, size: opened.size, range: opened.range }
      : null,
  )
} catch (e) {
  console.error('error', (e as Error).message)
}
