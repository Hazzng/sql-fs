import json
import os

import httpx

from sqlfs import Client
from sqlfs.errors import SQLFSError


requests = []
events = []


def observe(request):
    requests.append({"method": request.method, "path": request.url.path})


with httpx.Client(event_hooks={"request": [observe]}, timeout=30.0) as http:
    with Client(
        base_url=os.environ["SSE_FINALIZATION_BASE"],
        token=os.environ["SSE_FINALIZATION_TOKEN"],
        max_retries=3,
        http_client=http,
    ) as client:
        sandbox = client.sandboxes.attach(os.environ["SSE_FINALIZATION_SANDBOX"])
        try:
            for event in sandbox.exec_stream(os.environ["SSE_FINALIZATION_SCRIPT"], timeout_ms=5000):
                events.append({"type": event.type, "data": event.data, "exitCode": event.exit_code})
            outcome = {"kind": "success"}
        except SQLFSError as error:
            outcome = {
                "kind": "error",
                "code": error.code,
                "retryable": error.retryable,
                "status": error.status,
                "class": type(error).__name__,
            }
print(json.dumps({"outcome": outcome, "events": events, "requests": requests}))
