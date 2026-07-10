# Audio Offset By Duration

Use this workflow when Cozytrack exports separate WebM/Opus tracks that appear
to have started at different times but ended from the same stop action. The
duration difference is a practical fixed-offset estimate for Auphonic.

## Probe Durations

Chrome/WebKit WebM files often report `format=duration` as `N/A`, so probe the
last decoded audio packet instead. Run `ffprobe` once per file:

```bash
ffprobe -v error -select_streams a:0 \
  -show_packets -show_entries packet=pts_time,duration_time \
  -of csv=p=0 "Tr1.webm" \
  | awk -F, 'NF >= 2 { end = $1 + $2 } END { printf "%.3f\n", end }'
```

Repeat for `Tr2.webm`.

If packet probing is ambiguous, decode to null and read the final `time=` value:

```bash
ffmpeg -hide_banner -i "Tr1.webm" -f null -
```

## Calculate Auphonic Offset

Assuming both tracks stopped at the same real time:

```text
offset_seconds = longer_track_duration - shorter_track_duration
```

The shorter file is the track that started late. Apply the positive Auphonic
`offset` to that shorter track. Do not create extra delay-adjusted files beside
canonical `Tr1.webm` / `Tr2.webm` files unless you are also updating the stored
asset path; Podline uploads the exact paths that were registered at ingest time.

## Example

For `/Volumes/Music/Podcast/Sex Drunks/02_recordings/cozytrack/2026-07-04_independence-day`:

```text
Tr1.webm end: 5875.166s  (01:37:55.166)
Tr2.webm end: 5873.365s  (01:37:53.365)
Difference: 1.801s
```

Set the Auphonic offset on `Tr2` to `1.801` seconds, or `1.80` seconds if using
a UI field that rounds to hundredths.

## Caveats

This duration-difference method is valid only when the tracks share the same
stop point and differ mainly by recording start delay. If one file was trimmed,
cut off early, recovered from missing chunks, or otherwise has a different end
point, align by an audible cue instead.
