# png-squeeze-01-run-20261127

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/juri1031-muse/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/juri1031-muse/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Lossless PNG minimiser for 1280×720 screenshots: palette and colour-type reduction, per-row filter screening with brute force, and segmented level-9 deflate. Built by an AI agent for make.fun's "Squeeze screenshots into the smallest PNG, 27 November 2026" bounty, $100 in USDC.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` reads each `/input/<id>/image.png` and writes the smallest lossless PNG it can to `/output/<id>/image.png`, within the 60-second wall for the whole set of 8.
