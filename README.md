# tenantrepdc.com: Tenant Consulting property surveys

Upload a CoStar "For Lease" property report (PDF). The app pulls out every building (address, photo, specs,
available suites, overview, highlights), places it on a map, and gives you a private link for the client.
The client pans and zooms the map, opens each building, and gives it a thumbs up or down with an optional note.
You see every vote on the admin dashboard.

| URL | Who | What |
|---|---|---|
| `/admin` | You (password) | All surveys with 👍/👎 counts, client views, and last activity. Upload new PDFs. |
| `/admin/surveys/:id` | You | Votes and client notes, editing for every field, suite and floor plan, drag pins, new link |
| `/s/<22-char token>` | Client (no login) | Full-screen map survey with voting |

## Daily use
1. Go to **tenantrepdc.com/admin** and sign in.
2. Enter a title and client name, choose the CoStar PDF, then click **Create survey**. Processing takes 10 to 30 seconds.
3. Check the buildings. Fix anything the parser missed, add your own notes to the client, upload floor plans
   (PDF or image) and link each one to its suite, and hide any building you don't want shown.
4. **Copy** the private link and send it to the client.
5. Watch the votes come in on the dashboard. **New link** turns off the old link immediately.

## Building flyers, photos and virtual tours
Open a building in the survey editor and drop files on **"Drop building flyers, photos or floor plans here"**:
- **Flyer PDFs** are read page by page. Floor plan images are cut out with their captions ("Second Floor · Suite 200 · Suite 210")
  and attached to every suite named. Gallery photos keep their captions ("Lobby"). Every page is also kept as a flyer page,
  and the PDF is offered as a download. Pages or PDFs showing listing-broker emails or phone numbers start **hidden from the client**.
- **JPG/PNG/WebP photos** go into the building's gallery. Name a file with "plan" (e.g. `Suite 350 floor plan.png`) to file it as a floor plan.
- Every item has **Hide from client**, **Make main photo**, **Move to floor plans** and **Delete**.
- Paste a **Virtual tour link** (Matterport, YouTube…) in the building's fields to show a "Virtual tour" button.
- The **Monthly cost** box sets this building's NNN (blank = the survey's area estimate) and previews the client's cost table.
Uploads, tour links, your notes and votes are kept when you **Re-import from PDF**, and copied when you **Duplicate** a survey.

## Buildings ruled out
- **Rule out a survey building**: in the editor open it and click **Rule out…**, or while logged in, open the client's survey link,
  click the building and use the yellow **Advisor only → Rule out…** bar (clients never see it). Enter the reason. The building
  leaves the client's map and list and appears in the fold-out **Buildings ruled out** section at the bottom of their list.
  **Restore to survey** brings it back.
- **Buildings outside the survey** (ones a client found online): add them in the editor's **Buildings ruled out** panel with
  a name, address and reason (one-tap reasons included). The client can search the list.
- Ruled-out status and reasons are kept on re-import and copied when you duplicate a survey.

## Settings (environment variables)
| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | yes | Your admin login password |
| `SESSION_SECRET` | yes | Long random string that signs your login cookie |
| `DATA_DIR` | yes on a host | Where the database and images live. Must be a persistent disk (Docker image default: `/data`) |
| `BROKER_NAME`, `BROKER_EMAIL`, `BROKER_PHONE` | no | Your contact card at the bottom of each survey |
| `COMPANY_URL` | no | Where the logo links to (default https://www.tenantconsulting.com) |
| `TILE_URL`, `TILE_ATTRIBUTION` | no | Map tiles. The default is OpenStreetMap; see "Map tiles" below |

## Branding
- Colors and fonts: `public/css/brand.css` (the `:root` block at the top).
- Logo: replace `public/img/logo.svg` (it sits on the navy header bar, so use a white or light version).
  A PNG also works: save it as `public/img/logo.png` and change the `src` in the HTML files.
- Favicon: `public/img/favicon.svg`.

## Deploy on Render (recommended, about $7–$10/month)
1. Put this folder in a GitHub repository.
2. On render.com, click **New → Blueprint** and choose the repository. `render.yaml` sets up a Docker web service with a
   5 GB persistent disk. When asked, enter `ADMIN_PASSWORD` and your broker contact details.
3. When the deploy finishes, go to **Settings → Custom Domains** on the service and add `tenantrepdc.com` and `www.tenantrepdc.com`.
4. At your domain registrar, add the DNS records Render shows you. Usually that's an `A` record for `@` pointing to
   Render's IP and a `CNAME` for `www` pointing to `<service>.onrender.com`. Leave any `MX` (email) records alone.
   Render issues the HTTPS certificate automatically.

Any host that runs a Docker container with a persistent volume also works (Fly.io, Railway, a VPS).

## Map tiles
The default street map is OpenStreetMap's public tile server, which is fine for light use with attribution. If you expect
heavy traffic or want a different look, sign up for a commercial tile plan (e.g. MapTiler or Stadia Maps) and set
`TILE_URL` to their URL with your key.

## How extraction works
`lib/heuristic.js` reads the CoStar layout: the numbered page header ("1  10 Pidgeon Hill Dr • Name" /
"… • Submarket • City, ST ZIP"), the Listing/Building Details label blocks, the Available Spaces table
(including wrapped cells like "Office/Med-ical"), Property Overview and Leasing Highlights. The building photo is
the largest image on the property's first page. Pages captioned "… Floor • Suite …" or "Floor Plan" become floor plans.
Addresses are geocoded with the US Census geocoder, falling back to OpenStreetMap Nominatim. If one can't be found,
drag or click to place it in the editor. The original CoStar page for each building is saved so you can check
the extraction ("View original CoStar page" in the editor). Clients never see it.

## Privacy and security
- Survey links use 128-bit random tokens and every page sends `noindex`. Photos and floor plans are only served
  through the survey's own link.
- The CoStar listing-broker contact pages are never shown to clients.
- The admin login is rate-limited and uses an HttpOnly signed cookie that lasts 30 days.

## Run locally
Requires Node 22.5+ and poppler-utils (`brew install poppler` / `apt install poppler-utils`).
```
npm install
ADMIN_PASSWORD=choose-one SESSION_SECRET=$(openssl rand -hex 32) npm start
```
Then open http://localhost:3000/admin.
