#!/bin/sh
# Runs before nginx starts (the image runs every script in /docker-entrypoint.d). It turns the read key the seed step
# left in the shared volume into the one line of nginx configuration that sends it upstream (fathom-proxy.conf).
# Without a usable key the container stops here: a proxy that forwards searches with no credential would only produce
# 401s, and one that started anyway would hide that the seed step failed.
set -eu

key_file=/run/fathom/read.key
if [ ! -r "$key_file" ]; then
  echo "fathom: $key_file is missing; the seed service writes it (compose.yaml)" >&2
  exit 1
fi

key=$(cat "$key_file")
# The key goes into a configuration file, so its shape is checked first: nothing but the characters a key is made of.
if ! printf '%s' "$key" | grep -Eqx 'fth_[0-9a-f]{16}_[A-Za-z0-9_-]{43}'; then
  echo "fathom: $key_file does not hold an API key" >&2
  exit 1
fi

umask 077
printf 'proxy_set_header Authorization "Bearer %s";\n' "$key" > /tmp/fathom-key.conf
