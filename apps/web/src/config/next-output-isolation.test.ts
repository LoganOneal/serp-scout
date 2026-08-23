import { describe, expect, it } from 'vitest'
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from 'next/constants'
import { resolveNextDistDir } from '../../next.config'

describe('Next output isolation', () => {
  it('keeps a dev server out of the production build directory', () => {
    expect(resolveNextDistDir(PHASE_DEVELOPMENT_SERVER, {})).toBe('.next-dev')
    expect(resolveNextDistDir(PHASE_PRODUCTION_BUILD, {})).toBeUndefined()
  })

  it('honours an explicit output directory for isolated build verification', () => {
    expect(
      resolveNextDistDir(PHASE_PRODUCTION_BUILD, { NEXT_DIST_DIR: '.next-build' }),
    ).toBe('.next-build')
  })
})
