import { buildEditorsChoiceTargets, parseCsv, type EditorsChoiceProperty } from '@rnr/core'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

export async function loadEditorsChoiceTargets(args: {
  membershipPath: string
  inventoryPath: string
  pressContactsPath?: string
  pressProspectsPath?: string
}) {
  const membership = JSON.parse(await readFile(args.membershipPath, 'utf8')) as { slugs?: string[] }
  const inventoryRaw = await readMaybeGzip(args.inventoryPath)
  const inventory = JSON.parse(inventoryRaw) as { properties?: EditorsChoiceProperty[] } | EditorsChoiceProperty[]
  const properties = Array.isArray(inventory) ? inventory : inventory.properties ?? []
  const pressContacts = args.pressContactsPath ? parseCsv(await readFile(args.pressContactsPath, 'utf8')) : []
  const prospectsPath = args.pressProspectsPath ?? (await findPressProspectsCsv(args.membershipPath))
  const pressProspects = prospectsPath ? parseCsv(await readFile(prospectsPath, 'utf8')) : []
  return buildEditorsChoiceTargets({
    membership: { slugs: membership.slugs ?? [] },
    properties,
    pressContacts,
    pressProspects,
  })
}

export async function findPressProspectsCsv(membershipPath: string): Promise<string | undefined> {
  const dataDir = resolve(dirname(membershipPath), '../backlink_building/data')
  try {
    const names = (await readdir(dataDir))
      .filter((name) => name.startsWith('hotel-press-prospects-') && name.endsWith('.csv'))
      .sort()
      .reverse()
    return names[0] ? resolve(dataDir, names[0]) : undefined
  } catch {
    return undefined
  }
}

async function readMaybeGzip(path: string): Promise<string> {
  const buf = await readFile(path)
  if (path.endsWith('.gz') || buf[0] === 0x1f && buf[1] === 0x8b) {
    return gunzipSync(buf).toString('utf8')
  }
  return buf.toString('utf8')
}
