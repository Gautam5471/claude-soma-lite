#!/bin/sh
# Fetch the headline font the composition expects in ./fonts (not committed with the source).
#
# Instrument Serif, regular and italic, latin subset, from Google Fonts. It is licensed under the
# SIL Open Font License 1.1 (https://openfontlicense.org). Without these files the headlines fall
# back to Georgia. JetBrains Mono needs nothing: HyperFrames embeds it at render time.
set -eu
cd "$(dirname "$0")"
mkdir -p fonts
curl -fsSL -o fonts/InstrumentSerif-Regular.woff2 \
  'https://fonts.gstatic.com/s/instrumentserif/v5/jizBRFtNs2ka5fXjeivQ4LroWlx-6zUTjnTLgNs.woff2'
curl -fsSL -o fonts/InstrumentSerif-Italic.woff2 \
  'https://fonts.gstatic.com/s/instrumentserif/v5/jizHRFtNs2ka5fXjeivQ4LroWlx-6zAjjH7Motmp5g.woff2'
echo "fonts ready in $(pwd)/fonts"
