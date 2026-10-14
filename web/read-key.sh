#!/bin/sh
# Runs before nginx starts (the image runs every script in /docker-entrypoint.d). It turns the read key the seed step
# left in the shared volume into the one line of nginx configuration that sends it upstream (fathom-proxy.conf).
# Without a usable key the container stops here: a proxy that forwards searches with no credential would only produce
# 401s, and one that started anyway would hide that the seed step failed.
#
# The two paths can be given as arguments, which is how tests/unit/test_read_key.py runs it.
set -eu
LC_ALL=C
export LC_ALL

key_file=${1:-/run/fathom/read.key}
conf=${2:-/tmp/fathom-key.conf}

if [ ! -r "$key_file" ]; then
  echo "fathom: $key_file is missing; the seed service writes it (compose.yaml)" >&2
  exit 1
fi

refuse() {
  echo "fathom: $key_file does not hold an API key" >&2
  exit 1
}

# What is in the file becomes part of nginx's configuration, so it has to be one key and nothing else. Matching the
# key's shape with grep is not enough by itself: grep judges each line separately, and a good first line followed by
# `"; add_header ...` would pass and be written out whole. So, in order: the file is as long as a key, with or without
# the newline that ends its line; it holds no character a key cannot (which rules out a second line, a carriage
# return, a quote, a space); and only then the shape.
bytes=$(wc -c < "$key_file")
[ "$bytes" -eq 64 ] || [ "$bytes" -eq 65 ] || refuse
key=$(cat "$key_file")
case "$key" in
  *[!A-Za-z0-9_-]*) refuse ;;
esac
printf '%s' "$key" | grep -Eqx 'fth_[0-9a-f]{16}_[A-Za-z0-9_-]{43}' || refuse

umask 077
printf 'proxy_set_header Authorization "Bearer %s";\n' "$key" > "$conf"
