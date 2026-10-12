import json

import httpx
import pytest
import respx

from sqlfs import Client, TransportError

BASE_URL = "https://api.test"
OUTPUT = {"stdout": "done", "stderr": "", "exitCode": 0, "durationMs": 1, "timedOut": False}


@pytest.mark.parametrize(
    "body",
    [
        '{"stdout":"partial"',
        "null",
        "{}",
        json.dumps({**OUTPUT, "exitCode": "0"}),
        json.dumps({**OUTPUT, "stderr": None}),
        json.dumps({**OUTPUT, "durationMs": None}),
        json.dumps({**OUTPUT, "timedOut": "false"}),
    ],
)
@respx.mock
def test_invalid_exec_response_has_unknown_outcome_without_replay(body):
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec-sync").mock(
        side_effect=[httpx.Response(200, content=body), httpx.Response(200, json=OUTPUT)]
    )
    sandbox = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    with pytest.raises(TransportError) as exc:
        sandbox.exec("curl -X POST https://example.test/effect", read_only=True, retry_on_5xx=True)
    assert exc.value.status is None
    assert exc.value.code is None
    assert route.call_count == 1


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"results": None},
        {"results": []},
        {"results": [{"id": "a", "exitCode": 0}]},
        {"results": [{**OUTPUT, "id": "wrong"}]},
        {"results": [{**OUTPUT, "id": "a", "exitCode": None}]},
    ],
)
@respx.mock
def test_incomplete_batch_response_has_unknown_outcome_without_replay(body):
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec-sync-batch").mock(
        side_effect=[
            httpx.Response(200, json=body),
            httpx.Response(200, json={"results": [{**OUTPUT, "id": "a"}]}),
        ]
    )
    sandbox = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    with pytest.raises(TransportError) as exc:
        sandbox.exec_batch(
            [{"id": "a", "script": "curl -X POST https://example.test/effect"}],
            read_only=True,
            retry_on_5xx=True,
        )
    assert exc.value.status is None
    assert exc.value.code is None
    assert route.call_count == 1


@pytest.mark.parametrize(
    "body",
    [
        "",
        'event: stdout\ndata: {"data":"partial"}\n\n',
        'event: exit\ndata: {"durationMs":1}\n\n',
        'event: exit\ndata: {"exitCode":"0","durationMs":1}\n\n',
    ],
)
@respx.mock
def test_stream_without_valid_exit_has_unknown_outcome(body):
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec").mock(
        return_value=httpx.Response(
            200, content=body, headers={"Content-Type": "text/event-stream"}
        )
    )
    sandbox = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    with pytest.raises(TransportError) as exc:
        list(sandbox.exec_stream("curl -X POST https://example.test/effect", read_only=True))
    assert exc.value.status is None
    assert exc.value.code is None
    assert route.call_count == 1


@respx.mock
def test_streaming_disconnect_does_not_replay():
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec").mock(
        side_effect=httpx.ReadError("connection reset")
    )
    sandbox = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")

    with pytest.raises(TransportError):
        list(sandbox.exec_stream("printf done"))
    assert route.call_count == 1


class InterruptedStream(httpx.SyncByteStream):
    def __iter__(self):
        yield b'event: stdout\ndata: {"data":"partial"}\n\n'
        raise httpx.ReadError("connection reset")


@respx.mock
def test_stream_disconnect_preserves_partial_output_and_reports_unknown_outcome():
    route = respx.post(f"{BASE_URL}/v1/sandboxes/sb/exec").mock(
        return_value=httpx.Response(200, stream=InterruptedStream())
    )
    sandbox = Client(base_url=BASE_URL, token="t.k.n", max_retries=1).sandboxes.attach("sb")
    execution = sandbox.exec_stream("printf partial; sleep 5")

    first = next(execution)
    assert [first.type, first.data] == ["stdout", "partial"]
    with pytest.raises(TransportError) as exc:
        next(execution)
    assert exc.value.status is None
    assert exc.value.code is None
    assert route.call_count == 1
