import { redirect } from 'next/navigation'

/** Work starts in Scout: you decide before you operate. */
export default function Home(): never {
  redirect('/scout')
}
