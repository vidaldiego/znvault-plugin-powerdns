# Security policy

Please report suspected vulnerabilities privately through GitHub's security
advisory interface. Do not open a public issue containing credentials, DNS
data, private key material, Vault aliases, endpoints, or exploit details.

Supported releases are the latest published minor release. Reports should
include the plugin version, Node.js version, PowerDNS version, and a minimal
reproduction using synthetic data.

This project intentionally has no credential flags or environment-variable
fallback. A proposal that adds either mechanism must include a threat-model
update and will be rejected unless it preserves the Vault-only trust boundary.
