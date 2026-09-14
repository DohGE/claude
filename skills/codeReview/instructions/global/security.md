---
name: Security
applies-to:
  - "!**/models/**"
gate: the file carries something a security rule can bite - code, markup, configuration or data; a pure re-export barrel (only `export * from` lines) carries none of it
scopes:
  ts: ["**/*.ts", "!**/*.spec.ts"]
  markup: ["**/*.html"]
  config: ["**/package.json", "**/angular.json", "**/*.env", "**/environment*.ts"]
---
## Checklist
- {ts} No `DomSanitizer.bypassSecurityTrust*` calls without a justification in the PR description and a provably static, developer-controlled value — never on user-, API- or URL-derived data.
- {markup} `[innerHTML]` is bound only to trusted i18n translation values (`'key' | translate`); never to user input, API responses, query params or string-concatenated/interpolated HTML.
- {ts, markup} No DOM injection that bypasses Angular sanitization: no `nativeElement.innerHTML`/`outerHTML`, `insertAdjacentHTML`, `document.write`, manual `<script>`/`<iframe>` creation; DOM changes go through templates and bindings.
- {ts} No `eval`, `new Function(...)`, or string arguments to `setTimeout`/`setInterval`.
- {ts, markup} URLs bound to `[href]`/`[src]` or passed to `window.open`/`Router.navigateByUrl` never come unvalidated from user input or query params; `javascript:` URLs are forbidden; redirect targets (`returnUrl`-style params) are validated against an allowlist of internal routes (open-redirect).
- {markup} External links with `target="_blank"` carry `rel="noopener noreferrer"`.
- No secrets in the diff: API keys, tokens, passwords, connection strings or private endpoints — not in code, configs, environment files, tests or comments, not even "temporarily".
- {ts} Sensitive data (tokens, credentials, PII) never appears in log/console statements, URL query params, `localStorage`/`sessionStorage`, or error messages shown to users.
- {ts} `HttpClient` XSRF protection stays enabled — `withNoXsrfProtection()` is forbidden; `withCredentials`/`credentials: 'include'` is added only for a reviewed, documented cross-origin case.
- {ts} Authentication headers are attached by the shared interceptor only — never hand-built per request; an interceptor never forwards `Authorization`/cookies to hosts outside the app's API origin and never logs request/response bodies or headers.
- {ts} Access control is enforced by route guards (and the backend) — hiding a button or menu entry is presentation, not authorization; every security-relevant route added in the diff has its guard.
- {ts, markup} User-provided content (file names, rich text, uploaded HTML/SVG) is treated as untrusted: never rendered through `innerHTML`/`srcdoc` and never used to build selectors, URLs or templates.
- {ts, config} A new third-party dependency introduced in the diff is reported for verification (maintenance status, license, known vulnerabilities) — never silently accepted.
