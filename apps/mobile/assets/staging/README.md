# Staging imagery — interim

Every image in this folder was **cropped from the director-approved boards**
(`docs/design/boards/2026-09-13/customer.png` and `rider.png`) on 13 September
2026, upscaled with a Lanczos filter and, for the six service illustrations,
keyed to a transparent background. The storefront hero had the board's mock
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

Replace them with master illustrations (the six services, the campaign art)
and with real catalogue photography. Nothing references these files except
`src/data/staging.ts`, the six-service presentation in `src/data/services.ts`,
and the two campaign cards — so the swap is contained.
