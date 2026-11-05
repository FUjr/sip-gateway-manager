# SIP Gateway WebUI

## Navigation

- 概览: counts, SIM lines, extensions, live registration, and routing shortcuts.
- 网关: physical gateways and their SIM accounts.
- SIP 账户: SIM lines and client extensions, connection credentials, enablement.
- 分机组: reusable groups of extensions.
- 电话路由 / 短信路由: ordered rule cards and editable topology.
- 短信记录: per-recipient status and retry.
- 服务器设置: admin-only transport parameters.
- 账户与租户: timezone/password; admin-only tenant and registration management.

Use established SIP and routing terms. Keep explanations for consequential states
and errors. Avoid additional service concepts or instructional dashboard text.

## Rules

Incoming rules match original caller/sender numbers; outgoing rules match target
numbers. Select source accounts, number conditions, destination, and optional
weekday/time windows. Show the source, router, target and external number in the
editable topology. Keep route tests in a collapsible panel. Test inputs invalidate
old answers. Saved and applied versions can be tested separately.

Preserve restrictions and unrelated routes. Versioned atomic rule-set updates
reject stale edits. Reuse identical groups without mutating shared memberships.
No rule implies rejection of external communication. Internal client extensions
resolve within the current tenant before external routing.

## State and credentials

Saving and applying are separate operations. Pending state remains visible in the
shared header and beside connection credentials. Default login username is empty;
password managers may fill previously saved credentials. SIP passwords are masked
until requested, and account IDs remain separate from internal extension numbers.

Live registration comes from Asterisk AMI contacts, filtered to accounts owned by
the current tenant. Enabled and reachable are distinct. If querying Asterisk
fails, show unknown status rather than inventing offline/online state. No contact
address, credential, or other tenant account is returned in the status response.

## Layout

Light navigation, compact tables, and bordered resource/route cards share spacing,
color and typography tokens. Desktop uses a fixed sidebar and two resource columns;
mobile uses scrollable navigation and one column. Topology nodes stack vertically
on mobile. All controls keep labels, focus styles and keyboard access.
