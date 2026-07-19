# buddy-fleet-status

Nightly smoke checks for the Odam Solutions app fleet. One workflow, one sequential
run, five assertions per app (loads, renders, console clean, no page errors, no
failed first-party requests). All third-party origins are aborted at the network
layer, so the nightly costs each app exactly one page-load from GitHub's runners.

Results land in status/<app>.json and render as dots on https://buddy-fleet.vercel.app.
Red means two consecutive failed nights. A missed cron shows grey, not red.

The deep per-app suites (e.g. GuitarBuddy's 70-check qa_full.py) stay manual and
pre-ship; this repo is the coarse "did anything white-screen" layer only.
