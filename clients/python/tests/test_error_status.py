import json

import httpx
import pytest
import respx

from sqlfs import AuthError, Client, ConflictError, NotFoundError, ServerError, ValidationError

BASE_URL = "https://api.test"


@pytest.mark.parametrize(
    ("code", "status", "error_type"),
    [
        ("ENOENT", 404, NotFoundError),
        ("EEXIST", 409, ConflictError),
        ("ENOTEMPTY", 409, ConflictError),
        ("ESTALE", 409, ConflictError),
        ("EPERM", 403, AuthError),
        ("FORBIDDEN", 403, AuthError),
        ("EISDIR", 400, ValidationError),
        ("ENOTDIR", 400, ValidationError),
        ("ELOOP", 400, ValidationError),
        ("EINVAL", 400, ValidationError),
        ("EREADONLY", 500, ServerError),
        ("ECOHERENCE", 503, ServerError),
        ("ELOCKLOST_APPLIED", 503, ServerError),
        ("EDRIVERFAULT", 503, ServerError),
        ("EEXEC_OUTCOME_UNKNOWN", 503, ServerError),
    ],
)
@respx.mock
def test_canonical_http_and_sse_errors_match_without_replay(code, status, error_type):
    body = {
        "error": "operation failed",
        "code": code,
        "retryable": False,
        "details": {"path": "/home/user/file"},
    }
    for delivery in ("http", "sse"):
        endpoint = "exec-sync" if delivery == "http" else "exec"
        response = (
            httpx.Response(status, json=body)
            if delivery == "http"
            else httpx.Response(
                200,
                content=f"event: error\ndata: {json.dumps(body)}\n\n",
                headers={"Content-Type": "text/event-stream"},
            )
        )
        route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/{endpoint}").mock(return_value=response)
        sandbox = Client(base_url=BASE_URL, token="t.k.n", max_retries=3).sandboxes.attach("sb")
        script = "curl -X POST https://example.test/effect"

        with pytest.raises(error_type) as exc:
            if delivery == "http":
                sandbox.exec(script, read_only=True, retry_on_5xx=True)
            else:
                list(sandbox.exec_stream(script, read_only=True))
        assert str(exc.value) == body["error"]
        assert exc.value.code == code
        assert exc.value.status == status
        assert exc.value.retryable is False
        assert exc.value.details == body["details"]
        assert route.call_count == 1
