---
"virtualfs-api": patch
---

fix(js-exec): patch Buffer.from/toString in QuickJS sandbox to honour encoding argument (base64, base64url, hex, latin1)

The just-bash Buffer shim ignored the encoding argument on both `Buffer.from(str, enc)` and `buf.toString(enc)`, making every encoding a silent no-op. A bootstrap snippet is now injected at session creation time that patches those methods with correct base64, base64url, hex, and latin1 implementations. Regression tests cover round-trip encode/decode for all four encodings plus the original no-op bug.
