# HAMDEE workspace design

Preserve the existing HAMDEE interface and workflows for one approved owner/admin. Partners and tenants are records; they do not receive portals in this milestone. Authentication and persistent property metadata use the existing vanilla workspace, not a new frontend framework.

The gold/brass branding, HAMDEE logo, Inter font, approximately13px interface text,232px desktop sidebar, pale limestone canvas, white cards, subtle borders, icons, navigation and card/table/detail hierarchy remain. The source assets are local in `public/shared/`; workspace-specific styling is in `public/workspace/foundation.css`. A static font-path alias preserves the inherited stylesheet URL without changing the shared asset bytes.

Property identity/revision, create/edit dialogs, reversible archive/restore reasons and audit history remain visible and attributable. Dashboard counts come from saved metadata. Unavailable financial modules do not display fabricated balances or treat zero as an accepted financial result. The development banner and unconfigured-backend state communicate the actual boundary.

Native forms/dialogs retain labels, keyboard dismissal/focus return, actionable errors and pending-state feedback. Drafts survive recoverable network/version errors and clear on session loss; stale responses cannot restore protected UI. Tables/tabs scroll within containers on mobile, and navigation remains collapsible. Respect reduced motion. No new motion or visual redesign was introduced by standalone packaging.

The current owner flow is managed email/password sign-in directly to Dashboard after server verification of the sole owner and enabled membership. It has no mandatory MFA, enrollment, QR/OTP screen or one-hour assurance freshness gate. Preserve CSRF protection, server session expiry, explicit logout and recovery preparation. Partners and tenants remain business records, not login accounts. Historical security checkpoint documents do not define the current login experience.

Form recovery should keep a failed sign-in actionable without resubmitting credentials automatically. An expired CSRF write proof can be renewed through a safe read while retaining an operational draft; saving again always requires an explicit action. Property search should distinguish an empty register from empty filtered results and offer a direct way to clear filters. These refinements reuse existing native controls, panel hierarchy, brass actions, white surfaces, Inter and compact spacing; no new visual direction or motion is selected.

Browser coverage includes desktop1440×1000 and mobile390×844, owner email/password login, property/history, empty/error/conflict states, keyboard access and late-response handling. Automated checks do not constitute full screen-reader or cross-browser certification. Test screenshots and reports are ignored artifacts, not public source.
