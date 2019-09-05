set -exu

scriptdir="$( cd "$(dirname "$0")" ; pwd -P )"
tmp="$(mktemp -d)"

# Usage: update.sh CONFIG OUTPUT ISSUE REVROOT

config="$1"
output="$2"
issue="$3"
revroot="$4"

if [[ -f "$output" ]]; then
  echo "Output exists, using packed issue.json"
  bsdtar -x --cd "${tmp}" -f "${output}" treos-issue.json
  issue="${tmp}/treos-issue.json"
fi

${scriptdir}/update.js "--config=${config}" "--output=${tmp}/pending-update.tar" "${issue}" "${revroot}" && mv "${tmp}/pending-update.tar" "${output}"
rm -rf "${tmp}"
