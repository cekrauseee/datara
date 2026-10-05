# Product behavior

## Exploration

The country selector switches between Brazil and the United States. Each visited country keeps its own mounted page, selected area, camera position, zoom and search text in memory. Hidden pages are not exposed as active UI; their search popup closes. Reloading clears that in-memory session and reconstructs selection from the URL.

The search accepts names, state abbreviations and source codes. Matching is case- and accent-insensitive, supports multiple words, prioritizes states and returns at most 30 matches. US local search loads separately from the national map. A place and a subdivision with the same name remain distinct results.

Click a boundary or select a search result to fit that area. Breadcrumbs navigate back to the state or country. A desktop selection card shows the area type, state and source identifier. Names are shown on hover and in selection UI, not permanently painted on the map.

Drag to pan; use the mouse wheel, trackpad pinch or zoom buttons to zoom. With the Canvas focused:

| Key               | Action                              |
| ----------------- | ----------------------------------- |
| Arrow keys        | Pan                                 |
| `+` / `=`         | Zoom in                             |
| `-`               | Zoom out                            |
| `Home` / `Escape` | Clear selection and fit the country |

Zoom is limited to 1–100. Selection animation lasts 260 ms and is interruptible. Reduced-motion preferences disable camera animation and skeleton pulsing. A direct URL with selection first displays the country, then approaches the selected area; returning to a retained country preserves its camera instead.

## URLs

| Example                               | Selection                                   |
| ------------------------------------- | ------------------------------------------- |
| `/br`                                 | Brazil                                      |
| `/br?state=35`                        | São Paulo state                             |
| `/br?state=35&municipality=3550308`   | São Paulo municipality                      |
| `/us`                                 | United States                               |
| `/us?state=02`                        | Alaska                                      |
| `/us?state=06&county=06037`           | Los Angeles County                          |
| `/us?state=36&place=3651000`          | New York city                               |
| `/us?state=36&subdivision=3606150617` | A subdivision identified by its source code |

Country paths are lowercase; query parameters are English. Codes are strings and retain leading zeros. Parsing checks numeric lengths: state 2, municipality/place 7, county 5, subdivision 10. Brazil resolves municipality before state; the US resolves place, subdivision, county, then state. A valid-looking but unknown ID produces a not-found message. Malformed values are ignored in favor of another valid level.

Selection writes canonical parameters from the chosen area's state. It removes obsolete selection parameters, including earlier Portuguese names, while preserving unrelated query parameters and the fragment. Browser back/forward restores URL selections. The root and unknown country paths normalize to Brazil; there is no separate 404 page. Vite's base URL is used for navigation and asset paths.

## Geographic levels

Brazil includes states and municipalities. The US includes 50 states plus District of Columbia, counties/equivalents, places and county subdivisions. Alaska and Hawaii use inset placement and do not retain their real geographic position or relative scale in the national composition. US territories are excluded.

At national zoom, state boundaries are shown. Municipal/county boundaries begin at 2.5× and fade toward their final opacity by 4×. US local detail requests begin at 4×; places/subdivisions become visible from 8×, reaching full zoom-dependent opacity at 10×. Newly prepared details also fade in over 240 ms. Places take picking priority over subdivisions, followed by counties; outside place coverage, the administrative context remains available.

## Loading and errors

A country silhouette skeleton remains until the first Canvas drawing is ready. Controls are disabled while the map is unavailable. Download/preparation failures expose retry actions; local detail and search failures are reported separately. Detail loading never means that an area has no geography. The footer attributes the current data source and edition.
