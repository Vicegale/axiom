# 0001. Local server, opened in the browser

- Status: accepted
- Date: 2026-11-25
- Spec section: docs/spec/06-architecture.md (T1, T7)

## Context

Axiom is a locally run app with a web view (00). It needs a process that keeps running for automatic statuses now and the proactive agent later.

## Decision

One local server process, run as a systemd user service, serving the HTTP API and the web UI on `127.0.0.1`. The owner opens it in their normal browser. Desktop notifications come from the browser (Web Notifications API).

## Alternatives considered

- Tauri or Electron desktop shell: a native window and native notifications, but a packaging and update burden for a single user.
- Server-sent desktop notifications through libnotify: work with no tab open; rejected by the owner in favour of browser notifications.

## Consequences

- Notifications only appear while an Axiom tab is open (it can sit in the background).
- Bound to loopback only; no authentication in the first build.
- A desktop shell can still wrap the same web UI later.
