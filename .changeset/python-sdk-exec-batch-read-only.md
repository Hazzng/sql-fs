---
"virtualfs-api": patch
---

Python SDK: expose `read_only` parameter on `Sandbox.exec_batch()`. When `read_only=True`, the request forwards `readOnly: true` to the server, activating parallel script execution under a shared read-lock. Defaults to `False` (sequential, write-lock) for full backward compatibility.
