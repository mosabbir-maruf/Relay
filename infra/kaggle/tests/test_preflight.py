#!/usr/bin/env python3
"""
Unit tests for Relay Kaggle preflight and configuration resolver.
Tests all validation rules, override precedence, and command construction offline.
Compatible with Python 3.8+ unittest.
"""

import json
import os
import subprocess
import sys
import unittest
import urllib.error
from unittest import mock

# Ensure infra/kaggle is on python path
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
KAGGLE_DIR = os.path.dirname(CURRENT_DIR)
if KAGGLE_DIR not in sys.path:
    sys.path.insert(0, KAGGLE_DIR)

import preflight  # noqa: E402


class TestPreflight(unittest.TestCase):
    def setUp(self):
        self.mock_t4_gpu = {
            "available": True,
            "count": 2,
            "devices": [
                {"index": 0, "name": "Tesla T4", "memory_mb": 15109.0},
                {"index": 1, "name": "Tesla T4", "memory_mb": 15109.0},
            ],
            "total_vram_gb": 29.51,
            "is_tesla_t4": True,
        }

    def test_mask_token(self):
        self.assertEqual(preflight.mask_token(None), "<none>")
        self.assertEqual(preflight.mask_token(""), "<none>")
        self.assertEqual(preflight.mask_token("short"), "********")
        self.assertEqual(preflight.mask_token("hf_1234567890abcdef"), "hf_1...cdef")

    def test_sanitize_served_name(self):
        self.assertEqual(
            preflight.sanitize_served_name("Qwen/Qwen2.5-Coder-7B-Instruct"),
            "qwen2.5-coder-7b-instruct",
        )
        self.assertEqual(
            preflight.sanitize_served_name("meta-llama/Llama-3.1-8B-Instruct"),
            "llama-3.1-8b-instruct",
        )
        self.assertEqual(
            preflight.sanitize_served_name("QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ"),
            "qwen3-coder-30b-a3b-instruct-awq",
        )

    def test_default_config_resolution(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "context_length": 32768,
            "torch_dtype": "bfloat16",
            "quantization_method": None,
            "param_count": 7_000_000_000,
            "requires_remote_code": False,
            "gated": False,
        }
        user_overrides = {}
        resolved = preflight.resolve_configuration(
            "Qwen/Qwen2.5-Coder-7B-Instruct", attrs, user_overrides
        )

        self.assertEqual(resolved["status"], "PASS")
        self.assertEqual(resolved["served_model_name"], "qwen2.5-coder-7b-instruct")
        self.assertEqual(resolved["tensor_parallel_size"], 2)
        # On T4, default dtype must be float16 even if config has bfloat16
        self.assertEqual(resolved["dtype"], "float16")
        self.assertIsNone(resolved["quantization"])
        self.assertEqual(resolved["max_model_len"], 4096)
        self.assertEqual(resolved["max_num_seqs"], 4)
        self.assertEqual(resolved["gpu_memory_utilization"], 0.85)
        self.assertTrue(resolved["enforce_eager"])
        # Standard models do not require trust_remote_code
        self.assertFalse(resolved["trust_remote_code"])

        # Check command construction
        cmd = resolved["command_str"]
        self.assertIn("vllm serve Qwen/Qwen2.5-Coder-7B-Instruct", cmd)
        self.assertIn("--served-model-name qwen2.5-coder-7b-instruct", cmd)
        self.assertIn("--tensor-parallel-size 2", cmd)
        self.assertIn("--dtype float16", cmd)
        self.assertIn("--enforce-eager", cmd)
        self.assertNotIn("--quantization", cmd)
        self.assertNotIn("--trust-remote-code", cmd)

    def test_trust_remote_code_precedence(self):
        # 1. Model metadata requires remote code
        attrs_remote = {
            "architectures": ["Qwen2ForCausalLM"],
            "requires_remote_code": True,
        }
        resolved_auto = preflight.resolve_configuration("Custom/Model", attrs_remote, {})
        self.assertTrue(resolved_auto["trust_remote_code"])
        self.assertIn("--trust-remote-code", resolved_auto["command_str"])

        # 2. User override forces False even when metadata had True
        resolved_forced_false = preflight.resolve_configuration(
            "Custom/Model", attrs_remote, {"trust_remote_code": False}
        )
        self.assertFalse(resolved_forced_false["trust_remote_code"])
        self.assertNotIn("--trust-remote-code", resolved_forced_false["command_str"])

        # 3. User override forces True when metadata had False
        attrs_standard = {
            "architectures": ["LlamaForCausalLM"],
            "requires_remote_code": False,
        }
        resolved_forced_true = preflight.resolve_configuration(
            "meta-llama/Llama-3-8B", attrs_standard, {"trust_remote_code": True}
        )
        self.assertTrue(resolved_forced_true["trust_remote_code"])
        self.assertIn("--trust-remote-code", resolved_forced_true["command_str"])

    def test_user_overrides_precedence(self):
        attrs = {
            "architectures": ["LlamaForCausalLM"],
            "model_type": "llama",
            "context_length": 8192,
            "torch_dtype": "float16",
            "quantization_method": None,
            "param_count": 8_000_000_000,
            "requires_remote_code": False,
            "gated": False,
        }
        user_overrides = {
            "served_model_name": "my-custom-llama",
            "tensor_parallel_size": 1,
            "max_model_len": 2048,
            "max_num_seqs": 8,
            "gpu_memory_utilization": 0.90,
            "quantization": "awq",
        }
        resolved = preflight.resolve_configuration(
            "meta-llama/Meta-Llama-3-8B-Instruct", attrs, user_overrides
        )

        self.assertEqual(resolved["served_model_name"], "my-custom-llama")
        self.assertEqual(resolved["tensor_parallel_size"], 1)
        self.assertEqual(resolved["max_model_len"], 2048)
        self.assertEqual(resolved["max_num_seqs"], 8)
        self.assertEqual(resolved["gpu_memory_utilization"], 0.90)
        self.assertEqual(resolved["quantization"], "awq")
        self.assertIn("--quantization awq", resolved["command_str"])
        self.assertIn("--served-model-name my-custom-llama", resolved["command_str"])

    def test_unsupported_architecture_rejection(self):
        attrs = {
            "architectures": ["BertForMaskedLM"],
            "model_type": "bert",
            "context_length": 512,
            "torch_dtype": "float32",
            "quantization_method": None,
            "param_count": 110_000_000,
        }
        errors = preflight.validate_compatibility(
            "google-bert/bert-base-uncased", attrs, self.mock_t4_gpu, {}
        )
        self.assertTrue(any("not a supported causal language model" in e for e in errors))

    def test_unknown_architecture_fails_closed(self):
        attrs = {
            "architectures": ["CustomTransformerForAudio"],
            "model_type": "custom_audio",
            "context_length": 1024,
            "torch_dtype": "float16",
            "quantization_method": None,
            "param_count": 500_000_000,
        }
        errors = preflight.validate_compatibility(
            "custom/unknown-model", attrs, self.mock_t4_gpu, {}
        )
        self.assertTrue(any("Unable to verify causal LM compatibility" in e for e in errors))

    def test_fp8_quantization_rejection_on_t4(self):
        attrs = {
            "architectures": ["LlamaForCausalLM"],
            "model_type": "llama",
            "quantization_method": "fp8",
            "param_count": 8_000_000_000,
        }
        errors = preflight.validate_compatibility(
            "neuralmagic/Meta-Llama-3-8B-Instruct-FP8", attrs, self.mock_t4_gpu, {}
        )
        self.assertTrue(any("FP8" in e and "Tesla T4" in e for e in errors))

    def test_oversized_unquantized_model_rejection(self):
        # 32B unquantized in 16-bit requires ~64 GB VRAM -> exceeds 30 GB
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "quantization_method": None,
            "param_count": 32_500_000_000,
        }
        errors = preflight.validate_compatibility(
            "Qwen/Qwen2.5-Coder-32B-Instruct", attrs, self.mock_t4_gpu, {}
        )
        self.assertTrue(any("exceeds the total usable VRAM" in e for e in errors))

    def test_oversized_4bit_model_rejection(self):
        # 70B in 4-bit requires ~42 GB VRAM -> exceeds 30 GB total
        attrs = {
            "architectures": ["LlamaForCausalLM"],
            "model_type": "llama",
            "quantization_method": "awq",
            "param_count": 70_000_000_000,
        }
        errors = preflight.validate_compatibility(
            "casperhansen/llama-3-70b-instruct-awq", attrs, self.mock_t4_gpu, {}
        )
        self.assertTrue(any("exceeding dual T4 capacity" in e for e in errors))

    def test_supported_awq_quantized_30b_model(self):
        # 30.5B AWQ model (like Qwen3-Coder-30B AWQ) fits on dual T4 (~15.2 GB total)
        attrs = {
            "architectures": ["Qwen2MoeForCausalLM"],
            "model_type": "qwen2_moe",
            "quantization_method": "awq",
            "param_count": 30_500_000_000,
        }
        errors = preflight.validate_compatibility(
            "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", attrs, self.mock_t4_gpu, {}
        )
        self.assertEqual(len(errors), 0)

    def test_invalid_tensor_parallel_size(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "param_count": 7_000_000_000,
        }
        # TP=0
        errors = preflight.validate_compatibility(
            "Qwen/Qwen2.5-7B", attrs, self.mock_t4_gpu, {"tensor_parallel_size": 0}
        )
        self.assertTrue(any("Invalid tensor_parallel_size" in e for e in errors))

        # TP=4 on 2 detected GPUs
        errors = preflight.validate_compatibility(
            "Qwen/Qwen2.5-7B", attrs, self.mock_t4_gpu, {"tensor_parallel_size": 4}
        )
        self.assertTrue(any("exceeds detected GPU count" in e for e in errors))

    def test_invalid_max_model_len(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "param_count": 7_000_000_000,
        }
        errors = preflight.validate_compatibility(
            "Qwen/Qwen2.5-7B", attrs, self.mock_t4_gpu, {"max_model_len": 64}
        )
        self.assertTrue(any("Invalid max_model_len" in e for e in errors))

    def test_gated_model_handling(self):
        # When HF returns 401/403 without token
        err_401 = urllib.error.HTTPError(
            url="https://huggingface.co/api/models/meta-llama/Llama-3-8B",
            code=401,
            msg="Unauthorized",
            hdrs={},
            fp=None,
        )
        with mock.patch("urllib.request.urlopen", side_effect=err_401):
            with self.assertRaises(PermissionError) as ctx:
                preflight.fetch_hf_model_metadata("meta-llama/Llama-3-8B", hf_token=None)
            self.assertIn("gated or private", str(ctx.exception))
            self.assertIn("A Hugging Face access token is required", str(ctx.exception))

        # When HF returns 403 WITH token
        err_403 = urllib.error.HTTPError(
            url="https://huggingface.co/api/models/meta-llama/Llama-3-8B",
            code=403,
            msg="Forbidden",
            hdrs={},
            fp=None,
        )
        with mock.patch("urllib.request.urlopen", side_effect=err_403):
            with self.assertRaises(PermissionError) as ctx:
                preflight.fetch_hf_model_metadata(
                    "meta-llama/Llama-3-8B", hf_token="hf_mocktoken12345"
                )
            self.assertIn("Access denied", str(ctx.exception))
            self.assertIn("verify your Hugging Face account has accepted", str(ctx.exception))

    def test_json_output_shape(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "context_length": 4096,
            "quantization_method": "awq",
            "param_count": 7_000_000_000,
        }
        resolved = preflight.resolve_configuration("Qwen/Qwen2.5-7B-AWQ", attrs, {})
        # Verify JSON serialization round-trip
        json_str = json.dumps(resolved)
        parsed = json.loads(json_str)

        required_keys = [
            "status",
            "model_id",
            "served_model_name",
            "tensor_parallel_size",
            "dtype",
            "quantization",
            "max_model_len",
            "max_num_seqs",
            "gpu_memory_utilization",
            "enforce_eager",
            "trust_remote_code",
            "command_args",
            "command_str",
        ]
        for key in required_keys:
            self.assertIn(key, parsed)

    def test_command_args_executable_array(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "context_length": 4096,
            "torch_dtype": "float16",
            "quantization_method": None,
            "param_count": 7_620_000_000,
            "requires_remote_code": False,
            "gated": False,
        }
        resolved = preflight.resolve_configuration(
            "Qwen/Qwen2.5-Coder-7B-Instruct", attrs, {}
        )
        cmd_args = resolved["command_args"]
        self.assertIsInstance(cmd_args, list)
        self.assertEqual(cmd_args[0], "vllm")
        self.assertEqual(cmd_args[1], "serve")
        self.assertEqual(cmd_args[2], "Qwen/Qwen2.5-Coder-7B-Instruct")
        self.assertIn("--served-model-name", cmd_args)
        self.assertIn("qwen2.5-coder-7b-instruct", cmd_args)
        self.assertIn("--tensor-parallel-size", cmd_args)
        self.assertIn("2", cmd_args)
        self.assertIn("--dtype", cmd_args)
        self.assertIn("float16", cmd_args)
        self.assertIn("--gpu-memory-utilization", cmd_args)
        self.assertIn("0.85", cmd_args)
        self.assertIn("--enforce-eager", cmd_args)
        self.assertEqual(resolved["command_str"], " ".join(cmd_args))

    def test_vllm_sh_start_extraction_regression(self):
        """Regression test for Kaggle Step 7 NameError: name 'command_str' is not defined."""
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "context_length": 4096,
            "torch_dtype": "float16",
            "quantization_method": None,
            "param_count": 7_620_000_000,
            "requires_remote_code": False,
            "gated": False,
        }
        resolved = preflight.resolve_configuration(
            "Qwen/Qwen2.5-Coder-7B-Instruct", attrs, {}
        )
        preflight_json = json.dumps(resolved)

        bash_script = """
        set -euo pipefail
        preflight_json="$1"

        served_name=$(echo "${preflight_json}" | python3 -c "import sys, json; print(json.load(sys.stdin).get('served_model_name', ''))")
        cmd_str=$(echo "${preflight_json}" | python3 -c "import sys, json; print(json.load(sys.stdin).get('command_str', ''))")

        cmd_args=()
        while IFS= read -r -d '' arg; do
          cmd_args+=("${arg}")
        done < <(echo "${preflight_json}" | python3 -c "import sys, json
data = json.load(sys.stdin)
for a in data.get('command_args', []):
    sys.stdout.buffer.write(a.encode('utf-8') + b'\\x00')
")

        echo "SERVED_NAME:${served_name}"
        echo "CMD_STR:${cmd_str}"
        echo "ARGS_COUNT:${#cmd_args[@]}"
        echo "FIRST_ARG:${cmd_args[0]}"
        echo "SECOND_ARG:${cmd_args[1]}"
        """

        res = subprocess.run(
            ["bash", "-c", bash_script, "bash", preflight_json],
            capture_output=True,
            text=True,
            check=True,
        )
        output = res.stdout
        self.assertIn("SERVED_NAME:qwen2.5-coder-7b-instruct", output)
        self.assertIn("ARGS_COUNT:20", output)
        self.assertIn("FIRST_ARG:vllm", output)
        self.assertIn("SECOND_ARG:serve", output)


if __name__ == "__main__":
    unittest.main()
