import { permanentRedirect } from 'next/navigation'

/**
 * Research moved under Scout.
 *
 * Kept only so links written before the Scout/Portfolio split still resolve.
 * Unlike the redirects deleted in phase 1, this one points at a path that
 * actually renders what its name promised.
 */
export default function Page(): never {
  permanentRedirect('/scout')
}
