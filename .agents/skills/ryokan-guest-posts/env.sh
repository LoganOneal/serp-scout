# Source before any Ryokan Society pipeline command:  source .agents/skills/ryokan-guest-posts/env.sh
# Points the shared guest-post scripts at the Ryokan lead set, never the Hotel Hot Tubs one.
_RS_REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")/../../.." && pwd)"
export HHT_EXPORTS="$_RS_REPO/exports/ryokan-guest-post"
export HHT_MASTER="$_RS_REPO/exports/ryokan-guest-post/Ryokan Society Guest Post Tracker.xlsx"
export HHT_HAIKU_RULES="$_RS_REPO/.agents/skills/ryokan-guest-posts/references/haiku-rules-ryokan.txt"
export RS_HANDOFF="$_RS_REPO/exports/handoff/ryokan"
export GPP="$_RS_REPO/.agents/skills/guest-post-pitches/scripts"
export RSP="$_RS_REPO/.agents/skills/ryokan-guest-posts/scripts"
unset _RS_REPO
