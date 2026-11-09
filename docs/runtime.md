# Keeping the 24/7 run up

Two things break an unattended run that have nothing to do with the game logic. Both are
recorded here because they look like code bugs from the outside.

## A missing bundled ffmpeg must not re-download on every restart

`run-hubie.bat` runs `node scripts/bootstrap.mjs --check` before it starts the host. The
check used to require `vendor/ffmpeg/ffmpeg.exe`, but the encoder's `bin()` already falls
back to an ffmpeg on `PATH`. So on this host — which has ffmpeg 9.0.2 from WinGet — every
restart re-downloaded the 115 MB build before the stream could come up.

`bootstrap --check` now accepts a system ffmpeg and prints which one it will use:

```
$ node scripts/bootstrap.mjs --check
[bootstrap] vendor ready (ffmpeg: system)
```

## The mouth degrades when the LLM quota is spent

The host falls back to canned lines when the LLM answers `HTTP 429`. It is visible in the
log and does not stop play, chat ingest, or the encoder:

```
brain: frame comment skipped (LLM HTTP 429: You've reached your weekly usage limit ...)
```

The reset timestamp is in the provider's own message. Watch it, because until then viewer
replies and big-win lines come from the fallback table instead of the model.

## Verify

```bash
node scripts/bootstrap.mjs --check        # exits 0 and names the ffmpeg it will use
node --test test/runtime-entrypoints.test.js
```

## Rollback

Revert the `--check` block in `scripts/bootstrap.mjs`; nothing else depends on it.
