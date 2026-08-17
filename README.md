# @zincapp/znvault-plugin-powerdns

Vault-backed management of the PowerDNS Authoritative HTTP API from the
`znvault` CLI. The plugin covers zones, RRsets, metadata, DNSSEC keys, TSIG,
autoprimaries, views, networks, search, statistics, cache operations, and a
same-origin API escape hatch.

The PowerDNS endpoint, API key, TLS material, and client settings are stored in
ZnVault. Local connection profiles contain only a Vault profile name and a
secret alias. After the secret and connection are created, DNS commands do not
ask for PowerDNS credentials and do not accept credentials through flags or
environment variables.

## Requirements

- Node.js 20 or newer
- `@zincapp/znvault-cli` 2.11 or newer
- A PowerDNS Authoritative API reachable from the operator machine
- A ZnVault identity allowed to read and decrypt the selected configuration
  secret

The PowerDNS API authenticates requests with `X-API-Key`. This plugin obtains
that value only by decrypting the referenced ZnVault secret in memory.

## Install

From the npm registry after a release:

```bash
znvault plugin install @zincapp/znvault-plugin-powerdns
```

For development:

```bash
git clone https://github.com/vidaldiego/znvault-plugin-powerdns.git
cd znvault-plugin-powerdns
npm ci
npm run check
```

## Create the Vault configuration

Create one ZnVault secret per PowerDNS API connection. `--data-stdin` keeps the
document, including the API key, out of shell history and process arguments:

```bash
znvault --profile operators secret create services/dns/authoritative \
  --type setting \
  --sub-type powerdns \
  --data-stdin
```

Paste a document with this schema, then end standard input:

```json
{
  "schema": "io.zincapp.znvault.powerdns/v1",
  "apiUrl": "https://dns-api.example.com/api/v1",
  "apiKey": "<POWERDNS_API_KEY>",
  "serverId": "localhost",
  "timeoutMs": 15000,
  "maxResponseBytes": 10485760,
  "tls": {
    "rejectUnauthorized": true
  }
}
```

`apiUrl` must end in `/api/v1`. HTTPS certificate verification is enabled by
default. A private CA can be embedded as `tls.ca`. HTTP requires the explicit
`"allowInsecureHttp": true` setting in the Vault document; it is intended only
for a protected local transport. TLS verification can be disabled explicitly
with `"tls": { "rejectUnauthorized": false }`, but supplying the correct CA is
safer.

An opaque secret whose `text` field contains the same JSON document is also
supported.

## Connection profiles

Add a local name for the Vault reference while using the same ZnVault profile
that owns the secret:

```bash
znvault --profile operators powerdns profile add primary \
  --secret-alias services/dns/authoritative \
  --activate

znvault --profile operators powerdns profile check primary
znvault powerdns profile list
```

Connection profiles live in `~/.znvault/powerdns/profiles.json`. The directory
is mode `0700`, the file is mode `0600`, writes are atomic, and the file never
contains an endpoint, API key, certificate, or other PowerDNS credential. Each
connection is pinned to the ZnVault CLI profile used when it was created. The
plugin refuses to decrypt it under a different profile.

Use the active connection or select another one before the subcommand:

```bash
znvault powerdns zone list
znvault powerdns --connection secondary zone list
```

## Common operations

```bash
# Servers, search, and statistics
znvault powerdns server list
znvault powerdns server show
znvault powerdns server statistics
znvault powerdns search 'www.example.com.' --object-type record

# Zones
znvault powerdns zone list
znvault powerdns zone show example.com
znvault powerdns zone create example.com \
  --kind Native \
  --nameserver ns1.example.com \
  --nameserver ns2.example.com
znvault powerdns zone notify example.com --yes
znvault powerdns zone rectify example.com --yes
znvault powerdns zone export example.com --output example.com.zone
znvault powerdns zone delete example.com --yes

# RRsets
znvault powerdns record list example.com
znvault powerdns record replace example.com www.example.com A \
  --ttl 300 \
  --content 192.0.2.20 \
  --yes
znvault powerdns record extend example.com example.com TXT \
  --content '"verification=example"'
znvault powerdns record prune example.com example.com TXT \
  --content '"verification=example"' \
  --yes
znvault powerdns record delete example.com www.example.com A --yes

# Metadata and DNSSEC
znvault powerdns metadata list example.com
znvault powerdns metadata set example.com ALLOW-AXFR-FROM \
  --value 192.0.2.0/24 \
  --yes
znvault powerdns cryptokey list example.com
znvault powerdns cryptokey create example.com --keytype csk --active

# TSIG
znvault powerdns tsig list
znvault powerdns tsig create transfer-key --algorithm hmac-sha256

# Autoprimaries, views, and networks
znvault powerdns autoprimary list
znvault powerdns view list
znvault powerdns view add-zone internal example.com..internal
znvault powerdns network set 192.0.2.0 24 internal --yes
```

`record extend` and `record prune` require a PowerDNS version that supports the
`EXTEND` and `PRUNE` RRset change types. Views and networks require a PowerDNS
version and backend that support views.

## JSON-driven operations

Complex objects can be supplied from files without adding a flag for every
PowerDNS field:

```bash
znvault powerdns zone create example.com --from zone.json
znvault powerdns zone update example.com --from zone-settings.json --yes
znvault powerdns record patch example.com --from rrsets.json --yes
```

The generic request command covers API additions and less common endpoints. It
accepts only paths on the configured `/api/v1` origin, rejects redirects, and
requires `--yes` for mutations:

```bash
znvault powerdns api request GET /servers/localhost/config
znvault powerdns api request PUT /servers/localhost/cache/flush \
  --body flush.json \
  --yes
```

Responses redact fields commonly used for secrets. `--reveal-secrets --yes`
disables that redaction for an intentional inspection. DNSSEC private keys and
TSIG key material have equivalent `--reveal --yes` controls.

## Command groups

| Group | Coverage |
| --- | --- |
| `profile` | Add, list, show, select, remove, and connectivity-check Vault references |
| `server` | List servers, inspect one server, and read statistics |
| `zone` | List, show, create, update, delete, export, notify, rectify, and retrieve AXFR |
| `record` / `rrset` | List, replace, extend, prune, delete, and apply JSON RRset patches |
| `metadata` | List, get, add, replace, and delete zone metadata |
| `cryptokey` | List, inspect, generate/import, change state, and delete DNSSEC keys |
| `tsig` | List, inspect, generate/import, update, and delete TSIG keys |
| `autoprimary` | List, add, and remove autoprimaries |
| `view` | List views and add or remove zone variants |
| `network` | List, inspect, and set network-to-view mappings |
| `search` | Search zones, records, and comments |
| `cache` | Flush a name or the complete cache |
| `api` | Same-origin access to the remaining and future HTTP API surface |

## Security properties

- No `--api-key`, endpoint, username, password, or credential environment
  fallback exists.
- ZnVault tenant context comes from the authenticated CLI profile; the plugin
  never accepts a tenant identifier.
- Vault metadata is resolved by alias and revalidated after decrypting with
  reference resolution disabled.
- Connection secrets are held only for the lifetime of one command.
- HTTPS verification is on by default, redirects are rejected, responses have
  a configurable size limit, and requests have a timeout.
- PowerDNS error bodies are not copied into exceptions, preventing accidental
  disclosure of submitted key material.
- Destructive operations require an explicit `--yes`.
- Private DNSSEC and TSIG material is redacted unless explicitly revealed.

ZnVault audit logs remain the source of truth for who decrypted a connection
secret. PowerDNS access controls and audit facilities remain responsible for
authorizing and recording the downstream DNS operation.

## Development

```bash
npm ci
npm run check
npm run test:coverage
npm pack --dry-run
```

The implementation follows the official
[PowerDNS Authoritative HTTP API](https://doc.powerdns.com/authoritative/http-api/)
and its [routing table](https://doc.powerdns.com/authoritative/http-routingtable.html).
