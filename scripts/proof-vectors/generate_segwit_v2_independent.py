#!/usr/bin/env python3
"""Independently generate BIP-322 SegWit vectors signed over a VERSION-2 to_sign.

Pure-Python (stdlib only): hand-written secp256k1 point arithmetic, RFC-6979
deterministic ECDSA, BIP-143 sighash, BIP-322 to_spend/to_sign construction
and bech32 address encoding. Deliberately shares NO code with the
bitcoinjs-lib / @noble stack the app's verifier uses, so a shared sighash bug
(e.g. mis-committing nVersion) cannot pass both sides.

Run: python3 scripts/proof-vectors/generate_segwit_v2_independent.py
Outputs the address + base64 witness for:
  - native P2WPKH
  - P2WSH single-key (<pk> OP_CHECKSIG)
  - P2SH-P2WPKH (base58check P2SH address; redeem-script push in scriptSig
    is implied by the wrapper — the exported proof is the witness stack)
  - P2SH-P2WSH single-key
All commit to a to_sign transaction with nVersion = 2.
"""
import hashlib
import hmac
import base64

MSG = b"Hello World"

# --- secp256k1 -------------------------------------------------------------
P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)


def modinv(a, m):
    return pow(a, -1, m)


def point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1) * modinv(2 * y1, P) % P
    else:
        lam = (y2 - y1) * modinv(x2 - x1, P) % P
    x3 = (lam * lam - x1 - x2) % P
    return (x3, (lam * (x1 - x3) - y1) % P)


def point_mul(k, pt):
    r = None
    while k:
        if k & 1:
            r = point_add(r, pt)
        pt = point_add(pt, pt)
        k >>= 1
    return r


def compress(pt):
    x, y = pt
    return bytes([2 + (y & 1)]) + x.to_bytes(32, "big")


# --- hashes ------------------------------------------------------------------

def sha256(b):
    return hashlib.sha256(b).digest()


def dsha256(b):
    return sha256(sha256(b))


def hash160(b):
    return hashlib.new("ripemd160", sha256(b)).digest()


def tagged_hash(tag, m):
    t = sha256(tag.encode())
    return sha256(t + t + m)


# --- RFC 6979 deterministic ECDSA -------------------------------------------

def rfc6979_k(privkey, msghash):
    x = privkey.to_bytes(32, "big")
    k = b"\x00" * 32
    v = b"\x01" * 32
    k = hmac.new(k, v + b"\x00" + x + msghash, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    k = hmac.new(k, v + b"\x01" + x + msghash, hashlib.sha256).digest()
    v = hmac.new(k, v, hashlib.sha256).digest()
    while True:
        v = hmac.new(k, v, hashlib.sha256).digest()
        cand = int.from_bytes(v, "big")
        if 1 <= cand < N:
            return cand
        k = hmac.new(k, v + b"\x00", hashlib.sha256).digest()
        v = hmac.new(k, v, hashlib.sha256).digest()


def ecdsa_sign(privkey, msghash):
    z = int.from_bytes(msghash, "big")
    while True:
        k = rfc6979_k(privkey, msghash)
        pt = point_mul(k, G)
        r = pt[0] % N
        if r == 0:
            continue
        s = modinv(k, N) * (z + r * privkey) % N
        if s == 0:
            continue
        if s > N // 2:
            s = N - s
        return r, s


def der(r, s):
    def enc_int(v):
        b = v.to_bytes((v.bit_length() + 8) // 8, "big")
        return b"\x02" + bytes([len(b)]) + b

    body = enc_int(r) + enc_int(s)
    return b"\x30" + bytes([len(body)]) + body


# --- serialization helpers ---------------------------------------------------

def varint(n):
    if n < 0xFD:
        return bytes([n])
    if n <= 0xFFFF:
        return b"\xfd" + n.to_bytes(2, "little")
    return b"\xfe" + n.to_bytes(4, "little")


def push(data):
    assert len(data) < 0x4C
    return bytes([len(data)]) + data


# --- bech32 -------------------------------------------------------------------
CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def bech32_polymod(values):
    gen = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((b >> i) & 1) else 0
    return chk


def bech32_encode(hrp, witver, prog):
    data = [witver] + convertbits(prog, 8, 5)
    hrp_exp = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    polymod = bech32_polymod(hrp_exp + data + [0] * 6) ^ 1  # bech32 (v0)
    chk = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(CHARSET[d] for d in data + chk)


def convertbits(data, frombits, tobits):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    for value in data:
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if bits:
        ret.append((acc << (tobits - bits)) & maxv)
    return ret


# --- base58check (for P2SH addresses) -----------------------------------------
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58check(payload):
    data = payload + dsha256(payload)[:4]
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, rem = divmod(n, 58)
        out = B58[rem] + out
    for b in data:
        if b == 0:
            out = "1" + out
        else:
            break
    return out


def p2sh_address(redeem_script):
    return base58check(b"\x05" + hash160(redeem_script))


# --- BIP-322 tx construction ---------------------------------------------------

def to_spend_tx(scriptpubkey, msg):
    mh = tagged_hash("BIP0322-signed-message", msg)
    scriptsig = b"\x00\x20" + mh
    tx = (
        (0).to_bytes(4, "little")  # nVersion 0
        + varint(1)
        + b"\x00" * 32
        + (0xFFFFFFFF).to_bytes(4, "little")
        + varint(len(scriptsig))
        + scriptsig
        + (0).to_bytes(4, "little")  # sequence 0
        + varint(1)
        + (0).to_bytes(8, "little")
        + varint(len(scriptpubkey))
        + scriptpubkey
        + (0).to_bytes(4, "little")  # locktime
    )
    return tx


def bip143_sighash_v2(to_spend_txid, script_code, msg_scriptpubkey=None):
    """BIP-143 sighash for the to_sign tx with nVersion = 2 (SIGHASH_ALL)."""
    outpoint = to_spend_txid + (0).to_bytes(4, "little")
    hash_prevouts = dsha256(outpoint)
    hash_sequence = dsha256((0).to_bytes(4, "little"))
    out = (0).to_bytes(8, "little") + varint(1) + b"\x6a"  # value 0, OP_RETURN
    hash_outputs = dsha256(out)
    pre = (
        (2).to_bytes(4, "little")  # nVersion 2 <-- the point of these vectors
        + hash_prevouts
        + hash_sequence
        + outpoint
        + varint(len(script_code))
        + script_code
        + (0).to_bytes(8, "little")  # amount 0
        + (0).to_bytes(4, "little")  # nSequence 0
        + hash_outputs
        + (0).to_bytes(4, "little")  # nLockTime
        + (1).to_bytes(4, "little")  # SIGHASH_ALL
    )
    return dsha256(pre)


def witness_b64(items):
    out = varint(len(items))
    for it in items:
        out += varint(len(it)) + it
    return base64.b64encode(out).decode()


def main():
    priv = int.from_bytes(sha256(b"vault-independent-segwit-v2-vector-key"), "big") % N
    pub = compress(point_mul(priv, G))
    print("pubkey:", pub.hex())

    # --- native P2WPKH ---
    pkh = hash160(pub)
    spk = b"\x00\x14" + pkh
    addr = bech32_encode("bc", 0, list(pkh))
    txid = dsha256(to_spend_tx(spk, MSG))
    script_code = b"\x76\xa9\x14" + pkh + b"\x88\xac"
    sighash = bip143_sighash_v2(txid, script_code)
    r, s = ecdsa_sign(priv, sighash)
    sig = der(r, s) + b"\x01"
    print("P2WPKH addr:", addr)
    print("P2WPKH sig :", witness_b64([sig, pub]))

    # --- P2WSH single-key (<pk> OP_CHECKSIG) ---
    wscript = push(pub) + b"\xac"
    sh = sha256(wscript)
    spk = b"\x00\x20" + sh
    addr = bech32_encode("bc", 0, list(sh))
    txid = dsha256(to_spend_tx(spk, MSG))
    sighash = bip143_sighash_v2(txid, wscript)
    r, s = ecdsa_sign(priv, sighash)
    sig = der(r, s) + b"\x01"
    print("P2WSH addr:", addr)
    print("P2WSH sig :", witness_b64([sig, wscript]))

    # --- P2SH-P2WPKH ---
    # Redeem script is the v0 witness program (0x00 0x14 <pkh>); the to_spend
    # scriptPubKey is P2SH of it, and the BIP-143 script_code is the implied
    # P2PKH. The redeem-script push in the to_sign scriptSig doesn't enter the
    # BIP-143 digest; the exported proof is the witness stack alone.
    redeem = b"\x00\x14" + pkh
    spk = b"\xa9\x14" + hash160(redeem) + b"\x87"
    addr = p2sh_address(redeem)
    txid = dsha256(to_spend_tx(spk, MSG))
    script_code = b"\x76\xa9\x14" + pkh + b"\x88\xac"
    sighash = bip143_sighash_v2(txid, script_code)
    r, s = ecdsa_sign(priv, sighash)
    sig = der(r, s) + b"\x01"
    print("P2SH-P2WPKH addr:", addr)
    print("P2SH-P2WPKH sig :", witness_b64([sig, pub]))

    # --- P2SH-P2WSH single-key (<pk> OP_CHECKSIG) ---
    redeem = b"\x00\x20" + sha256(wscript)
    spk = b"\xa9\x14" + hash160(redeem) + b"\x87"
    addr = p2sh_address(redeem)
    txid = dsha256(to_spend_tx(spk, MSG))
    sighash = bip143_sighash_v2(txid, wscript)
    r, s = ecdsa_sign(priv, sighash)
    sig = der(r, s) + b"\x01"
    print("P2SH-P2WSH addr:", addr)
    print("P2SH-P2WSH sig :", witness_b64([sig, wscript]))

    # --- P2SH-P2WSH 2-of-2 OP_CHECKMULTISIG ---
    # Witness script: OP_2 <pk1> <pk2> OP_2 OP_CHECKMULTISIG. Witness stack is
    # [<empty CHECKMULTISIG dummy>, sig1, sig2, witnessScript], signatures in
    # the same order as the pubkeys in the script. Exercises the multisig
    # witness-script path independently of the bitcoinjs stack (script
    # ordering, empty dummy element, multi-signature BIP-143 sighash).
    priv2 = int.from_bytes(sha256(b"vault-independent-segwit-v2-vector-key-2"), "big") % N
    pub2 = compress(point_mul(priv2, G))
    print("pubkey2:", pub2.hex())
    ms_script = b"\x52" + push(pub) + push(pub2) + b"\x52\xae"
    redeem = b"\x00\x20" + sha256(ms_script)
    spk = b"\xa9\x14" + hash160(redeem) + b"\x87"
    addr = p2sh_address(redeem)
    txid = dsha256(to_spend_tx(spk, MSG))
    sighash = bip143_sighash_v2(txid, ms_script)
    r, s = ecdsa_sign(priv, sighash)
    sig1 = der(r, s) + b"\x01"
    r, s = ecdsa_sign(priv2, sighash)
    sig2 = der(r, s) + b"\x01"
    print("P2SH-P2WSH 2of2 addr:", addr)
    print("P2SH-P2WSH 2of2 sig :", witness_b64([b"", sig1, sig2, ms_script]))


if __name__ == "__main__":
    main()
