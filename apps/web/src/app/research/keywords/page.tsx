import { redirect } from 'next/navigation'

/** Merged into the single Research wizard. */
export default function ResearchKeywordsRedirect() {
  redirect('/research?new=1')
}
