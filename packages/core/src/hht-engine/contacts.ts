export type ContactMethod = 'EMAIL' | 'CONTACT_FORM'

export interface ContactCandidate {
  name: string | null
  role: string | null
  email: string | null
  formUrl: string | null
  source: string
}

export interface ChosenContact {
  name: string | null
  role: string | null
  email: string | null
  formUrl: string | null
  method: ContactMethod
  source: string
}

const GUEST_ORDER = ['guidelines', 'editor', 'general', 'form']
const INSERTION_ORDER = ['author', 'editor', 'general', 'form']

export function chooseContact(type: 'guest_post' | 'link_insertion', candidates: ContactCandidate[]): ChosenContact | null {
  const order = type === 'guest_post' ? GUEST_ORDER : INSERTION_ORDER
  const ranked = [...candidates].sort((a, b) => rank(a.source, order) - rank(b.source, order))
  for (const candidate of ranked) {
    if (candidate.email) {
      return {
        name: candidate.name,
        role: candidate.role,
        email: candidate.email.toLowerCase(),
        formUrl: null,
        method: 'EMAIL',
        source: candidate.source,
      }
    }
  }
  const form = ranked.find((candidate) => candidate.formUrl)
  if (!form?.formUrl) return null
  return {
    name: form.name,
    role: form.role,
    email: null,
    formUrl: form.formUrl,
    method: 'CONTACT_FORM',
    source: form.source,
  }
}

export function normalizeContactEmail(email: string): string {
  return email.trim().toLowerCase()
}

function rank(source: string, order: string[]): number {
  const index = order.findIndex((item) => source.includes(item))
  return index === -1 ? order.length : index
}
