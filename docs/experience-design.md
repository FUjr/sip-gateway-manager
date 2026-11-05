# Design: a shared SIM desk, powered by Asterisk

The product is a place to share cellular lines with personal SIP terminals.
The user's object is a **line** (one modem with a SIM), not a dialplan rule.
A physical gateway owns lines; a terminal is one phone/desktop SIP identity,
not a human login. SIM phone numbers, installed modem slots and online state
are not known to this platform, so the UI must not invent them.

## Underlying model

Asterisk Endpoint is protocol behaviour, Auth is a credential, AoR/Contact is
where a registered endpoint can be reached. These compile from an account and
are connection details, not three things for beginners to create.
Each authenticated endpoint has an isolated context. Client internal extensions
are resolved before external routing. Incoming rules match caller/sender numbers; outgoing rules match destination numbers.
The dedicated graphical editor supports weekdays and time windows in each tenant timezone.
Outbound traffic uses an explicitly selected modem endpoint. Voice bridges through
Asterisk (direct_media=no); SIP MESSAGE is independently routed and durably queued
by the backend. A MESSAGE success is not a cellular delivery receipt.

References:
- https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/PJSIP-Configuration-Sections-and-Relationships/
- https://docs.asterisk.org/Configuration/Dialplan/Contexts-Extensions-and-Priorities/
- https://docs.asterisk.org/Latest_API/API_Documentation/Dialplan_Applications/MessageSend/

## Product abstraction

Default navigation is **My lines / My terminals / SMS history**. Connections and
technical routing live under advanced configuration. Each line has four purposes:
who answers calls; who receives SMS; who may call out; who may send SMS. Each
purpose displays its configured people and external number scope separately.
The overview is a semantic circuit: external world ↔ selected cellular line ↔
sharing service ↔ personal terminals. A physical gateway is the line's location;
the WebUI is a control surface, not an extra node in the audio path. Number
restrictions belong to outbound use, not to the cellular connection itself.

The beginner editor asks for a purpose, terminal(s), and (outbound only) allowed
numbers. It atomically compiles to validated account references, groups and routes.
It never creates/changes credentials or widens an exact-number scope implicitly.
Several receivers ring simultaneously for voice; SMS is delivered independently.
No catch-all route is automatically created. Unconfigured purposes remain closed.

## Preserve truth and existing work

- Existing simple configuration projects into purposes without migration or writes.
- Conditional inbound rules, shared inbound sources or several rules for one
  purpose remain custom; show that fact and link to advanced configuration.
- Editing a purpose preserves its ID, priority, name and other purposes. Groups
  shared elsewhere are never edited; a new group is created/reused when needed.
- Reject overlapping outbound purposes in the beginner editor rather than hide
  first-match precedence. Advanced routing continues to support deliberate splits.
- Save uses a configuration revision and one transaction. Stale edits fail without
  writes. Saved state and applied state remain distinct. No automatic apply.
- The interactive rehearsal uses the actual resolver for the saved configuration,
  including internal extension precedence and disabled services; it performs no
  calls/SMS. Changing its inputs invalidates the displayed answer.
- No green line is evidence of registration. The diagram describes service intent;
  cellular health, installed credentials and actual registration remain separate.

## Acceptance

Existing exact-10099 purposes retain their restrictions. Two lines do not imply
permission to use both. A beginner can set incoming voice with several terminals,
see simultaneous ringing, and separately leave SMS unconfigured. Stale saves,
shared rules, disabled accounts, internal-number collisions and overlapping
outbound purposes cannot silently change unrelated behaviour. Desktop and mobile
render the same semantic relationships, with visible and labelled connectors.
