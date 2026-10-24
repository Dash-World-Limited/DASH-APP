# Service photography

These are the photographs on the six Home service tiles: Food, Shops,
Pharmacy, Local Market, Declutter and Logistics. Each is a photographic
cut-out on a transparent background, composed into an 88:72 frame (the tile's
image box) at 440 × 360 px.

They replaced the drawings cut from the approved board, which looked clipped
and artificial on the A55. David asked for real photos on 14 September.

## How they are composed

`compose_services.py` treats the six as one set:

- **Trim.** Each cut-out is cropped to its subject.
- **Equal visual weight.** Each subject is scaled so it covers the same share
  of the frame (41%). A wide plate and a tall basket then read as the same
  size, where the raw images varied from 37% to 59%.
- **One baseline.** Every subject stands on the same line near the bottom of
  the frame.
- **Contact shadow.** A soft shadow sits under each subject, so nothing
  floats on Light. On Dark it disappears into the tile.

The cut-out edges were checked for a white matte fringe and have none: the
semi-transparent edge pixels are the subject's own colour. So the images sit
cleanly on the Dark tiles too.

To rebuild, run the script over the 640 px originals from commit `b4968bf`:

```bash
git show b4968bf:apps/mobile/assets/v2/categories/<name>.png > <dir>/<name>.png
python compose_services.py <dir> .
```

## Source: to confirm before any store release

Codex added these images on `codex/native-mobile-v2-rebuild`, in commit
`b4968bf`, "Replace category illustrations with real photography", on
14 September 2026. That commit records no photographer, source or licence.
Before a public release, either:

- confirm where the images came from and that DASH may use them commercially;
  or
- replace them with commissioned or licensed photography of the same subjects.

These images are DASH's own category imagery, not merchant content. Merchant
storefront and product photos come from merchants, through catalogue upload.
