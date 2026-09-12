---
name: Electrum TOFU trust boundary
description: Security rules for the Electrum TLS TOFU pinning design — what may be pinned, and how trust decisions must be validated
---

The Electrum TLS trust design (electron/electrum-client.cjs) has three non-obvious invariants that any future change must preserve:

1. **TOFU is only for PROVEN self-signed leaves.** Eligibility requires `DEPTH_ZERO_SELF_SIGNED_CERT` AND a structurally self-signed leaf (self-referential `issuerCertificate` or subject === issuer). `SELF_SIGNED_CERT_IN_CHAIN` is NOT eligible — it signals an untrusted *private-CA* chain, which must stay a strict rejection.
2. **Hostname identity must be checked independently** via `tls.checkServerIdentity(host, cert)`. Node reports `DEPTH_ZERO_SELF_SIGNED_CERT` *before* hostname mismatches, so `authorizationError` alone never surfaces a wrong-host self-signed cert — it would silently enter the TOFU path.
3. **The trust IPC must never trust renderer-supplied certificate metadata.** Pins are written only when the fingerprint matches a short-lived main-process observation of the cert the server actually presented during the refused connection.

**Why:** Three consecutive code reviews each found a trust-downgrade hole (pin downgrading CA failures; wrong-host self-signed slipping into TOFU; forged renderer `selfSigned` flags). These are the exact attack shapes a MITM uses against Electrum.

**How to apply:** Any change to `evaluateCertificate` or `electrum-trust-certificate` must keep all three invariants; expired/wrong-host/untrusted-CA certs must stay `CERT_INVALID` even with a pre-existing pin. Tests cover each — extend, don't weaken.
