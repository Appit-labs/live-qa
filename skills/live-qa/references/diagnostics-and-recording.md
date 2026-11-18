# Diagnostics and recording

## Diagnostics when a step looks wrong

- `errors --clear` then reproduce, then `errors` — separates new failures from
  noise the page had on load.
- `network requests` for failed calls; `agent_browser_network_source` correlates a
  failure to its initiator.
- `vitals` for Core Web Vitals and hydration timing.
- `a11y --tags wcag2a,wcag2aa` for accessibility findings on the key screens.

### Recording the run

`ffmpeg` must be on PATH (it is, 8.x). Record the whole run:

```
record start <dir>/run.mp4 --contact-sheet --cursor --fps 15
# … the whole step sequence …
record stop
```

`.mp4` is H.264, `.webm` is VP8, `--fps` accepts 1–60. `record start`
invalidates every @ref, so take a fresh `snapshot -i` before continuing.

**Know what this artifact is.** Capture is repaint-driven, not a real framerate:
measured here, a 32-second run produced only **6 unique frames** despite a 15fps
container. Treat the video as a timestamped state timeline that proves what was
on screen and when — never as evidence about animation smoothness, transition
timing, or jank. `output.frames` counts held/duplicated frames, so it says
nothing; judge uniqueness, not the container FPS.

**The contact sheet is the better artifact.** `--contact-sheet` writes
`<stem>.contact-sheet.png`, one image of every visual change with a timestamp
and a red box around the changed region. It drops straight into a report and
reviews in seconds where a choppy video gets skipped.

For genuinely smooth motion (reviewing a CSS transition), this capture path
cannot do it — run a headed browser under `Xvfb` and record the display with
`ffmpeg -f x11grab`, or use Playwright's `recordVideo` in a committed spec.
`trace start` / `trace stop` gives a Playwright trace with DOM snapshots and a
filmstrip, which is the better debugging artifact; `stream enable` / `disable`
is for watching live.
