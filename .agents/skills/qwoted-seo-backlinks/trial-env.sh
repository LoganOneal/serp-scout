# Trial-account isolation for Qwoted
#
# Usage:
#   export QWOTED_HOME="$HOME/.qwoted-trial-1"
#   python3 qwoted_login.py --start-chrome
#
# Each QWOTED_HOME is a separate cookie jar, Chrome profile, rate log,
# and Algolia cache. Wipe the directory to throw the persona away.
# Never reuse ~/.qwoted from the 2026-07-03 disable.
