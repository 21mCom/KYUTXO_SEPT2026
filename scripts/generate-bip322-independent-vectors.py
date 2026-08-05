#!/usr/bin/env python3
"""Deterministic generator for the INDEPENDENT BIP-322 Taproot test vectors in
client/src/lib/signatureVerify.test.ts.

Everything here is hand-written pure Python (secp256k1 point arithmetic,
tagged hashes, BIP-340 Schnorr signing, BIP-341 taproot tweak & sighash,
BIP-322 to_spend/to_sign construction, bech32m) with NO third-party crypto
libraries, so the vectors are independent of the bitcoinjs-lib /
@bitcoinerlab/secp256k1 stack the app verifier uses. A shared sighash bug
cannot make both sides agree.

Determinism: all private keys are derived from fixed seed strings (below),
and BIP-340 signing uses aux_rand = 32 zero bytes, so re-running this script
always reproduces the committed constants byte-for-byte.

Usage:  python3 scripts/generate-bip322-independent-vectors.py
Output: the vector constants, labelled with the test-file constant names.

Related: the independent SegWit v2 / P2SH-wrapped vectors (P2WPKH_V2_INDEP_*,
P2WSH_V2_INDEP_*, P2SH_P2WPKH_V2_INDEP_*, P2SH_P2WSH_V2_INDEP_*) are
reproduced by scripts/proof-vectors/generate_segwit_v2_independent.py
(seed-string key + RFC-6979 deterministic ECDSA, so equally re-derivable).

This script also emits the EXT_* "external independent vectors" (P2WSH
2-of-2 / 2-of-3 OP_CHECKMULTISIG, P2TR single-leaf script-path,
CHECKSIGADD 2-of-2 tapscript, and 2-leaf / 4-leaf taproot trees). The
ORIGINAL EXT_* vectors were produced by an uncommitted throwaway script
whose keys were lost, so they were regenerated from the committed seed
strings below (ECDSA is RFC-6979 deterministic, Schnorr uses
aux_rand = 32 zero bytes) — re-running this script reproduces the
committed EXT_* constants byte-for-byte. All EXT_* vectors sign EXT_MSG
("I certify that I control the following Bitcoin address."), commit to a
version-0 to_sign, and preserve the original witness-stack shapes the
tamper tests rely on (2-of-3 signed by NON-ADJACENT cosigners A and C;
CHECKSIGADD stack [sigB, sigA, leafScript, controlBlock]).
"""

import hashlib
import hmac

# ---------------------------------------------------------------- secp256k1

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (
    0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
    0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8,
)


def point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    if p1[0] == p2[0] and (p1[1] + p2[1]) % P == 0:
        return None
    if p1 == p2:
        lam = (3 * p1[0] * p1[0]) * pow(2 * p1[1], P - 2, P) % P
    else:
        lam = (p2[1] - p1[1]) * pow(p2[0] - p1[0], P - 2, P) % P
    x3 = (lam * lam - p1[0] - p2[0]) % P
    return (x3, (lam * (p1[0] - x3) - p1[1]) % P)


def point_mul(k, pt=G):
    r = None
    while k:
        if k & 1:
            r = point_add(r, pt)
        pt = point_add(pt, pt)
        k >>= 1
    return r


def has_even_y(pt):
    return pt[1] % 2 == 0


def xonly(pt):
    return pt[0].to_bytes(32, "big")


# ------------------------------------------------------------- tagged hash

def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def tagged_hash(tag: str, msg: bytes) -> bytes:
    t = sha256(tag.encode())
    return sha256(t + t + msg)


# --------------------------------------------------------- BIP-340 signing

def schnorr_sign(msg32: bytes, seckey: int) -> bytes:
    """BIP-340 default signing with aux_rand = 32 zero bytes (deterministic)."""
    d0 = seckey % N
    assert d0 != 0
    pt = point_mul(d0)
    d = d0 if has_even_y(pt) else N - d0
    aux = b"\x00" * 32
    t = (d ^ int.from_bytes(tagged_hash("BIP0340/aux", aux), "big")).to_bytes(32, "big")
    k0 = (
        int.from_bytes(tagged_hash("BIP0340/nonce", t + xonly(pt) + msg32), "big") % N
    )
    assert k0 != 0
    r_pt = point_mul(k0)
    k = k0 if has_even_y(r_pt) else N - k0
    e = (
        int.from_bytes(
            tagged_hash("BIP0340/challenge", xonly(r_pt) + xonly(pt) + msg32), "big"
        )
        % N
    )
    sig = xonly(r_pt) + ((k + e * d) % N).to_bytes(32, "big")
    return sig


# ------------------------------------------------------------------ bech32m

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


def bech32m_encode_p2tr(prog32: bytes) -> str:
    hrp = "bc"
    data = [1]  # witness v1
    acc = 0
    bits = 0
    for byte in prog32:
        acc = (acc << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            data.append((acc >> bits) & 31)
    if bits:
        data.append((acc << (5 - bits)) & 31)
    hrp_exp = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    polymod = bech32_polymod(hrp_exp + data + [0] * 6) ^ 0x2BC830A3
    checksum = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(CHARSET[d] for d in data + checksum)


# ---------------------------------------------------------------- taproot

def taproot_tweak(internal_x: bytes, merkle_root: bytes):
    """Return (parity, output_x) for internal key + optional merkle root."""
    t = int.from_bytes(tagged_hash("TapTweak", internal_x + merkle_root), "big") % N
    p_pt = lift_x(internal_x)
    q_pt = point_add(p_pt, point_mul(t))
    return (0 if has_even_y(q_pt) else 1), xonly(q_pt)


def lift_x(x32: bytes):
    x = int.from_bytes(x32, "big")
    y_sq = (pow(x, 3, P) + 7) % P
    y = pow(y_sq, (P + 1) // 4, P)
    assert pow(y, 2, P) == y_sq, "no square root — invalid x"
    return (x, y if y % 2 == 0 else P - y)


def tweaked_seckey(seckey: int, merkle_root: bytes) -> int:
    pt = point_mul(seckey % N)
    d = seckey % N if has_even_y(pt) else N - (seckey % N)
    t = int.from_bytes(tagged_hash("TapTweak", xonly(pt) + merkle_root), "big") % N
    return (d + t) % N


# --------------------------------------------------------- tx serialization

def compact_size(n: int) -> bytes:
    assert n < 253
    return bytes([n])


def ser_outpoint(txid_le: bytes, vout: int) -> bytes:
    return txid_le + vout.to_bytes(4, "little")


def bip322_txs(address_script: bytes, message: str, to_sign_version: int):
    """Build the BIP-322 virtual to_spend / to_sign transactions."""
    msg_hash = tagged_hash("BIP0322-signed-message", message.encode())
    script_sig = b"\x00\x20" + msg_hash  # OP_0 PUSH32 <hash>
    # to_spend
    to_spend = (
        (0).to_bytes(4, "little")
        + compact_size(1)
        + ser_outpoint(b"\x00" * 32, 0xFFFFFFFF)
        + compact_size(len(script_sig))
        + script_sig
        + (0).to_bytes(4, "little")  # sequence
        + compact_size(1)
        + (0).to_bytes(8, "little")
        + compact_size(len(address_script))
        + address_script
        + (0).to_bytes(4, "little")  # locktime
    )
    to_spend_txid = sha256(sha256(to_spend))  # little-endian as stored
    return {
        "version": to_sign_version,
        "prevout": ser_outpoint(to_spend_txid, 0),
        "sequence": 0,
        "locktime": 0,
        "prev_script": address_script,
        "prev_value": 0,
        "out_script": b"\x6a",  # OP_RETURN
        "out_value": 0,
    }


def bip341_sighash(tx, annex: bytes | None, leaf_script: bytes | None, sighash_type: int = 0) -> bytes:
    """BIP-341 signature hash for the single-input single-output to_sign tx."""
    assert sighash_type == 0 or sighash_type == 1  # DEFAULT / ALL
    buf = b"\x00"  # sighash epoch
    buf += bytes([sighash_type])
    buf += tx["version"].to_bytes(4, "little")
    buf += tx["locktime"].to_bytes(4, "little")
    # sha_prevouts
    buf += sha256(tx["prevout"])
    # sha_amounts
    buf += sha256(tx["prev_value"].to_bytes(8, "little"))
    # sha_scriptpubkeys
    buf += sha256(compact_size(len(tx["prev_script"])) + tx["prev_script"])
    # sha_sequences
    buf += sha256(tx["sequence"].to_bytes(4, "little"))
    # sha_outputs
    out_ser = tx["out_value"].to_bytes(8, "little") + compact_size(len(tx["out_script"])) + tx["out_script"]
    buf += sha256(out_ser)
    spend_type = (2 if leaf_script is not None else 0) | (1 if annex is not None else 0)
    buf += bytes([spend_type])
    buf += (0).to_bytes(4, "little")  # input_index
    if annex is not None:
        buf += sha256(compact_size(len(annex)) + annex)
    if leaf_script is not None:
        leaf_hash = tagged_hash(
            "TapLeaf", bytes([0xC0]) + compact_size(len(leaf_script)) + leaf_script
        )
        buf += leaf_hash + b"\x00" + (0xFFFFFFFF).to_bytes(4, "little")
    return tagged_hash("TapSighash", buf)


# ------------------------------------------------------------ wire helpers

def witness_b64(items: list[bytes]) -> str:
    import base64

    out = compact_size(len(items))
    for it in items:
        out += compact_size(len(it)) + it
    return base64.b64encode(out).decode()


def key_from_seed(seed: str) -> int:
    return int.from_bytes(sha256(seed.encode()), "big") % N


def p2tr_script(output_x: bytes) -> bytes:
    return b"\x51\x20" + output_x


def flip_annex_byte(annex: bytes) -> bytes:
    # flip one payload byte: 'x' -> 'y' in the first occurrence of 'x' after 0x50
    i = annex.index(b"x", 1)
    return annex[:i] + b"y" + annex[i + 1 :]


MESSAGE = "Hello World"
EXT_MESSAGE = "I certify that I control the following Bitcoin address."


def emit(name: str, value: str):
    print(f"{name} = {value}")


# ---------------------------------------------------- script-path + annex

def gen_annex_script_path():
    internal = key_from_seed("kyutxo-annex-internal-key")
    leaf_key = key_from_seed("kyutxo-annex-leaf-key")
    leaf_pt = point_mul(leaf_key)
    leaf_script = b"\x20" + xonly(leaf_pt) + b"\xac"  # <xonly pk> OP_CHECKSIG
    leaf_hash = tagged_hash(
        "TapLeaf", bytes([0xC0]) + compact_size(len(leaf_script)) + leaf_script
    )
    internal_pt = point_mul(internal)
    parity, output_x = taproot_tweak(xonly(internal_pt), leaf_hash)
    addr = bech32m_encode_p2tr(output_x)
    control = bytes([0xC0 | parity]) + xonly(internal_pt)
    annex = b"\x50" + b"kyutxo annex test vector"

    # This vector signs the extended proof-of-control message used elsewhere
    # in the test file (EXT_MSG), not "Hello World".
    tx = bip322_txs(p2tr_script(output_x), EXT_MESSAGE, 0)
    sh = bip341_sighash(tx, annex, leaf_script, 0)
    sig = schnorr_sign(sh, leaf_key)

    emit("P2TR_ANNEX_ADDR", f"'{addr}'")
    emit("P2TR_ANNEX_SIG", f"'{witness_b64([sig, leaf_script, control, annex])}'")
    emit("P2TR_ANNEX_STRIPPED_SIG", f"'{witness_b64([sig, leaf_script, control])}'")
    emit(
        "P2TR_ANNEX_ALTERED_SIG",
        f"'{witness_b64([sig, leaf_script, control, flip_annex_byte(annex)])}'",
    )


# ------------------------------------------------------ key-path + annex

def gen_annex_key_path():
    seckey = key_from_seed("kyutxo keypath annex vector seed")
    internal_pt = point_mul(seckey)
    _, output_x = taproot_tweak(xonly(internal_pt), b"")
    addr = bech32m_encode_p2tr(output_x)
    annex = b"\x50" + b"kyutxo keypath annex vector"
    tweaked = tweaked_seckey(seckey, b"")

    tx = bip322_txs(p2tr_script(output_x), MESSAGE, 0)
    sig_default = schnorr_sign(bip341_sighash(tx, annex, None, 0), tweaked)
    sig_all = schnorr_sign(bip341_sighash(tx, annex, None, 1), tweaked) + b"\x01"

    emit("P2TR_KEYPATH_ANNEX_ADDR", f"'{addr}'")
    emit("P2TR_KEYPATH_ANNEX_SIG", f"'{witness_b64([sig_default, annex])}'")
    emit("P2TR_KEYPATH_ANNEX_STRIPPED_SIG", f"'{witness_b64([sig_default])}'")
    emit(
        "P2TR_KEYPATH_ANNEX_ALTERED_SIG",
        f"'{witness_b64([sig_default, flip_annex_byte(annex)])}'",
    )
    emit("P2TR_KEYPATH_ANNEX_ALL_SIG", f"'{witness_b64([sig_all, annex])}'")


# --------------------------------------------------- version-2 to_sign

def gen_v2_key_path():
    # NOTE: the originally published key-path v2 vector was signed with a
    # throwaway key whose seed was lost, so it could not be reproduced. The
    # vector was regenerated from this committed seed (the test constants
    # were updated to match); the script-path v2 and annex vectors below/above
    # still reproduce the originally published bytes exactly.
    seckey = key_from_seed("kyutxo v2 taproot keypath key")
    internal_pt = point_mul(seckey)
    _, output_x = taproot_tweak(xonly(internal_pt), b"")
    addr = bech32m_encode_p2tr(output_x)
    tweaked = tweaked_seckey(seckey, b"")

    tx = bip322_txs(p2tr_script(output_x), MESSAGE, 2)
    sig = schnorr_sign(bip341_sighash(tx, None, None, 0), tweaked)

    emit("P2TR_KEYPATH_V2_INDEP_ADDR", f"'{addr}'")
    emit("P2TR_KEYPATH_V2_INDEP_SIG", f"'{witness_b64([sig])}'")


def gen_v2_script_path():
    internal = key_from_seed("kyutxo v2 taproot scriptpath internal key")
    leaf_key = key_from_seed("kyutxo v2 taproot scriptpath leaf key")
    leaf_pt = point_mul(leaf_key)
    leaf_script = b"\x20" + xonly(leaf_pt) + b"\xac"
    leaf_hash = tagged_hash(
        "TapLeaf", bytes([0xC0]) + compact_size(len(leaf_script)) + leaf_script
    )
    internal_pt = point_mul(internal)
    parity, output_x = taproot_tweak(xonly(internal_pt), leaf_hash)
    addr = bech32m_encode_p2tr(output_x)
    control = bytes([0xC0 | parity]) + xonly(internal_pt)

    tx = bip322_txs(p2tr_script(output_x), MESSAGE, 2)
    sig = schnorr_sign(bip341_sighash(tx, None, leaf_script, 0), leaf_key)

    emit("P2TR_SCRIPT_V2_INDEP_ADDR", f"'{addr}'")
    emit("P2TR_SCRIPT_V2_INDEP_SIG", f"'{witness_b64([sig, leaf_script, control])}'")


# ==================================================================
# EXT_* external independent vectors (multisig P2WSH + taproot trees)
# ==================================================================
# The original EXT_* vectors came from an uncommitted throwaway script and
# their keys were lost; these are regenerated from the seed strings below.

# ---------------------------------------------- RFC-6979 deterministic ECDSA

def rfc6979_k(privkey: int, msghash: bytes) -> int:
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


def ecdsa_sign_der(privkey: int, msghash: bytes) -> bytes:
    """RFC-6979 deterministic, low-S ECDSA signature, DER + SIGHASH_ALL byte."""
    z = int.from_bytes(msghash, "big")
    while True:
        k = rfc6979_k(privkey, msghash)
        pt = point_mul(k)
        r = pt[0] % N
        if r == 0:
            continue
        s = pow(k, N - 2, N) * (z + r * privkey) % N
        if s == 0:
            continue
        if s > N // 2:
            s = N - s
        break

    def enc_int(v: int) -> bytes:
        b = v.to_bytes((v.bit_length() + 8) // 8, "big")
        return b"\x02" + bytes([len(b)]) + b

    body = enc_int(r) + enc_int(s)
    return b"\x30" + bytes([len(body)]) + body + b"\x01"  # SIGHASH_ALL


def compress(pt) -> bytes:
    return bytes([2 + (pt[1] & 1)]) + pt[0].to_bytes(32, "big")


def push(data: bytes) -> bytes:
    assert len(data) < 0x4C
    return bytes([len(data)]) + data


# --------------------------------------------------------------- bech32 (v0)

def bech32_encode_p2wsh(prog32: bytes) -> str:
    hrp = "bc"
    data = [0]  # witness v0
    acc = 0
    bits = 0
    for byte in prog32:
        acc = (acc << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            data.append((acc >> bits) & 31)
    if bits:
        data.append((acc << (5 - bits)) & 31)
    hrp_exp = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    polymod = bech32_polymod(hrp_exp + data + [0] * 6) ^ 1  # bech32 (v0)
    checksum = [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]
    return hrp + "1" + "".join(CHARSET[d] for d in data + checksum)


# ------------------------------------------------------------ BIP-143 sighash

def bip143_sighash(to_spend_txid: bytes, script_code: bytes, version: int = 0) -> bytes:
    """BIP-143 SIGHASH_ALL for the single-input single-OP_RETURN-output to_sign."""
    dsha = lambda b: sha256(sha256(b))
    outpoint = to_spend_txid + (0).to_bytes(4, "little")
    pre = (
        version.to_bytes(4, "little")
        + dsha(outpoint)  # hashPrevouts
        + dsha((0).to_bytes(4, "little"))  # hashSequence
        + outpoint
        + compact_size(len(script_code))
        + script_code
        + (0).to_bytes(8, "little")  # amount
        + (0).to_bytes(4, "little")  # nSequence
        + dsha((0).to_bytes(8, "little") + compact_size(1) + b"\x6a")  # hashOutputs
        + (0).to_bytes(4, "little")  # nLockTime
        + (1).to_bytes(4, "little")  # SIGHASH_ALL
    )
    return sha256(sha256(pre))


def to_spend_txid(address_script: bytes, message: str) -> bytes:
    msg_hash = tagged_hash("BIP0322-signed-message", message.encode())
    script_sig = b"\x00\x20" + msg_hash
    to_spend = (
        (0).to_bytes(4, "little")
        + compact_size(1)
        + ser_outpoint(b"\x00" * 32, 0xFFFFFFFF)
        + compact_size(len(script_sig))
        + script_sig
        + (0).to_bytes(4, "little")
        + compact_size(1)
        + (0).to_bytes(8, "little")
        + compact_size(len(address_script))
        + address_script
        + (0).to_bytes(4, "little")
    )
    return sha256(sha256(to_spend))


# -------------------------------------------------------- EXT P2WSH multisig

def gen_ext_p2wsh_multisig():
    key_a = key_from_seed("kyutxo ext p2wsh cosigner A")
    key_b = key_from_seed("kyutxo ext p2wsh cosigner B")
    key_c = key_from_seed("kyutxo ext p2wsh cosigner C")
    pub_a = compress(point_mul(key_a))
    pub_b = compress(point_mul(key_b))
    pub_c = compress(point_mul(key_c))

    # 2-of-2: OP_2 <pkA> <pkB> OP_2 OP_CHECKMULTISIG, both cosigners signing.
    # Witness stack: [<empty CHECKMULTISIG dummy>, sigA, sigB, witnessScript].
    script = b"\x52" + push(pub_a) + push(pub_b) + b"\x52\xae"
    sh = sha256(script)
    spk = b"\x00\x20" + sh
    txid = to_spend_txid(spk, EXT_MESSAGE)
    sighash = bip143_sighash(txid, script, 0)
    sig_a = ecdsa_sign_der(key_a, sighash)
    sig_b = ecdsa_sign_der(key_b, sighash)
    emit("EXT_P2WSH_2OF2_ADDR", f"'{bech32_encode_p2wsh(sh)}'")
    emit("EXT_P2WSH_2OF2_SIG", f"'{witness_b64([b'', sig_a, sig_b, script])}'")

    # 2-of-3: OP_2 <pkA> <pkB> <pkC> OP_3 OP_CHECKMULTISIG, signed by the
    # NON-ADJACENT cosigners A and C (the middle key B does not sign), so the
    # verifier must match sigs to keys in script order while skipping B.
    # Witness stack: [<empty dummy>, sigA, sigC, witnessScript].
    script3 = b"\x52" + push(pub_a) + push(pub_b) + push(pub_c) + b"\x53\xae"
    sh3 = sha256(script3)
    spk3 = b"\x00\x20" + sh3
    txid3 = to_spend_txid(spk3, EXT_MESSAGE)
    sighash3 = bip143_sighash(txid3, script3, 0)
    sig_a3 = ecdsa_sign_der(key_a, sighash3)
    sig_c3 = ecdsa_sign_der(key_c, sighash3)
    emit("EXT_P2WSH_2OF3_ADDR", f"'{bech32_encode_p2wsh(sh3)}'")
    emit("EXT_P2WSH_2OF3_SIG", f"'{witness_b64([b'', sig_a3, sig_c3, script3])}'")


# ------------------------------------------------------ EXT taproot vectors

def tap_leaf_hash(script: bytes) -> bytes:
    return tagged_hash("TapLeaf", bytes([0xC0]) + compact_size(len(script)) + script)


def tap_branch(a: bytes, b: bytes) -> bytes:
    return tagged_hash("TapBranch", (a + b) if a <= b else (b + a))


def gen_ext_taproot():
    # Single-leaf script-path: leaf is <xA> OP_CHECKSIG.
    internal = key_from_seed("kyutxo ext taproot internal key")
    internal_x = xonly(point_mul(internal))

    leaf_key = key_from_seed("kyutxo ext taproot leaf key")
    leaf_script = b"\x20" + xonly(point_mul(leaf_key)) + b"\xac"
    leaf_h = tap_leaf_hash(leaf_script)
    parity, output_x = taproot_tweak(internal_x, leaf_h)
    control = bytes([0xC0 | parity]) + internal_x
    tx = bip322_txs(p2tr_script(output_x), EXT_MESSAGE, 0)
    sig = schnorr_sign(bip341_sighash(tx, None, leaf_script, 0), leaf_key)
    emit("EXT_P2TR_LEAF_ADDR", f"'{bech32m_encode_p2tr(output_x)}'")
    emit("EXT_P2TR_LEAF_SIG", f"'{witness_b64([sig, leaf_script, control])}'")

    # CHECKSIGADD 2-of-2: <xA> OP_CHECKSIG <xB> OP_CHECKSIGADD OP_2 OP_NUMEQUAL.
    # Witness stack (execution order): [sigB, sigA, leafScript, controlBlock].
    csa_a = key_from_seed("kyutxo ext taproot csa key A")
    csa_b = key_from_seed("kyutxo ext taproot csa key B")
    csa_script = (
        b"\x20" + xonly(point_mul(csa_a)) + b"\xac"
        + b"\x20" + xonly(point_mul(csa_b)) + b"\xba\x52\x9c"
    )
    csa_h = tap_leaf_hash(csa_script)
    parity, output_x = taproot_tweak(internal_x, csa_h)
    control = bytes([0xC0 | parity]) + internal_x
    tx = bip322_txs(p2tr_script(output_x), EXT_MESSAGE, 0)
    sighash = bip341_sighash(tx, None, csa_script, 0)
    sig_a = schnorr_sign(sighash, csa_a)
    sig_b = schnorr_sign(sighash, csa_b)
    emit("EXT_P2TR_CSA_ADDR", f"'{bech32m_encode_p2tr(output_x)}'")
    emit("EXT_P2TR_CSA_SIG", f"'{witness_b64([sig_b, sig_a, csa_script, control])}'")

    # Multi-leaf trees: each leaf is <x_i> OP_CHECKSIG with its own key, so the
    # control block carries a real merkle path verifyTaprootCommitment must fold.
    leaf_keys = [key_from_seed(f"kyutxo ext taproot tree leaf key {i}") for i in range(4)]
    leaf_scripts = [b"\x20" + xonly(point_mul(k)) + b"\xac" for k in leaf_keys]
    leaf_hashes = [tap_leaf_hash(s) for s in leaf_scripts]

    # 2-leaf tree, spending leaf 0: merkle path = [leafHash 1].
    root2 = tap_branch(leaf_hashes[0], leaf_hashes[1])
    parity, output_x = taproot_tweak(internal_x, root2)
    control = bytes([0xC0 | parity]) + internal_x + leaf_hashes[1]
    tx = bip322_txs(p2tr_script(output_x), EXT_MESSAGE, 0)
    sig = schnorr_sign(bip341_sighash(tx, None, leaf_scripts[0], 0), leaf_keys[0])
    emit("EXT_P2TR_2LEAF_ADDR", f"'{bech32m_encode_p2tr(output_x)}'")
    emit("EXT_P2TR_2LEAF_SIG", f"'{witness_b64([sig, leaf_scripts[0], control])}'")

    # 4-leaf tree ((L0,L1),(L2,L3)), spending leaf 2:
    # merkle path = [leafHash 3, branch(L0,L1)] (2 levels).
    branch01 = tap_branch(leaf_hashes[0], leaf_hashes[1])
    branch23 = tap_branch(leaf_hashes[2], leaf_hashes[3])
    root4 = tap_branch(branch01, branch23)
    parity, output_x = taproot_tweak(internal_x, root4)
    control = bytes([0xC0 | parity]) + internal_x + leaf_hashes[3] + branch01
    tx = bip322_txs(p2tr_script(output_x), EXT_MESSAGE, 0)
    sig = schnorr_sign(bip341_sighash(tx, None, leaf_scripts[2], 0), leaf_keys[2])
    emit("EXT_P2TR_4LEAF_ADDR", f"'{bech32m_encode_p2tr(output_x)}'")
    emit("EXT_P2TR_4LEAF_SIG", f"'{witness_b64([sig, leaf_scripts[2], control])}'")


if __name__ == "__main__":
    print("// Independently generated BIP-322 Taproot vectors")
    print("// (client/src/lib/signatureVerify.test.ts)")
    print()
    gen_annex_script_path()
    print()
    gen_annex_key_path()
    print()
    gen_v2_key_path()
    print()
    gen_v2_script_path()
    print()
    gen_ext_p2wsh_multisig()
    print()
    gen_ext_taproot()
