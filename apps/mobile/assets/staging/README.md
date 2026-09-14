# Staging imagery — interim

Every image in this folder was **cropped from the director-approved boards**
(`docs/design/boards/2026-09-13/customer.png` and `rider.png`) on 13 September
2026 and upscaled with a Lanczos filter. The storefront hero had the board's mock
status bar cropped off and its drawn back and share glyphs filled from the
surrounding pixels — the app draws its own controls in those places.

They exist so the screens can be judged against the boards with the approved
content in place rather than grey boxes. They are not production assets:

- they are soft at device resolution, being crops of a ~235px-wide phone
  drawing shown on a ~412pt screen at 3x density;
- merchant photographs must come from merchants, through catalogue upload, not
  from a mock-up;
- the product imagery depicts branded goods as drawn on the board, for staging
  review only.

**14 September.** The six Home service drawings looked clipped and artificial
on the A55. They are no longer cut from the board; the tiles use photography
instead, from `assets/services` (see that folder's README). The Shops
category circles were cut again, because the first cut was off-centre enough
to take in the neighbouring circle. Each is now the board's circle, centred
on itself.

Replace everything here with real catalogue photography and master campaign
art. Nothing references these files except `src/data/staging.ts` and the two
campaign cards, so the swap is contained.
