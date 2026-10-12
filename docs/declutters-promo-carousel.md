# Declutters desktop campaign carousel

Campaign data lives in `apps/web/public/declutter/promos/campaigns.json`.
The carousel reads it on page load with `cache: 'no-store'`. Replace artwork
files or edit/reorder/add/remove JSON records without changing the component.
Distribute the public directory with the web release. No API, migration or new
environment variable is required.

Each record requires a unique `id`, `title`, descriptive `alt`, and an `image`
path under `/declutter/promos/` (PNG, JPG/JPEG or WebP). Optional `status` is
shown beside the title. Optional `href` accepts an approved HTTPS URL or a
site-relative path. Omit it when no destination has been approved; all six
initial campaigns deliberately omit links.

Initial order: DASH App, DASH AI, DASH Rider / Dasher, DASH Declutters,
DASH Club, DASH AI Studio. App and AI launch in December. Club and AI Studio
are Coming Soon. Declutters artwork supplies November 1; no year or Rider
launch date has been added. Original attachment bytes are preserved.

At widths below 1024px the hero carousel is hidden and no campaign manifest
or artwork is requested. Desktop shows one complete, contained image at a
time, rotating every 6.5 seconds. Hover, keyboard focus and hidden browser tabs
pause rotation. Reduced-motion preference starts it paused. Arrows, selection
dots, keyboard arrows/Home/End and explicit pause/play remain available.
Manual navigation pauses automatic rotation until Play is selected.

The asset namespace intentionally sits below `/declutter/`, preserving the
existing Declutters deployment middleware boundary. Marketplace listings
remain in the normal Everything section; hero copy and links are unchanged.
