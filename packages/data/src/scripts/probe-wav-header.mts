const url = process.argv[2] ?? 'https://rank-and-rent-beta.vercel.app/api/recordings/8'
const r = await fetch(url, { headers: { Range: 'bytes=0-31' } })
console.log('status', r.status)
console.log('content-type', r.headers.get('content-type'))
console.log('content-range', r.headers.get('content-range'))
console.log('content-length', r.headers.get('content-length'))
const buf = Buffer.from(await r.arrayBuffer())
console.log('bytes', buf.length)
console.log('hex', buf.subarray(0, 16).toString('hex'))
console.log('ascii', JSON.stringify(buf.subarray(0, 16).toString('ascii')))
// RIFF....WAVE = wav; ID3/fff = mp3; ftyp = mp4/m4a; OggS = ogg
if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
  console.log('format: WAV')
} else if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) {
  console.log('format: MPEG audio (mp3)')
} else if (buf.toString('ascii', 0, 3) === 'ID3') {
  console.log('format: MP3 with ID3')
} else {
  console.log('format: unknown')
}
