import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from gemma_provider import (
    GemmaProviderError,
    OllamaConfig,
    OllamaGemmaProvider,
)


class OllamaHandler(BaseHTTPRequestHandler):
    request_payload = None
    response_payload = {"message": {"content": '{"ok": true}'}}
    status_code = 200

    def do_POST(self):
        self.__class__.request_payload = json.loads(
            self.rfile.read(int(self.headers["Content-Length"]))
        )
        body = json.dumps(self.__class__.response_payload).encode("utf-8")
        self.send_response(self.__class__.status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


class OllamaGemmaProviderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), OllamaHandler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever)
        cls.server_thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join()

    def setUp(self):
        OllamaHandler.request_payload = None
        OllamaHandler.response_payload = {"message": {"content": '{"ok": true}'}}
        OllamaHandler.status_code = 200
        self.provider = OllamaGemmaProvider(
            OllamaConfig(base_url=self.base_url, model="test-gemma")
        )

    def test_sends_schema_packet_and_returns_parsed_object(self):
        schema = {
            "type": "object",
            "properties": {"ok": {"type": "boolean"}},
            "required": ["ok"],
        }
        result = self.provider.generate_structured(
            task="analyze_fragment",
            context_packet={"fragment_id": "f-1"},
            response_schema=schema,
        )

        self.assertEqual(result, {"ok": True})
        payload = OllamaHandler.request_payload
        self.assertEqual(payload["model"], "test-gemma")
        self.assertEqual(payload["format"], schema)
        self.assertFalse(payload["stream"])
        self.assertEqual(payload["options"]["temperature"], 0)
        user_content = json.loads(payload["messages"][1]["content"])
        self.assertEqual(user_content["context_packet"], {"fragment_id": "f-1"})

    def test_encodes_image_bytes_for_ollama(self):
        self.provider.generate_structured(
            task="analyze_fragment",
            context_packet={"fragment_id": "f-1"},
            response_schema={"type": "object"},
            images=[b"image-bytes"],
        )

        self.assertEqual(
            OllamaHandler.request_payload["messages"][1]["images"],
            ["aW1hZ2UtYnl0ZXM="],
        )

    def test_rejects_non_object_model_output(self):
        OllamaHandler.response_payload = {"message": {"content": '[1, 2]'}}

        with self.assertRaisesRegex(GemmaProviderError, "must be a JSON object"):
            self.provider.generate_structured(
                task="analyze_fragment",
                context_packet={},
                response_schema={"type": "object"},
            )

    def test_reports_ollama_http_errors(self):
        OllamaHandler.status_code = 404
        OllamaHandler.response_payload = {"error": "model not found"}

        with self.assertRaisesRegex(GemmaProviderError, "HTTP 404"):
            self.provider.generate_structured(
                task="analyze_fragment",
                context_packet={},
                response_schema={"type": "object"},
            )

    def test_rejects_empty_task_before_network_call(self):
        with self.assertRaisesRegex(ValueError, "task must not be empty"):
            self.provider.generate_structured(
                task=" ",
                context_packet={},
                response_schema={"type": "object"},
            )


if __name__ == "__main__":
    unittest.main()