# Contributing

Contributions are licensed under GPL-3.0, as described in LICENSE. Keep changes
focused and include tests for routing, tenant isolation, configuration publication,
or SIP behavior affected by the change.

Use synthetic accounts and isolated containers. Never commit deployment data,
credentials, enrollment exports, certificates, or captures containing real calls.
Do not run tests against a production PBX or send real calls/SMS without permission.

Follow the validation commands in README.md and the GitHub Actions workflow.
Describe the behavior before and after the change, tests run, and any remaining
hardware or network validation. Host or simulated SIP tests do not establish
real modem compatibility.
