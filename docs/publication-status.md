# GitHub source publication

The `main` branch contains the completed local HAMDEE continuation from
`54bd7c8b2735470a572b5e2ce0308f9d360fc93c`. This publication adds only this
status note and disables Vercel Git-triggered deployments from `main`.
Application code, existing migrations and tests remain identical to that candidate.

The candidate's recorded local evidence is 647 regression tests, 28 native
PostgreSQL checks and 208 desktop/mobile browser checks, plus successful
typecheck, lint, build and 81 runtime checks. These are local results, not
hosted acceptance results. See `client-release.md` and
`client-requirements-review.md` for the implementation and requirement mapping.

Hosted acceptance remains pending. The existing DEMO database may contain real
client records and must not be treated as a certified synthetic test destination.
The experimental Preview binding is excluded from this publication. A certified
test destination, recovery verification and destination-specific reviewed upgrade
are required before hosted acceptance. No hosted migration or deployment is
authorized by this source publication.

R29, R31, R33 and R34 retain their narrow source-identity or calculation decisions.
Do not invent vehicle links, percentages, historical openings, dates, currencies
or fines. Do not replay local-only migrations against Production.
