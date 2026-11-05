# Security

SIP Gateway Manager stores SIP credentials and tenant configuration. Do not
include enrollment JSON, database files, environment files, certificates, or
raw SIP traces in public issues or pull requests. Use synthetic examples and
redact telephone numbers, authentication headers, host identities, and tokens.

Report suspected vulnerabilities privately through GitHub private vulnerability
reporting when it is available. Otherwise contact the repository owner privately
before disclosing details. Do not post a working exploit or production secrets
in a public issue.

Use trusted TLS certificates, unique AMI and SIP secrets, restricted management
access, and protected backups. Keep the AMI and internal routing API private.
Registration closes after the first administrator is created; review account and
tenant permissions before opening the service to users.

Phone calls and SMS can incur charges. Test with isolated accounts and explicit
permission before using real numbers or changing a production deployment.
