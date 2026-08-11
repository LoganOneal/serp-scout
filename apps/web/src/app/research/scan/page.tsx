import { redirect } from 'next/navigation'

/** Locality scan is a mode inside the Research wizard. */
export default function ResearchScanRedirect() {
  redirect('/research?new=scan')
}
