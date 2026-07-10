#!/usr/bin/env bash
# Generates a self-signed test PKI:
#   root.pem  - self-signed CA (the trust anchor for the "valid" test)
#   leaf.pem  - signing certificate, issued by the root
#   leaf.key  - leaf private key (used by `create` to sign the manifest)
#   chain.pem - leaf + root, the full chain embedded in the manifest
#
# For the trusted-path test, point NODE_EXTRA_CA_CERTS at root.pem so the
# verifier anchors the chain without touching the system trust store.
set -euo pipefail
cd "$(dirname "$0")"

SUBJ_ROOT="/CN=SEA Test Root CA/O=builtinsea"
SUBJ_LEAF="/CN=SEA Test Signer/O=builtinsea"

# Root CA (self-signed).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout root.key -out root.pem -days 3650 -subj "$SUBJ_ROOT" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"

# Leaf, signed by the root.
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout leaf.key -out leaf.csr -subj "$SUBJ_LEAF"
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\n' > leaf.ext
openssl x509 -req -in leaf.csr -CA root.pem -CAkey root.key -CAcreateserial \
    -out leaf.pem -days 3650 -extfile leaf.ext
rm -f leaf.csr leaf.ext root.srl

# Full chain, leaf first.
cat leaf.pem root.pem > chain.pem
echo "generated: root.pem leaf.pem leaf.key chain.pem"
