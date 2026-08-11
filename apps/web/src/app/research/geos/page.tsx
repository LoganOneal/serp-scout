import { redirect } from 'next/navigation'

/** Import lives under Research → Data library. */
export default function ResearchGeosRedirect() {
  redirect('/research?import=1')
}
