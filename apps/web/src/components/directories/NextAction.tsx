import type { DirectorySummary } from '@rnr/data'

/**
 * One next action, with its command, and its blocker when it has one.
 *
 * ==================== WHY ONE AND NOT A LIST ====================
 * The pipeline has a strict order — demand before verdicts, verdicts before a
 * paid difficulty pass — and a screen that offers five equal buttons for an
 * ordered pipeline is a screen that gets the order wrong. `pickNext` also skips
 * every priced stage, so this never nudges toward spending money before the free
 * work is done.
 * ===============================================================
 *
 * The command is shown rather than run. Every one of these is a long-running
 * job that spends a quota or writes hundreds of rows, and the CLI is where they
 * report progress, cost and refusals properly. A button here would hide all of
 * that behind a spinner.
 */
export function NextAction({
  action,
  decided,
  keywords,
}: {
  action: DirectorySummary['nextAction']
  decided: number
  keywords: number
}) {
  if (!action) {
    return (
      <div className="okbox" style={{ marginTop: 14 }}>
        Every free stage has run. {decided.toLocaleString('en-US')} of{' '}
        {keywords.toLocaleString('en-US')} keywords are decided.
      </div>
    )
  }

  return (
    <div className={action.blocker ? 'stopbox' : 'warnbox'} style={{ marginTop: 14 }}>
      <div className="stage-next-head">
        Next: {action.label}
        {action.blocker ? ' — blocked' : ''}
      </div>

      {action.blocker && <div className="stage-next-blocker">{action.blocker}</div>}

      <code className="mono stage-next-cmd">{action.command}</code>

      {keywords > 0 && decided === 0 && (
        <div className="stage-next-note">
          All {keywords.toLocaleString('en-US')} keywords are UNKNOWN. That is not a verdict —
          it means a signal the decision needs was never measured, so nothing here is a
          judgement about the keywords themselves.
        </div>
      )}
    </div>
  )
}
