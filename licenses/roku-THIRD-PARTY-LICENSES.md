# Third-party licenses

## Fonts (bundled in `fonts/`)

The same two fonts the Nostalgex Apple TV app bundles, from
[google/fonts](https://github.com/google/fonts).

| Font | Copyright | License |
|------|-----------|---------|
| DM Mono (Regular, Medium) | 2020, The DM Mono Project Authors (github.com/googlefonts/dm-mono) | SIL Open Font License 1.1, `fonts/OFL-DMMono.txt` |
| VT323 | 2011, The VT323 Project Authors (peter.hull@oikoi.com) | SIL Open Font License 1.1, `fonts/OFL-VT323.txt` |

## Nostalgex

Portions are ported from [Nostalgex](https://github.com/chadMueller/Nostalgex),
copyright Chad Mueller / Muell Haus Inc., MIT License. See [LICENSE](LICENSE).

The Nostalgex name and wordmark are upstream's brand and are not part of this
project. `images/` (`logo.png`, the icons and splash) holds placeholder art
that `tools/make-art.mjs` draws, which also draws the pillarbox art in
`images/look/` and the activity pictures in `images/activities/`. The sounds in `sounds/` are drawn by `tools/make-sounds.mjs`;
no recorded media is used.

## QR Code generator

`source/util/QrCode.brs` follows the design of Project Nayuki's
[QR Code generator library](https://www.nayuki.io/page/qr-code-generator-library),
copyright (c) Project Nayuki, MIT License: its Reed-Solomon blocks, function
patterns, codeword placement and mask penalty.
