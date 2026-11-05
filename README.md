# SIP Gateway Manager

Authenticated, multi-tenant SIP management for Asterisk 22: device modem accounts,
external SIP clients, client groups, independent voice/SMS routes, and QModem JSON enrollment.
The Compose stack has exactly two containers: Asterisk plus FastAPI/SQLite, and a React/Nginx frontend.

## Start

1. Configure `AMI_SECRET` (24+ random characters) in `.env` and install a trusted certificate in `certs/fullchain.pem` and `certs/privkey.pem`.
2. Run `docker compose up -d --build`, open HTTPS port 8443 and register the first account. It becomes the platform administrator and owns its own tenant.
3. Public registration is closed automatically. Administrators can create tenants or enable registration under **账号与租户**. Each tenant has one login and independently owned lines, terminals and routing rules.
4. Set the public hostname under administrator connection settings, apply it, create a gateway and one line per modem, then add SIP terminals. Export the line enrollment JSON for QModem.
5. Use **电话规则** and **短信规则** to edit source, number, weekdays/time windows and destinations. Click a topology to edit. Save, rehearse, then apply. Applying one tenant preserves other tenants' unpublished drafts.

Login passwords require 12–128 characters and are stored using salted scrypt. SIP credentials remain independent and require at least 16 characters. Internal short numbers are local to each tenant. Number conditions match the caller/sender for incoming traffic and destination for outgoing traffic. Time windows use the tenant timezone, include the start and exclude the end; overnight windows belong to their starting weekday. Offline SMS retries retain their original targets.

Use a **new data volume** for this version: legacy single-admin data is deliberately rejected, never deleted. Preserve the original volume for rollback. Tenant removal revokes access, cancels pending SMS and removes resources; connected calls finish naturally. Retired SIP account identities cannot be reused by another tenant.

Hostname changes require a PBX restart after applying. Transport/RTP port changes require a restart with matching port mappings. Back up `gateway-data` securely. Stop with `docker compose down` without `-v` to retain production data.

## Beginner WebUI

The default **我的线路** page models one modem/SIM as a shared cellular line.
Select a line and arrange four independent purposes: **who answers calls, who
receives SMS, who may call out, and who may send SMS**. The semantic diagram
shows external network, the selected line (inside its physical gateway), the
shared switching service, and the personal terminals. It is a service model,
not a display of individual dialplan rules or evidence of online registration.

**接听终端** creates connection identities for personal phones/desktops, not
administrator logins. Connection identities and unused internal numbers are
created automatically; passwords remain hidden until requested. Gateway enrollment
and client connection instructions are available beside each line/terminal.
Technical accounts, groups, rules and transports remain under **高级配置与连接**.

The purpose editor compiles one user intent atomically into validated groups and
routes. It preserves other purposes and shared group membership, rejects stale
configuration revisions, and refuses ambiguous overlapping outbound uses. Custom
conditional/shared dialplans stay under advanced configuration instead of being
silently flattened. Incoming conditions match the original caller/sender. Scheduled rules are edited
in the dedicated graphical rule editor. Existing number restrictions are preserved when editing.

**号码预演** uses the backend's real resolver for the saved configuration to show
which line/terminal would be chosen, including internal-short-number precedence
and blocked requests. It never places a call, sends SMS or changes configuration.
Saved and applied state remain distinct; the global indicator survives reloads.
Delivery labels distinguish SIP delivery from carrier confirmation.

See [the product model and design rationale](docs/experience-design.md).

## Routing

A **device account** identifies one modem, not an entire router. Inbound rules select device sources
and client/group destinations. Outbound rules select client sources and a device destination.
SMS and voice have independent enabled flags and rules. Rules match exact numbers, prefixes, or any
number; lower priority runs first, ties sort by rule ID, and only the first matching rule runs.
No match rejects the request. Client-to-client numeric extensions support internal voice and SMS.
Voice groups ring eligible registered members in parallel; the first answer wins.
SMS groups create an independent durable delivery for every eligible member.

SMS acceptance (`202`) follows durable SQLite insertion. Delivery is recorded only after a final
SIP response, not the AMI action acknowledgement. Offline recipients retry independently, starting
at 30 seconds and capped at 5 minutes; registration wakes waiting deliveries. Default TTL is 7 days.
Bodies are erased when all targets finish or TTL expires; delivery metadata is retained 30 days.
Stable per-target delivery IDs let QModem's managed sender deduplicate cellular sends. Ordinary
external SIP clients may receive duplicates after a lost acknowledgement (at-least-once delivery).
Messages are UTF-8 text/plain, at most 4096 bytes. This is SIP MESSAGE routing, not SMS-over-IMS.

## Security and operation

Only HTTPS frontend, SIP TLS, and RTP are published. AMI binds to loopback; MESSAGE ingress and
completion callbacks use a private Unix socket. The WebUI uses an authenticated HttpOnly session,
CSRF checks, login throttling, and no public internal callback endpoints. Credentials and message history are restricted to their owning tenant.

Asterisk's image is pinned by digest and the matching module source archive by SHA-256.
Accounts use TLS, digest authentication, NAT contact rewriting and anchored RTP. External clients
must support SIP TLS and PCMA/PCMU. There is no built-in WebRTC softphone or automatic TLS issuer.
Health checks require both the backend and the custom Asterisk module.

## Validation

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
.venv/bin/python -m pytest -q
cd frontend
npm ci
npm run build
npx playwright install chromium
npx playwright test
```

Browser tests mock the API with isolated fixtures and need only a frontend server; they do not
modify the running gateway. Set `WEB_TEST_URL=http://localhost:5173` when using the Vite dev server.
An existing Chromium installation can be selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
The real SIP test runs from the repository root:
`SIP_TEST_PORT=15061 WEB_TEST_URL=https://localhost:28443 .venv/bin/python tests/protocol.py`.
It requires a trusted test certificate for `sip.test` and creates test accounts/routes, so run it
only against a disposable stack. It covers TLS registration, digest authentication, internal/group
voice setup and bidirectional internal RTP, bidirectional SMS, per-recipient offline recovery and stable-ID deduplication.

QModem target builds and service/import tests are separate from physical acceptance. Two real
modems with concurrent cellular calls, PCM traffic, AT/ADB recovery and SMS sends still require DUT
validation. No firmware flash or production deployment is performed by these tests.

## Release deployment

Tagging `v*` runs GitHub Actions validation and publishes two amd64 images in
`sip-gateway-manager-images-amd64.tar.gz`, `compose.release.yaml` and `SHA256SUMS`.
Verify checksums, load the archive using `docker load`, configure `.env` and TLS
certificates as above, then run
`RELEASE_TAG=v1.0.0 docker compose -f compose.release.yaml up -d --wait`.
The release uses a fresh named data volume. Preserve previous service files and
volumes until the new service and gateway registration have been verified.
