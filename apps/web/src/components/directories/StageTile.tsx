import type { DirectoryStage } from '@rnr/data'
import { NULL_DISPLAY } from '@/lib/format'

/**
 * One pipeline stage: what it measured, out of how many, and what stops it.
 *
 * ==================== THE COUNT IS ALWAYS n / total ====================
 * Never a bare number and never a percentage alone. "412" does not say whether
 * that is most of the grid or a tenth of it, and a percentage hides the
 * denominator entirely — which is the same mistake `commentTotal` exists to
 * prevent beside `commentRank`, and the same one `DifficultyCell` prevents by
 * printing coverage next to the score.
 *
 * A blocked stage shows 0 / 975 AND the reason. Without the reason, zero reads
 * as "nothing to find" rather than "nothing was asked".
 * ======================================================================
 */
export function StageTile({ stage }: { stage: DirectoryStage }) {
  const tone =
    stage.state === 'done'
      ? 'ok'
      : stage.state === 'blocked'
        ? 'stop'
        : stage.state === 'partial'
          ? 'warn'
          : 'idle'

  return (
    <div className={`funnel-tile stage-tile stage-${tone}`} title={stage.detail}>
      <span className="funnel-label">
        {stage.label}
        {stage.cost === 'paid' && (
          <span className="stage-cost" title="This stage spends money">
            $
          </span>
        )}
      </span>

      <span className="funnel-value">
        {stage.measured === null || stage.total === null ? (
          <span className={stage.state === 'done' ? '' : 'null'}>
            {stage.state === 'done' ? 'set' : stage.state === 'partial' ? 'partial' : NULL_DISPLAY}
          </span>
        ) : (
          <>
            <span className={stage.measured === 0 ? 'null' : ''}>
              {stage.measured.toLocaleString('en-US')}
            </span>
            <span className="stage-denom"> / {stage.total.toLocaleString('en-US')}</span>
          </>
        )}
      </span>

      <span className="stage-detail">{stage.detail}</span>

      {stage.blocker && <span className="stage-blocker">{stage.blocker}</span>}
    </div>
  )
}
