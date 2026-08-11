import { permanentRedirect } from 'next/navigation'

/**
 * Retired. Shortlisted cells and targeted cells are one list now -- keeping them apart is what
 * put the frozen prediction and the realised result on different pages, so the comparison this
 * system exists to make was never on screen together.
 */
export default function ShortlistPage(): never {
  permanentRedirect('/markets')
}
