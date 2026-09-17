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
import tempfile
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

    def test_parse_semver(self):
        self.assertEqual(preflight.parse_semver("0.16.0"), (0, 16, 0))
        self.assertEqual(preflight.parse_semver("0.29.0.post1"), (0, 29, 0, 1))
        self.assertTrue(preflight.parse_semver("0.15.0") < preflight.parse_semver("0.16.0"))
        self.assertTrue(preflight.parse_semver("0.29.0") >= preflight.parse_semver("0.16.0"))

    # 1. GPT-2 Tiny Model Recommendations
    def test_gpt2_tiny_model_recommendations(self):
        config = {
            "architectures": ["GPT2LMHeadModel"],
            "model_type": "gpt2",
            "n_positions": 1024,
            "n_ctx": 1024,
            "n_embd": 768,
            "n_head": 12,
            "n_layer": 12,
            "torch_dtype": "float32",
        }
        model_info = {"id": "openai-community/gpt2"}
        attrs = preflight.inspect_model_attributes(model_info, config)
        attrs["param_count"] = 124_000_000

        resolved = preflight.resolve_configuration(
            "openai-community/gpt2", attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertEqual(resolved["status"], "CANDIDATE_RECOMMENDED")
        self.assertEqual(resolved["tensor_parallel_size"], 1)
        self.assertEqual(resolved["max_model_len"], 1024)
        self.assertEqual(resolved["max_num_seqs"], 1)
        self.assertEqual(resolved["dtype"], "float16")
        self.assertEqual(resolved["gpu_memory_utilization"], preflight.POLICY_UTILIZATION_MIN)
        self.assertEqual(
            resolved["decisions"]["tensor_parallel_size"]["source"],
            "memory_aware_single_gpu_fit",
        )
        self.assertEqual(
            resolved["decisions"]["max_model_len"]["source"],
            "bounded_native_context",
        )
        # Verify memory breakdown reconciliation
        per_gpu = resolved["memory_breakdown"]["per_gpu_workload_gb"]
        self.assertEqual(
            per_gpu["total"],
            round(
                per_gpu["weights"]
                + per_gpu["visual"]
                + per_gpu["kv_cache"]
                + per_gpu["cuda_runtime"],
                2,
            ),
        )

    # Regression Test: GPT-2 TP=1 Memory Reconciliation
    def test_gpt2_memory_breakdown_reconciliation_regression(self):
        config = {
            "architectures": ["GPT2LMHeadModel"],
            "model_type": "gpt2",
            "n_positions": 1024,
            "n_ctx": 1024,
            "n_embd": 768,
            "n_head": 12,
            "n_layer": 12,
            "torch_dtype": "float32",
        }
        model_info = {"id": "openai-community/gpt2"}
        attrs = preflight.inspect_model_attributes(model_info, config)
        # Verify with exact 137M (0.14B) parameter count from live GPT-2 run
        attrs["param_count"] = 137_022_720

        resolved = preflight.resolve_configuration(
            "openai-community/gpt2", attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertEqual(resolved["tensor_parallel_size"], 1)

        mem = resolved["memory_breakdown"]
        comps = mem["estimated_components"]
        per_gpu = mem["per_gpu_workload_gb"]

        weights_per_gpu = per_gpu["weights"]
        visual_per_gpu = per_gpu["visual"]
        kv_per_gpu = per_gpu["kv_cache"]
        cuda_runtime = per_gpu["cuda_runtime"]
        per_gpu_breakdown = per_gpu["total"]

        # Exact regression requirement:
        # per_gpu_breakdown == weights_per_gpu + visual_per_gpu + kv_per_gpu + cuda_runtime
        self.assertEqual(
            per_gpu_breakdown,
            round(weights_per_gpu + visual_per_gpu + kv_per_gpu + cuda_runtime, 2),
        )
        # Values reconcile: 0.27 + 0.00 + 0.04 + 1.00 = 1.31 GB
        self.assertEqual(weights_per_gpu, 0.27)
        self.assertEqual(visual_per_gpu, 0.0)
        self.assertEqual(kv_per_gpu, 0.04)
        self.assertEqual(cuda_runtime, 1.0)
        self.assertEqual(per_gpu_breakdown, 1.31)
        self.assertEqual(comps["total_estimated_single_gpu_workload_gb"], 1.31)

    # 2. Qwen 7B FP16 Recommendations
    def test_qwen_7b_fp16_recommendations(self):
        config = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "max_position_embeddings": 32768,
            "torch_dtype": "bfloat16",
            "num_hidden_layers": 28,
            "num_attention_heads": 28,
            "num_key_value_heads": 4,
            "hidden_size": 3584,
            "head_dim": 128,
        }
        model_info = {"id": "Qwen/Qwen2.5-Coder-7B-Instruct"}
        attrs = preflight.inspect_model_attributes(model_info, config)
        attrs["param_count"] = 7_620_000_000

        resolved = preflight.resolve_configuration(
            "Qwen/Qwen2.5-Coder-7B-Instruct", attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertEqual(resolved["status"], "CANDIDATE_RECOMMENDED")
        self.assertEqual(resolved["tensor_parallel_size"], 2)
        self.assertEqual(resolved["max_model_len"], 4096)
        self.assertEqual(resolved["max_num_seqs"], 1)
        self.assertEqual(resolved["dtype"], "float16")
        self.assertEqual(
            resolved["decisions"]["tensor_parallel_size"]["source"],
            "memory_aware_dual_gpu_fit",
        )
        self.assertIsNotNone(resolved["decisions"]["dtype"]["warning"])

    # 3. Qwen 30B AWQ Recommendations
    def test_qwen_30b_awq_recommendations(self):
        config = {
            "architectures": ["Qwen2MoeForCausalLM"],
            "model_type": "qwen2_moe",
            "max_position_embeddings": 32768,
            "quantization_config": {"quant_method": "awq"},
            "num_hidden_layers": 48,
            "num_attention_heads": 32,
            "num_key_value_heads": 4,
            "hidden_size": 4096,
            "head_dim": 128,
        }
        model_info = {"id": "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ"}
        attrs = preflight.inspect_model_attributes(model_info, config)
        attrs["param_count"] = 30_500_000_000

        resolved = preflight.resolve_configuration(
            "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ", attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertEqual(resolved["status"], "CANDIDATE_RECOMMENDED")
        self.assertEqual(resolved["tensor_parallel_size"], 2)
        self.assertEqual(resolved["quantization"], "awq")
        self.assertGreaterEqual(resolved["gpu_memory_utilization"], preflight.POLICY_UTILIZATION_MIN)
        self.assertLessEqual(resolved["gpu_memory_utilization"], preflight.POLICY_UTILIZATION_MAX)

    # 4. GLM-OCR Multimodal Recommendations
    def test_glm_ocr_multimodal_recommendations(self):
        config = {
            "architectures": ["GlmOcrForConditionalGeneration"],
            "model_type": "glm_ocr",
            "text_config": {
                "max_position_embeddings": 131072,
                "dtype": "bfloat16",
                "num_hidden_layers": 16,
                "num_attention_heads": 16,
                "num_key_value_heads": 2,
                "hidden_size": 1536,
                "head_dim": 96,
            },
            "vision_config": {
                "num_parameters": 100_000_000,
            },
            "num_parameters": 900_000_000,
        }
        model_info = {"id": "zai-org/GLM-OCR"}
        attrs = preflight.inspect_model_attributes(model_info, config)
        resolved = preflight.resolve_configuration(
            "zai-org/GLM-OCR", attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertEqual(resolved["status"], "CANDIDATE_RECOMMENDED")
        self.assertEqual(resolved["model_kind"], "multimodal_causal_lm")
        self.assertEqual(resolved["modalities"], ["text", "image"])
        self.assertEqual(resolved["max_model_len"], 4096)
        self.assertEqual(resolved["tensor_parallel_size"], 1)
        visual_comp = resolved["memory_breakdown"]["estimated_components"]["visual"]
        self.assertGreater(visual_comp["value"], 0)

    # 5. BF16 to FP16 Runtime Warning
    def test_bf16_to_fp16_runtime_warning(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "torch_dtype": "bfloat16",
            "context_length": 4096,
            "param_count": 7_000_000_000,
        }
        resolved = preflight.resolve_configuration(
            "test-model", attrs, {}, gpu_info=self.mock_t4_gpu
        )
        dtype_decision = resolved["decisions"]["dtype"]
        self.assertEqual(dtype_decision["value"], "float16")
        self.assertEqual(dtype_decision["source"], "t4_hardware_constraint")
        self.assertIn("downcasts to float16", dtype_decision["warning"])

    # 6. FP8 on T4 Rejection
    def test_fp8_on_t4_rejection(self):
        attrs = {
            "architectures": ["LlamaForCausalLM"],
            "model_type": "llama",
            "quantization_method": "fp8",
            "param_count": 8_000_000_000,
        }
        errors = preflight.validate_compatibility(
            "test-fp8", attrs, self.mock_t4_gpu, {}
        )
        self.assertTrue(any("FP8" in e and "Tesla T4" in e for e in errors))

    # 7. Unknown Native Context Handling
    def test_unknown_native_context_handling(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "context_length": None,
            "param_count": 7_000_000_000,
        }
        resolved = preflight.resolve_configuration(
            "test-unknown-ctx", attrs, {}, gpu_info=self.mock_t4_gpu
        )
        ctx_decision = resolved["decisions"]["max_model_len"]
        self.assertEqual(ctx_decision["value"], 2048)
        self.assertEqual(ctx_decision["source"], "safe_candidate_fallback")
        self.assertIsNotNone(ctx_decision["warning"])
        self.assertIn("UNKNOWN", ctx_decision["warning"])

    # 8. Unknown Hardware Handling
    def test_unknown_hardware_handling(self):
        no_gpu = {
            "status": "UNKNOWN_NO_GPU",
            "available": False,
            "count": 0,
            "devices": [],
            "total_vram_gb": 0.0,
            "per_gpu_vram_gb": 0.0,
            "is_tesla_t4": False,
            "compute_capability": "Unknown",
        }
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "context_length": 4096,
            "param_count": 7_000_000_000,
        }
        resolved = preflight.resolve_configuration("test-model", attrs, {}, gpu_info=no_gpu)
        self.assertEqual(resolved["status"], "CANDIDATE_RECOMMENDED")
        self.assertTrue(
            resolved["memory_breakdown"]["eval_hardware"]["is_simulated_reference"]
        )
        self.assertEqual(resolved["tensor_parallel_size"], 2)

    # 9. Single GPU Fit Selection
    def test_single_gpu_fit_selection(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "context_length": 2048,
            "param_count": 1_500_000_000,
        }
        resolved = preflight.resolve_configuration(
            "test-1.5b", attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertEqual(resolved["tensor_parallel_size"], 1)
        self.assertEqual(
            resolved["decisions"]["tensor_parallel_size"]["source"],
            "memory_aware_single_gpu_fit",
        )

    # 10. Dual GPU Fit Selection
    def test_dual_gpu_fit_selection(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "context_length": 4096,
            "param_count": 7_000_000_000,
        }
        resolved = preflight.resolve_configuration(
            "test-7b", attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertEqual(resolved["tensor_parallel_size"], 2)
        self.assertEqual(
            resolved["decisions"]["tensor_parallel_size"]["source"],
            "memory_aware_dual_gpu_fit",
        )

    # 11. Dual GPU Rejection
    def test_dual_gpu_rejection(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "param_count": 70_000_000_000,
        }
        errors = preflight.validate_compatibility(
            "test-70b", attrs, self.mock_t4_gpu, {}
        )
        self.assertTrue(any("exceeds usable capacity of dual Tesla T4s" in e for e in errors))

    # 12. User Overrides Precedence and Source
    def test_user_overrides_precedence_and_source(self):
        attrs = {
            "architectures": ["Qwen2ForCausalLM"],
            "model_type": "qwen2",
            "context_length": 8192,
            "param_count": 7_000_000_000,
        }
        user_overrides = {
            "served_model_name": "custom-alias",
            "tensor_parallel_size": 1,
            "max_model_len": 1024,
            "max_num_seqs": 2,
            "gpu_memory_utilization": 0.75,
            "dtype": "float32",
            "quantization": "awq",
            "enforce_eager": False,
            "trust_remote_code": True,
        }
        resolved = preflight.resolve_configuration(
            "test-model", attrs, user_overrides, gpu_info=self.mock_t4_gpu
        )
        for k in [
            "tensor_parallel_size",
            "max_model_len",
            "max_num_seqs",
            "gpu_memory_utilization",
            "dtype",
            "quantization",
            "trust_remote_code",
            "enforce_eager",
            "served_model_name",
        ]:
            self.assertEqual(resolved["decisions"][k]["source"], "user_override")
        self.assertEqual(resolved["served_model_name"], "custom-alias")
        self.assertEqual(resolved["tensor_parallel_size"], 1)
        self.assertEqual(resolved["max_model_len"], 1024)
        self.assertEqual(resolved["max_num_seqs"], 2)
        self.assertEqual(resolved["gpu_memory_utilization"], 0.75)
        self.assertEqual(resolved["dtype"], "float32")
        self.assertEqual(resolved["quantization"], "awq")
        self.assertFalse(resolved["enforce_eager"])
        self.assertTrue(resolved["trust_remote_code"])

    # 13. Unsupported Architecture Rejection
    def test_unsupported_architecture_rejection(self):
        attrs = {
            "architectures": ["BertForMaskedLM"],
            "model_type": "bert",
            "param_count": 110_000_000,
        }
        errors = preflight.validate_compatibility("bert-base", attrs, self.mock_t4_gpu, {})
        self.assertTrue(any("not a supported causal language model" in e for e in errors))

    # 14. vLLM Version Compatibility Check
    def test_vllm_version_compatibility(self):
        # 1. Incompatible: GLM-OCR requires 0.16.0, installed 0.15.0
        check_incompat = preflight.check_vllm_version_compatibility(
            ["GlmOcrForConditionalGeneration"], "0.15.0"
        )
        self.assertFalse(check_incompat["compatible"])
        self.assertEqual(check_incompat["status"], "INCOMPATIBLE")
        self.assertIn("requires vLLM >= 0.16.0", check_incompat["warning"])

        # 2. Compatible: GLM-OCR with 0.29.0
        check_compat = preflight.check_vllm_version_compatibility(
            ["GlmOcrForConditionalGeneration"], "0.29.0"
        )
        self.assertTrue(check_compat["compatible"])
        self.assertEqual(check_compat["status"], "COMPATIBLE")

        # 3. Unknown architecture: reports UNKNOWN
        check_unknown = preflight.check_vllm_version_compatibility(
            ["LlamaForCausalLM"], "0.29.0"
        )
        self.assertTrue(check_unknown["compatible"])
        self.assertEqual(check_unknown["status"], "UNKNOWN_REQUIRES_RUNTIME_CHECK")
        self.assertIn("UNKNOWN", check_unknown["warning"])

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
        self.assertTrue(any("exceeds usable capacity of dual Tesla T4s" in e for e in errors))

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
        self.assertTrue(any("exceeds usable capacity of dual Tesla T4s" in e for e in errors))

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

    def test_glm_ocr_multimodal_classification(self):
        """Validates that GlmOcrForConditionalGeneration is classified as multimodal with image modality."""
        kind, modalities = preflight.classify_model_capabilities(
            ["GlmOcrForConditionalGeneration"], "glm_ocr", {}
        )
        self.assertEqual(kind, "multimodal_causal_lm")
        self.assertEqual(modalities, ["text", "image"])

    def test_glm_ocr_nested_config_and_dtype_resolution(self):
        """Validates parsing of GLM-OCR nested text_config and safe T4 float16 resolution."""
        model_info = {
            "id": "zai-org/GLM-OCR",
            "tags": ["image-text-to-text", "ocr"],
        }
        config = {
            "architectures": ["GlmOcrForConditionalGeneration"],
            "model_type": "glm_ocr",
            "text_config": {
                "max_position_embeddings": 131072,
                "dtype": "bfloat16",
            },
            "vision_config": {
                "image_size": 336,
            },
            "num_parameters": 900_000_000,
        }
        attrs = preflight.inspect_model_attributes(model_info, config)
        self.assertEqual(attrs["model_kind"], "multimodal_causal_lm")
        self.assertEqual(attrs["modalities"], ["text", "image"])
        self.assertEqual(attrs["context_length"], 131072)
        self.assertEqual(attrs["torch_dtype"], "bfloat16")
        self.assertEqual(attrs["param_count"], 900_000_000)

        # Validate dual T4 compatibility
        errors = preflight.validate_compatibility(
            "zai-org/GLM-OCR", attrs, self.mock_t4_gpu, {}
        )
        self.assertEqual(len(errors), 0)

        # Validate configuration resolution: on T4, bfloat16 must be coerced to float16
        resolved = preflight.resolve_configuration("zai-org/GLM-OCR", attrs, {})
        self.assertEqual(resolved["status"], "CANDIDATE_RECOMMENDED")
        self.assertEqual(resolved["dtype"], "float16")
        self.assertEqual(resolved["served_model_name"], "glm-ocr")
        self.assertEqual(resolved["model_kind"], "multimodal_causal_lm")
        self.assertEqual(resolved["modalities"], ["text", "image"])
        self.assertEqual(resolved["max_model_len"], 4096)
        self.assertIn("--served-model-name glm-ocr", resolved["command_str"])
        self.assertIn("--dtype float16", resolved["command_str"])

    def test_extra_vllm_args_string_and_list(self):
        """Tests that user-supplied extra vLLM flags are safely appended to argv array."""
        attrs = {
            "architectures": ["GlmOcrForConditionalGeneration"],
            "model_kind": "multimodal_causal_lm",
            "modalities": ["text", "image"],
        }
        # 1. As string
        user_overrides_str = {
            "extra_vllm_args": "--limit-mm-per-prompt image=1 --trust-remote-code"
        }
        res_str = preflight.resolve_configuration(
            "zai-org/GLM-OCR", attrs, user_overrides_str
        )
        self.assertEqual(
            res_str["extra_vllm_args"],
            ["--limit-mm-per-prompt", "image=1", "--trust-remote-code"],
        )
        self.assertIn("--limit-mm-per-prompt", res_str["command_args"])
        self.assertIn("image=1", res_str["command_args"])

        # 2. As list
        user_overrides_list = {
            "extra_vllm_args": ["--limit-mm-per-prompt", "image=2"]
        }
        res_list = preflight.resolve_configuration(
            "zai-org/GLM-OCR", attrs, user_overrides_list
        )
        self.assertEqual(
            res_list["extra_vllm_args"],
            ["--limit-mm-per-prompt", "image=2"],
        )
        self.assertIn("image=2", res_list["command_args"])

    def test_multimodal_context_length_minimum(self):
        """Validates that multimodal models require at least 512 context tokens."""
        attrs = {
            "architectures": ["GlmOcrForConditionalGeneration"],
            "model_kind": "multimodal_causal_lm",
            "modalities": ["text", "image"],
            "param_count": 900_000_000,
        }
        # max_model_len=256 is invalid for multimodal
        errors = preflight.validate_compatibility(
            "zai-org/GLM-OCR", attrs, self.mock_t4_gpu, {"max_model_len": 256}
        )
        self.assertTrue(any("Must be >= 512" in e for e in errors))

    def test_deterministic_test_image_generation(self):
        """Validates test_image.py generates valid PNG and base64 data URI without dependencies."""
        import test_image
        png_data = test_image.generate_test_png("RELAY TEST")
        self.assertTrue(png_data.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertTrue(len(png_data) > 100)

        data_uri = test_image.generate_test_data_uri("RELAY TEST")
        self.assertTrue(data_uri.startswith("data:image/png;base64,"))
        self.assertTrue(len(data_uri) > 150)

    def test_served_model_name_validation_regression(self):
        """
        Regression test:
        1. SERVED_MODEL_NAME=None -> resolved alias 'gpt2' -> /v1/models validation passes.
        2. Explicit SERVED_MODEL_NAME='my-gpt2' -> validation uses 'my-gpt2'.
        """
        model_id = "openai-community/gpt2"
        attrs = {
            "architectures": ["GPT2LMHeadModel"],
            "model_type": "gpt2",
            "context_length": 1024,
            "param_count": 137_022_720,
        }

        # Case 1: SERVED_MODEL_NAME = None (Default)
        raw_user_override = None
        resolved = preflight.resolve_configuration(
            model_id, attrs, {"served_model_name": raw_user_override}, gpu_info=self.mock_t4_gpu
        )
        # Verify preflight resolved the alias automatically to 'gpt2'
        self.assertEqual(resolved["served_model_name"], "gpt2")

        # Resolve authoritative model alias using the helper
        effective_alias = preflight.resolve_effective_served_model_name(
            user_override=raw_user_override,
            model_id=model_id,
            resolved_config=resolved,
        )
        self.assertEqual(effective_alias, "gpt2")

        # Simulate /v1/models response from running vLLM server
        running_models = ["gpt2"]

        # If notebook checked the raw user override (None), it would fail:
        self.assertNotIn(raw_user_override, running_models)
        # Using the authoritative effective_alias, validation passes:
        self.assertIn(effective_alias, running_models)

        # Also test on-disk config resolution when config file is provided or read
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            cfg_path = os.path.join(tmpdir, "resolved_config.json")
            with open(cfg_path, "w", encoding="utf-8") as f:
                json.dump({"served_model_name": "gpt2"}, f)
            disk_alias = preflight.resolve_effective_served_model_name(
                user_override=None,
                config_path=cfg_path,
            )
            self.assertEqual(disk_alias, "gpt2")
            self.assertIn(disk_alias, running_models)

        # Case 2: Explicit SERVED_MODEL_NAME = "my-gpt2"
        explicit_user_override = "my-gpt2"
        resolved_explicit = preflight.resolve_configuration(
            model_id, attrs, {"served_model_name": explicit_user_override}, gpu_info=self.mock_t4_gpu
        )
        self.assertEqual(resolved_explicit["served_model_name"], "my-gpt2")

        effective_explicit = preflight.resolve_effective_served_model_name(
            user_override=explicit_user_override,
            model_id=model_id,
            resolved_config=resolved_explicit,
        )
        self.assertEqual(effective_explicit, "my-gpt2")

        # When server was launched with explicit name, /v1/models returns ['my-gpt2']
        running_models_explicit = ["my-gpt2"]
        self.assertIn(effective_explicit, running_models_explicit)

        # Crucially: if server was running default 'gpt2', validation of explicit override fails
        self.assertNotIn(effective_explicit, ["gpt2"])

    def test_check_has_chat_template(self):
        """Tests check_has_chat_template under diverse tokenizer_config structures."""
        # Valid string template
        has_t, desc = preflight.check_has_chat_template({"chat_template": "{% for m in messages %}{{ m.content }}{% endfor %}"})
        self.assertTrue(has_t)
        self.assertEqual(desc, "tokenizer has valid chat template")

        # Valid list of dict templates
        has_t, desc = preflight.check_has_chat_template({"chat_template": [{"name": "default", "template": "{{ messages }}"}]})
        self.assertTrue(has_t)
        self.assertEqual(desc, "tokenizer has valid chat template")

        # Missing chat_template
        has_t, desc = preflight.check_has_chat_template({})
        self.assertFalse(has_t)
        self.assertEqual(desc, "tokenizer has no usable chat template")

        # None chat_template
        has_t, desc = preflight.check_has_chat_template({"chat_template": None})
        self.assertFalse(has_t)
        self.assertEqual(desc, "tokenizer has no usable chat template")

        # Empty string
        has_t, desc = preflight.check_has_chat_template({"chat_template": "   "})
        self.assertFalse(has_t)
        self.assertEqual(desc, "tokenizer has no usable chat template")

        # List with no valid template key
        has_t, desc = preflight.check_has_chat_template({"chat_template": [{"name": "default"}]})
        self.assertFalse(has_t)
        self.assertEqual(desc, "tokenizer has no usable chat template")

        # Non-dict tokenizer config
        has_t, desc = preflight.check_has_chat_template(None)
        self.assertFalse(has_t)
        self.assertEqual(desc, "tokenizer has no usable chat template")

    def test_test_plan_gpt2_no_chat_template(self):
        """
        Regression test: GPT-2 / base causal model with no chat template
        must select /v1/completions with prompt 'Hello, my name is' and max_tokens 20.
        """
        model_id = "openai-community/gpt2"
        attrs = {
            "model_kind": "text_causal_lm",
            "has_chat_template": False,
            "chat_template_desc": "tokenizer has no usable chat template",
            "context_length": 1024,
            "param_count": 124_000_000,
        }
        resolved = preflight.resolve_configuration(
            model_id, attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertIn("inference_test_plan", resolved)
        plan = resolved["inference_test_plan"]

        self.assertEqual(plan["test_api"], "/v1/completions")
        self.assertEqual(plan["endpoint"], "/v1/completions")
        self.assertEqual(plan["reason"], "tokenizer has no usable chat template")
        self.assertFalse(plan["is_chat"])
        self.assertFalse(plan["is_multimodal"])
        self.assertFalse(plan["has_chat_template"])
        self.assertEqual(plan["payload"]["model"], "gpt2")
        self.assertEqual(plan["payload"]["prompt"], "Hello, my name is")
        self.assertEqual(plan["payload"]["max_tokens"], 20)
        self.assertEqual(plan["payload"]["temperature"], 0.0)

    def test_test_plan_instruct_model_with_chat_template(self):
        """
        Regression test: Instruct / chat model with a valid chat template
        must select /v1/chat/completions with PONG smoke test prompt.
        """
        model_id = "Qwen/Qwen2.5-Coder-7B-Instruct"
        attrs = {
            "model_kind": "text_causal_lm",
            "has_chat_template": True,
            "chat_template_desc": "tokenizer has valid chat template",
            "context_length": 32768,
            "param_count": 7_000_000_000,
        }
        resolved = preflight.resolve_configuration(
            model_id, attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertIn("inference_test_plan", resolved)
        plan = resolved["inference_test_plan"]

        self.assertEqual(plan["test_api"], "/v1/chat/completions")
        self.assertEqual(plan["endpoint"], "/v1/chat/completions")
        self.assertEqual(plan["reason"], "tokenizer has valid chat template")
        self.assertTrue(plan["is_chat"])
        self.assertFalse(plan["is_multimodal"])
        self.assertTrue(plan["has_chat_template"])
        self.assertEqual(plan["payload"]["model"], "qwen2.5-coder-7b-instruct")
        self.assertEqual(
            plan["payload"]["messages"],
            [{"role": "user", "content": "Reply with only the single word PONG"}],
        )
        self.assertEqual(plan["payload"]["max_tokens"], 16)

    def test_test_plan_missing_or_invalid_chat_template_fallback(self):
        """
        Regression test: Models with missing or corrupt chat templates safely
        fall back to /v1/completions without raising errors.
        """
        # Case 1: Tokenizer config is empty
        plan1 = preflight.resolve_inference_test_plan(
            model_id="custom/base-model",
            target_model="base-model",
            attrs={"model_kind": "text_causal_lm", "tokenizer_config": {}},
        )
        self.assertEqual(plan1["test_api"], "/v1/completions")
        self.assertEqual(plan1["reason"], "tokenizer has no usable chat template")
        self.assertFalse(plan1["is_chat"])

        # Case 2: Chat template is whitespace
        plan2 = preflight.resolve_inference_test_plan(
            model_id="custom/corrupt-model",
            target_model="corrupt-model",
            attrs={"model_kind": "text_causal_lm", "tokenizer_config": {"chat_template": "   "}},
        )
        self.assertEqual(plan2["test_api"], "/v1/completions")
        self.assertEqual(plan2["reason"], "tokenizer has no usable chat template")

        # Case 3: Empty resolved config / no metadata available
        plan3 = preflight.resolve_inference_test_plan(
            model_id="custom/unknown-model",
            target_model="unknown-model",
            attrs={"model_kind": "text_causal_lm"},
        )
        self.assertEqual(plan3["test_api"], "/v1/completions")
        self.assertEqual(plan3["reason"], "tokenizer has no usable chat template")

    def test_test_plan_multimodal_model_endpoint(self):
        """
        Regression test: Multimodal vision/OCR models must always use
        /v1/chat/completions with image data URI payload regardless of tokenizer template.
        """
        model_id = "zai-org/GLM-OCR"
        attrs = {
            "model_kind": "multimodal_causal_lm",
            "has_chat_template": False,
            "chat_template_desc": "tokenizer has no usable chat template",
            "context_length": 8192,
            "param_count": 900_000_000,
        }
        resolved = preflight.resolve_configuration(
            model_id, attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertIn("inference_test_plan", resolved)
        plan = resolved["inference_test_plan"]

        self.assertEqual(plan["test_api"], "/v1/chat/completions")
        self.assertEqual(plan["endpoint"], "/v1/chat/completions")
        self.assertEqual(
            plan["reason"],
            "multimodal vision/OCR architecture requires chat message format",
        )
        self.assertTrue(plan["is_chat"])
        self.assertTrue(plan["is_multimodal"])
        self.assertEqual(plan["payload"]["model"], "glm-ocr")
        messages = plan["payload"]["messages"]
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["role"], "user")
        contents = messages[0]["content"]
        self.assertTrue(any(c.get("type") == "image_url" for c in contents))
        self.assertTrue(any(c.get("type") == "text" for c in contents))

    # --- Cloudflare Tunnel URL Propagation & Verification Tests ---

    def test_validate_tunnel_url(self):
        """Tests validate_tunnel_url under valid, invalid, and edge-case URLs."""
        # Valid URLs
        valid, msg = preflight.validate_tunnel_url("https://stephanie-nerve-faces-alarm.trycloudflare.com")
        self.assertTrue(valid, msg)
        self.assertEqual(msg, "")

        valid, msg = preflight.validate_tunnel_url("https://subdomain.example.com/v1")
        self.assertTrue(valid, msg)

        # Invalid: Empty or None
        valid, msg = preflight.validate_tunnel_url(None)
        self.assertFalse(valid)
        self.assertIn("empty", msg.lower())

        valid, msg = preflight.validate_tunnel_url("")
        self.assertFalse(valid)

        # Invalid: Insecure HTTP scheme
        valid, msg = preflight.validate_tunnel_url("http://stephanie-nerve-faces-alarm.trycloudflare.com")
        self.assertFalse(valid)
        self.assertIn("https", msg.lower())

        # Invalid: Missing hostname
        valid, msg = preflight.validate_tunnel_url("https://")
        self.assertFalse(valid)
        self.assertIn("hostname", msg.lower())

        # Invalid: Single-label hostname without domain dot
        valid, msg = preflight.validate_tunnel_url("https://myhostname")
        self.assertFalse(valid)
        self.assertIn("dot", msg.lower())

        # Invalid: Localhost / 127.0.0.1 / null
        valid, msg = preflight.validate_tunnel_url("https://localhost")
        self.assertFalse(valid)
        valid, msg = preflight.validate_tunnel_url("https://null")
        self.assertFalse(valid)

    def test_extract_tunnel_url_from_shell_output(self):
        """Tests authoritative extraction of tunnel URL from diverse shell output formats."""
        # Case 1: Standard cloudflared.sh start banner with PUBLIC_URL & BASE_URL
        shell_banner = """
========================================================
SUCCESS: Cloudflare Quick Tunnel is LIVE!
Public URL: https://stephanie-nerve-faces-alarm.trycloudflare.com
Base URL:   https://stephanie-nerve-faces-alarm.trycloudflare.com/v1
========================================================
PUBLIC_URL=https://stephanie-nerve-faces-alarm.trycloudflare.com
BASE_URL=https://stephanie-nerve-faces-alarm.trycloudflare.com/v1
PUBLIC_TUNNEL_URL=https://stephanie-nerve-faces-alarm.trycloudflare.com
MODEL=gpt2
"""
        extracted = preflight.extract_tunnel_url(output_or_text=shell_banner)
        self.assertEqual(extracted, "https://stephanie-nerve-faces-alarm.trycloudflare.com")

        # Case 2: Output with quotes or whitespace
        output_quotes = "PUBLIC_URL='https://quoted-tunnel-123.trycloudflare.com'\n"
        self.assertEqual(
            preflight.extract_tunnel_url(output_or_text=output_quotes),
            "https://quoted-tunnel-123.trycloudflare.com",
        )

        # Case 3: Raw daemon log text
        raw_log = "2026-09-17T17:15:30Z INF | https://logged-tunnel-456.trycloudflare.com |"
        self.assertEqual(
            preflight.extract_tunnel_url(output_or_text=raw_log),
            "https://logged-tunnel-456.trycloudflare.com",
        )

    def test_extract_tunnel_url_file_persistence_and_stale_prevention(self):
        """Tests reading from WORK_DIR/public_tunnel_url.txt and preventing stale URL reuse."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            url_file = os.path.join(tmpdir, "public_tunnel_url.txt")

            # Initially empty -> returns None
            self.assertIsNone(preflight.extract_tunnel_url(work_dir=tmpdir))

            # Write newly created tunnel URL
            with open(url_file, "w", encoding="utf-8") as f:
                f.write("https://fresh-tunnel-789.trycloudflare.com\n")

            extracted = preflight.extract_tunnel_url(work_dir=tmpdir)
            self.assertEqual(extracted, "https://fresh-tunnel-789.trycloudflare.com")

            # Remove file (simulating stop_tunnel or start_tunnel cleanup)
            os.remove(url_file)
            self.assertIsNone(preflight.extract_tunnel_url(work_dir=tmpdir))

    def test_resolve_canonical_tunnel_urls(self):
        """Tests resolve_canonical_tunnel_urls producing canonical PUBLIC_TUNNEL_URL and derived BASE_URL."""
        res = preflight.resolve_canonical_tunnel_urls("https://stephanie-nerve-faces-alarm.trycloudflare.com")
        self.assertEqual(
            res["public_tunnel_url"],
            "https://stephanie-nerve-faces-alarm.trycloudflare.com",
        )
        self.assertEqual(
            res["base_url"],
            "https://stephanie-nerve-faces-alarm.trycloudflare.com/v1",
        )

        # Trailing slash handling
        res_slash = preflight.resolve_canonical_tunnel_urls("https://stephanie-nerve-faces-alarm.trycloudflare.com/")
        self.assertEqual(
            res_slash["public_tunnel_url"],
            "https://stephanie-nerve-faces-alarm.trycloudflare.com",
        )
        self.assertEqual(
            res_slash["base_url"],
            "https://stephanie-nerve-faces-alarm.trycloudflare.com/v1",
        )

        # Invalid URL raises ValueError
        with self.assertRaises(ValueError):
            preflight.resolve_canonical_tunnel_urls("not-a-valid-url")

    @mock.patch("urllib.request.urlopen")
    def test_verify_tunnel_readiness_guards_invalid_url_without_dns(self, mock_urlopen):
        """Verifies verify_tunnel_readiness immediately aborts without network calls on invalid URL."""
        # Empty
        ready, msg, data = preflight.verify_tunnel_readiness("")
        self.assertFalse(ready)
        self.assertIn("Pre-validation failed", msg)
        self.assertIsNone(data)
        mock_urlopen.assert_not_called()

        # None
        ready, msg, data = preflight.verify_tunnel_readiness(None)
        self.assertFalse(ready)
        self.assertIn("Pre-validation failed", msg)
        mock_urlopen.assert_not_called()

        # Invalid scheme
        ready, msg, data = preflight.verify_tunnel_readiness("http://insecure.trycloudflare.com")
        self.assertFalse(ready)
        self.assertIn("Pre-validation failed", msg)
        mock_urlopen.assert_not_called()

    @mock.patch("preflight.check_tcp_tls_connectivity", return_value=(True, "ok"))
    @mock.patch("preflight.query_local_dns", return_value=(True, ["104.16.230.132"], "ok"))
    @mock.patch("preflight.query_public_recursive_dns", return_value=(True, ["104.16.230.132"], "ok"))
    @mock.patch("time.sleep", return_value=None)
    @mock.patch("urllib.request.urlopen")
    def test_verify_tunnel_readiness_dns_retry_and_success(self, mock_urlopen, mock_sleep, mock_pub, mock_local, mock_tcp):
        """Tests that transient DNS propagation delays (gaierror) are retried until HTTP 200 succeeds."""
        import io
        import socket

        # First call: DNS resolution fails (gaierror)
        # Second call: HTTP 200 response with model data
        mock_resp = mock.MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = json.dumps({"data": [{"id": "gpt2"}]}).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp

        mock_urlopen.side_effect = [
            urllib.error.URLError(socket.gaierror(-2, "Name or service not known")),
            mock_resp,
        ]

        ready, msg, data = preflight.verify_tunnel_readiness(
            "https://stephanie-nerve-faces-alarm.trycloudflare.com",
            timeout_secs=10,
            poll_interval=0.1,
        )

        self.assertTrue(ready)
        self.assertIn("HTTP 200", msg)
        self.assertIsNotNone(data)
        self.assertEqual(data["data"][0]["id"], "gpt2")
        self.assertEqual(mock_urlopen.call_count, 2)

    def test_clean_tunnel_url_markdown_and_wrapper_stripping(self):
        """Tests that clean_tunnel_url strips Markdown link syntax, brackets, and quotes."""
        expected = "https://stephanie-nerve-faces-alarm.trycloudflare.com"

        # Plain URL
        self.assertEqual(preflight.clean_tunnel_url(expected), expected)
        self.assertEqual(preflight.clean_tunnel_url(expected + "/"), expected)
        self.assertEqual(preflight.clean_tunnel_url(expected + "/v1"), expected)

        # Markdown links
        self.assertEqual(
            preflight.clean_tunnel_url(f"[{expected}]({expected})"),
            expected,
        )
        self.assertEqual(
            preflight.clean_tunnel_url(f"[Public Tunnel URL]({expected})"),
            expected,
        )
        self.assertEqual(
            preflight.clean_tunnel_url(f"[{expected}]"),
            expected,
        )

        # Angle brackets & quotes
        self.assertEqual(preflight.clean_tunnel_url(f"<{expected}>"), expected)
        self.assertEqual(preflight.clean_tunnel_url(f'"{expected}"'), expected)
        self.assertEqual(preflight.clean_tunnel_url(f"'{expected}'"), expected)

        # None / empty
        self.assertEqual(preflight.clean_tunnel_url(None), "")
        self.assertEqual(preflight.clean_tunnel_url(""), "")

    def test_enable_ipv4_dns_fallback(self):
        """Tests that enable_ipv4_dns_fallback retries AF_UNSPEC gaierror with AF_INET."""
        import socket

        orig_getaddrinfo = socket.getaddrinfo
        called_families = []

        def mock_gai(host, port, family=0, type=0, proto=0, flags=0):
            called_families.append(family)
            if family == 0:
                raise socket.gaierror(-2, "Name or service not known")
            return [("AF_INET", 1, 6, "", ("104.16.132.229", 443))]

        try:
            socket.getaddrinfo = mock_gai
            # Reset global flag to allow re-patching in test
            preflight._ipv4_fallback_enabled = False
            preflight.enable_ipv4_dns_fallback()

            res = socket.getaddrinfo("test-domain.trycloudflare.com", 443)
            self.assertEqual(res[0][4][0], "104.16.132.229")
            self.assertIn(0, called_families)
            self.assertIn(socket.AF_INET, called_families)
        finally:
            socket.getaddrinfo = orig_getaddrinfo

    @mock.patch("time.time", side_effect=[100.0, 100.1, 105.0, 105.0, 105.0])
    @mock.patch("time.sleep", return_value=None)
    @mock.patch("preflight.query_local_dns")
    @mock.patch("preflight.query_public_recursive_dns")
    def test_readiness_hostname_not_yet_resolvable(self, mock_pub_dns, mock_local_dns, mock_sleep, mock_time):
        """Tests that when hostname is not publicly visible, readiness times out and reports diagnostics."""
        mock_pub_dns.return_value = (False, [], "Public recursive resolver (1.1.1.1) currently reports NXDOMAIN / no A record.")
        mock_local_dns.return_value = (False, [], "Local system DNS resolution failed: socket.gaierror(-2, 'Name or service not known')")

        ready, msg, data = preflight.verify_tunnel_readiness(
            "https://test-pending-host.trycloudflare.com",
            timeout_secs=2,
            poll_interval=0.1,
        )

        self.assertFalse(ready)
        self.assertIsNone(data)
        self.assertIn("PUBLIC_DNS_UNAVAILABLE", msg)
        self.assertIn("not yet publicly resolvable", msg)
        self.assertIn("Local DNS result:", msg)
        self.assertIn("Public recursive DNS result:", msg)
        self.assertIn("cloudflared process:", msg)

    @mock.patch("time.sleep", return_value=None)
    @mock.patch("preflight.check_tcp_tls_connectivity", return_value=(True, "ok"))
    @mock.patch("urllib.request.urlopen")
    @mock.patch("preflight.query_local_dns")
    @mock.patch("preflight.query_public_recursive_dns")
    def test_readiness_hostname_becomes_resolvable_after_polling(
        self, mock_pub_dns, mock_local_dns, mock_urlopen, mock_tcp, mock_sleep
    ):
        """Tests that polling retries until hostname becomes publicly resolvable and endpoint responds."""
        mock_pub_dns.side_effect = [
            (False, [], "Public recursive resolver (1.1.1.1) currently reports NXDOMAIN / no A record."),
            (True, ["104.16.230.132"], "Resolved via dig @1.1.1.1: ['104.16.230.132']"),
        ]
        mock_local_dns.side_effect = [
            (False, [], "gaierror -2"),
            (True, ["104.16.230.132"], "Resolved via local system DNS: ['104.16.230.132']"),
        ]

        mock_resp = mock.MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = json.dumps({"data": [{"id": "gpt2"}]}).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        ready, msg, data = preflight.verify_tunnel_readiness(
            "https://test-delayed-host.trycloudflare.com",
            timeout_secs=10,
            poll_interval=0.1,
            expected_model="gpt2",
        )

        self.assertTrue(ready)
        self.assertIn("[READY]", msg)
        self.assertIn("HTTP 200", msg)
        self.assertIsNotNone(data)
        self.assertEqual(data["data"][0]["id"], "gpt2")

    @mock.patch("time.time", side_effect=[100.0, 100.1, 105.0, 105.0, 105.0])
    @mock.patch("time.sleep", return_value=None)
    @mock.patch("preflight.query_local_dns")
    @mock.patch("preflight.query_public_recursive_dns")
    def test_readiness_local_dns_failure_but_public_dns_success(self, mock_pub_dns, mock_local_dns, mock_sleep, mock_time):
        """Tests distinction of local negative cache when public DNS already resolves the record."""
        mock_pub_dns.return_value = (True, ["104.16.230.132"], "Resolved via dig @1.1.1.1: ['104.16.230.132']")
        mock_local_dns.return_value = (False, [], "Local system DNS resolution failed: gaierror -2")

        ready, msg, data = preflight.verify_tunnel_readiness(
            "https://test-cache-mismatch.trycloudflare.com",
            timeout_secs=2,
            poll_interval=0.1,
        )

        self.assertFalse(ready)
        self.assertIsNone(data)
        self.assertIn("LOCAL_DNS_NEGATIVE_CACHE", msg)
        self.assertIn("negative cache", msg.lower())
        self.assertIn("Public recursive DNS result:", msg)
        self.assertIn("Local DNS result:", msg)

    @mock.patch("time.time", side_effect=[100.0, 100.1, 105.0, 105.0, 105.0])
    @mock.patch("time.sleep", return_value=None)
    @mock.patch("preflight.query_local_dns")
    @mock.patch("preflight.query_public_recursive_dns")
    def test_readiness_both_local_and_public_dns_failure(self, mock_pub_dns, mock_local_dns, mock_sleep, mock_time):
        """Tests that when both local and public DNS fail, hostname not publicly visible is reported."""
        mock_pub_dns.return_value = (False, [], "Public recursive resolver (1.1.1.1) currently reports NXDOMAIN / no A record.")
        mock_local_dns.return_value = (False, [], "Local system DNS resolution failed: gaierror -2")

        ready, msg, data = preflight.verify_tunnel_readiness(
            "https://test-both-fail.trycloudflare.com",
            timeout_secs=2,
            poll_interval=0.1,
        )

        self.assertFalse(ready)
        self.assertIsNone(data)
        self.assertIn("PUBLIC_DNS_UNAVAILABLE", msg)
        self.assertIn("NXDOMAIN", msg)
        self.assertIn("Local DNS result:", msg)
        self.assertIn("Public recursive DNS result:", msg)

    def test_readiness_malformed_url(self):
        """Tests that malformed or empty URLs immediately fail pre-validation without polling."""
        for bad_url in [
            "",
            None,
            "http://insecure.trycloudflare.com",
            "https://",
            "https://invalid-single-label",
            "https://localhost",
        ]:
            ready, msg, data = preflight.verify_tunnel_readiness(bad_url)
            self.assertFalse(ready)
            self.assertIn("MALFORMED_URL", msg)
            self.assertIn("Pre-validation failed", msg)
            self.assertIsNone(data)

    @mock.patch("preflight.check_cloudflared_process_alive")
    def test_readiness_dead_cloudflared_process(self, mock_proc_alive):
        """Tests that when cloudflared PID is dead, polling aborts immediately without waiting."""
        mock_proc_alive.return_value = (False, 8888, "cloudflared process PID 8888 does not exist")

        ready, msg, data = preflight.verify_tunnel_readiness(
            "https://test-dead-proc.trycloudflare.com",
            timeout_secs=60,
            pid=8888,
        )

        self.assertFalse(ready)
        self.assertIn("PROCESS_DEAD", msg)
        self.assertIn("PID 8888", msg)
        self.assertIsNone(data)

    @mock.patch("preflight.check_tcp_tls_connectivity", return_value=(True, "ok"))
    @mock.patch("preflight.query_local_dns", return_value=(True, ["104.16.230.132"], "ok"))
    @mock.patch("preflight.query_public_recursive_dns", return_value=(True, ["104.16.230.132"], "ok"))
    @mock.patch("preflight.check_cloudflared_process_alive", return_value=(True, 1234, "running"))
    @mock.patch("urllib.request.urlopen")
    def test_readiness_successful_dns_and_http(
        self, mock_urlopen, mock_proc, mock_pub, mock_local, mock_tcp
    ):
        """Tests full success condition: live process + public DNS + local DNS + TCP/TLS + HTTP 200."""
        mock_resp = mock.MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = json.dumps({"data": [{"id": "gpt2"}]}).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        ready, msg, data = preflight.verify_tunnel_readiness(
            "https://test-success.trycloudflare.com",
            expected_model="gpt2",
            pid=1234,
        )

        self.assertTrue(ready)
        self.assertIn("[READY]", msg)
        self.assertIn("HTTP 200", msg)
        self.assertIsNotNone(data)
        self.assertEqual(data["data"][0]["id"], "gpt2")

    @mock.patch("time.sleep", return_value=None)
    @mock.patch("preflight.check_tcp_tls_connectivity", return_value=(True, "ok"))
    @mock.patch("preflight.query_local_dns", return_value=(True, ["104.16.230.132"], "ok"))
    @mock.patch("preflight.query_public_recursive_dns", return_value=(True, ["104.16.230.132"], "ok"))
    @mock.patch("preflight.check_cloudflared_process_alive", return_value=(True, 1234, "running"))
    @mock.patch("urllib.request.urlopen")
    def test_readiness_expected_model_mismatch(
        self, mock_urlopen, mock_proc, mock_pub, mock_local, mock_tcp, mock_sleep
    ):
        """Tests that when HTTP 200 is returned but expected model is not present, failure is reported."""
        mock_resp = mock.MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = json.dumps({"data": [{"id": "other-model"}]}).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        ready, msg, data = preflight.verify_tunnel_readiness(
            "https://test-mismatch.trycloudflare.com",
            timeout_secs=2,
            poll_interval=0.1,
            expected_model="gpt2",
            pid=1234,
        )

        self.assertFalse(ready)
        self.assertIn("MODEL_NOT_FOUND", msg)
        self.assertIn("expected model 'gpt2' not found", msg)


class TestProcessorDependencies(unittest.TestCase):
    """
    Tests for generic model-runtime dependency resolution and bootstrap behavior.
    Enforces that:
      - SmolVLM/SmolVLM2 resolves num2words as required
      - Idefics/Idefics3 does NOT guess or inherit num2words
      - GPT-2 and text models have no extra processor dependencies
      - Matching precedence strictly honors processor_class > architecture/model_type > model_id
      - Attention head fallback divides when divisible and leaves unknown when not
      - Extra user packages via EXTRA_PIP_PACKAGES are respected
      - Package installed vs missing reporting is accurate
    """

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

    def test_smolvlm_processor_requires_num2words(self):
        """SmolVLM processor metadata resolves num2words in required_packages."""
        attrs = {
            "model_id": "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
            "model_type": "smolvlm",
            "architectures": ["SmolVLMForConditionalGeneration"],
            "processor_class": "SmolVLMProcessor",
            "image_processor_type": "SmolVLMImageProcessor",
        }
        deps = preflight.resolve_model_dependencies(attrs)
        self.assertIn("num2words", deps["required_packages"])
        # Do not assume num2words is missing in the host environment;
        # assert that status is consistently classified as installed or missing
        self.assertTrue(
            "num2words" in deps["missing_packages"]
            or "num2words" in deps["installed_packages"]
        )

    def test_smolvlm_via_architecture_or_model_type_requires_num2words(self):
        """Even without processor_class, smolvlm architecture or model_type matches num2words."""
        attrs = {
            "model_id": "community/fine-tuned-smolvlm",
            "model_type": "smolvlm",
            "architectures": ["SmolVLMForConditionalGeneration"],
        }
        deps = preflight.resolve_model_dependencies(attrs)
        self.assertIn("num2words", deps["required_packages"])

    def test_generic_idefics3_does_not_require_num2words(self):
        """Generic Idefics3 must NOT inherit num2words."""
        attrs = {
            "model_id": "HuggingFaceM4/Idefics3-8B-Llama3",
            "model_type": "idefics3",
            "architectures": ["Idefics3ForConditionalGeneration"],
            "processor_class": "Idefics3Processor",
        }
        deps = preflight.resolve_model_dependencies(attrs)
        self.assertEqual(deps["required_packages"], [])
        self.assertEqual(deps["missing_packages"], [])

    def test_gpt2_text_model_requires_no_extra_dependencies(self):
        """Causal text models require zero additional processor dependencies."""
        attrs = {
            "model_id": "openai-community/gpt2",
            "model_type": "gpt2",
            "architectures": ["GPT2LMHeadModel"],
        }
        deps = preflight.resolve_model_dependencies(attrs)
        self.assertEqual(deps["required_packages"], [])
        self.assertEqual(deps["missing_packages"], [])

    def test_precedence_processor_class_over_model_type_and_id(self):
        """Processor metadata has highest precedence over model type and ID."""
        # Ambiguous model_id and model_type, but explicit SmolVLMProcessor class
        attrs = {
            "model_id": "custom-org/my-vision-model",
            "model_type": "custom_vlm",
            "architectures": ["CustomConditionalGeneration"],
            "processor_class": "SmolVLMProcessor",
        }
        deps = preflight.resolve_model_dependencies(attrs)
        self.assertIn("num2words", deps["required_packages"])

    def test_generic_attention_head_calculation(self):
        """Attention head fallback: explicit > hidden_size // head_dim when divisible > unknown."""
        # 1. Divisible case (e.g. SmolVLM2: 2048 // 64 = 32)
        cfg_divisible = {
            "num_hidden_layers": 24,
            "hidden_size": 2048,
            "head_dim": 64,
        }
        dims = preflight.extract_attention_dimensions(cfg_divisible)
        self.assertEqual(dims["num_attention_heads"], 32)
        self.assertEqual(dims["num_key_value_heads"], 32)
        self.assertEqual(dims["head_dim"], 64)
        self.assertEqual(dims["source"], "hf_config")

        # 2. Non-divisible case -> leaves unknown (None)
        cfg_non_divisible = {
            "num_hidden_layers": 24,
            "hidden_size": 2000,
            "head_dim": 64,
        }
        dims_non_div = preflight.extract_attention_dimensions(cfg_non_divisible)
        self.assertIsNone(dims_non_div["num_attention_heads"])

        # 3. Explicit num_attention_heads takes precedence
        cfg_explicit = {
            "num_hidden_layers": 24,
            "num_attention_heads": 16,
            "hidden_size": 2048,
            "head_dim": 64,
        }
        dims_exp = preflight.extract_attention_dimensions(cfg_explicit)
        self.assertEqual(dims_exp["num_attention_heads"], 16)

    def test_extra_pip_packages_user_override(self):
        """User can specify additional packages via EXTRA_PIP_PACKAGES or extra_packages argument."""
        attrs = {
            "model_id": "openai-community/gpt2",
            "model_type": "gpt2",
            "architectures": ["GPT2LMHeadModel"],
        }
        with mock.patch.dict(os.environ, {"EXTRA_PIP_PACKAGES": "custom-pkg another-pkg"}):
            deps = preflight.resolve_model_dependencies(attrs)
            self.assertIn("custom-pkg", deps["required_packages"])
            self.assertIn("another-pkg", deps["required_packages"])

    def test_dependency_status_reporting_mocked(self):
        """Accurately classifies missing vs installed packages when presence is mocked."""
        attrs = {
            "model_id": "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
            "processor_class": "SmolVLMProcessor",
        }
        # Case A: package missing
        with mock.patch("preflight.is_package_installed", return_value=False):
            deps = preflight.resolve_model_dependencies(attrs)
            self.assertEqual(deps["missing_packages"], ["num2words"])
            self.assertEqual(deps["installed_packages"], [])
            self.assertEqual(
                deps["bootstrap_command"],
                ["pip", "install", "-q", "--no-cache-dir", "num2words"],
            )

        # Case B: package installed
        with mock.patch("preflight.is_package_installed", return_value=True):
            deps = preflight.resolve_model_dependencies(attrs)
            self.assertEqual(deps["missing_packages"], [])
            self.assertEqual(deps["installed_packages"], ["num2words"])
            self.assertEqual(deps["bootstrap_command"], [])

    def test_generic_idefics_and_idefics2_do_not_require_num2words(self):
        """Generic Idefics and Idefics2 architectures and processors do NOT require num2words."""
        # Test Idefics 1
        attrs_idefics1 = {
            "model_id": "HuggingFaceM4/idefics-9b",
            "model_type": "idefics",
            "architectures": ["IdeficsForVisionText2Text"],
            "processor_class": "IdeficsProcessor",
        }
        deps1 = preflight.resolve_model_dependencies(attrs_idefics1)
        self.assertNotIn("num2words", deps1["required_packages"])
        self.assertEqual(deps1["required_packages"], [])

        # Test Idefics 2
        attrs_idefics2 = {
            "model_id": "HuggingFaceM4/idefics2-8b",
            "model_type": "idefics2",
            "architectures": ["Idefics2ForConditionalGeneration"],
            "processor_class": "Idefics2Processor",
        }
        deps2 = preflight.resolve_model_dependencies(attrs_idefics2)
        self.assertNotIn("num2words", deps2["required_packages"])
        self.assertEqual(deps2["required_packages"], [])

    def test_already_installed_package_not_reported_as_missing(self):
        """An already-installed package is recorded in installed_packages and NOT in missing_packages."""
        attrs = {
            "model_id": "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
            "processor_class": "SmolVLMProcessor",
        }
        with mock.patch("preflight.is_package_installed", return_value=True):
            deps = preflight.resolve_model_dependencies(attrs)
            self.assertIn("num2words", deps["installed_packages"])
            self.assertNotIn("num2words", deps["missing_packages"])
            self.assertEqual(deps["missing_packages"], [])
            self.assertEqual(deps["bootstrap_command"], [])

    def test_missing_package_reported_as_missing(self):
        """A missing package is recorded in missing_packages and NOT in installed_packages."""
        attrs = {
            "model_id": "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
            "processor_class": "SmolVLMProcessor",
        }
        with mock.patch("preflight.is_package_installed", return_value=False):
            deps = preflight.resolve_model_dependencies(attrs)
            self.assertIn("num2words", deps["missing_packages"])
            self.assertNotIn("num2words", deps["installed_packages"])
            self.assertEqual(
                deps["bootstrap_command"],
                ["pip", "install", "-q", "--no-cache-dir", "num2words"],
            )

    def test_bootstrap_installs_only_missing_packages(self):
        """Bootstrap command and missing_packages only include packages not yet installed."""
        attrs = {
            "model_id": "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
            "processor_class": "SmolVLMProcessor",
        }
        with mock.patch.dict(os.environ, {"EXTRA_PIP_PACKAGES": "present-dep missing-dep"}):
            def mock_installed(pkg_name):
                return pkg_name in ("num2words", "present-dep")

            with mock.patch("preflight.is_package_installed", side_effect=mock_installed):
                deps = preflight.resolve_model_dependencies(attrs)
                self.assertIn("num2words", deps["installed_packages"])
                self.assertIn("present-dep", deps["installed_packages"])
                self.assertEqual(deps["missing_packages"], ["missing-dep"])
                self.assertEqual(
                    deps["bootstrap_command"],
                    ["pip", "install", "-q", "--no-cache-dir", "missing-dep"],
                )

    def test_repeated_bootstrap_is_idempotent(self):
        """Repeated bootstrap is idempotent: once installed, missing_packages becomes empty."""
        attrs = {
            "model_id": "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
            "processor_class": "SmolVLMProcessor",
        }
        # First execution: package is missing
        with mock.patch("preflight.is_package_installed", return_value=False):
            deps_step1 = preflight.resolve_model_dependencies(attrs)
            self.assertEqual(deps_step1["missing_packages"], ["num2words"])
            self.assertEqual(
                deps_step1["bootstrap_command"],
                ["pip", "install", "-q", "--no-cache-dir", "num2words"],
            )

        # Second execution: package has been installed by bootstrap
        with mock.patch("preflight.is_package_installed", return_value=True):
            deps_step2 = preflight.resolve_model_dependencies(attrs)
            self.assertEqual(deps_step2["missing_packages"], [])
            self.assertEqual(deps_step2["bootstrap_command"], [])
            self.assertIn("num2words", deps_step2["installed_packages"])

    def test_pip_failure_exits_nonzero_and_is_not_suppressed(self):
        """vllm.sh bootstrap fails with non-zero exit code (1) when pip install fails."""
        vllm_sh = os.path.join(KAGGLE_DIR, "vllm.sh")
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a mock failing pip binary
            fake_pip = os.path.join(tmpdir, "pip")
            with open(fake_pip, "w") as f:
                f.write("#!/bin/sh\necho 'Mock pip error: network down' >&2\nexit 1\n")
            os.chmod(fake_pip, 0o755)

            # Create a mock preflight reporting num2words missing
            fake_preflight = os.path.join(tmpdir, "preflight.py")
            with open(fake_preflight, "w") as f:
                f.write(
                    "#!/usr/bin/env python3\n"
                    "import json, sys\n"
                    "if '--json' in sys.argv:\n"
                    "    print(json.dumps({'missing_packages': ['num2words']}))\n"
                    "    sys.exit(0)\n"
                    "sys.exit(0)\n"
                )
            os.chmod(fake_preflight, 0o755)

            env = {
                **os.environ,
                "PATH": f"{tmpdir}:{os.environ.get('PATH', '')}",
                "MODEL_ID": "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
                "SCRIPT_DIR": tmpdir,
                "WORK_DIR": tmpdir,
            }

            cmd = ["bash", vllm_sh, "bootstrap"]
            res = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(res.returncode, 1, "bootstrap_deps must exit with code 1 on pip failure")
            output = res.stderr + res.stdout
            self.assertIn("Failed to install processor dependencies", output)
            self.assertIn("Mock pip error", output)

    def test_vllm_bootstrap_success_and_idempotency_via_shell(self):
        """vllm.sh bootstrap installs dependencies once and does not re-invoke pip when satisfied."""
        vllm_sh = os.path.join(KAGGLE_DIR, "vllm.sh")
        with tempfile.TemporaryDirectory() as tmpdir:
            pip_log = os.path.join(tmpdir, "pip_calls.txt")
            fake_pip = os.path.join(tmpdir, "pip")
            with open(fake_pip, "w") as f:
                f.write(f"#!/bin/sh\necho \"$@\" >> '{pip_log}'\nexit 0\n")
            os.chmod(fake_pip, 0o755)

            flag_file = os.path.join(tmpdir, "installed.flag")
            fake_preflight = os.path.join(tmpdir, "preflight.py")
            with open(fake_preflight, "w") as f:
                f.write(
                    "#!/usr/bin/env python3\n"
                    "import json, sys, os\n"
                    "if '--json' in sys.argv:\n"
                    f"    if os.path.exists('{flag_file}'):\n"
                    "        print(json.dumps({'missing_packages': []}))\n"
                    "    else:\n"
                    "        print(json.dumps({'missing_packages': ['num2words']}))\n"
                    "    sys.exit(0)\n"
                    "sys.exit(0)\n"
                )
            os.chmod(fake_preflight, 0o755)

            env = {
                **os.environ,
                "PATH": f"{tmpdir}:{os.environ.get('PATH', '')}",
                "MODEL_ID": "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
                "SCRIPT_DIR": tmpdir,
                "WORK_DIR": tmpdir,
            }

            cmd = ["bash", vllm_sh, "bootstrap"]

            # Run 1: installs num2words
            res1 = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(res1.returncode, 0)
            self.assertIn("Successfully installed processor dependencies", res1.stdout)
            with open(pip_log, "r") as f:
                lines1 = f.readlines()
            self.assertEqual(len(lines1), 1)
            self.assertIn("num2words", lines1[0])

            # Simulate installation complete for Step 2
            with open(flag_file, "w") as f:
                f.write("done\n")

            # Run 2: already satisfied, pip is NOT invoked again
            res2 = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(res2.returncode, 0)
            self.assertIn("All required model processor dependencies are already satisfied", res2.stdout)
            with open(pip_log, "r") as f:
                lines2 = f.readlines()
            self.assertEqual(len(lines2), 1, "pip must not be invoked again on repeated bootstrap")

    def test_smolvlm2_candidate_recommendation_offline(self):
        """SmolVLM2 candidate recommendation includes dependencies and multimodal plan."""
        config = {
            "architectures": ["SmolVLMForConditionalGeneration"],
            "model_type": "smolvlm",
            "image_token_id": 49190,
            "vision_config": {"longest_edge": 384},
            "text_config": {
                "num_hidden_layers": 24,
                "hidden_size": 2048,
                "head_dim": 64,
                "max_position_embeddings": 8192,
                "torch_dtype": "bfloat16",
            },
        }
        model_info = {
            "id": "HuggingFaceTB/SmolVLM2-2.2B-Instruct",
            "processor_config": {"processor_class": "SmolVLMProcessor"},
            "preprocessor_config": {"image_processor_type": "SmolVLMImageProcessor"},
        }
        attrs = preflight.inspect_model_attributes(model_info, config)
        attrs["param_count"] = 2_200_000_000

        resolved = preflight.resolve_configuration(
            "HuggingFaceTB/SmolVLM2-2.2B-Instruct", attrs, {}, gpu_info=self.mock_t4_gpu
        )
        self.assertEqual(resolved["status"], "CANDIDATE_RECOMMENDED")
        self.assertEqual(resolved["model_kind"], "multimodal_causal_lm")
        self.assertEqual(resolved["tensor_parallel_size"], 1)
        self.assertEqual(resolved["dtype"], "float16")
        self.assertEqual(resolved["max_model_len"], 4096)
        self.assertTrue(resolved["inference_test_plan"]["is_multimodal"])
        self.assertIn("num2words", resolved["required_packages"])
        self.assertIn("dependencies", resolved)
        self.assertIn("missing_packages", resolved)


if __name__ == "__main__":
    unittest.main()
