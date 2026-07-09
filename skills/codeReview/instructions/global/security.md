---
name: Security
---
## Checklist
- No `DomSanitizer.bypassSecurityTrust*` calls without a written justification and a provably static, developer-controlled value — never on user-, API- or URL-derived data.
- `[innerHTML]` is bound only to trusted i18n translation values (`'key' | translate`); never to user input, API responses, query params or string-concatenated/interpolated HTML.
- No DOM injection that bypasses Angular sanitization: no `nativeElement.innerHTML`/`outerHTML`, `insertAdjacentHTML`, `document.write`, manual `<script>`/`<iframe>` creation; DOM changes go through templates and bindings.
- No `eval`, `new Function(...)`, or string arguments to `setTimeout`/`setInterval`.
- URLs bound to `[href]`/`[src]` or passed to `window.open`/`Router.navigateByUrl` never come unvalidated from user input or query params; `javascript:` URLs are forbidden; redirect targets (`returnUrl`-style params) are validated against an allowlist of internal routes (open-redirect).
- External links with `target="_blank"` carry `rel="noopener noreferrer"`.
- No secrets in the diff: API keys, tokens, passwords, connection strings or private endpoints — not in code, configs, environment files, tests or comments, not even "temporarily".
- Sensitive data (tokens, credentials, PII) never appears in log/console statements, URL query params, `localStorage`/`sessionStorage`, or error messages shown to users.
- `HttpClient` XSRF protection stays enabled — `withNoXsrfProtection()` is forbidden; `withCredentials`/`credentials: 'include'` is added only for a reviewed, documented cross-origin case.
- Authentication headers are attached by the shared interceptor only — never hand-built per request; an interceptor never forwards `Authorization`/cookies to hosts outside the app's API origin and never logs request/response bodies or headers.
- Access control is enforced by route guards (and the backend) — hiding a button or menu entry is presentation, not authorization; every security-relevant route added in the diff has its guard.
- User-provided content (file names, rich text, uploaded HTML/SVG) is treated as untrusted: never rendered through `innerHTML`/`srcdoc` and never used to build selectors, URLs or templates.
- SSR-enabled apps only: server-side `useValue` providers must be request-independent (a mutable `useValue` singleton is shared between requests and leaks state between users — per-request values use `useFactory`); no user-specific data is serialized into transfer state (`TransferState`, `resource`/`httpResource` `id`) because that HTML may be cached and shared; the HTTP transfer-cache `includeHeaders` option never includes auth or cookie headers.
- A new third-party dependency introduced in the diff is reported for verification (maintenance status, license, known vulnerabilities) — never silently accepted.
