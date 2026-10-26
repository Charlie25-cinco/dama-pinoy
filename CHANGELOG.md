# Changelog

This project uses [Semantic Versioning](https://semver.org/). This file begins with v1.4.0; earlier releases predate this changelog.

## 2.4.2 — 2026-10-26

- **Fixed:** An unfinished password reset no longer turns into a normal login. A verified recovery session now stays a pending reset: reopening the app in any tab returns to **Set New Password** instead of the lobby, the normal Log Out control stays hidden, and **Back to Menu** or **Cancel Reset** signs the recovery session out. Requesting a code alone still creates no session.
- **Changed:** The pending-reset marker is stored in `localStorage` (user ID and time only, never tokens) so it survives a new tab; normal login, logout, and saving the new password clear it. Refreshed the installed app cache.

## 2.4.1 — 2026-10-26

- **Fixed:** Simplified account access to email/password Log In, Create Account, and Forgot Password. Removed the magic-link request, passwordless-signup checkbox, and redundant reset/guest choices from the form.
- **Changed:** Password reset now presents one guided email → code → new-password flow; resend appears only at the code step. Existing account sessions and previously issued email callbacks remain compatible. Refreshed the installed app cache.

## 2.4.0 — 2026-10-26

- **Added:** Email OTP password reset: request/resend a code, verify it, then save a new password. Codes can be entered on another browser/device without a matching PKCE verifier.
- **Changed:** Reset verification uses a non-persisted client before installing the verified recovery session; active/saved rooms still block identity switching. Signup and magic-link login retain PKCE. Reset emails require the Supabase `{{ .Token }}` template.
- **Changed:** Refreshed the installed app cache for the reset-code UI.

## 2.3.2 — 2026-10-26

- **Fixed:** Email callbacks now explicitly exchange PKCE codes once and verify the returned account instead of silently falling back to the login screen. Missing-browser verifiers, expired/reused links, provider errors, and incompatible links display actionable status text.
- **Fixed:** Password-recovery callbacks retain their recovery marker and show the new-password form, including after a same-tab refresh. Guest upgrade and saved-room identity checks remain enforced.
- **Changed:** Callback credentials are removed from the address bar before SDK loading, referrers are suppressed, and the installed app cache is refreshed.

## 2.3.1 — 2026-10-26

- **Fixed:** Scoped compact desktop player-name positioning to player cards so account email/password fields no longer overlap. Account inputs now have visible theme-consistent surfaces, borders, and focus feedback.
- **Changed:** Refreshed the installed app cache for the account form layout fix.

## 2.3.0 — 2026-10-26

- **Added:** Optional email/password and passwordless email-link accounts, anonymous-identity upgrades, profile editing, session restoration, recovery UI, logout, and confirmed account deletion.
- **Added:** Private cross-device account statistics recorded only from server-validated online games/matches. Guest/local statistics and Last Replay are preserved and never silently merged; existing Auth-owned replay access follows the account across devices.
- **Changed:** Players and spectators support guest/account identity labels. Account deletion removes private records and anonymizes retained shared match/replay history. Refreshed the offline cache and excluded query-bearing/authenticated responses from caching.

## 2.2.0 — 2026-10-25

- **Added:** Transactionally recorded online replays with participant-only recent history (latest 20), validated viewing/export, and per-player board orientation, separate from local Last Replay and statistics.
- **Added:** Up to five Auth-owned, read-only room spectators with server-enforced membership, private live updates, a spectator badge/list, and last-move feedback.
- **Changed:** Saved rooms offer explicit Rejoin/Leave controls, restore authoritative state within the existing disconnect grace, and discard stale in-flight sync responses after leaving. Updated the offline cache.

## 2.1.0 — 2026-10-25

- **Added:** Online room hosts can choose their Game 1 color and Single Game, Best of 3, Best of 5, or Best of 9. Online series keep player-owned scores, swap colors each game, count draws toward the game limit, and require both players to confirm the next game or new series.
- **Changed:** Online moves render optimistically for the moving player, resynchronize on rejection, poll and refresh more reliably, and show clearer waiting, series, game-result, match-result, and last-move feedback. Red still opens every game.
- **Changed:** Added per-series and per-game ownership fields to the Supabase schema and kept database snapshots authoritative. Refreshed the installed app cache for the updated static assets.

## 2.0.1 — 2026-10-25

- **Changed:** Added the public Supabase project URL and publishable key to the browser configuration and refreshed the installed app cache.
- **Fixed:** Serialized guest sign-in so rapid create/join actions cannot start two anonymous sessions and leave the room seat tied to a different user.

## 2.0.0 — 2026-10-24

- **Added:** Guest-only online Single Game rooms with six-character codes, private Realtime presence/broadcast, synchronized moves, disconnect grace, and two-player rematches.
- **Added:** Supabase migration with member-only RLS, service-role-only transactional room functions, and an Edge Function that validates moves against shared Filipino Dama rules. Public online configuration and deployment instructions are included.
- **Changed:** Online results remain separate from local scores, statistics, and Last Replay; the local game stays playable offline. Refreshed the installed app cache for the new static assets.
- **Fixed:** Room membership checks handle empty guest seats explicitly, and snapshot reads retry when a concurrent move or rematch changes the room version.

## 1.9.0 — 2026-10-24

- **Added:** Export completed replays as versioned JSON files with player ownership, colors, board view, ordered captures, promotions, game summary, and export date.
- **Added:** Import validated replay files from the menu or viewer for read-only playback without replacing the saved Last Replay or changing game and statistics data. File transfer works offline and when opening the app directly.
- **Changed:** Replay controls and status feedback support file transfer on desktop and mobile; refreshed the offline cache for installed clients.
- **Fixed:** Opening or leaving a replay returns the page to the top so mobile navigation does not leave the next screen clipped.

## 1.8.0 — 2026-10-24

- **Added:** A local statistics dashboard with overall records, per-mode and per-AI-difficulty results, Best of 3/5/9 series results, current and longest win streaks, captures, and average moves per game.
- **Added:** Completed games and finalized matches are saved locally, while restarted games, abandoned games, and replay viewing do not create records. Statistics can be reset after confirmation without affecting names, preferences, the saved replay, the active game, or all-time win counters.
- **Changed:** Local two-player statistics use Player 1's perspective; vs Computer statistics use the human player's perspective. Drawn series count as played but not as won or lost. The offline cache version is refreshed for installed clients.

## 1.7.0 — 2026-10-24

- **Changed:** An ordinary piece that reaches the promotion row during a capture chain now continues jumping as an ordinary piece. It becomes a Dama only when the turn ends on that row, following the Filipino Dama rule selected for this app.
- **Changed:** How to Play, README, and the agent checks describe the revised promotion rule. The offline cache version is refreshed for installed clients.

## 1.6.0 — 2026-10-24

- **Added:** Player 1's board view keeps their pieces at the bottom when they choose Blue, including after color swaps in a series and in newly saved replays.
- **Changed:** Visual square order, coordinate labels, board accessibility descriptions, and keyboard directions now follow the displayed orientation while Red still opens every game. Older replays keep the original view.
- **Changed:** Updated the offline cache version for installed clients.

## 1.5.0 — 2026-10-24

- **Added:** Game 1 color selection for Player 1 or the human in both opponent modes, saved across visits.
- **Changed:** Red opens every game; players exchange colors after each series game while names, series scores, and all-time wins follow the players. The computer can play either color.
- **Changed:** End screens, replay snapshots, How to Play, and responsive controls reflect player-owned colors; legacy names, scores, and replays remain available. Updated the offline cache version.

## 1.4.0 — 2026-10-24

- **Added:** Best of 5 and Best of 9 series for local and computer opponents, with 3- and 5-win early finishes and a fixed game limit.
- **Changed:** Match progress, final results, help text, and saved replay labels now reflect the selected series length. Drawn games count toward the selected game limit.
- **Changed:** The match-format selector adapts to desktop and mobile widths; the PWA cache version refreshes offline assets.
